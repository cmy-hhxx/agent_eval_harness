import { stat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { InputSource } from "@eval/contracts";

/** File-system reads used to resolve configured input sources. */
export interface SourceReader {
  files(sources: InputSource[]): Promise<string[]>;
  read(file: string): Promise<string>;
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

export const fileSourceReader: SourceReader = { files: sourceFiles, read: readInputSource };
