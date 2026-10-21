import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { safeId, RetryableInputDownloadError, type InputDownload } from "@eval/contracts";
import { atomicWrite } from "./files.js";

async function equalFiles(left: string, right: string): Promise<boolean> {
  const a = await open(left, "r");
  let b;
  try {
    try { b = await open(right, "r"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    const size = (await a.stat()).size;
    if (size !== (await b.stat()).size) return false;
    const x = Buffer.alloc(1024 * 1024), y = Buffer.alloc(x.length);
    for (let offset = 0; offset < size;) {
      const length = Math.min(x.length, size - offset);
      const [u, v] = await Promise.all([a.read(x, 0, length, offset), b.read(y, 0, length, offset)]);
      if (u.bytesRead !== length || v.bytesRead !== length) throw new Error("Input changed during file comparison");
      if (!x.subarray(0, length).equals(y.subarray(0, length))) return false;
      offset += length;
    }
    return true;
  } finally { await a.close(); await b?.close(); }
}

async function* checked(file: InputDownload, signal: AbortSignal, complete: (rows: number) => void): AsyncGenerator<Uint8Array> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "", bytes = 0, rows = 0;
  const parse = (line: string) => {
    if (!line.trim()) return;
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid JSONL object in ${file.name}`);
    rows++;
  };
  for await (const chunk of file.chunks) {
    signal.throwIfAborted();
    bytes += chunk.length;
    pending += decoder.decode(chunk, { stream: true });
    let offset = 0, end: number;
    while ((end = pending.indexOf("\n", offset)) >= 0) {
      parse(pending.slice(offset, end));
      offset = end + 1;
    }
    pending = pending.slice(offset);
    yield chunk;
  }
  parse(pending + decoder.decode());
  if (bytes !== file.size || rows < file.rows)
    throw new Error(`Incomplete ${file.name}: bytes ${bytes}/${file.size}, rows ${rows}/${file.rows}`);
  complete(rows);
}

/** Caller journals syncing before entry and acquires the date lock in beforeReplace.
 * No consumer may read this date during promotion until readiness is durably recorded. */
export async function replaceInputSnapshot(
  directory: string, files: AsyncIterable<() => Promise<InputDownload>>, signal: AbortSignal, beforeReplace: () => Promise<void>,
  onFileReady?: (file: string, model: string, rows: number) => Promise<void>,
): Promise<{ changed: boolean; bytes: number; rows: Record<string, number> }> {
  const staging = path.join(directory, ".incoming");
  await mkdir(staging, { recursive: true });
  const names: string[] = [];
  const rows: Record<string, number> = {};
  let bytes = 0;
  const publications: Promise<void>[] = [];
  let publicationFailure: unknown;
  try {
    // Each response is complete even if the catalog grows between files.
    for await (const download of files) {
      for (let attempt = 1; ; attempt++) {
        signal.throwIfAborted();
        let file: InputDownload | undefined;
        try {
          file = await download();
          if (!file.name.endsWith(".jsonl") || names.includes(file.name)) throw new Error("Invalid snapshot file name");
          safeId(file.name.slice(0, -".jsonl".length));
          const model = file.name.slice(0, -".jsonl".length);
          await atomicWrite(path.join(staging, file.name), checked(file, signal, count => { rows[model] = count; }));
          bytes += file.size;
          names.push(file.name);
          if (onFileReady) publications.push(onFileReady(path.join(staging, file.name), model, rows[model])
            .catch(error => { publicationFailure ??= error; }));
          break;
        } catch (error) {
          signal.throwIfAborted();
          if (!(error instanceof RetryableInputDownloadError)) throw error;
          if (attempt === 3) throw new Error(`Download failed after ${attempt} attempts: ${error.message}`, { cause: error });
        } finally { await file?.close(); }
        // Retry the interrupted file, retaining validated siblings in this snapshot.
        await delay(1000 * 2 ** (attempt - 1), undefined, { signal });
      }
    }
    if (!names.length) throw new Error("Empty input snapshot");
    await Promise.all(publications);
    if (publicationFailure) throw publicationFailure;
    const changed: string[] = [];
    for (const name of names)
      if (!await equalFiles(path.join(staging, name), path.join(directory, name))) changed.push(name);
    signal.throwIfAborted();
    if (changed.length) await beforeReplace();
    for (const name of changed) await rename(path.join(staging, name), path.join(directory, name));
    const handle = await open(directory, "r");
    try { await handle.sync(); } finally { await handle.close(); }
    return { changed: changed.length > 0, bytes, rows };
  } finally {
    await Promise.all(publications);
    // Only our transient download files; committed sources and run outputs are retained.
    await rm(staging, { recursive: true, force: true });
  }
}
