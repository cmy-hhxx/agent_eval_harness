import test from "node:test";
import assert from "node:assert/strict";
import type { AutomationJob } from "./index.js";
import { createEvaluationScheduler } from "./evaluation-scheduler.js";

const job = (date: string, evaluation: AutomationJob["evaluation"] = "pending"): AutomationJob => ({
  date, evaluation, download: "ready", runIds: [date], adopted: false, observed: {},
  checkedAt: 0, downloadAttempts: 0, evaluationAttempts: 0, nextDownloadAt: 0, nextEvaluationAt: 0,
});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("dates fill vacant slots and due retries precede new dates without rerunning accepted work", async () => {
  let capacity = 2;
  const started: string[] = [], release = new Map<string, () => void>(), errors: unknown[] = [];
  const jobs = [job("01"), job("02"), job("03", "completed"), job("04", "retry")];
  const scheduler = createEvaluationScheduler(() => capacity, async current => {
    started.push(current.date); current.evaluation = "evaluating";
    await new Promise<void>(resolve => release.set(current.date, resolve));
    current.evaluation = "completed";
  }, error => errors.push(error));
  scheduler.tick(jobs); await tick();
  assert.deepEqual(started, ["04", "01"]);
  scheduler.tick(jobs); await tick();
  assert.equal(started.length, 2);
  capacity = 0;
  release.get("04")!(); await tick(); scheduler.tick(jobs); await tick();
  assert.equal(scheduler.size, 1, "lowering capacity preserves the other running date");
  assert.deepEqual(started, ["04", "01"]);
  capacity = 2;
  scheduler.tick(jobs); await tick();
  assert.deepEqual(started, ["04", "01", "02"], "vacant slot fills before date 01 ends");
  release.get("01")!(); release.get("02")!(); await scheduler.settled();
  scheduler.tick(jobs); await tick();
  assert.equal(scheduler.size, 0); assert.deepEqual(errors, []);
});

test("an existing evaluation can be retained while other dates start", async () => {
  const active = job("01", "evaluating"), next = job("02");
  let finish!: () => void, calls = 0;
  const inFlight = new Promise<void>(resolve => { finish = resolve; });
  const scheduler = createEvaluationScheduler(() => 2, async current => {
    calls++; current.evaluation = "completed";
  }, error => { throw error; });
  scheduler.track(active, inFlight);
  scheduler.tick([active, next]); await tick();
  assert.equal(calls, 1); assert.equal(scheduler.size, 1);
  finish(); await scheduler.settled();
});

test("backoff, incomplete downloads and once mode do not launch evaluations", async () => {
  const retry = job("01", "retry"), future = job("02"), downloading = job("03");
  future.nextEvaluationAt = Date.now() + 60_000; downloading.download = "downloading";
  let calls = 0;
  const scheduler = createEvaluationScheduler(() => 16, async () => { calls++; }, () => {}, true);
  scheduler.tick([retry, future, downloading]); await tick();
  assert.equal(calls, 0);
});

test("a due retry uses the installed snapshot while the next snapshot downloads", async () => {
  const retry = job("01", "retry"), initial = job("02"), installing = job("03");
  retry.download = initial.download = "downloading";
  retry.downloaded = { a_fast: 2 };
  installing.download = "installing"; installing.downloaded = { a_fast: 2 };
  const started: string[] = [];
  const scheduler = createEvaluationScheduler(() => 16, async current => {
    started.push(current.date); current.evaluation = "completed";
  }, error => { throw error; });
  scheduler.tick([retry, initial, installing]); await scheduler.settled();
  scheduler.tick([retry, initial, installing]); await tick();
  assert.deepEqual(started, ["01"]);
});
