import path from "node:path";
import { open, realpath, stat } from "node:fs/promises";
import { HttpError } from "@eval/contracts";

/** Resolve symlinks, including an output directory that has not been created yet. */
async function resolved(file: string): Promise<string> {
  try { return await realpath(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = path.dirname(file);
    if (parent === file) throw error;
    return path.join(await resolved(parent), path.basename(file));
  }
}

export async function consolePath(file: unknown, roots?: string[], input = false) {
  if (typeof file !== "string" || !path.isAbsolute(file) || !file.trim())
    throw new HttpError(400, "请输入服务器绝对路径");
  const target = await resolved(file);
  const allowed = roots && await Promise.all(roots.map(root => resolved(root)));
  if (allowed && !allowed.some(root => target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep)))
    throw new HttpError(400, "路径不在该预设允许的目录内: " + file);
  if (!input) {
    try { if (!(await stat(target)).isDirectory()) throw new HttpError(400, "输出必须是目录"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return { path: target, kind: "directory" as const };
  }
  const info = await stat(target);
  if (!info.isFile() && !info.isDirectory()) throw new HttpError(400, "输入必须是文件或目录");
  return { path: target, kind: info.isDirectory() ? "directory" as const : "file" as const };
}

/** Read a bounded window backwards. The cursor allows older errors to remain inspectable. */
export async function consoleLog(file: string, runId: string, errorsOnly: boolean, cursor?: number) {
  const handle = await open(file, "r");
  try {
    const size = (await handle.stat()).size;
    if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > size))
      throw new HttpError(400, "Invalid log cursor");
    const end = cursor ?? size, start = Math.max(0, end - 1024 * 1024);
    const buffer = Buffer.alloc(end - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const bytes = buffer.subarray(0, bytesRead), first = start ? bytes.indexOf(10) + 1 : 0;
    if (start && !first) throw new Error("Log record exceeds the 1 MiB viewer window");
    const complete = bytes.subarray(first).toString("utf8").split("\n");
    if (end === size) complete.pop();
    const rows: Record<string, unknown>[] = [];
    for (const line of complete) {
      if (!line.trim()) continue;
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record.run_id === runId && (!errorsOnly || record.level === "error")) rows.push(record);
    }
    return { rows, cursor: start ? start + first : null };
  } finally { await handle.close(); }
}
