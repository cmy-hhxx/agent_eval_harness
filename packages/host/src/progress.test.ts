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
  assert.equal(progress.usage.archived_tokens,0);
  assert.equal(progress.usage.archived_attempts,3);
  assert.equal(progress.usage.unarchived_attempts,0);
  assert.match(progress.usage.scope,/零不代表未消耗/);
  assert.equal(progress.blocked, 1);
  assert.equal(progress.cancelled, 1);
  assert.equal(progress.queued, 1);
  assert.deepEqual(state, before);
  const active = { attemptId: 'a', contentSubmissions: 1, fileErrors: 0, repeatedErrors: 0, stopped: false, draft: {},
    errors: [{ category: 'decision' as const, code: 'completion_review_required', path: '/', message: 'Review' }] };
  state.manifest.states.pending.status = 'running';
  state.manifest.states.pending.attempts=1;
  assert.equal(progressSnapshot(state).usage.unarchived_attempts,1);
  state.manifest.states.pending.failure = active;
  const review = progressSnapshot(state, 1000);
  assert.equal(review.running, 1);
  assert.equal(review.repairing, 0, 'first completion confirmation is not a content repair');
  active.errors[0].code = 'missing_evidence';
  assert.equal(progressSnapshot(state, 1000).repairing, 1);
  const preparing = progressSnapshot(state, 1000, new Set(['pending']));
  assert.equal(preparing.preparing, 1);
  assert.equal(preparing.running + preparing.repairing + preparing.queued, 0);
  assert.equal(preparing.updated_at, '1970-01-01T00:00:01.000Z');
});
