import { stat, readFile, readdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import type { InputSource } from "@eval/contracts";

/** File-system reads used to resolve configured input sources. */
export interface SourceReader {
  files(sources: InputSource[]): Promise<string[]>;
  read(file: string): Promise<string>;
  revision(file: string): Promise<string>;
  lines(file: string, revision?: string): AsyncIterable<{ line: string; index: number }>;
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

/** Stream large JSONL inputs without retaining whole files; reject concurrent source edits. */
export async function* readInputSourceLines(source: string, expected?: string): AsyncIterable<{ line: string; index: number }> {
  const revision = await fileRevision(source);
  if (expected !== undefined && revision !== expected)
    throw new Error("读取期间输入文件发生变化，请重试：" + source);
  const stream = createReadStream(source);
  try {
    let index = 0;
    let fragments: Buffer[] = [];
    const decode = (parts: Buffer[]): string => {
      const bytes = parts.length === 1 ? parts[0]! : Buffer.concat(parts);
      const text = (bytes.at(-1) === 13 ? bytes.subarray(0, -1) : bytes).toString("utf8");
      return index === 1 ? text.replace(/^\uFEFF/, "") : text;
    };
    for await (const chunk of stream) {
      let start = 0, end: number;
      while ((end = chunk.indexOf(10, start)) !== -1) {
        index++;
        const line = decode([...fragments, chunk.subarray(start, end)]);
        fragments = [];
        yield { line, index };
        start = end + 1;
      }
      if (start < chunk.length) fragments.push(chunk.subarray(start));
    }
    if (fragments.length) {
      index++;
      // A final line without a newline is valid; unlike CRLF, a bare trailing CR is not stripped.
      const text = (fragments.length === 1 ? fragments[0]! : Buffer.concat(fragments)).toString("utf8");
      yield { line: index === 1 ? text.replace(/^\uFEFF/, "") : text, index };
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
export async function sourceFiles(sources: InputSource[]): Promise<string[]> {
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
  files: sourceFiles, read: readInputSource, revision: fileRevision, lines: readInputSourceLines,
};
