import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { createGunzip, createGzip } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Artifact, JsonObject, ValidationIssue } from "./index.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
export function internalPath(run: string, ...parts: string[]): string {
  return path.join(run, "_internal", ...parts);
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map((v) => canonical(v ?? null)).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
}
export function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
  return value as JsonObject;
}
export function safeId(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,180}$/.test(value) || value.includes(".."))
    throw new HttpError(400, "Invalid identifier");
  return value;
}
export async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}
export async function readJson<T = JsonObject>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}
export async function atomicWrite(file: string, value: string | Uint8Array | AsyncIterable<Uint8Array>): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), "." + path.basename(file) + "-" + randomUUID());
  try {
    const handle = await open(temp, "wx");
    try {
      if (typeof value === "string" || value instanceof Uint8Array) await handle.writeFile(value);
      else for await (const chunk of value) await handle.writeFile(chunk);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, file);
    const directory = await open(path.dirname(file), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temp, { force: true });
  }
}
export async function writeJson(file: string, value: unknown): Promise<void> {
  await atomicWrite(file, JSON.stringify(value, null, 2) + "\n");
}
async function* gzip(source: () => Readable): AsyncGenerator<Uint8Array> {
  // Open the source only once atomicWrite is ready to consume it and handle errors.
  const input = source(), stream = input.pipe(createGzip());
  input.on("error", (error) => stream.destroy(error));
  try {
    yield* stream;
  } finally {
    input.destroy();
    stream.destroy();
  }
}
export async function writeJsonl(file: string, rows: Iterable<unknown>): Promise<void> {
  const lines = Readable.from((function* () {
    for (const row of rows) yield Buffer.from((JSON.stringify(row) ?? "null") + "\n");
  })());
  await atomicWrite(file, file.endsWith(".gz") ? gzip(() => lines) : lines);
}
export async function appendJsonl(file: string, rows: Iterable<unknown>): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const handle = await open(file, "a");
  try {
    for (const row of rows) await handle.writeFile((JSON.stringify(row) ?? "null") + "\n");
    await handle.sync();
  } finally {
    await handle.close();
  }
  const directory = await open(path.dirname(file), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
export async function* readJsonl(file: string): AsyncGenerator<unknown> {
  const source = createReadStream(file);
  const stream = file.endsWith(".gz") ? source.pipe(createGunzip()) : source;
  source.on("error", (error) => stream.destroy(error));
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (line.trim()) yield JSON.parse(line);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield JSON.parse(buffer);
  } finally {
    source.destroy();
  }
}
export async function compressFile(file: string): Promise<void> {
  await atomicWrite(file + ".gz", gzip(() => createReadStream(file)));
  await rm(file);
}
export async function readInputs(run: string): Promise<Record<string, unknown>> {
  const inputs: Record<string, unknown> = {};
  for await (const row of readJsonl(internalPath(run, "inputs.jsonl.gz"))) {
    const { id, value } = row as { id: string; value: unknown };
    safeId(id);
    if (Object.hasOwn(inputs, id)) throw new Error(`Duplicate input snapshot: ${id}`);
    inputs[id] = value;
  }
  return inputs;
}
export async function writeInputs(run: string, inputs: Record<string, unknown>): Promise<void> {
  await writeJsonl(internalPath(run, "inputs.jsonl.gz"), (function* () {
    for (const [id, value] of Object.entries(inputs)) yield { id, value };
  })());
}
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export function redact(text: string, secrets: string[]): string {
  for (const secret of secrets.filter(Boolean)) text = text.split(secret).join("[REDACTED]");
  return text;
}
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string, readonly issues?: ValidationIssue[]) {
    super(message);
    this.status = status;
  }
}
export class ValidationError extends HttpError {
  constructor(issues: ValidationIssue[]) {
    super(422, issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"), issues);
  }
}
export function schemaIssues(errors: { keyword: string; instancePath: string; message?: string; params: unknown }[] | null | undefined, value?: unknown): ValidationIssue[] {
  return (errors || []).map((error) => {
    const field = (error.params as { missingProperty?: string; additionalProperty?: string }).missingProperty ||
      (error.params as { additionalProperty?: string }).additionalProperty;
    const location = error.instancePath + (field ? "/" + field.replaceAll("~", "~0").replaceAll("/", "~1") : "");
    const actual = location.split("/").slice(1).reduce<unknown>((node, key) =>
      node && typeof node === "object" ? (node as Record<string, unknown>)[key.replaceAll("~1", "/").replaceAll("~0", "~")] : undefined, value);
    return { category: "structure", code: "schema_" + error.keyword, path: location || "/",
      candidate: /^\/evaluations\/([AB])(?:\/|$)/.exec(location)?.[1], expected: error.params, actual: actual ?? null,
      message: "输出结构无效：" + (error.message || error.keyword) + (error.keyword === "required" ? "；依赖此字段的语义检查暂不可执行" : "") };
  });
}
export async function body(req: IncomingMessage, maxBytes = 32 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new HttpError(413, "Request too large");
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}
export function json(res: ServerResponse, value: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}
export async function request<T>(
  url: string,
  method = "GET",
  value?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: value === undefined ? undefined : JSON.stringify(value),
    signal: signal ?? AbortSignal.timeout(30000),
  });
  const data = (await response.json()) as JsonObject;
  if (!response.ok) throw new HttpError(response.status, String(data.error || response.statusText), data.issues as ValidationIssue[] | undefined);
  return data as T;
}
export async function listen(
  handler: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>,
  port = 0,
): Promise<{ server: Server; url: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    void handler(req, res, new URL(req.url || "/", "http://127.0.0.1")).catch((error) => {
      if (res.headersSent) res.destroy();
      else json(res, { error: errorText(error), ...(error instanceof HttpError && error.issues ? { issues: error.issues } : {}) }, error instanceof HttpError ? error.status : 500);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No HTTP address");
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
export class ArtifactStore {
  readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
  }
  async put(name: string, data: string | Uint8Array): Promise<Artifact> {
    const bytes = typeof data === "string" ? Buffer.from(data) : data;
    const id = randomUUID();
    await mkdir(this.directory, { recursive: true });
    await writeFile(path.join(this.directory, id), bytes);
    return { id, name, bytes: bytes.length };
  }
  async get(id: string): Promise<Uint8Array> {
    return readFile(path.join(this.directory, safeId(id)));
  }
}
export async function runLock(directory: string): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, ".run-lock");
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, "wx");
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
      } finally {
        await handle.close();
      }
      return async () => {
        const value = await readJson<{ token: string }>(file);
        if (value.token === token) await rm(file);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let previous: { pid: number; token: string };
      try {
        previous = await readJson(file);
      } catch {
        throw new Error("Run lock is incomplete; verify no host is running before removing it.");
      }
      try {
        process.kill(previous.pid, 0);
      } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code === "ESRCH") {
          // Serialize reclamation so a competing host cannot unlink a newly acquired lock.
          const guard = file + ".reclaim";
          try {
            await mkdir(guard);
          } catch {
            throw new Error("Run lock recovery in progress; retry after verifying the host state.");
          }
          try {
            const current = await readJson<{ pid: number; token: string }>(file).catch(() => null);
            if (current?.token === previous.token && current.pid === previous.pid) await rm(file);
          } finally {
            await rm(guard, { recursive: true });
          }
          continue;
        }
      }
      throw new Error(`Run already owned by host PID ${previous.pid}`);
    }
  }
  throw new Error("Could not acquire run lock");
}
