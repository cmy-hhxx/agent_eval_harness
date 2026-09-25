import { stat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
export async function inputRevision(source: string): Promise<string> {
  const info = await stat(source, { bigint: true });
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
}
export async function readInputSource(source: string): Promise<{ text: string; revision: string }> {
  const revision = await inputRevision(source),
    text = await readFile(source, "utf8");
  if ((await inputRevision(source)) !== revision)
    throw new Error("读取期间输入文件发生变化，请重试：" + source);
  return { text, revision };
}
export async function sourceFiles(target: string, filename: string): Promise<string[]> {
  const info = await stat(target);
  if (!info.isDirectory()) return [target];
  const matches: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && entry.name === filename) matches.push(file);
    }
  }
  await visit(target);
  return matches;
}
