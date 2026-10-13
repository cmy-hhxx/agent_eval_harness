import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { readJson, runLock, writeJson } from "./files.js";
import { locateRun } from "./run-layout.js";

async function stateIdentity(run: string) {
  const value = await stat(locateRun(run).stateFile);
  // Device numbers can change after remounting; only checkpoint changes invalidate the projection.
  return { ino: value.ino, size: value.size, mtimeMs: value.mtimeMs };
}

/** The caller owns the run lock. Publish only after the corresponding checkpoint is durable. */
export async function writeRunOverview(run: string, value: unknown): Promise<void> {
  await writeJson(locateRun(run).overviewFile, { state: await stateIdentity(run), value });
}

async function runDirectories(directory: string) {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && !entry.name.startsWith("."))
      .map(entry => path.join(directory, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Read small projections, reporting each unavailable run without hiding valid neighbours. */
export async function readRunOverviews<T>(directory: string): Promise<({ runId: string; value: T; error?: never } | { runId: string; error: string; value?: never })[]> {
  const result: Awaited<ReturnType<typeof readRunOverviews<T>>> = [];
  for (const run of await runDirectories(directory)) {
    const runId = path.basename(run);
    try {
      let current: Awaited<ReturnType<typeof stateIdentity>>;
      try { current = await stateIdentity(run); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      const record = await readJson<{ state: typeof current; value: T }>(locateRun(run).overviewFile);
      current = await stateIdentity(run);
      if (!record?.state || !Object.hasOwn(record, "value") ||
          Object.entries(current).some(([key, value]) => record.state[key as keyof typeof current] !== value))
        throw new Error("索引与当前状态文件不一致");
      result.push({ runId, value: record.value });
    } catch {
      result.push({ runId, error: `运行统计索引缺失、损坏或过期：${runId}。等待当前保存完成后重试；若仍失败，停止该运行后执行 node scripts/rebuild-run-overviews.mjs <运行根目录>。` });
    }
  }
  return result;
}

/** Explicit maintenance, not a read-time fallback. Never overwrite an active writer's projection. */
export async function rebuildRunOverviews<T>(directory: string, project: (checkpoint: T) => unknown): Promise<string[]> {
  const updated = [];
  for (const run of await runDirectories(directory)) {
    try { await stateIdentity(run); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    const release = await runLock(run, { createDirectory: false });
    try {
      const value = project(await readJson<T>(locateRun(run).stateFile));
      await writeRunOverview(run, value);
      updated.push(path.basename(run));
    } finally { await release(); }
  }
  return updated;
}
