import test from "node:test";
import assert from "node:assert/strict";
import type { AttemptSpec, PlannedTask } from "@eval/contracts";
import { createModelRequests } from "./model-requests.js";

test("manual model waits extend deadlines, validate live attempts and clean up on cancellation", async t => {
  let grant!: () => void, releaseCount = 0;
  const pending = new Promise<void>(resolve => { grant = resolve; });
  const requests = createModelRequests({ concurrency: () => 1, acquire: async (context, signal) => {
    await Promise.race([pending, new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))]);
    return { model: context.model, release: () => { releaseCount++; } };
  } });
  const spec = { attemptId: "attempt", runId: "run", deadline: Date.now() + 500, model: {} } as AttemptSpec;
  requests.register(spec, { id: "task", stage: "comparison" } as PlannedTask);
  await assert.rejects(requests.acquire("unknown", "call", t.signal), /Unknown/);
  const waiting = requests.acquire("attempt", "call", t.signal);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert(requests.deadline(spec) >= spec.deadline + 20);
  await assert.rejects(requests.acquire("attempt", "call", t.signal), /Duplicate/);
  grant(); await waiting;
  const extended = requests.deadline(spec);
  assert(extended >= spec.deadline + 20);
  requests.remove("attempt");
  assert.equal(releaseCount, 1);
  requests.release("attempt", "call");
  assert.equal(releaseCount, 1);
});

test("stopping admission rejects queued and future calls while retaining active permits until completion", async t => {
  let released = 0;
  const requests = createModelRequests({ concurrency: () => 1, async acquire(context, signal) {
    if (context.callId === "active") return { model: context.model, release() { released++; } };
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } });
  const spec = { attemptId: "attempt", runId: "run", deadline: Date.now() + 500, model: {} } as AttemptSpec;
  requests.register(spec, { id: "task", stage: "comparison" } as PlannedTask);
  await requests.acquire("attempt", "active", t.signal);
  const queued = requests.acquire("attempt", "queued", t.signal);
  requests.stopAdmission(new Error("run fault"));
  await assert.rejects(queued, /run fault/);
  await assert.rejects(requests.acquire("attempt", "future", t.signal), /run fault/);
  assert.equal(released, 0);
  requests.release("attempt", "active");
  requests.remove("attempt");
  assert.equal(released, 1);
});
