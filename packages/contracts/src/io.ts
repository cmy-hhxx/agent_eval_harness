import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Artifact, JsonObject } from "./index.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
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
export function digest(value: unknown): string {
  return sha256(canonical(value));
}
export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
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
export async function atomicText(file: string, value: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), "." + path.basename(file) + "-" + randomUUID());
  try {
    const handle = await open(temp, "wx");
    try {
      await handle.writeFile(value);
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
  await atomicText(file, JSON.stringify(value, null, 2) + "\n");
}
export async function writeJsonl(file: string, rows: unknown[]): Promise<void> {
  await atomicText(file, rows.map(canonical).join("\n") + (rows.length ? "\n" : ""));
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
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
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
  if (!response.ok) throw new HttpError(response.status, String(data.error || response.statusText));
  return data as T;
}
export async function listen(
  handler: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>,
  port = 0,
): Promise<{ server: Server; url: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    void handler(req, res, new URL(req.url || "/", "http://127.0.0.1")).catch((error) => {
      if (res.headersSent) res.destroy();
      else json(res, { error: errorText(error) }, error instanceof HttpError ? error.status : 500);
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
    const hash = sha256(bytes);
    const id = hash;
    await mkdir(this.directory, { recursive: true });
    await writeFile(path.join(this.directory, id), bytes);
    return { id, name, digest: hash, bytes: bytes.length };
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
