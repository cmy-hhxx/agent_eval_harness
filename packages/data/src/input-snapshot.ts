import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { InputDownload } from "@eval/contracts";
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

async function* checked(file: InputDownload, signal: AbortSignal): AsyncGenerator<Uint8Array> {
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
  if (bytes !== file.size || rows !== file.rows)
    throw new Error(`Incomplete ${file.name}: bytes ${bytes}/${file.size}, rows ${rows}/${file.rows}`);
}

/** Caller owns the date lock and must journal syncing before entry. No evaluation may read
 * this date until every rename completes and the caller durably records readiness. */
export async function replaceInputSnapshot(
  directory: string, files: AsyncIterable<InputDownload>, signal: AbortSignal, beforeReplace: () => Promise<void>,
): Promise<{ changed: boolean; bytes: number }> {
  const staging = path.join(directory, ".incoming");
  await mkdir(staging, { recursive: true });
  const names: string[] = [];
  let bytes = 0;
  try {
    // The producer validates the remote catalog again before ending this iterator.
    for await (const file of files) {
      try {
        if (!/^[a-z_]+\.jsonl$/.test(file.name) || names.includes(file.name)) throw new Error("Invalid snapshot file name");
        await atomicWrite(path.join(staging, file.name), checked(file, signal));
        bytes += file.size;
        names.push(file.name);
      } finally { await file.close(); }
    }
    if (!names.length) throw new Error("Empty input snapshot");
    const changed: string[] = [];
    for (const name of names)
      if (!await equalFiles(path.join(staging, name), path.join(directory, name))) changed.push(name);
    signal.throwIfAborted();
    if (changed.length) await beforeReplace();
    for (const name of changed) await rename(path.join(staging, name), path.join(directory, name));
    const handle = await open(directory, "r");
    try { await handle.sync(); } finally { await handle.close(); }
    return { changed: changed.length > 0, bytes };
  } finally {
    // Only our transient download files; committed sources and run outputs are retained.
    await rm(staging, { recursive: true, force: true });
  }
}
