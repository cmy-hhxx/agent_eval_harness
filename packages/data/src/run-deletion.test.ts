import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deleteRun, RunDeletionError } from "./run-deletion.js";
import { exists, runLock, writeJson } from "./files.js";
import { createFileLogger } from "./logging.js";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "eval-delete-"));
  const options = { outputDirectory: path.join(root, "runs"), runId: "delete-me",
    logDirectory: path.join(root, "log"), logLockDirectory: path.join(root, ".runtime/log-writer") };
  const run = path.join(options.outputDirectory, options.runId);
  await writeJson(path.join(run, "state.json"), { format: "evaluation-run", runId: options.runId });
  const logger = createFileLogger({ directory: options.logDirectory, lockDirectory: options.logLockDirectory });
  return { root, options, run, logger };
}

test("run deletion removes all run output and exact journal records while preserving shared data and other runs", async () => {
  const { root, options, run, logger } = await fixture();
  try {
    const result = path.join(run, "results/attribution.jsonl");
    await writeJson(result, { judgment: "accepted" });
    await writeJson(path.join(run, "_internal/tasks/t/events.jsonl"), { debug: true });
    await writeFile(path.join(run, "report.md"), "report");
    await writeJson(path.join(run, "stats.json"), { accepted: 1 });
    const preserved = [path.join(root, "source.jsonl"), path.join(root, "library/model.json"),
      path.join(options.outputDirectory, "keep-me/state.json"), path.join(options.logDirectory, "comparison-statistics-log.jsonl")];
    for (const file of preserved) await writeJson(file, { run_id: options.runId, source: "shared" });
    const runtime = path.join(options.logDirectory, "runtime.log"), evaluation = path.join(options.logDirectory, "evaluation.log");
    const keptRuntime = ' {"run_id":"keep-me", "message":"delete-me"}\r\n\n{"component":"dashboard"}\n';
    const keptEvaluation = '{ "run_id": "delete-me-too", "result": "delete-me" }\n';
    await writeFile(runtime, JSON.stringify({ run_id: options.runId }) + "\n" + keptRuntime);
    await writeFile(evaluation, keptEvaluation + JSON.stringify({ run_id: options.runId }) + "\n");
    const deleted = await deleteRun(options);
    assert.deepEqual(deleted, { run_id: options.runId, deleted: true, logs: { runtime: 1, evaluation: 1 } });
    assert.equal(await exists(run), false);
    assert.equal(await readFile(runtime, "utf8"), keptRuntime);
    assert.equal(await readFile(evaluation, "utf8"), keptEvaluation);
    for (const file of preserved) assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { run_id: options.runId, source: "shared" });
    assert.deepEqual((await readdir(options.outputDirectory)).sort(), ["keep-me"]);
    assert.deepEqual((await readdir(options.logDirectory)).sort(), ["comparison-statistics-log.jsonl", "evaluation.log", "runtime.log"]);
    // A new run with the same business identifier can append normally after the journal inode changes.
    assert(await logger.evaluation({ time: new Date().toISOString(), workflow: "comparison", run_id: options.runId,
      task_id: "new", attempt_id: "new", stage: "comparison", submission_id: "new", result: { score: 1 } }));
    assert.equal((await readFile(evaluation, "utf8")).split("\n").filter(Boolean).length, 2);
    await assert.rejects(deleteRun(options), (error: unknown) => error instanceof RunDeletionError && error.reason === "not_found");
    assert.equal(await exists(run), false, "a repeated deletion must not recreate an empty run directory");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("run deletion shares the log writer lock and refreshes existing logger deduplication indexes", async () => {
  const { root, options, run, logger } = await fixture();
  try {
    const row = { time: new Date().toISOString(), workflow: "comparison", run_id: options.runId,
      task_id: "old", attempt_id: "old", stage: "comparison", submission_id: "old", result: { score: 1 } };
    assert(await logger.evaluation(row));
    const otherLogger = createFileLogger({ directory: options.logDirectory, lockDirectory: options.logLockDirectory });
    const writes = Array.from({ length: 24 }, (_, index) => otherLogger.evaluation({ ...row, run_id: "keep-me", task_id: String(index) }));
    const [deleted, written] = await Promise.all([deleteRun(options), Promise.all(writes)]);
    assert.equal(deleted.logs.evaluation, 1);
    assert(written.every(Boolean));
    assert.equal(await exists(run), false);
    assert(await logger.evaluation(row), "an already loaded logger must see the replacement journal");
    const rows = (await readFile(path.join(options.logDirectory, "evaluation.log"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(rows.filter((item) => item.run_id === "keep-me").length, 24);
    assert.equal(rows.filter((item) => item.run_id === options.runId).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("run deletion refuses live or incomplete locks and can reclaim a dead owner", async () => {
  const { root, options, run } = await fixture();
  try {
    const release = await runLock(run);
    await assert.rejects(deleteRun(options), (error: unknown) => error instanceof RunDeletionError && error.reason === "conflict");
    assert.equal(await exists(path.join(run, "state.json")), true);
    await release();
    await writeFile(path.join(run, ".run-lock"), "{");
    await assert.rejects(deleteRun(options), /锁尚未释放/);
    await writeJson(path.join(run, ".run-lock"), { pid: 2_000_000_000, token: "dead" });
    const deleted = await deleteRun(options);
    assert.deepEqual(deleted.logs, { runtime: 0, evaluation: 0 });
    assert.equal(await exists(run), false);
    assert.equal(await exists(options.logDirectory), false, "missing journals do not create new log files");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("damaged journals and symbolic links refuse deletion before modifying run output or either log", async () => {
  const { root, options, run } = await fixture();
  try {
    await mkdir(options.logDirectory);
    const runtime = path.join(options.logDirectory, "runtime.log"), evaluation = path.join(options.logDirectory, "evaluation.log");
    const runtimeText = JSON.stringify({ run_id: options.runId }) + "\n";
    await writeFile(runtime, runtimeText);
    await writeFile(evaluation, '{"run_id":');
    await assert.rejects(deleteRun(options), /日志记录不完整或损坏/);
    assert.equal(await readFile(runtime, "utf8"), runtimeText);
    assert.equal(await readFile(evaluation, "utf8"), '{"run_id":');
    assert.equal(await exists(path.join(run, "state.json")), true);
    assert.deepEqual((await readdir(options.logDirectory)).sort(), ["evaluation.log", "runtime.log"]);
    await rm(evaluation);
    const outside = path.join(root, "outside.jsonl");
    await writeFile(outside, runtimeText);
    await symlink(outside, evaluation);
    await assert.rejects(deleteRun(options), /日志必须是普通文件/);
    assert.equal(await readFile(outside, "utf8"), runtimeText);
    const linked = path.join(options.outputDirectory, "linked-run");
    await symlink(run, linked);
    await assert.rejects(deleteRun({ ...options, runId: "linked-run" }), /不能是符号链接/);
    assert.equal(await exists(path.join(run, "state.json")), true);
    await assert.rejects(deleteRun({ ...options, runId: "../outside" }), /Invalid identifier/);
    assert.deepEqual((await readdir(options.outputDirectory)).sort(), ["delete-me", "linked-run"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("failed journal commits or run detachment restore both original journals and release the run lock", async () => {
  for (const failurePoint of ["evaluation.log", "run-directory"]) {
    const { root, options, run } = await fixture();
    try {
      await mkdir(options.logDirectory);
      const originals = new Map<string, string>();
      for (const name of ["runtime.log", "evaluation.log"]) {
        const file = path.join(options.logDirectory, name), text = JSON.stringify({ run_id: options.runId }) + "\r\n";
        await writeFile(file, text);
        originals.set(file, text);
      }
      let failed = false;
      await assert.rejects(deleteRun({ ...options, fileOperations: {
        rename: async (from, to) => {
          if (!failed && (failurePoint === "run-directory" ? from === run : path.basename(String(to)) === failurePoint)) {
            failed = true;
            throw new Error("fixture rename failure: " + failurePoint);
          }
          await rename(from, to);
        },
      } }), /fixture rename failure/);
      assert(failed);
      assert.equal(await exists(path.join(run, "state.json")), true);
      assert.equal(await exists(path.join(run, ".run-lock")), false);
      for (const [file, text] of originals) assert.equal(await readFile(file, "utf8"), text);
      assert.deepEqual((await readdir(options.outputDirectory)).sort(), [options.runId]);
      assert.deepEqual((await readdir(options.logDirectory)).sort(), ["evaluation.log", "runtime.log"]);
      assert.equal((await deleteRun(options)).deleted, true, "failed commits leave the run available for retry");
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("failed temporary-file cleanup still releases the run lock and preserves the deletion error", async () => {
  const { root, options, run } = await fixture();
  try {
    await mkdir(options.logDirectory);
    await writeFile(path.join(options.logDirectory, "runtime.log"), JSON.stringify({ run_id: options.runId }) + "\n");
    await writeFile(path.join(options.logDirectory, "evaluation.log"), "{broken");
    let cleanupFailed = false;
    await assert.rejects(deleteRun({ ...options, fileOperations: {
      remove: async (file, flags) => {
        if (!cleanupFailed && path.basename(String(file)).startsWith(".delete-")) {
          cleanupFailed = true;
          throw new Error("fixture cleanup failure");
        }
        await rm(file, flags);
      },
    } }), /日志记录不完整或损坏/);
    assert(cleanupFailed);
    assert.equal(await exists(path.join(run, ".run-lock")), false);
    assert.equal(await exists(path.join(run, "state.json")), true);
    const release = await runLock(run);
    await release();
  } finally { await rm(root, { recursive: true, force: true }); }
});
