import { stat, readFile, readdir } from "node:fs/promises";
import { createReadStream, openSync, closeSync, readSync, fstatSync, statSync, type BigIntStats } from "node:fs";
import path from "node:path";
import type { InputSource } from "@eval/contracts";

/** File-system reads used to resolve configured input sources. */
export interface SourceReader {
  files(sources: InputSource[]): Promise<string[]>;
  revision(file: string): Promise<string>;
  lines(file: string, revision?: string): AsyncIterable<{ line: string; index: number; byteOffset: number; byteLength: number }>;
  record(file: string, byteOffset: number, byteLength: number, revision: string): string;
}

async function fileRevision(source: string): Promise<string> {
  const info = await stat(source, { bigint: true });
  return [info.dev, info.ino, info.size, info.mtimeNs].join(":");
}

/** Read a file once, rejecting a read that raced a concurrent write. */
export async function readInputSource(source: string): Promise<string> {
  const revision = await fileRevision(source),
    text = await readFile(source, "utf8");
  if ((await fileRevision(source)) !== revision)
    throw new Error("读取期间输入文件发生变化，请重试：" + source);
  return text;
}

/** Read one already indexed record without retaining the source file in memory. */
function readInputSourceRecord(source: string, byteOffset: number, byteLength: number, expected: string): string {
  const descriptor = openSync(source, "r");
  const revision = (info: BigIntStats) => [info.dev, info.ino, info.size, info.mtimeNs].join(":");
  try {
    if (revision(fstatSync(descriptor, { bigint: true })) !== expected)
      throw new Error("读取期间输入文件发生变化，请重试：" + source);
    const buffer = Buffer.allocUnsafe(byteLength);
    let received = 0;
    while (received < byteLength) {
      const count = readSync(descriptor, buffer, received, byteLength - received, byteOffset + received);
      if (!count) throw new Error("读取期间输入源记录缺失，请重试：" + source);
      received += count;
    }
    if (revision(fstatSync(descriptor, { bigint: true })) !== expected ||
        revision(statSync(source, { bigint: true })) !== expected)
      throw new Error("读取期间输入文件发生变化，请重试：" + source);
    return buffer.toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

/** Stream large JSONL inputs without retaining whole files; reject concurrent source edits. */
async function* readInputSourceLines(source: string, expected?: string): AsyncIterable<{ line: string; index: number; byteOffset: number; byteLength: number }> {
  const revision = await fileRevision(source);
  if (expected !== undefined && revision !== expected)
    throw new Error("读取期间输入文件发生变化，请重试：" + source);
  const stream = createReadStream(source);
  try {
    let index = 0;
    let byteOffset = 0;
    let fragments: Buffer[] = [];
    const decode = (bytes: Buffer, stripCR: boolean) => {
      const bom = index === 1 && bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
      const end = stripCR && bytes.at(-1) === 13 ? bytes.length - 1 : bytes.length;
      return { line: bytes.subarray(bom, end).toString("utf8"), byteOffset: byteOffset + bom, byteLength: end - bom };
    };
    for await (const chunk of stream) {
      let start = 0, end: number;
      while ((end = chunk.indexOf(10, start)) !== -1) {
        index++;
        const bytes = fragments.length ? Buffer.concat([...fragments, chunk.subarray(start, end)]) : chunk.subarray(start, end);
        const record = decode(bytes, true);
        fragments = [];
        yield { ...record, index };
        byteOffset += bytes.length + 1;
        start = end + 1;
      }
      if (start < chunk.length) fragments.push(chunk.subarray(start));
    }
    if (fragments.length) {
      index++;
      // A final line without a newline is valid; unlike CRLF, a bare trailing CR is not stripped.
      const bytes = fragments.length === 1 ? fragments[0]! : Buffer.concat(fragments);
      yield { ...decode(bytes, false), index };
    }
    if ((await fileRevision(source)) !== revision)
      throw new Error("读取期间输入文件发生变化，请重试：" + source);
  } finally {
    stream.destroy();
  }
}

async function walk(directory: string): Promise<string[]> {
  const matches: string[] = [];
  const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) matches.push(...(await walk(file)));
    else if (entry.isFile()) matches.push(file);
  }
  return matches;
}

/** Resolve source descriptors into deterministically ordered files. */
async function sourceFiles(sources: InputSource[]): Promise<string[]> {
  const files: string[] = [];
  for (const source of sources) {
    if (source.kind === "file") {
      await stat(source.path);
      files.push(source.path);
      continue;
    }
    const include = source.include ? new Set(source.include) : undefined;
    for (const file of await walk(source.path))
      if (include ? include.has(path.basename(file)) : path.extname(file) === ".jsonl") files.push(file);
  }
  return [...new Set(files)].sort();
}

export const fileSourceReader: SourceReader = {
  files: sourceFiles, revision: fileRevision, lines: readInputSourceLines, record: readInputSourceRecord,
};
