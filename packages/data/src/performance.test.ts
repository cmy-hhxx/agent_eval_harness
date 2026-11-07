import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPerformanceLog } from "./performance.js";

const row = (taskId: string) => ({
  runId: "run", taskId, stage: "attribution-component", attemptId: taskId + "-attempt", attempt: 1,
  status: "succeeded", confirmed: true, channel: "gateway", model: "judge",
  modelUsage: [{ channel: "gateway", model: "judge", usage: { input: 10, output: 100, cacheRead: 300, cacheWrite: 690, totalTokens: 1100 }, reasoningTokens: 60 }],
  inputIds: { answer: "input-1" }, identity: { version: "aime_fast", case_id: "c1" },
  usage: { input: 10, output: 100, cacheRead: 300, cacheWrite: 690, totalTokens: 1100 },
  reasoningTokens: 60, calls: 2, requiredReadCalls: 1, contentSubmissions: 2,
  submissionCodes: { tool_error_severity: 1 }, firstSubmissionAccepted: false,
  timings: { modelMs: 5000, queuedMs: 1200 },
  startedAt: "2026-11-06T00:00:00.000Z", finishedAt: "2026-11-06T00:00:06.000Z", wallMs: 6000,
});

test("performance rows keep usage, cache hit ratio and identity per attempt", async () => {
  const run = await mkdtemp(path.join(os.tmpdir(), "perf-"));
  const log = createPerformanceLog(run);
  await Promise.all([log.record(row("t1")), log.record(row("t2"))]);
  await log.close();
  const lines = (await readFile(path.join(run, "performance.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(lines.map(line => line.task_id).sort(), ["t1", "t2"]);
  assert.equal(lines[0].cache_hit_ratio, 0.3);
  assert.equal(lines[0].reasoning_tokens, 60);
  assert.deepEqual(lines[0].model_usage, row("t1").modelUsage);
  assert.deepEqual(lines[0].identity, { version: "aime_fast", case_id: "c1" });
  assert.equal(lines[0].usage.output, 100);
});

test("a failed row does not stop later rows", async () => {
  const run = await mkdtemp(path.join(os.tmpdir(), "perf-"));
  const log = createPerformanceLog(run);
  const broken = { ...row("bad"), identity: 1n as unknown as Record<string, unknown> };
  await assert.rejects(log.record(broken));
  await log.record(row("good"));
  await log.close();
  const lines = (await readFile(path.join(run, "performance.jsonl"), "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).task_id, "good");
});
