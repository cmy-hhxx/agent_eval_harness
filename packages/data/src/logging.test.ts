import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFileLogger } from "./logging.js";

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
    assert.equal((await readRows(path.join(directory, "log/runtime.log"))).length, 1);
    const restarted = createFileLogger(options(directory));
    assert(await restarted.evaluation(rows[0]));
    assert.equal((await readRows(path.join(directory, "log/evaluation.log"))).length, 28);
    assert.deepEqual((await readdir(path.join(directory, "log"))).sort(), ["evaluation.log", "runtime.log"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("errors are redacted and rate limited across instances; interrupted tails recover without losing complete records", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "eval-logs-"));
  try {
    const logger = createFileLogger({
      ...options(directory),
      secrets: [JSON.stringify({ credential: "private-key" })],
    });
    const context = { component: "host", event: "failed", run_id: "run" };
    await logger.error(
      new Error("failed: " + JSON.stringify({ credential: "private-key" }) + "\nnext line"),
      { ...context, task_id: "a" },
    );
    await logger.error(
      new Error("failed: " + JSON.stringify({ credential: "private-key" }) + "\nnext line"),
      { ...context, task_id: "b" },
    );
    await logger.evaluation(row);
    const runtime = path.join(directory, "log/runtime.log"),
      evaluation = path.join(directory, "log/evaluation.log");
    const text = await readFile(runtime, "utf8");
    assert(!text.includes("private-key"));
    assert.equal((await readRows(runtime)).length, 1);
    const old = JSON.parse(text);
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
