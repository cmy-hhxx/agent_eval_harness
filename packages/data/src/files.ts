import { randomUUID } from "node:crypto";
import { createReadStream, fsync } from "node:fs";
import { chmod, link, lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import path from "node:path";
import jsonParser from "stream-json/parser.js";
import Assembler from "stream-json/assembler.js";
import { safeId, type Artifact, type JsonObject } from "@eval/contracts";

/** Local filesystem operations used by report and offline maintenance callers. */
export const localFiles = {
  read: readFile,
  stream: createReadStream,
  list: readdir,
  stat,
  chmod,
  mkdir,
  remove: rm,
};

/** FileHandle.sync() blocks the event loop; the threadpool keeps the Host responsive during publication. */
function syncFile(handle: FileHandle): Promise<void> {
  return new Promise((resolve, reject) => fsync(handle.fd, error => error ? reject(error) : resolve()));
}

export function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

export async function readJson<T = JsonObject>(file: string): Promise<T> {
  // Checkpoints can exceed V8's string limit while each individual value remains small.
  const assembler = new Assembler<T>();
  async function* chunks() {
    let first = true;
    for await (const chunk of createReadStream(file, { encoding: "utf8" })) {
      if (first && chunk.charCodeAt(0) === 0xfeff) throw new SyntaxError("Unexpected BOM in JSON input");
      first = false;
      yield chunk;
    }
  }
  try {
    await pipeline(chunks(), jsonParser.asStream({ streamValues: false }), async (tokens) => {
      for await (const token of tokens) assembler.consume(token);
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Parser "))
      throw new SyntaxError("Invalid JSON: " + error.message, { cause: error });
    throw error;
  }
  return assembler.current as T;
}

export async function atomicWrite(
  file: string,
  value: string | Uint8Array | AsyncIterable<Uint8Array>,
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), "." + path.basename(file) + "-" + randomUUID());
  try {
    const handle = await open(temp, "wx");
    try {
      if (typeof value === "string" || value instanceof Uint8Array) await handle.writeFile(value);
      else for await (const chunk of value) await handle.writeFile(chunk);
      await syncFile(handle);
    } finally {
      await handle.close();
    }
    await rename(temp, file);
    const directory = await open(path.dirname(file), "r");
    try {
      await syncFile(directory);
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

/** Serialize bounded pieces, never build a string the size of a run. */
export async function writeCheckpointJson(file: string, value: unknown): Promise<number> {
  let bytes = 0;
  const ancestors = new Set<object>();
  function* tokens(item: unknown): Generator<string> {
    if (item === null || typeof item !== "object") { yield JSON.stringify(item) ?? "null"; return; }
    if (ancestors.has(item)) throw new TypeError("Circular checkpoint value");
    ancestors.add(item);
    if (Array.isArray(item)) {
      yield "[";
      for (let i = 0; i < item.length; i++) { if (i) yield ","; yield* tokens(item[i]); }
      yield "]";
    } else {
      yield "{";
      let first = true;
      for (const [key, child] of Object.entries(item)) {
        if (child === undefined) continue;
        if (!first) yield ",";
        first = false;
        yield JSON.stringify(key) + ":";
        yield* tokens(child);
      }
      yield "}";
    }
    ancestors.delete(item);
  }
  async function* chunks() {
    let parts: string[] = [], length = 0;
    for (const token of tokens(value)) {
      parts.push(token); length += token.length;
      if (length >= 64 * 1024) {
        const chunk = Buffer.from(parts.join("")); bytes += chunk.length;
        yield chunk; parts = []; length = 0;
      }
    }
    const last = Buffer.from(parts.join("") + "\n"); bytes += last.length; yield last;
  }
  await atomicWrite(file, chunks());
  return bytes;
}

async function* gzip(source: () => Readable): AsyncGenerator<Uint8Array> {
  // Open the source only once atomicWrite is ready to consume it and handle errors.
  const input = source(),
    stream = input.pipe(createGzip());
  input.on("error", (error) => stream.destroy(error));
  try {
    yield* stream;
  } finally {
    input.destroy();
    stream.destroy();
  }
}

export async function writeJsonl(file: string, rows: Iterable<unknown> | AsyncIterable<unknown>): Promise<void> {
  const lines = Readable.from(
    (async function* () {
      for await (const row of rows) yield Buffer.from((JSON.stringify(row) ?? "null") + "\n");
    })(),
  );
  await atomicWrite(file, file.endsWith(".gz") ? gzip(() => lines) : lines);
}

/** Append complete JSONL rows and make their bytes durable without rewriting existing rows. */
export async function appendJsonl(file: string, rows: Iterable<unknown>): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const handle = await open(file, "a");
  try {
    for (const row of rows) await handle.writeFile((JSON.stringify(row) ?? "null") + "\n");
    await syncFile(handle);
  } finally {
    await handle.close();
  }
  const directory = await open(path.dirname(file), "r");
  try { await syncFile(directory); } finally { await directory.close(); }
}

export async function* readJsonlText(file: string, keepFinalLine = false): AsyncGenerator<string> {
  const source = createReadStream(file);
  const stream = file.endsWith(".gz") ? source.pipe(createGunzip()) : source;
  source.on("error", (error) => stream.destroy(error));
  const decoder = new TextDecoder();
  let pending: string[] = [];
  try {
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true });
      let start = 0, end: number;
      while ((end = text.indexOf("\n", start)) >= 0) {
        const part = text.slice(start, end);
        const line = pending.length ? pending.join("") + part : part;
        pending = [];
        start = end + 1;
        if (line.trim()) yield line;
      }
      if (start < text.length) pending.push(text.slice(start));
    }
    pending.push(decoder.decode());
    // An interrupted append can leave an incomplete trailing line; callers that need it opt in.
    const buffer = pending.join("");
    if (keepFinalLine && buffer.trim()) yield buffer;
  } finally {
    source.destroy();
  }
}

export async function* readJsonl(file: string): AsyncGenerator<unknown> {
  for await (const line of readJsonlText(file, true)) yield JSON.parse(line);
}

export async function compressFile(file: string): Promise<void> {
  await atomicWrite(
    file + ".gz",
    gzip(() => createReadStream(file)),
  );
  await rm(file);
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

interface RunOwner { pid: number; token: string }
const incompleteLock = "Run lock is incomplete; verify no host is running before removing it.";

async function readRunOwner(file: string): Promise<RunOwner> {
  let owner: RunOwner;
  try { owner = await readJson<RunOwner>(file); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error(incompleteLock, { cause: error });
    throw error;
  }
  if (!owner || !Number.isInteger(owner.pid) || owner.pid <= 0 || owner.pid > 2147483647 ||
      typeof owner.token !== "string" || !owner.token.trim()) throw new Error(incompleteLock);
  return owner;
}

/** Read-only liveness check; never steals a lock from a living process. */
export async function hasLiveRunOwner(directory: string): Promise<boolean> {
  const file = path.join(directory, ".run-lock");
  let owner: RunOwner;
  try { owner = await readRunOwner(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  try { process.kill(owner.pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}

export async function runLock(directory: string, options: { createDirectory?: boolean } = {}): Promise<() => Promise<void>> {
  if (options.createDirectory !== false) await mkdir(directory, { recursive: true });
  const file = path.join(directory, ".run-lock"), guard = file + ".reclaim";
  const token = randomUUID();
  const pending = file + "-" + token;
  try {
    const handle = await open(pending, "wx");
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
    } finally {
      await handle.close();
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      await lstat(guard).then(
        () => { throw new Error("Run lock recovery in progress; retry after verifying the host state."); },
        (error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; },
      );
      try {
        // Publish an already complete owner atomically without replacing another owner.
        // Opening the public file before writing would expose transient invalid JSON.
        await link(pending, file);
        return async () => {
          const value = await readJson<{ token: string }>(file);
          if (value.token === token) await rm(file);
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let previous: RunOwner;
        try { previous = await readRunOwner(file); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        try {
          process.kill(previous.pid, 0);
        } catch (probe) {
          if ((probe as NodeJS.ErrnoException).code === "ESRCH") {
            // Serialize reclamation so a competing host cannot unlink a newly acquired lock.
            try {
              await mkdir(guard);
            } catch {
              throw new Error("Run lock recovery in progress; retry after verifying the host state.");
            }
            try {
              const current = await readRunOwner(file).catch((error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return undefined;
                throw error;
              });
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
  } finally {
    await rm(pending, { force: true });
  }
}
