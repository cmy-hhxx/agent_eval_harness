import { spawn } from "node:child_process";
import { mkdir, open, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
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
import { countNavigationPage, readExecutionTool, readResponsibilityChainTool } from "./execution-navigation.js";
import { RequiredReadBudget } from "./required-reading.js";
import { traceReadCoverage } from "./trace-audit.js";
import { reviewTools,scoreTools } from "./review.js";

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
const presentedAudit = (ctx: ToolContext) => ({ traceReads: [...(ctx.presentedReads ?? []), ...ctx.audit.traceReads] });
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
function tracePathHint(sources: ReturnType<typeof evidenceSources>) {
  const paths = sources.filter(source => source.kind === "text"), shown = paths.slice(0, 8)
    .map(source => ({ path: source.path, chars: source.text.length }));
  while (JSON.stringify(shown).length > 1200) shown.pop();
  return `路径不存在；可用文本路径 ${JSON.stringify(shown)}（共${paths.length}条）。直接按真实路径补读所缺范围，已读内容复用原证据；只在目录未包含目标时读取父路径或根目录。`;
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
  const outputArtifacts = [], diagnosticArtifacts = [];
  for (const [name, file] of [
    ["script", script],
    ["stdout", outPath],
    ["stderr", errPath],
  ]) {
    const size = (await stat(file)).size;
    if (size > 64 * 1024 * 1024) throw new Error("代码输出超过 64 MiB；请在脚本中生成精简结果");
    const artifact = await ctx.artifacts.put(`${id}.${name}`, await readFile(file));
    ctx.audit.artifacts.push(artifact);
    diagnosticArtifacts.push(artifact);
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
  const out = await readFile(outPath, "utf8"), err = await readFile(errPath, "utf8");
  // Complete logs are already visible below. Only truncated logs need a separate read entry.
  outputArtifacts.push(...diagnosticArtifacts.filter(artifact =>
    artifact.name.endsWith(".stdout") && out.length > ctx.policy.maxOutputChars ||
    artifact.name.endsWith(".stderr") && err.length > ctx.policy.maxOutputChars));
  return { ...textResult({
    exit_code: exitCode,
    timed_out: timedOut,
    cancelled: signal.aborted,
    duration_seconds: (Date.now() - started) / 1000,
    stdout: out.slice(0, ctx.policy.maxOutputChars),
    stderr: err.slice(0, ctx.policy.maxOutputChars),
    artifacts: outputArtifacts,
    ...(errors.length ? { errors } : {}),
  }), ...(exitCode !== 0 || timedOut || signal.aborted || errors.length > 0 ? { isError: true } : {}) };
}
export type ExecutableTool = Omit<ToolDefinition, "description">;

export const builtinTools: ExecutableTool[] = [
  readExecutionTool,
  readResponsibilityChainTool,
  ...reviewTools,
  ...scoreTools,
  {
    name: "edit_json",
    fileWriter: true,
    inputSchema: schema({ path: str, set_json: str, append_json: str,
      remove_fields: { type: "array", items: str } }, ["path"]),
    async execute(ctx, value) {
      const args = value as { path: string; set_json?: string; append_json?: string; remove_fields?: string[] };
      if (path.basename(args.path) !== args.path || !args.path.endsWith(".json"))
        throw new Error("JSON 草稿使用工作目录内的单个文件名，不含目录");
      const workspace = await realpath(ctx.workdir), file = path.join(workspace, args.path);
      const decode = (text: string) => {
        const result = JSON.parse(text);
        if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("JSON 草稿和字段更新必须为对象");
        return result as Record<string, unknown>;
      };
      let draft: Record<string, unknown> = {};
      try {
        if (await realpath(file) !== file) throw new Error("JSON 草稿不能使用符号链接");
        draft = decode(await readFile(file, "utf8"));
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const set = decode(args.set_json ?? "{}"), append = decode(args.append_json ?? "{}");
      draft = { ...draft, ...set };
      for (const [key, rows] of Object.entries(append)) {
        const prior = Object.hasOwn(draft, key) ? draft[key] : [];
        if (!Array.isArray(rows) || !Array.isArray(prior)) throw new Error(`append_json 的 ${key} 与原字段均须为数组`);
        draft = { ...draft, [key]: [...prior, ...rows] };
      }
      for (const key of args.remove_fields ?? []) delete draft[key];
      // Validate all edits before replacing the file; a malformed edit leaves the prior draft intact.
      const temp = path.join(workspace, `${randomUUID()}.tmp`);
      await writeFile(temp, JSON.stringify(draft, null, 2));
      await rename(temp, file);
      return textResult({ path: args.path, updated_fields: [...new Set([...Object.keys(set), ...Object.keys(append)])],
        removed_fields: args.remove_fields ?? [],
        array_lengths: Object.fromEntries(Object.entries(draft).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, (value as unknown[]).length])) });
    },
  },
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
      const responsibilityChoices = (object(ctx.materialNavigation?.[args.candidate] ?? {}).responsibility_choices as {message_index:number}[] | undefined)
        ?.filter(choice=>choice.message_index===args.message_index);
      const sources = evidenceSources(message(ctx, args.candidate, args.message_index));
      const path = args.path;
      const selected = selectEvidenceSource(sources, path);
      if (!selected) throw new Error(tracePathHint(sources));
      const { source, start, end: selectionEnd } = selected;
      // A fully displayed serialized leaf also covers its decoded text. Partial JSON
      // and equal values at other paths do not establish that physical coverage.
      const requiredSource = ctx.requiredReads?.some(read => read.candidate === args.candidate &&
        read.message_index === args.message_index && read.kind === source.kind && read.path === source.path);
      const jsonLeaf = source.kind === "text" && !requiredSource
        ? selectEvidenceSource(sources.filter(item => item.kind === "json"), source.path) : undefined;
      const readInJson = jsonLeaf && traceReadCoverage(presentedAudit(ctx), { candidate: args.candidate, message_index: args.message_index,
        kind: "json", path: jsonLeaf.source.path, start: jsonLeaf.start, end: jsonLeaf.end }).covered;
      const totalChars = selectionEnd - start;
      if (path !== undefined && (args.source_offset ?? 0) > 0) throw new Error("非零 source_offset 仅用于整条消息的文本路径目录，读取具体路径时使用正文 offset");
      const offset = args.offset ?? 0;
      if (offset > totalChars) throw new Error(`offset 超出当前来源长度 ${totalChars}，请使用上次返回的 next_offset`);
      const paths = sources.filter((item) => item.kind === "text" && item.quotable !== false);
      const sourceOffset = args.source_offset ?? 0;
      if (sourceOffset > paths.length) throw new Error("source_offset 超出文本路径目录范围");
      const showDirectory = path === undefined || source.quotable === false;
      const shownPaths = showDirectory ? paths.slice(sourceOffset, sourceOffset + 16).map((item) => ({ path: item.path, chars: item.text.length })) : [];
      const coverage = (end: number) => readInJson ? { covered: true, missing: [] } : traceReadCoverage(requiredSource ? ctx.audit : presentedAudit(ctx), {
        candidate: args.candidate, message_index: args.message_index, kind: source.kind, path: source.path,
        start: start + offset, end: start + end,
      });
      // A deliberately bounded reread is a context check; do not remove its conditions
      // just because the same characters appeared in separate earlier responses.
      const wholeContext = path !== undefined && args.max_chars !== undefined && args.max_chars <= 1800;
      const page = (end: number) => {
        const evidence = cite(registeredInputId(ctx, args.candidate), args.message_index, source, start + offset, start + end);
        const quotable = source.quotable !== false && !!evidence.quote && !overlapsImagePlaceholder(source.text, start + offset, start + end);
        const { covered, missing } = coverage(end);
        const alreadyRead = quotable && covered;
        const reused: { start: number; end: number }[] = [];
        let cursor = start + offset;
        for (const gap of missing) {
          if (gap.start > cursor) reused.push({ start: cursor, end: gap.start });
          cursor = gap.end;
        }
        if (cursor < start + end) reused.push({ start: cursor, end: start + end });
        const { quote, ...coordinates } = evidence;
        return {
          source: { kind: source.kind, path: source.path },
          ...(responsibilityChoices?.length ? { responsibility_choices: responsibilityChoices } : {}),
          ...(path !== undefined ? { selection_path: path } : {}),
          ...(alreadyRead ? { already_read: true } : {}),
          evidence: !quotable ? [] : wholeContext ? [displayEvidence(evidence)] : alreadyRead ? [displayEvidence(quote.length > 400
            ? { ...coordinates, quote_preview: quote.slice(0, 200) } : evidence)] : missing.map(range =>
              displayEvidence(cite(registeredInputId(ctx, args.candidate), args.message_index, source, range.start, range.end))),
          ...(quotable && !wholeContext && !alreadyRead && reused.length ? { reused_evidence: reused.map(range => {
            const { quote: _quote, ...reference } = cite(registeredInputId(ctx, args.candidate), args.message_index, source, range.start, range.end);
            return { ...displayEvidence(reference), offset: range.start - start, end_offset: range.end - start };
          }) } : {}),
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
      if (end > offset && !fitted.value.already_read) ctx.audit.traceReads.push(...coverage(end).missing.map(range => ({
        candidate: args.candidate, message_index: args.message_index,
        kind: source.kind, path: source.path, ...range,
      })));
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
        message_index: { type: ["integer", "null"], minimum: 0 },
        path: { type: "string" },
        offset: index,
      },
      ["candidate", "query"],
    ),
    async execute(ctx, value) {
      const args = value as {
        candidate: string;
        query: string;
        scope?: "all" | "tool_returns";
        message_index?: number | null;
        path?: string;
        offset?: number;
      };
      const offset = args.offset ?? 0;
      type Excerpt = { path: string; evidence: ReturnType<typeof cite>; read: TraceRead };
      const matches: (Excerpt & { context: Excerpt[]; has_more: boolean })[] = [];
      let total = 0;
      if (args.message_index != null) message(ctx, args.candidate, args.message_index);
      const messages = record(ctx, args.candidate).messages.map((message, index) => ({ message, index }))
        .filter(item => args.message_index == null || item.index === args.message_index);
      const selected = args.scope === "tool_returns" ? messages.filter(({ message }) => {
        const value = object(message);
        return value.role === "tool" || ["function_call_output", "tool_result"].includes(String(value.type));
      }).reverse() : messages;
      selected.forEach(({ message: m, index: i }) => {
        const sources = evidenceSources(m);
        const range = args.path === undefined ? undefined : selectEvidenceSource(sources, args.path);
        if (args.path !== undefined && !range) {
          if (args.message_index != null) throw new Error(tracePathHint(sources));
          return;
        }
        // A text match has a precise leaf location; suppress only its serialized
        // value, preserving distinct JSON key/numeric matches in the same message.
        const leaves = sources.filter(source => source.kind === "text" &&
          (args.path === undefined || args.path === "" || source.path === args.path || source.path.startsWith(`${args.path}/`)) &&
          source.text.includes(args.query));
        const jsonSources = sources.filter(source => source.kind === "json");
        const mirrors = range?.source.kind === "text" ? [] : leaves.flatMap(leaf => {
          const location = selectEvidenceSource(jsonSources, leaf.path);
          return location ? [{ start: location.end - JSON.stringify(leaf.text).length, end: location.end }] : [];
        });
        const searchable = range?.source.kind === "text" ? [range.source] : [...leaves, ...(range ? [range.source] : jsonSources)];
        for (const source of searchable) {
          if (source.quotable === false) continue;
          const { path: location, text } = source;
          const from = range?.source === source ? range.start : 0, to = range?.source === source ? range.end : text.length;
          let start = from,
            position: number;
          while ((position = text.indexOf(args.query, start)) >= 0 && position + args.query.length <= to) {
            if (source.kind === "json" && mirrors.some(mirror => position >= mirror.start && position + args.query.length <= mirror.end)) {
              start = position + args.query.length;
              continue;
            }
            const evidence = cite(
              registeredInputId(ctx, args.candidate), i,
              source,
              Math.max(from, position - 100),
              Math.min(to, position + args.query.length + 200),
            );
            if (!overlapsImagePlaceholder(text, Math.max(from, position - 100), Math.min(to, position + args.query.length + 200))) {
              if (total >= offset && matches.length < 20) {
                // Short neighboring metadata and the source opening often carry
                // the object/date/unit needed to interpret a distant text hit.
                const context: Excerpt[] = [];
                let contextChars = 0;
                const addContext = (item: typeof source, start: number, end: number) => {
                  const read = { candidate: args.candidate, message_index: i, kind: item.kind, path: item.path, start, end };
                  if (context.length >= 4 || contextChars + end - start > 600 || end <= start ||
                    traceReadCoverage(presentedAudit(ctx), read).covered || overlapsImagePlaceholder(item.text, start, end)) return;
                  context.push({ path: item.path, evidence: cite(registeredInputId(ctx, args.candidate), i, item, start, end), read });
                  contextChars += end - start;
                };
                if (source.kind === "text") {
                  if (position - 100 > 200) addContext(source, 0, 200);
                  const parent = source.path.slice(0, source.path.lastIndexOf("/"));
                  for (const sibling of sources.filter(item => item.kind === "text" && item !== source && item.text.length <= 180 &&
                    item.path.slice(0, item.path.lastIndexOf("/")) === parent &&
                    !/\/(?:id|uid|uuid|ref|type|role|call_id|mimeType|mime_type|serial_number)$/u.test(item.path)))
                    addContext(sibling, 0, sibling.text.length);
                }
                matches.push({ path: location, evidence, context, has_more: position - 100 > from || position + args.query.length + 200 < to, read: {
                  candidate: args.candidate, message_index: i, kind: source.kind, path: source.path,
                  start: Math.max(from, position - 100), end: Math.min(to, position + args.query.length + 200),
                } });
              }
              total++;
            }
            start = position + args.query.length;
          }
        }
      });
      if (offset > total) throw new Error("offset 超出检索结果范围");
      const shown = matches;
      let contextReads: TraceRead[] = [];
      const page = () => {
        contextReads = [];
        const seen = new Set(shown.map(match => match.evidence.evidence_id));
        const coverage = presentedAudit(ctx);
        let newChars = 0;
        const count = (read: TraceRead) => {
          const missing = traceReadCoverage(coverage, read).missing;
          newChars += missing.reduce((sum, range) => sum + range.end - range.start, 0);
          coverage.traceReads.push(read);
          return missing.length === 0;
        };
        const displayed = shown.map(({ path, evidence, read, context, has_more }) => {
          const alreadyRead = count(read);
          return { path, evidence: displayEvidence(evidence), already_read: alreadyRead,
            context: context.filter(item => {
              if (seen.has(item.evidence.evidence_id)) return false;
              seen.add(item.evidence.evidence_id); contextReads.push(item.read); count(item.read); return true;
            }).map(item => ({ path: item.path, evidence: displayEvidence(item.evidence) })),
            ...(has_more && !alreadyRead ? { read_request: { candidate: args.candidate, message_index: evidence.message_index, path,
              offset: Math.max(0, read.start - 200), max_chars: 1800 } } : {}) };
        });
        return textResult({
          matches: displayed, new_source_chars: newChars,
          total, next_offset: offset + shown.length, has_more: offset + shown.length < total,
        });
      };
      let result = page();
      while (result.content[0]!.text!.length > ctx.policy.maxOutputChars) {
        const contextual = shown.findLast(match => match.context.length);
        if (contextual) contextual.context.pop();
        else if (shown.length > 1) shown.pop();
        else break;
        result = page();
      }
      if (result.content[0]!.text!.length > ctx.policy.maxOutputChars)
        throw new Error("本次工具输出上限无法容纳一条完整检索证据；请用 read_trace 读取已定位的消息");
      ctx.audit.traceReads.push(...shown.map((match) => match.read), ...contextReads);
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
  registerRequiredReads(reads: readonly import("@eval/contracts").TraceRead[]): void {
    this.required.register(reads);
  }
  budget(maxCalls = this.context.policy.maxToolCalls) {
    const used = this.context.audit.calls - this.context.audit.requiredReadCalls - this.draftWriteCalls;
    const withinLimit = this.context.draftWriteInCallLimit;
    const draftRemaining = withinLimit ? Math.min(this.draftWriteRemaining, Math.max(0, maxCalls - used - this.draftWriteCalls)) : this.draftWriteRemaining;
    const explorationLimit = withinLimit ? maxCalls - this.draftWriteCalls - draftRemaining : maxCalls;
    return {
      exploration: { used, remaining: Math.max(0, explorationLimit - used) },
      required_reads: { used: this.required.used, remaining: this.required.remaining,
        covered: this.required.covered(this.context.audit) },
      draft_writes: { used: this.draftWriteCalls, remaining: draftRemaining, tools: this.writerNames },
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
  private persistQueue: Promise<void> = Promise.resolve();
  execute(name: string, args: unknown, signal: AbortSignal, maxCalls = this.context.policy.maxToolCalls): Promise<ToolResult> {
    if (!["inspect_material", "edit_json"].includes(name))
      return this.executeOne(name, args, signal, maxCalls);
    // Material inspection and incremental file edits share one task-local order;
    // read-only evidence tools may overlap and only serialize their bank persistence.
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
    const budget = this.budget(maxCalls), exhausted = budget.exploration.remaining === 0;
    if (exhausted && budget.draft_writes.remaining > 0 && name === "execute_code" && args !== undefined && valid) {
      const outputs = (args as { outputs?: string[] }).outputs;
      if (!outputs?.some(file => /\.json$/iu.test(file)))
        throw new ValidationError([{ category: "structure", code: "draft_output_required", path: "/outputs",
          message: "探索额度已耗尽，execute_code 仅可用于写稿，须在 outputs 声明待提交的 JSON 文件；只读提取或计算不能使用预留写稿额度。也可用 edit_json 保存草稿。" }]);
    }
    const draftWrite = exhausted && !mandatory && tool.fileWriter === true && budget.draft_writes.remaining > 0;
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
      const cacheable = name === "read_artifact",
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
        // Prior search hits can split a page into several new ranges; charge their span once.
        const returned = this.context.audit.traceReads.slice(before.traceReads.length);
        const first = returned[0], last = returned.at(-1);
        if (first && last && this.required.charge(args, { ...first, end: last.end }, before)) this.context.audit.requiredReadCalls++;
      }
      // Register only the committed page after pagination; source text is carried as strings.
      // Delegated tools and arbitrary artifacts are excluded because their objects are not generated evidence envelopes.
      if (!result.isError && ["read_execution", "read_responsibility_chain", "read_trace", "search_trace", "view_image", "check_table"].includes(name)) {
        const bank = this.context.audit.evidenceBank!;
        for (const content of result.content) if (content.type === "text" && content.text)
          content.text = JSON.stringify(projectEvidenceReferences(JSON.parse(content.text), bank));
        if (result.details !== undefined) result.details = projectEvidenceReferences(result.details, bank);
        const snapshot = [...bank], write = this.persistQueue.then(() => this.context.persistEvidenceBank?.(snapshot));
        this.persistQueue = write.then(() => undefined, () => undefined);
        await write;
      }
      if (!result.isError && ["read_execution", "read_responsibility_chain", "read_trace", "search_trace", "view_image", "check_table"].includes(name)) {
        const candidate = (args as { candidate?: string }).candidate;
        const presentation = candidate && this.context.sourcePresentations?.get(candidate);
        if (presentation) {
          for (const content of result.content) if (content.type === "text" && content.text)
            content.text = JSON.stringify(presentSource(JSON.parse(content.text), presentation));
          if (result.details !== undefined) result.details = presentSource(result.details, presentation);
        }
      }
      if (!result.isError && name === "read_execution") {
        const page = object(result.details);
        countNavigationPage(page);
        result.content = [{ type: "text", text: JSON.stringify(page) }];
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
export * from "./component-identity.js";
export * from "./trace-exchanges.js";
export * from "./validation.js";
export * from "./trace-audit.js";
export * from "./table-correspondence.js";
export * from "./citation-markup.js";
export * from "./serper.js";
export * from "./web-reader.js";
export { calculate, calculateExpression } from "./decimal.js";
export * from "./source-blocks.js";
export * from "./visual-capture.js";

export * from "./trace-identity.js";

export * from "./review.js";
