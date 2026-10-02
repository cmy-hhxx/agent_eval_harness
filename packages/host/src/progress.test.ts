import test from "node:test";
import assert from "node:assert/strict";
import { emptyUsage, type RunState, type TaskState } from "@eval/contracts";
import { progressSnapshot } from "./progress.js";

test("progress separates execution failures from dependency blocks and cancellations", () => {
  const states: Record<string, TaskState> = {
    failed: { status: "failed", attempts: 1, failure: {
      attemptId: "attempt", errors: [{ category: "file", code: "missing", path: "/path", message: "missing file" }],
      contentSubmissions: 0, fileErrors: 1, repeatedErrors: 0, stopped: false,
    } },
    timed_out: { status: "timed_out", attempts: 1 },
    blocked: { status: "blocked", attempts: 0, reason: "Dependency did not succeed" },
    cancelled: { status: "cancelled", attempts: 1 },
    pending: { status: "pending", attempts: 0 },
  };
  const state: RunState = {
    manifest: {
      format: "evaluation-run", runId: "progress", status: "finished", debug: false,
      engine: { engine: "pi", version: "test", commit: "test", buildId: "test" }, evaluatorVersion: "test",
      config: {}, inputs: {}, preflight: {}, startedAt: 1, states,
      tasks: Object.keys(states).map(id => ({ id, stage: "criteria", inputIds: {}, dependencies: {}, data: {} })),
    },
    receipts: {}, usage: emptyUsage(), recordedAttempts: 3,
  };
  const before = structuredClone(state);
  const progress = progressSnapshot(state);
  assert.deepEqual(progress.failures, { file: 1, interruption: 1 });
  assert.equal(progress.blocked, 1);
  assert.equal(progress.cancelled, 1);
  assert.equal(progress.queued, 1);
  assert.deepEqual(state, before);
});
