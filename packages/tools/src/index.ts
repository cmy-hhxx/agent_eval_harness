import { spawn } from "node:child_process";
import { mkdir, open, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { JsonSchema, ToolContent, ToolContext, ToolDefinition, ToolResult, TraceRead, ValidationIssue } from "@eval/contracts";
import { fileURLToPath } from "node:url";
import { canonical, errorText, object, presentSource, projectEvidenceReferences, schemaIssues, SUBMISSION_FILE_SCHEMA, toolBudgetMetadataChars, validateEvidenceBank, ValidationError } from "@eval/contracts";

import { cite, displayEvidence, evidenceId, evidenceSources, overlapsImagePlaceholder, selectEvidenceSource } from "./evidence.js";
import { compareTraceTableRows, parseTraceTables, type TableCheckRequest } from "./table-correspondence.js";
import { calculate } from "./decimal.js";
import { fitStringPage } from "./pagination.js";
import { RequiredReadBudget } from "./required-reading.js";

const schema = (properties: JsonSchema, required = Object.keys(properties)): JsonSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const str = { type: "string", minLength: 1 };
const index = { type: "integer", minimum: 0 };
export const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  details: value,
});
function record(ctx: ToolContext, candidate: string): { messages: unknown[] } {
  const value = ctx.inputs.get(candidate);
  if (!value || !Array.isArray(object(value).messages)) throw new Error("只能访问本任务材料");
  return value as { messages: unknown[] };
}
function registeredInputId(ctx: ToolContext, candidate: string): string {
  const id = ctx.inputIds.get(candidate);
  if (!ctx.inputs.has(candidate) || !id) throw new Error("candidate 必须选择本任务材料中列出的候选标识");
  evidenceId(id, 0, "image");
  return id;
}
function message(ctx: ToolContext, candidate: string, i: number): unknown {
  const value = record(ctx, candidate).messages[i];
  if (!value) throw new Error("消息索引不存在");
  return value;
}
export function images(value: unknown): ToolContent[] {
  if (typeof value === "string") {
    const match = /^data:(image\/[\w.+-]+);base64,([\s\S]+)$/i.exec(value);
    return match ? [{ type: "image", mimeType: match[1], data: match[2] }] : [];
  }
  if (!value || typeof value !== "object") return [];
  const node = value as Record<string, unknown>;
  if (node.type === "image" && typeof node.data === "string" && /^image\//i.test(String(node.mimeType || node.mime_type || "")))
    return [
      {
        type: "image",
        data: node.data,
        mimeType: String(node.mimeType || node.mime_type),
      },
    ];
  return Object.values(node).flatMap(images);
}
const calculationSchema = schema({
  operation: { enum: ["add", "subtract", "multiply", "divide"] },
  operands: { type: "array", items: str, minItems: 2, maxItems: 20 },
});
export async function executeCode(ctx: Pick<ToolContext, "workdir" | "execution" | "artifacts"> & {
  audit: Pick<ToolContext["audit"], "artifacts">;
  policy: Pick<ToolContext["policy"], "codeTimeoutSeconds" | "maxOutputChars">;
}, value: unknown, signal: AbortSignal): Promise<ToolResult> {
  const args = value as {
    language: "python" | "shell";
    code: string;
    timeout_seconds?: number;
    outputs?: string[];
  };
  const id = randomUUID();
  const logs = path.join(ctx.workdir, ".execution");
  await mkdir(logs, { recursive: true });
  const script = path.join(logs, `${id}.${args.language === "python" ? "py" : "sh"}`);
  await writeFile(script, args.code);
  const outPath = path.join(logs, `${id}.stdout`),
    errPath = path.join(logs, `${id}.stderr`);
  const stdout = await open(outPath, "w"),
    stderr = await open(errPath, "w");
  const command =
    args.language === "python" ? ctx.execution?.python || process.env.EVAL_PYTHON || "python3" : "/bin/bash";
  const started = Date.now();
  let timedOut = false;
  const proc = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("./code-process.js", import.meta.url)),
      command,
      ...(args.language === "python" ? [script] : ["--noprofile", "--norc", script]),
    ],
    {
      cwd: ctx.workdir,
      detached: true,
      stdio: ["ignore", stdout.fd, stderr.fd, "ipc"],
      env: {
        PATH: process.env.PATH,
        LANG: "C.UTF-8",
        PYTHONUNBUFFERED: "1",
        TMPDIR: ctx.workdir,
        HOME: ctx.workdir,
      },
    },
  );
  let killTimer: NodeJS.Timeout | undefined;
  const terminate = () => {
    if (!proc.pid) return;
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    try {
      process.kill(-proc.pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        // The invocation guardian also owns cleanup on IPC disconnect. A denied
        // group signal must not escape the abort listener and crash the Worker.
        if (proc.connected) proc.disconnect();
      }
    }
    killTimer ??= setTimeout(() => {
      try {
        process.kill(-proc.pid!, "SIGKILL");
      } catch {
        /* group already exited */
      }
    }, 2000);
  };
  const timeout = setTimeout(
    () => {
      timedOut = true;
      terminate();
    },
    1000 * Math.min(args.timeout_seconds || ctx.policy.codeTimeoutSeconds, ctx.policy.codeTimeoutSeconds),
  );
  signal.addEventListener("abort", terminate, { once: true });
  if (signal.aborted) terminate();
  let exitCode: number | null = null;
  try {
    exitCode = await new Promise<number | null>((resolve, reject) => {
      proc.once("error", reject);
      // Output uses owned file descriptors, so no pipe drain is needed. Node can
      // omit `close` after a manual IPC disconnect; the guardian's exit is final.
      proc.once("exit", (code) => resolve(code));
    });
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", terminate);
    // Clean background descendants even when the shell itself returned successfully.
    terminate();
    if (killTimer) clearTimeout(killTimer);
    await stdout.close();
    await stderr.close();
  }
  const outputArtifacts = [];
  for (const [name, file] of [
    ["script", script],
    ["stdout", outPath],
    ["stderr", errPath],
  ]) {
    const size = (await stat(file)).size;
    if (size > 64 * 1024 * 1024) throw new Error("代码输出超过 64 MiB；请在脚本中生成精简结果");
    const artifact = await ctx.artifacts.put(`${id}.${name}`, await readFile(file));
    ctx.audit.artifacts.push(artifact);
    outputArtifacts.push(artifact);
  }
  const workspace = await realpath(ctx.workdir);
  const errors: ValidationIssue[] = [];
  for (const [index, name] of (args.outputs || []).entries()) {
    try {
      const file = await realpath(path.resolve(ctx.workdir, name));
      if (!file.startsWith(workspace + path.sep)) throw new Error("产物必须位于任务工作目录");
      if ((await stat(file)).size > 32 * 1024 * 1024) throw new Error("单个产物不能超过 32 MiB");
      const artifact = await ctx.artifacts.put(path.relative(workspace, file), await readFile(file));
      ctx.audit.artifacts.push(artifact);
      outputArtifacts.push(artifact);
    } catch (error) {
      errors.push({ category: "file", code: "code_output_invalid", path: `/outputs/${index}`,
        actual: (error as NodeJS.ErrnoException).code || null, message: errorText(error) });
    }
  }
  const out = (await readFile(outPath, "utf8")).slice(0, ctx.policy.maxOutputChars),
    err = (await readFile(errPath, "utf8")).slice(0, ctx.policy.maxOutputChars);
  return { ...textResult({
    exit_code: exitCode,
    timed_out: timedOut,
    cancelled: signal.aborted,
    duration_seconds: (Date.now() - started) / 1000,
    stdout: out,
    stderr: err,
    artifacts: outputArtifacts,
    ...(errors.length ? { errors } : {}),
  }), ...(exitCode !== 0 || timedOut || signal.aborted || errors.length > 0 ? { isError: true } : {}) };
}
export type ExecutableTool = Omit<ToolDefinition, "description">;

export const builtinTools: ExecutableTool[] = [
  { name: "inspect_material",
    inputSchema: SUBMISSION_FILE_SCHEMA,
    async execute(context, value, signal) {
      if (!context.inspectMaterial) throw new Error("当前任务未配置结构化材料核查");
      return context.inspectMaterial(value, signal);
    } },
  {
    name: "check_table",
    inputSchema: schema({
      candidate: str,
      answer_table_index: { type: "integer", minimum: 1 },
      sources: { type: "array", minItems: 1, items: schema({
        table_index: { type: "integer", minimum: 1 },
        key_columns: { type: "array", minItems: 1, items: schema({ answer: index, source: index }) },
        value_columns: { type: "array", minItems: 1, items: schema({ answer: index, source: index }) },
      }) },
      message_index: index,
      offset: index,
    }, ["candidate"]),
    async execute(ctx, value) {
      const args = value as { candidate: string; answer_table_index?: number;
        sources?: (Omit<TableCheckRequest["sources"][number], "table_id"> & { table_index: number })[];
        message_index?: number; offset?: number };
      const raw = record(ctx, args.candidate), offset = args.offset ?? 0;
      // Number the full source-owned inventory before filtering or pagination, so selections never shift.
      const tables = parseTraceTables(raw, registeredInputId(ctx, args.candidate));
      const tableIndices = new Map(tables.map((table, index) => [table.table_id, index + 1]));
      const selectedTable = (index: number) => {
        if (!Number.isSafeInteger(index) || index < 1 || index > tables.length)
          throw new Error("表格编号不在本候选固定目录中；请先获取表格目录并选择已有的正整数 table_index");
        return tables[index - 1];
      };
      if ((args.answer_table_index === undefined) !== (args.sources === undefined))
        throw new Error("核验时必须同时提供 answer_table_index 和 sources；只传 candidate 可先获取表格目录");
      if (args.answer_table_index === undefined) {
        const all = tables.map((table, index) => ({ table, table_index: index + 1 }))
          .filter(({ table }) => args.message_index === undefined || table.message_index === args.message_index);
        if (offset > all.length) throw new Error("offset 超出表格目录范围");
        const shown = all.slice(offset, offset + 20).map(({ table, table_index }) => ({
          table_index, message_index: table.message_index, path: table.path,
          headers: table.headers, row_count: table.rows.length,
          preview: table.rows.slice(0, 2).map((row) => ({ row_index: row.row_index,
            cells: row.cells.slice(0, 6).map((cell) => cell.slice(0, 80)),
          })),
        }));
        const page = () => textResult({ tables: shown, total: all.length, offset,
          next_offset: offset + shown.length, has_more: offset + shown.length < all.length });
        let result = page();
        while (result.content[0].text!.length > ctx.policy.maxOutputChars && shown.length > 1) {
          shown.pop(); result = page();
        }
        if (result.content[0].text!.length > ctx.policy.maxOutputChars)
          throw new Error("本次工具输出上限无法容纳一个完整表格目录条目；请用 read_trace 读取目标消息");
        return result;
      }
      const request: TableCheckRequest = { answer_table_id: selectedTable(args.answer_table_index).table_id,
        sources: args.sources!.map(({ table_index, ...mapping }) => ({ ...mapping, table_id: selectedTable(table_index).table_id })) };
      const checked = compareTraceTableRows(raw, request, registeredInputId(ctx, args.candidate));
      if (offset > checked.rows.length) throw new Error("offset 超出回答表行范围");
      const evidence = (item: ReturnType<typeof cite>) => displayEvidence({ evidence_id: item.evidence_id,
        message_index: item.message_index, quote_preview: item.quote.slice(0, 600), has_more: item.quote.length > 600 });
      const answerColumns = [...request.sources[0].key_columns, ...request.sources[0].value_columns];
      const sourceSpecs = new Map(request.sources.map((source) => [source.table_id, source]));
      const shown = checked.rows.slice(offset, offset + 30).map((row) => row.status === "matched"
        ? { row_index: row.row_index, status: row.status }
        : { row_index: row.row_index, status: row.status,
          answer: { cells: answerColumns.map((column) => ({ column: column.answer, value: row.answer.cells[column.answer] })),
            evidence: evidence(row.answer.evidence) },
          sources: row.sources.map((source) => {
            const mapping = sourceSpecs.get(source.table_id)!;
            return { table_index: tableIndices.get(source.table_id)!, row_index: source.row_index, matched_by: source.matched_by,
              cells: [...mapping.key_columns, ...mapping.value_columns].map((column) => ({ column: column.source,
                value: source.cells[column.source] })), evidence: evidence(source.evidence) };
          }),
        });
      const page = () => textResult({ answer_table_index: args.answer_table_index, summary: checked.summary,
        rows: shown, total: checked.rows.length, offset, next_offset: offset + shown.length,
        has_more: offset + shown.length < checked.rows.length });
      let result = page();
      while (result.content[0].text!.length > ctx.policy.maxOutputChars && shown.length > 1) {
        shown.pop(); result = page();
      }
      if (result.content[0].text!.length > ctx.policy.maxOutputChars)
        throw new Error("本次工具输出上限无法容纳一行完整核验结果；请用 read_trace 读取两侧原文");
      const entry = { candidate: args.candidate, ...request };
      if (!(ctx.audit.tableChecks ?? []).some((check) => canonical(check) === canonical(entry)))
        (ctx.audit.tableChecks ??= []).push(structuredClone(entry));
      return result;
    },
  },
  {
    name: "read_trace",
    inputSchema: schema(
      {
        candidate: str,
        message_index: index,
        path: { type: "string" },
        offset: index,
        max_chars: { type: "integer", minimum: 1, maximum: 16000 },
        source_offset: index,
      },
      ["candidate", "message_index"],
    ),
    async execute(ctx, value) {
      const args = value as {
        candidate: string;
        message_index: number;
        path?: string;
        offset?: number;
        max_chars?: number;
        source_offset?: number;
      };
      const sources = evidenceSources(message(ctx, args.candidate, args.message_index));
      const path = args.path || undefined;
      const selected = selectEvidenceSource(sources, path);
      if (!selected) throw new Error("路径不存在；先省略 path 读取该消息，再选择真实字段路径");
      const { source, start, end: selectionEnd } = selected;
      const totalChars = selectionEnd - start;
      if (path !== undefined && (args.source_offset ?? 0) > 0) throw new Error("非零 source_offset 仅用于整条消息的文本路径目录，读取具体路径时使用正文 offset");
      const offset = args.offset ?? 0;
      if (offset > totalChars) throw new Error(`offset 超出当前来源长度 ${totalChars}，请使用上次返回的 next_offset`);
      const paths = sources.filter((item) => item.kind === "text");
      const sourceOffset = args.source_offset ?? 0;
      if (sourceOffset > paths.length) throw new Error("source_offset 超出文本路径目录范围");
      const showDirectory = path === undefined;
      const shownPaths = showDirectory ? paths.slice(sourceOffset, sourceOffset + 16).map((item) => ({ path: item.path, chars: item.text.length })) : [];
      const page = (end: number) => {
        const evidence = cite(registeredInputId(ctx, args.candidate), args.message_index, source, start + offset, start + end);
        const quotable = !!evidence.quote && !overlapsImagePlaceholder(source.text, start + offset, start + end);
        return {
          source: { kind: source.kind, path: source.path },
          ...(path !== undefined ? { selection_path: path } : {}),
          evidence: quotable ? [displayEvidence(evidence)] : [],
          // Text is shown once, paired with its ID; image placeholders have no evidence ID.
          ...(!quotable ? { text: evidence.quote } : {}),
          offset, next_offset: end, total_chars: totalChars, has_more: end < totalChars,
          ...(showDirectory ? { text_sources: shownPaths, text_sources_total: paths.length,
            text_sources_next_offset: sourceOffset + shownPaths.length,
            text_sources_has_more: sourceOffset + shownPaths.length < paths.length } : {}),
        };
      };
      let fitted;
      for (;;) {
        try {
          fitted = fitStringPage({ totalChars, offset, maxChars: args.max_chars ?? 16000,
            maxOutputChars: ctx.policy.maxOutputChars, build: page });
          break;
        } catch (error) {
          if (!(error instanceof RangeError) || shownPaths.length <= 1) throw error;
          shownPaths.pop();
        }
      }
      const end = fitted.end, result = textResult(fitted.value);
      if (end > offset) ctx.audit.traceReads.push({
        candidate: args.candidate, message_index: args.message_index,
        kind: source.kind, path: source.path, start: start + offset, end: start + end,
      });
      return result;
    },
  },
  {
    name: "search_trace",
    inputSchema: schema(
      {
        candidate: str,
        query: { type: "string", minLength: 1, maxLength: 500 },
        scope: { enum: ["all", "tool_returns"] },
        offset: index,
      },
      ["candidate", "query"],
    ),
    async execute(ctx, value) {
      const args = value as {
        candidate: string;
        query: string;
        scope?: "all" | "tool_returns";
        offset?: number;
      };
      const offset = args.offset ?? 0;
      const matches: { path: string; evidence: ReturnType<typeof cite>; read: TraceRead }[] = [];
      let total = 0;
      const messages = record(ctx, args.candidate).messages.map((message, index) => ({ message, index }));
      const selected = args.scope === "tool_returns" ? messages.filter(({ message }) => {
        const value = object(message);
        return value.role === "tool" || ["function_call_output", "tool_result"].includes(String(value.type));
      }).reverse() : messages;
      selected.forEach(({ message: m, index: i }) => {
        for (const source of evidenceSources(m)) {
          const { path: location, text } = source;
          let start = 0,
            position: number;
          while ((position = text.indexOf(args.query, start)) >= 0) {
            const evidence = cite(
              registeredInputId(ctx, args.candidate), i,
              source,
              Math.max(0, position - 100),
              Math.min(text.length, position + args.query.length + 200),
            );
            if (!overlapsImagePlaceholder(text, Math.max(0, position - 100), Math.min(text.length, position + args.query.length + 200))) {
              if (total >= offset && matches.length < 20) matches.push({ path: location, evidence, read: {
              candidate: args.candidate, message_index: i, kind: source.kind, path: source.path,
              start: Math.max(0, position - 100), end: Math.min(text.length, position + args.query.length + 200),
              } });
              total++;
            }
            start = position + args.query.length;
          }
        }
      });
      if (offset > total) throw new Error("offset 超出检索结果范围");
      const shown = matches;
      const page = () => textResult({
        matches: shown.map(({ path, evidence }) => ({ path, evidence: displayEvidence(evidence),
          read_request: { candidate: args.candidate, message_index: evidence.message_index, path } })),
        total,
        next_offset: offset + shown.length,
        has_more: offset + shown.length < total,
      });
      let result = page();
      while (result.content[0]!.text!.length > ctx.policy.maxOutputChars && shown.length > 1) {
        shown.pop();
        result = page();
      }
      if (result.content[0]!.text!.length > ctx.policy.maxOutputChars)
        throw new Error("本次工具输出上限无法容纳一条完整检索证据；请用 read_trace 读取已定位的消息");
      ctx.audit.traceReads.push(...shown.map((match) => match.read));
      return result;
    },
  },
  {
    name: "view_image",
    inputSchema: schema({ candidate: str, message_index: index }),
    async execute(ctx, value) {
      const args = value as { candidate: string; message_index: number };
      const content = images(message(ctx, args.candidate, args.message_index));
      if (!content.length) throw new Error("该消息没有可读取的内嵌图片");
      const id = `${args.candidate}:${args.message_index}`;
      const reference = evidenceId(registeredInputId(ctx, args.candidate), args.message_index, "image");
      // The top-level image_observations.image_number is a position in this task's evidence
      // directory, not the ordinal of the image in the answer; show it so the model copies it.
      const imageNumber = (ctx.audit.evidenceBank ?? []).indexOf(reference) + 1;
      const metadata = JSON.stringify({
        message: `原始消息 ${id}，${content.length} 张图片`,
        reference: { evidence_id: reference },
        ...(imageNumber > 0 ? { image_number: imageNumber } : {}),
      });
      if (metadata.length > ctx.policy.maxOutputChars)
        throw new Error("本次工具输出上限无法容纳图片元数据，未成功查看图片");
      if (!ctx.audit.viewedImages.includes(id)) ctx.audit.viewedImages.push(id);
      return {
        content: [
          {
            type: "text",
            text: metadata,
          },
          ...content,
        ],
      };
    },
  },
  {
    name: "calculate",
    inputSchema: {
      ...calculationSchema,
      properties: {
        ...(calculationSchema.properties as JsonSchema),
        candidate: str,
      },
      required: ["operation", "operands"],
    },
    async execute(ctx, value) {
      const args = value as {
        candidate?: string;
        operation: string;
        operands: string[];
      };
      const result = {
        candidate: args.candidate,
        ...object(calculate(args.operation, args.operands)),
      };
      ctx.audit.calculations.push(result);
      return textResult(result);
    },
  },
  {
    name: "calculate_pair",
    inputSchema: schema({ A: calculationSchema, B: calculationSchema }),
    async execute(ctx, value) {
      const args = value as Record<string, { operation: string; operands: string[] }>;
      const results = Object.entries(args).map(([candidate, v]) => ({
        candidate,
        ...object(calculate(v.operation, v.operands)),
      }));
      ctx.audit.calculations.push(...results);
      return textResult(results);
    },
  },
  {
    name: "execute_code",
    fileWriter: true,
    inputSchema: schema(
      {
        language: { enum: ["python", "shell"] },
        code: { type: "string", minLength: 1, maxLength: 200000 },
        timeout_seconds: { type: "integer", minimum: 1 },
        outputs: { type: "array", items: str, maxItems: 20 },
      },
      ["language", "code"],
    ),
    execute: executeCode,
  },
  {
    name: "read_artifact",
    inputSchema: schema(
      {
        id: str,
        offset: index,
        max_chars: { type: "integer", minimum: 1, maximum: 16000 },
      },
      ["id"],
    ),
    async execute(ctx, value) {
      const args = value as { id: string; offset?: number; max_chars?: number };
      const artifact = ctx.audit.artifacts.find((a) => a.id === args.id);
      if (!artifact) throw new Error("产物不属于本次任务");
      const bytes = await ctx.artifacts.get(args.id),
        extension = path.extname(artifact.name).toLowerCase();
      if ([".png", ".jpg", ".jpeg", ".webp"].includes(extension))
        return {
          content: [
            {
              type: "image",
              mimeType: `image/${extension === ".jpg" ? "jpeg" : extension.slice(1)}`,
              data: Buffer.from(bytes).toString("base64"),
            },
          ],
        };
      const text = Buffer.from(bytes).toString("utf8"),
        offset = args.offset ?? 0;
      const page = fitStringPage({ totalChars: text.length, offset, maxChars: args.max_chars ?? 16000,
        maxOutputChars: ctx.policy.maxOutputChars, build: (end) => ({
          text: text.slice(offset, end), offset, total_chars: text.length,
          next_offset: end, has_more: end < text.length,
        }) });
      return textResult(page.value);
    },
  },
];

export class ToolRegistry {
  private readonly tools = new Map<string, ExecutableTool>();
  register(tool: ExecutableTool): this {
    if (
      !/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(tool.name) ||
      ["submit_evaluation", "submit_evaluation_file"].includes(tool.name) ||
      this.tools.has(tool.name)
    )
      throw new Error(`Invalid or duplicate tool ${tool.name}`);
    this.tools.set(tool.name, tool);
    return this;
  }
  names(): string[] {
    return [...this.tools.keys()];
  }
  select(names: string[]): ExecutableTool[] {
    return names.map((name) => {
      const tool = this.tools.get(name);
      if (!tool) throw new Error(`Tool unavailable: ${name}`);
      return tool;
    });
  }
}
export function createRegistry(extra: ExecutableTool[] = []): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of [...builtinTools, ...extra]) registry.register(tool);
  return registry;
}
export class ToolRuntime {
  readonly context: ToolContext;
  private readonly definitions: Map<string, ExecutableTool>;
  private readonly validators;
  private readonly reads = new Map<string, ToolResult>();
  private readonly required: RequiredReadBudget;
  private readonly budgetMetadataChars: number;
  private readonly writerNames: string[];
  private draftWriteCalls = 0;
  private draftWriteRemaining = 0;
  constructor(context: ToolContext, tools: ExecutableTool[]) {
    if (context.inputIds.size !== context.inputs.size || [...context.inputs.keys()].some(key => !context.inputIds.has(key)) ||
      new Set(context.inputIds.values()).size !== context.inputIds.size) throw new RangeError("Tool sources require distinct registered input UUIDs");
    context.audit.evidenceBank ??= [];
    validateEvidenceBank(context.audit.evidenceBank);
    this.context = context;
    this.budgetMetadataChars = toolBudgetMetadataChars(tools.map(tool => tool.name));
    this.writerNames = tools.filter(tool => tool.fileWriter === true).map(tool => tool.name);
    this.required = new RequiredReadBudget(context.inputs, context.inputIds, context.requiredReads ?? [], context.policy.maxOutputChars, this.budgetMetadataChars);
    this.definitions = new Map(tools.map((t) => [t.name, t]));
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    this.validators = new Map(tools.map((t) => [t.name, ajv.compile(t.inputSchema)]));
  }
  /** Reserve one nonaccumulating writer call; failed writes still count toward the total cap. */
  reserveDraftWrite(): void {
    this.draftWriteRemaining = this.writerNames.length > 0 && this.draftWriteCalls < 1 + this.context.policy.repairAttempts ? 1 : 0;
  }
  clearDraftWrite(): void {
    this.draftWriteRemaining = 0;
  }
  budget(maxCalls = this.context.policy.maxToolCalls) {
    const used = this.context.audit.calls - this.context.audit.requiredReadCalls - this.draftWriteCalls;
    return {
      exploration: { used, remaining: Math.max(0, maxCalls - used) },
      required_reads: { used: this.required.used, remaining: this.required.remaining,
        covered: this.required.covered(this.context.audit) },
      draft_writes: { used: this.draftWriteCalls, remaining: this.draftWriteRemaining, tools: this.writerNames },
    };
  }
  withBudget(result: ToolResult, maxCalls = this.context.policy.maxToolCalls): ToolResult {
    const details = result.details && typeof result.details === "object" ? result.details as Record<string, unknown> : {};
    const previous = details.budget, content = [...result.content];
    if (previous && content.at(-1)?.text === JSON.stringify({ budget: previous })) content.pop();
    const budget = { ...(previous && typeof previous === "object" ? previous : {}), ...this.budget(maxCalls) };
    return { ...result, details: { ...details, budget },
      content: [...content, { type: "text", text: JSON.stringify({ budget }) }] };
  }
  /** Paginate large delegated tool responses without charging an exploration call. */
  async present(result: ToolResult, outputChars = Math.max(1, this.context.policy.maxOutputChars - this.budgetMetadataChars)): Promise<ToolResult> {
      const text = result.content
        .filter((c) => c.type === "text")
        .map((c) => c.text || "")
        .join("\n");
      if (text.length > outputChars) {
        const artifact = await this.context.artifacts.put("delegated-result.json", canonical(result));
        this.context.audit.artifacts.push(artifact);
        const page = fitStringPage({ totalChars: text.length, maxChars: text.length,
          maxOutputChars: outputChars, build: (end) => ({ preview: text.slice(0, end), artifact, truncated: true }) });
        result.content = [
          { type: "text", text: page.serialized },
          ...result.content.filter((c) => c.type !== "text"),
        ];
        result.details = { artifact, truncated: true };
      }
    return result;
  }
  private evidenceQueue: Promise<void> = Promise.resolve();
  execute(name: string, args: unknown, signal: AbortSignal, maxCalls = this.context.policy.maxToolCalls): Promise<ToolResult> {
    if (!["read_trace", "search_trace", "view_image", "check_table", "inspect_material"].includes(name))
      return this.executeOne(name, args, signal, maxCalls);
    // Revealing new directories and registering tool choices share one task-local order.
    const pending = this.evidenceQueue.then(() => this.executeOne(name, args, signal, maxCalls));
    this.evidenceQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }
  /** Charge a registered call before execution; absent SDK arguments never qualify for mandatory reads. */
  chargeCall(name: string, maxCalls = this.context.policy.maxToolCalls, args?: unknown) {
    const tool = this.definitions.get(name), validate = this.validators.get(name);
    if (!tool || !validate) throw new Error("Unknown tool");
    const valid = validate(args);
    const mandatory = args !== undefined && valid && name === "read_trace" && this.required.isRequired(args, this.context.audit);
    const exhausted = this.budget(maxCalls).exploration.remaining === 0;
    const draftWrite = exhausted && !mandatory && tool.fileWriter === true && this.draftWriteRemaining > 0;
    if (exhausted && !mandatory && !draftWrite)
      throw new Error(this.required.covered(this.context.audit)
        ? "探索工具预算已耗尽；必读正文已覆盖。可使用剩余写稿额度准备当前阶段 JSON，并调用当前内容工具；内容提交不占探索或写稿工具额度"
        : "探索工具预算已耗尽；尚未读取的必读正文仍可按 next_offset 继续读取。可使用剩余写稿额度准备当前阶段 JSON，并调用当前内容工具；内容提交不占探索或写稿工具额度");
    if (draftWrite) {
      this.draftWriteRemaining--;
      this.draftWriteCalls++;
    }
    this.context.audit.calls++;
    return { tool, validate, valid, mandatory, draftWrite };
  }
  private async executeOne(
    name: string,
    args: unknown,
    signal: AbortSignal,
    maxCalls = this.context.policy.maxToolCalls,
  ): Promise<ToolResult> {
    let draftWrite = false;
    try {
      signal.throwIfAborted();
      const charged = this.chargeCall(name, maxCalls, args);
      draftWrite = charged.draftWrite;
      const { tool, validate, valid, mandatory } = charged;
      if (!valid) throw new ValidationError(schemaIssues(validate.errors, args));
      const cacheable = ["read_trace", "search_trace", "read_artifact"].includes(name),
        key = canonical([name, args]);
      const cached = this.reads.get(key);
      const before = { traceReads: [...this.context.audit.traceReads] };
      // Keep the cached data independent of the live invocation budget. All tools
      // receive the same reserved space, including pages loaded from artifacts.
      const outputChars = Math.max(1, this.context.policy.maxOutputChars - this.budgetMetadataChars);
      const result = cacheable && cached ? structuredClone(cached) : await tool.execute({
        ...this.context, policy: { ...this.context.policy, maxOutputChars: outputChars },
      }, args, signal);
      if (mandatory && !cached && !result.isError) {
        const returned = this.context.audit.traceReads.at(-1);
        if (returned && this.required.charge(args, returned, before)) this.context.audit.requiredReadCalls++;
      }
      // Register only the committed page after pagination; source text is carried as strings.
      // Delegated tools and arbitrary artifacts are excluded because their objects are not generated evidence envelopes.
      if (!result.isError && ["read_trace", "search_trace", "view_image", "check_table"].includes(name)) {
        const bank = this.context.audit.evidenceBank!;
        for (const content of result.content) if (content.type === "text" && content.text)
          content.text = JSON.stringify(projectEvidenceReferences(JSON.parse(content.text), bank));
        if (result.details !== undefined) result.details = projectEvidenceReferences(result.details, bank);
        await this.context.persistEvidenceBank?.([...bank]);
      }
      if (!result.isError && ["read_trace", "search_trace", "view_image", "check_table"].includes(name)) {
        const candidate = (args as { candidate?: string }).candidate;
        const presentation = candidate && this.context.sourcePresentations?.get(candidate);
        if (presentation) {
          for (const content of result.content) if (content.type === "text" && content.text)
            content.text = JSON.stringify(presentSource(JSON.parse(content.text), presentation));
          if (result.details !== undefined) result.details = presentSource(result.details, presentation);
        }
      }
      await this.present(result, outputChars);
      if (cacheable && !result.isError) this.reads.set(key, structuredClone(result));
      if (draftWrite && result.isError) this.reserveDraftWrite();
      return this.withBudget(result, maxCalls);
    } catch (error) {
      if (draftWrite) this.reserveDraftWrite();
      const errors =
        error instanceof ValidationError
          ? error.issues
          : [
              {
                code: signal.aborted ? "tool_interrupted" : "tool_failed",
                path: "/",
                category: signal.aborted ? "interruption" : "file",
                expected: null,
                actual: (error as NodeJS.ErrnoException).code || null,
                message: errorText(error),
              },
            ];
      return this.withBudget({
        ...textResult({ errors, message: errorText(error) }),
        isError: true,
      }, maxCalls);
    }
  }
}

export * from "./evidence.js";
export * from "./evidence-coverage.js";
export * from "./instructions.js";
export * from "./validation.js";
export * from "./trace-audit.js";
export * from "./table-correspondence.js";
export * from "./citation-markup.js";
export * from "./serper.js";
export * from "./web-reader.js";
export { calculate } from "./decimal.js";
export * from "./source-blocks.js";

export * from "./trace-identity.js";
