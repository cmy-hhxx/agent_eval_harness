import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, link, lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { createGunzip, createGzip } from "node:zlib";
import path from "node:path";
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

export function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

export async function readJson<T = JsonObject>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
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
    await handle.sync();
  } finally {
    await handle.close();
  }
  const directory = await open(path.dirname(file), "r");
  try { await directory.sync(); } finally { await directory.close(); }
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
