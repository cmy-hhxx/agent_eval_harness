import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { readJson, writeJson } from "@eval/data";
import type { ModelRequestContext } from "@eval/host";
import { automationLlm, createAutomationLlm, loadLlmAllocations } from "../../../apps/host/src/automation-llm.js";
import { fixtureConfig } from "../../fixtures/comparison.js";

const call = (id: string): ModelRequestContext => ({ callId: id, runId: "run", taskId: id, stage: "attribution",
  model: { provider: "channel", model: "judge" } as ModelRequestContext["model"] });
const tick = () => new Promise(resolve => setImmediate(resolve));

test("sixteen prediction requests run while other sources wait; release only admits within source allocation", async t => {
  const llm = createAutomationLlm(["prediction", "ordinary"], { sources: {
    prediction: { concurrency: 16 }, ordinary: { concurrency: 0 },
  } }, async () => {});
  const releases = await Promise.all(Array.from({ length: 16 }, (_, i) => llm.acquire("prediction", "2026-10-01", call(String(i)), t.signal)));
  let entered = false;
  const extra = llm.acquire("prediction", "2026-10-01", call("extra"), t.signal).then(release => { entered = true; return release; });
  const other = new AbortController();
  const cancelled = assert.rejects(llm.acquire("ordinary", "2026-10-01", call("ordinary"), other.signal), /stopped/);
  await tick();
  assert.equal(llm.snapshot().active.length, 16);
  assert.equal(llm.snapshot().waiting.length, 2);
  assert.equal(entered, false);
  releases.shift()!(); const releaseExtra = await extra;
  assert.equal(llm.snapshot().active.length, 16);
  await llm.setConcurrency("prediction", 0);
  const held = llm.acquire("prediction", "2026-10-01", call("held"), t.signal);
  releases.forEach(release => release()); releaseExtra();
  assert.equal(llm.snapshot().active.length, 0);
  assert.equal(llm.snapshot().waiting.length, 2);
  other.abort(new Error("stopped")); await cancelled;
  await llm.setConcurrency("prediction", 1);
  (await held)();
  assert.equal(llm.snapshot().active.length, 0);
  assert.equal(llm.snapshot().waiting.length, 0);
});

test("allocations persist and failed saves do not take effect", async t => {
  const { directory } = await fixtureConfig();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "scheduling.json");
  await writeJson(file, { sources: { prediction: { concurrency: 16 }, ordinary: { concurrency: 0 } } });
  const llm = await automationLlm(file, { prediction: 4, ordinary: 4 });
  assert.equal(llm.concurrency("prediction"), 16);
  assert.equal(llm.concurrency("ordinary"), 0);
  assert.deepEqual(await readJson(file), { sources: { prediction: { concurrency: 16 }, ordinary: { concurrency: 0 } } });
  await llm.setConcurrency("ordinary", 3);
  assert.equal((await automationLlm(file, { ordinary: 4 })).concurrency("ordinary"), 3);
  const broken = createAutomationLlm(["prediction"], { sources: { prediction: { concurrency: 16 } } }, async () => { throw new Error("disk full"); });
  await assert.rejects(broken.setConcurrency("prediction", 0), /disk full/);
  assert.equal(broken.concurrency("prediction"), 16);
  await assert.rejects(llm.setConcurrency("ordinary", -1), /Invalid/);
  await writeJson(file, { sources: { prediction: { concurrency: 1.5 } } });
  await assert.rejects(loadLlmAllocations(file, {}), /Invalid/);
});

test("different dates and retries share one sixteen-call pool without cancelling live calls", async t => {
  const llm = createAutomationLlm(["prediction"], { sources: { prediction: { concurrency: 16 } } }, async () => {});
  const releases = await Promise.all(Array.from({ length: 16 }, (_, i) =>
    llm.acquire("prediction", "2026-09-27", { ...call(String(i)), runId: "active-date" }, t.signal)));
  let retryStarted = false, otherStarted = false;
  const retry = llm.acquire("prediction", "2026-09-25", { ...call("retry"), runId: "retry-date" }, t.signal)
    .then(release => { retryStarted = true; return release; });
  const other = llm.acquire("prediction", "2026-09-30", { ...call("other"), runId: "next-date" }, t.signal)
    .then(release => { otherStarted = true; return release; });
  await tick();
  assert.equal(retryStarted, false); assert.equal(otherStarted, false);
  releases.shift()!(); const releaseRetry = await retry;
  assert.equal(llm.snapshot().active.length, 16);
  assert.equal(otherStarted, false);
  releases.shift()!(); const releaseOther = await other;
  assert.equal(llm.snapshot().active.length, 16);
  assert.equal(new Set(llm.snapshot().active.map(item => item.date)).size, 3);
  releases.forEach(release => release()); releaseRetry(); releaseOther();
  assert.equal(llm.snapshot().active.length, 0);
});
