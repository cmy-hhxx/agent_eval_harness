import { spawn } from "node:child_process";
import { mkdir, open, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { JsonSchema, ToolContent, ToolContext, ToolDefinition, ToolResult } from "@eval/contracts";
import { fileURLToPath } from "node:url";
import { canonical, errorText, object, schemaIssues, ValidationError } from "@eval/contracts";

import { cite, evidenceId, evidenceSources, renderMessage } from "./evidence.js";

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
function images(value: unknown): ToolContent[] {
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
export const builtinTools: ToolDefinition[] = [
  {
    name: "read_trace",
    description:
      "按原始消息索引读取材料；offset 按 UTF-16 字符计，支持分页，提交时使用返回证据中的 evidence_id。",
    inputSchema: schema(
      {
        candidate: str,
        message_index: index,
        offset: index,
        max_chars: { type: "integer", minimum: 1, maximum: 16000 },
      },
      ["candidate", "message_index"],
    ),
    async execute(ctx, value) {
      const args = value as {
        candidate: string;
        message_index: number;
        offset?: number;
        max_chars?: number;
      };
      const source = message(ctx, args.candidate, args.message_index),
        full = renderMessage(source),
        offset = args.offset || 0,
        length = args.max_chars || 12000;
      const text = full.slice(offset, offset + length);
      const inputId = ctx.inputIds?.get(args.candidate) || args.candidate;
      const citations = evidenceSources(source)
        .flatMap((source) => {
          if (source.kind === "json")
            return text.includes("[图像数据")
              ? []
              : [
                  cite(
                    inputId,
                    args.message_index,
                    source,
                    offset,
                    Math.min(offset + length, source.text.length),
                  ),
                ];
          const matches = [];
          let start = 0;
          for (const line of source.text.split("\n")) {
            const end = start + Math.min(line.length, 640);
            if (line.trim() && text.includes(JSON.stringify(source.text.slice(start, end)).slice(1, -1)))
              matches.push(cite(inputId, args.message_index, source, start, end));
            start += line.length + 1;
          }
          return matches;
        })
        .filter((item) => item.quote)
        .slice(0, 12);
      return textResult({
        text,
        evidence: citations,
        offset,
        next_offset: offset + length,
        total_chars: full.length,
        has_more: offset + length < full.length,
      });
    },
  },
  {
    name: "search_trace",
    description: "在候选全部原始消息中搜索逐字子串，返回消息索引和证据；提交时使用其中的 evidence_id。",
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
              ctx.inputIds?.get(args.candidate) || args.candidate,
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
      return textResult({
        matches: matches.slice(offset, offset + 20),
        total: matches.length,
        next_offset: offset + 20,
        has_more: offset + 20 < matches.length,
      });
    },
  },
  {
    name: "view_image",
    description: "查看原始消息内已有的内嵌图片，不下载远程图片。",
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
              evidence_id: evidenceId(
                ctx.inputIds?.get(args.candidate) || args.candidate,
                args.message_index,
                "image",
              ),
            }),
          },
          ...content,
        ],
      };
    },
  },
  {
    name: "calculate",
    description: "本地执行数值运算；调用是可选的，不限制其他分析方法。",
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
    description: "可选的一次性双边核算。",
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
    description:
      "在本任务工作目录执行 Python 或 shell。原始材料副本位于 inputs/。可以写脚本和中间文件；outputs 声明需要保存的产物。",
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
    description: "分页读取之前工具保存的文本产物；图片产物返回图片内容。",
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
  private readonly tools = new Map<string, ToolDefinition>();
  register(tool: ToolDefinition): this {
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
  select(names: string[]): ToolDefinition[] {
    return names.map((name) => {
      const tool = this.tools.get(name);
      if (!tool) throw new Error(`Tool unavailable: ${name}`);
      return tool;
    });
  }
}
export function createRegistry(extra: ToolDefinition[] = []): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of [...builtinTools, ...extra]) registry.register(tool);
  return registry;
}
export class ToolRuntime {
  readonly context: ToolContext;
  private readonly definitions: Map<string, ToolDefinition>;
  private readonly validators;
  private readonly reads = new Map<string, ToolResult>();
  constructor(context: ToolContext, tools: ToolDefinition[]) {
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
