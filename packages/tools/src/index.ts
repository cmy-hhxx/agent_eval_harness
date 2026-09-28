import { spawn } from "node:child_process";
import { mkdir, open, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { JsonSchema, ToolContent, ToolContext, ToolDefinition, ToolResult } from "@eval/contracts";
import { fileURLToPath } from "node:url";
import { canonical, errorText, object, schemaIssues, ValidationError } from "@eval/contracts";

import { cite, evidenceId, evidenceSources, imagePlaceholder } from "./evidence.js";

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
function message(ctx: ToolContext, candidate: string, i: number): unknown {
  const value = record(ctx, candidate).messages[i];
  if (!value) throw new Error("消息索引不存在");
  return value;
}
export function images(value: unknown): ToolContent[] {
  if (typeof value === "string") {
    const match = /^data:(image\/[\w.+-]+);base64,([\s\S]+)$/.exec(value);
    return match ? [{ type: "image", mimeType: match[1], data: match[2] }] : [];
  }
  if (!value || typeof value !== "object") return [];
  const node = value as Record<string, unknown>;
  if (node.type === "image" && typeof node.data === "string" && (node.mimeType || node.mime_type))
    return [
      {
        type: "image",
        data: node.data,
        mimeType: String(node.mimeType || node.mime_type),
      },
    ];
  return Object.values(node).flatMap(images);
}
export function calculate(operation: string, operands: string[]): unknown {
  if (
    operands.length < 2 ||
    operands.length > 20 ||
    operands.some((v) => !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(v))
  )
    throw new Error("需要 2—20 个十进制数值字符串");
  const numbers = operands.map(Number);
  if (!numbers.every(Number.isFinite)) throw new Error("数值超出范围");
  const result = numbers.slice(1).reduce((a, b) => {
    if (operation === "add") return a + b;
    if (operation === "subtract") return a - b;
    if (operation === "multiply") return a * b;
    if (operation === "divide" && b !== 0) return a / b;
    throw new Error("不支持的运算或除数为零");
  }, numbers[0]);
  if (!Number.isFinite(result)) throw new Error("计算结果溢出");
  return {
    operation,
    operands,
    result: result.toPrecision(15),
    precision: "IEEE-754, 15 significant digits",
  };
}
const calculationSchema = schema({
  operation: { enum: ["add", "subtract", "multiply", "divide"] },
  operands: { type: "array", items: str, minItems: 2, maxItems: 20 },
});
async function executeCode(ctx: ToolContext, value: unknown, signal: AbortSignal): Promise<ToolResult> {
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
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
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
      proc.once("close", (code) => resolve(code));
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
  for (const name of args.outputs || []) {
    const file = await realpath(path.resolve(ctx.workdir, name));
    if (!file.startsWith(workspace + path.sep)) throw new Error("产物必须位于任务工作目录");
    if ((await stat(file)).size > 32 * 1024 * 1024) throw new Error("单个产物不能超过 32 MiB");
    const artifact = await ctx.artifacts.put(path.relative(workspace, file), await readFile(file));
    ctx.audit.artifacts.push(artifact);
    outputArtifacts.push(artifact);
  }
  const out = (await readFile(outPath, "utf8")).slice(0, ctx.policy.maxOutputChars),
    err = (await readFile(errPath, "utf8")).slice(0, ctx.policy.maxOutputChars);
  return textResult({
    exit_code: exitCode,
    timed_out: timedOut,
    cancelled: signal.aborted,
    duration_seconds: (Date.now() - started) / 1000,
    stdout: out,
    stderr: err,
    artifacts: outputArtifacts,
  });
}
export type ExecutableTool = Omit<ToolDefinition, "description">;

export const builtinTools: ExecutableTool[] = [
  {
    name: "read_trace",
    inputSchema: schema(
      {
        candidate: str,
        message_index: index,
        path: { type: "string" },
        offset: index,
        max_chars: { type: "integer", minimum: 1, maximum: 16000 },
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
      };
      const sources = evidenceSources(message(ctx, args.candidate, args.message_index));
      const source = args.path
        ? sources.find((item) => item.kind === "text" && item.path === args.path)
        : sources.find((item) => item.kind === "json");
      if (!source) throw new Error("文本路径不存在；先省略 path 读取该消息的 text_sources，再选择其中的路径");
      const offset = args.offset ?? 0;
      if (offset > source.text.length) throw new Error(`offset 超出当前来源长度 ${source.text.length}，请使用上次返回的 next_offset`);
      let end = Math.min(offset + (args.max_chars ?? 12000), source.text.length);
      const paths = sources.filter((item) => item.kind === "text");
      const shownPaths = source.kind === "json" ? paths.slice(0, 16).map((item) => ({ path: item.path, chars: item.text.length })) : [];
      const page = () => {
        const evidence = cite(args.message_index, source, offset, end);
        const quotable = !!evidence.quote && !evidence.quote.includes(imagePlaceholder);
        return textResult({
          source: { kind: source.kind, path: source.path },
          evidence: quotable ? [evidence] : [],
          // Text is shown once, paired with its ID; image placeholders have no evidence ID.
          ...(!quotable ? { text: evidence.quote } : {}),
          offset, next_offset: end, total_chars: source.text.length, has_more: end < source.text.length,
          ...(source.kind === "json" ? { text_sources: shownPaths, text_sources_has_more: shownPaths.length < paths.length } : {}),
        });
      };
      let result = page();
      // Fit the serialized response, including escaped quotes and metadata, before generic truncation.
      while (result.content[0]!.text!.length > ctx.policy.maxOutputChars && end - offset > 1) {
        end = offset + Math.max(1, Math.floor((end - offset) / 2));
        result = page();
      }
      while (result.content[0]!.text!.length > ctx.policy.maxOutputChars && shownPaths.length) {
        shownPaths.pop();
        result = page();
      }
      if (result.content[0]!.text!.length > ctx.policy.maxOutputChars)
        throw new Error("maxOutputChars 太小，无法完整返回一条证据；请增大工具输出预算");
      return result;
    },
  },
  {
    name: "search_trace",
    inputSchema: schema(
      {
        candidate: str,
        query: { type: "string", minLength: 1, maxLength: 500 },
        offset: index,
      },
      ["candidate", "query"],
    ),
    async execute(ctx, value) {
      const args = value as {
        candidate: string;
        query: string;
        offset?: number;
      };
      const matches: unknown[] = [];
      record(ctx, args.candidate).messages.forEach((m, i) => {
        for (const source of evidenceSources(m)) {
          const { path: location, text } = source;
          let start = 0,
            position: number;
          while ((position = text.indexOf(args.query, start)) >= 0) {
            const evidence = cite(
              i,
              source,
              Math.max(0, position - 100),
              Math.min(text.length, position + args.query.length + 200),
            );
            if (!evidence.quote.includes("[图像数据")) matches.push({ path: location, evidence });
            start = position + args.query.length;
            if (matches.length >= 10000) break;
          }
        }
      });
      const offset = args.offset || 0;
      const shown = matches.slice(offset, offset + 20);
      const page = () => textResult({
        matches: shown,
        total: matches.length,
        next_offset: offset + shown.length,
        has_more: offset + shown.length < matches.length,
      });
      let result = page();
      while (result.content[0]!.text!.length > ctx.policy.maxOutputChars && shown.length > 1) {
        shown.pop();
        result = page();
      }
      if (result.content[0]!.text!.length > ctx.policy.maxOutputChars)
        throw new Error("maxOutputChars 太小，无法完整返回一条检索证据；请增大工具输出预算");
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
      if (!ctx.audit.viewedImages.includes(id)) ctx.audit.viewedImages.push(id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              message: `原始消息 ${id}，${content.length} 张图片`,
              evidence_id: evidenceId(args.message_index, "image"),
            }),
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
        offset = args.offset || 0,
        length = args.max_chars || 12000;
      return textResult({
        text: text.slice(offset, offset + length),
        total_chars: text.length,
        next_offset: offset + length,
        has_more: offset + length < text.length,
      });
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
  constructor(context: ToolContext, tools: ExecutableTool[]) {
    this.context = context;
    this.definitions = new Map(tools.map((t) => [t.name, t]));
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    this.validators = new Map(tools.map((t) => [t.name, ajv.compile(t.inputSchema)]));
  }
  async execute(
    name: string,
    args: unknown,
    signal: AbortSignal,
    maxCalls = this.context.policy.maxToolCalls,
  ): Promise<ToolResult> {
    try {
      signal.throwIfAborted();
      const tool = this.definitions.get(name),
        validate = this.validators.get(name);
      if (!tool || !validate) throw new Error("Unknown tool");
      if (this.context.audit.calls >= maxCalls) throw new Error("探索工具预算已耗尽，请根据已有证据提交");
      this.context.audit.calls++;
      if (!validate(args)) throw new ValidationError(schemaIssues(validate.errors, args));
      const cacheable = ["read_trace", "search_trace", "read_artifact"].includes(name),
        key = canonical([name, args]);
      const cached = this.reads.get(key);
      if (cacheable && cached) return structuredClone(cached);
      const result = await tool.execute(this.context, args, signal);
      const text = result.content
        .filter((c) => c.type === "text")
        .map((c) => c.text || "")
        .join("\n");
      if (text.length > this.context.policy.maxOutputChars) {
        const artifact = await this.context.artifacts.put(`${name}-result.json`, canonical(result));
        this.context.audit.artifacts.push(artifact);
        result.content = [
          {
            type: "text",
            text:
              text.slice(0, this.context.policy.maxOutputChars) +
              `\n[完整工具结果见产物 ${artifact.id}，可用 read_artifact 分页读取]`,
          },
          ...result.content.filter((c) => c.type !== "text"),
        ];
        result.details = { artifact, truncated: true };
      }
      if (cacheable && !result.isError) this.reads.set(key, structuredClone(result));
      result.details = {
        ...(result.details && typeof result.details === "object" ? result.details : {}),
        budget: {
          used: this.context.audit.calls,
          remaining: Math.max(0, maxCalls - this.context.audit.calls),
        },
      };
      return result;
    } catch (error) {
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
      return {
        ...textResult({ errors, message: errorText(error) }),
        isError: true,
      };
    }
  }
}

export * from "./evidence.js";
export * from "./validation.js";
