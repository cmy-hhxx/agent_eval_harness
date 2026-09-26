import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { createGunzip, createGzip } from "node:zlib";
import path from "node:path";
import { safeId, type Artifact, type JsonObject } from "@eval/contracts";

/** Local filesystem operations used by report and offline maintenance callers. */
export const localFiles = {
  read: readFile,
  list: readdir,
  stat,
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

export async function writeJsonl(file: string, rows: Iterable<unknown>): Promise<void> {
  const lines = Readable.from(
    (function* () {
      for (const row of rows) yield Buffer.from((JSON.stringify(row) ?? "null") + "\n");
    })(),
  );
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

export async function* readJsonlText(file: string, keepFinalLine = false): AsyncGenerator<string> {
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
        if (line.trim()) yield line;
      }
    }
    buffer += decoder.decode();
    // An interrupted append can leave an incomplete trailing line; callers that need it opt in.
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
