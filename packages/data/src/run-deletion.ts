import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, lstat, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { safeId } from "@eval/contracts";
import { atomicWrite, readJson, runLock } from "./files.js";
import { withLogWriterLock } from "./logging.js";
import { runLayout } from "./run-layout.js";

export class RunDeletionError extends Error {
  constructor(readonly reason: "not_found" | "conflict", message: string) { super(message); }
}

async function info(file: string) {
  try { return await lstat(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

async function requireRun(directory: string, output: string, runId: string) {
  const run = await info(directory);
  if (!run) throw new RunDeletionError("not_found", "运行不存在");
  if (!run.isDirectory() || run.isSymbolicLink() || path.dirname(await realpath(directory)) !== await realpath(output))
    throw new RunDeletionError("conflict", "运行目录必须位于配置的输出目录内，且不能是符号链接");
  const state = await info(path.join(directory, "state.json"));
  if (!state) throw new RunDeletionError("not_found", "运行不存在");
  if (!state.isFile() || state.isSymbolicLink()) throw new RunDeletionError("conflict", "运行状态文件不是普通文件");
  const checkpoint = await readJson<{ format?: string; runId?: string }>(path.join(directory, "state.json"));
  if (checkpoint.format !== "evaluation-run" || checkpoint.runId !== runId)
    throw new RunDeletionError("conflict", "运行状态身份无效");
  const lock = await info(path.join(directory, ".run-lock"));
  if (lock && (!lock.isFile() || lock.isSymbolicLink()))
    throw new RunDeletionError("conflict", "运行锁不是普通文件");
}

interface PreparedLog {
  file: string; temporary?: string; removed: number;
  backup?: string; replaced?: boolean; preserveBackup?: boolean;
}

/** Stream full records while preserving every retained line byte for byte. */
async function prepareLog(file: string, runId: string): Promise<PreparedLog> {
  const current = await info(file);
  if (!current) return { file, removed: 0 };
  if (!current.isFile() || current.isSymbolicLink()) throw new RunDeletionError("conflict", "日志必须是普通文件：" + path.basename(file));
  const prepared: PreparedLog = { file, temporary: path.join(path.dirname(file), ".delete-" + randomUUID()), removed: 0 };
  async function* retained(): AsyncGenerator<Uint8Array> {
    let pending = Buffer.alloc(0);
    function keep(line: Buffer) {
      if (!line.toString("utf8").trim()) return true;
      let record: unknown;
      try { record = JSON.parse(line.toString("utf8")); }
      catch { throw new RunDeletionError("conflict", "日志记录不完整或损坏：" + path.basename(file)); }
      if (!record || typeof record !== "object" || Array.isArray(record))
        throw new RunDeletionError("conflict", "日志记录无效：" + path.basename(file));
      if ((record as { run_id?: unknown }).run_id !== runId) return true;
      prepared.removed++;
      return false;
    }
    for await (const chunk of createReadStream(file)) {
      pending = Buffer.concat([pending, chunk]);
      let start = 0, end: number;
      while ((end = pending.indexOf(10, start)) >= 0) {
        const line = pending.subarray(start, end + 1);
        if (keep(line)) yield line;
        start = end + 1;
      }
      pending = pending.subarray(start);
    }
    if (pending.length && keep(pending)) yield pending;
  }
  try {
    await atomicWrite(prepared.temporary!, retained());
    return prepared;
  } catch (error) {
    await rm(prepared.temporary!, { force: true });
    throw error;
  }
}

/** Delete only one run's output and its exact run_id entries from the shared journals. */
export async function deleteRun(options: {
  outputDirectory: string; runId: string; logDirectory: string; logLockDirectory: string;
  /** Test seam for interrupted filesystem commits and cleanup. */
  fileOperations?: { rename?: typeof rename; remove?: typeof rm };
}): Promise<{ run_id: string; deleted: true; logs: { runtime: number; evaluation: number } }> {
  const renameFile = options.fileOperations?.rename ?? rename, removeFile = options.fileOperations?.remove ?? rm;
  const runId = safeId(options.runId), output = path.resolve(options.outputDirectory);
  const layout = runLayout({ kind: "directory", path: output }, runId);
  await requireRun(layout.directory, output, runId);
  let release: () => Promise<void>;
  try { release = await runLock(layout.directory, { createDirectory: false }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new RunDeletionError("not_found", "运行不存在");
    throw new RunDeletionError("conflict", "运行正在执行或锁尚未释放，请停止运行后重试");
  }
  let moved: string | undefined;
  let detached = false;
  let operationFailed = false;
  const prepared: PreparedLog[] = [];
  try {
    // Recheck identity after acquiring ownership; another maintenance process may have changed it.
    await requireRun(layout.directory, output, runId);
    return await withLogWriterLock(options.logLockDirectory, async () => {
      try {
        const logs = await info(options.logDirectory);
        if (logs && (!logs.isDirectory() || logs.isSymbolicLink()))
          throw new RunDeletionError("conflict", "日志目录不是普通目录");
        for (const name of ["runtime.log", "evaluation.log"])
          prepared.push(await prepareLog(path.join(options.logDirectory, name), runId));
        // Both journals have been parsed successfully before changing either original file.
        // Hard links retain the original bytes without copying the full journals into memory.
        for (const log of prepared) if (log.temporary && log.removed) {
          const backup = path.join(options.logDirectory, ".delete-backup-" + randomUUID());
          await link(log.file, backup);
          log.backup = backup;
        }
        for (const log of prepared) if (log.temporary && log.removed) {
          await renameFile(log.temporary, log.file);
          log.replaced = true;
        }
        const tombstone = path.join(output, ".deleting-" + randomUUID());
        await renameFile(layout.directory, tombstone);
        moved = tombstone;
        detached = true;
        // Keep the original lock in the detached directory until every old output has been removed.
        await removeFile(tombstone, { recursive: true });
        moved = undefined;
        return { run_id: runId, deleted: true, logs: { runtime: prepared[0].removed, evaluation: prepared[1].removed } };
      } catch (error) {
        if (!detached) {
          const rollbackErrors: unknown[] = [];
          for (const log of [...prepared].reverse()) if (log.replaced && log.backup) {
            try { await renameFile(log.backup, log.file); }
            catch (rollback) { log.preserveBackup = true; rollbackErrors.push(rollback); }
          }
          if (rollbackErrors.length)
            throw new AggregateError([error, ...rollbackErrors], "删除失败且日志回滚失败，原日志备份保留在 " + options.logDirectory);
        }
        throw error;
      }
    });
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    const cleanup = await Promise.allSettled([
      ...prepared.flatMap((log) => [log.temporary, ...(log.preserveBackup ? [] : [log.backup])]
        .filter((file): file is string => !!file).map((file) => Promise.resolve().then(() => removeFile(file, { force: true })))),
      ...(moved ? [Promise.resolve().then(() => removeFile(moved!, { recursive: true, force: true }))] : []),
    ]);
    // The old lock was removed with the detached tree. A new run may already own the original path.
    let releaseError: unknown;
    if (!detached) {
      try { await release(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") releaseError = error; }
    }
    if (!operationFailed) {
      if (releaseError) throw releaseError;
      const failedCleanup = cleanup.find((item) => item.status === "rejected");
      if (failedCleanup?.status === "rejected") throw failedCleanup.reason;
    }
  }
}
