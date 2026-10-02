import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFileLogger, withLogWriterLock } from "./logging.js";

test("shared log locking refuses incomplete owners and recovery markers without retrying them", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "eval-logs-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lock = path.join(directory, ".run-lock"), guard = lock + ".reclaim";
  for (const recovery of [false, true]) {
    if (recovery) await mkdir(guard);
    else await writeFile(lock, "{}");
    let entered = false, timer: ReturnType<typeof setTimeout> | undefined;
    const operation = withLogWriterLock(directory, async () => { entered = true; });
    try {
      await assert.rejects(Promise.race([operation, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Invalid lock was retried")), 1000);
      })]), recovery ? /recovery in progress/ : /lock is incomplete/);
      assert.equal(entered, false);
    } finally {
      clearTimeout(timer);
      await rm(recovery ? guard : lock, { recursive: true, force: true });
      await operation.catch(() => {});
    }
  }
});

test("shared log locking allows a bounded initialization window for a competing writer", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "eval-logs-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lock = path.join(directory, ".run-lock");
  await writeFile(lock, "");
  const initialized = new Promise<void>((resolve, reject) => {
    setTimeout(() => {
      writeFile(lock, JSON.stringify({ pid: 2147483647, token: "initialized-owner" })).then(resolve, reject);
    }, 10);
  });
  let entered = false;
  try { await withLogWriterLock(directory, async () => { entered = true; }); }
  finally { await initialized; }
  assert.equal(entered, true);
});

const row = {
  time: new Date().toISOString(),
  workflow: "test",
  run_id: "run",
  task_id: "task",
  attempt_id: "attempt",
  submission_id: "submission",
  stage: "test",
  result: { score: 1 },
};
const readRows = async (file: string) =>
  (await readFile(file, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
const options = (root: string) => ({
  directory: path.join(root, "log"),
  lockDirectory: path.join(root, "locks"),
});

test("logs serialize multiple processes, retain single JSON lines and deduplicate durable submissions", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "eval-logs-"));
  try {
    const child = fileURLToPath(new URL("../../../tests/fixtures/log-child.js", import.meta.url));
    await Promise.all(
      ["a", "b", "c"].map((id) => promisify(execFile)(process.execPath, [child, directory, id])),
    );
    const rows = await readRows(path.join(directory, "log/evaluation.log"));
    assert.equal(rows.length, 28);
    assert(rows.every((r) => r.result.text === "中文🙂\n".repeat(20_000)));
    assert.equal((await readRows(path.join(directory, "log/runtime.log"))).length, 3);
    const restarted = createFileLogger(options(directory));
    assert(await restarted.evaluation(rows[0]));
    assert.equal((await readRows(path.join(directory, "log/evaluation.log"))).length, 28);
    assert.deepEqual((await readdir(path.join(directory, "log"))).sort(), ["evaluation.log", "runtime.log"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("errors retain all occurrences and full redacted details; interrupted tails recover without losing complete records", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "eval-logs-"));
  try {
    const logger = createFileLogger({
      ...options(directory),
      secrets: [JSON.stringify({ credential: "private-key" })],
    });
    const context = { component: "host", event: "failed", run_id: "run", attempt_id: "attempt" };
    await logger.error(
      new Error("failed: " + JSON.stringify({ credential: "private-key" }) + "\nnext line"),
      { ...context, task_id: "a" },
    );
    await logger.error(
      new Error("failed: " + JSON.stringify({ credential: "private-key" }) + "\nnext line"),
      { ...context, task_id: "b" },
    );
    await logger.error(
      new Error("failed: " + JSON.stringify({ credential: "private-key" }) + "\nnext line"),
      { ...context, task_id: "a" },
    );
    await logger.evaluation(row);
    const runtime = path.join(directory, "log/runtime.log"),
      evaluation = path.join(directory, "log/evaluation.log");
    const text = await readFile(runtime, "utf8");
    assert(!text.includes("private-key"));
    assert.equal((await readRows(runtime)).length, 3, "errors are not merged even with the same task and attempt");
    const old = (await readRows(runtime))[0];
    old.time = new Date(Date.now() - 61_000).toISOString();
    await writeFile(runtime, JSON.stringify(old) + "\n");
    await appendFile(evaluation, '{"time":"interrupted');
    const restarted = createFileLogger({
      ...options(directory),
      secrets: [JSON.stringify({ credential: "private-key" })],
    });
    await restarted.error(
      new Error("failed: " + JSON.stringify({ credential: "private-key" }) + "\nnext line"),
      context,
    );
    assert.equal((await readRows(runtime)).length, 2);
    const longError = new Error("raw detail\n".repeat(1000), { cause: new Error("original " + JSON.stringify({ credential: "private-key" })) });
    await restarted.error(longError, context);
    const last = (await readRows(runtime)).at(-1);
    assert.equal(last.message, longError.message);
    assert.equal(last.stack, longError.stack);
    assert.match(last.detail, /original \[REDACTED\]/);
    assert(!last.detail.includes("private-key"));
    assert(await restarted.evaluation(row));
    assert.deepEqual(await readRows(evaluation), [row]);
    assert(await restarted.evaluation({ ...row, task_id: "next", submission_id: "next" }));
    assert.equal((await readRows(evaluation)).length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("log I/O failure is visible once and does not throw into evaluation commits", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "eval-logs-"));
  const fallback = t.mock.method(console, "error", () => {});
  try {
    await writeFile(path.join(directory, "log"), "not a directory");
    const logger = createFileLogger(options(directory));
    assert.equal(await logger.evaluation(row), false);
    assert.equal(await logger.evaluation(row), false);
    await logger.error("failure", { component: "test", event: "failed" });
    assert.equal(fallback.mock.calls.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("automation lifecycle events use the shared runtime journal and redact context", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "eval-logs-"));
  try {
    const logger = createFileLogger({ ...options(directory), secrets: ["private-key"] });
    await logger.event("input_updated", { component: "automations", automation_id: "test", date: "2026-09-29", run_id: "daily-2026-09-29", detail: "private-key" });
    const records = await readRows(path.join(directory, "log/runtime.log"));
    assert.equal(records[0].level, "info");
    assert.equal(records[0].automation_id, "test");
    assert(!JSON.stringify(records).includes("private-key"));
    await logger.error("network unavailable", { component: "automations", event: "download_failed" });
    await logger.error("network unavailable", { component: "automations", event: "download_failed" });
    assert.equal((await readRows(path.join(directory, "log/runtime.log"))).length, 3, "distinct pipeline failures are retained without a task attempt id");
    assert.deepEqual((await readdir(path.join(directory, "log"))).sort(), ["evaluation.log", "runtime.log"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
