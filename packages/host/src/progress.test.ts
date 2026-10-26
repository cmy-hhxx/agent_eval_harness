import test from "node:test";
import assert from "node:assert/strict";
import { emptyUsage, type PlannedTask, type RunState, type TaskState } from "@eval/contracts";
import { attributionScheduling } from "@eval/workflows/attribution";
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
    errors: [{ category: 'decision' as const, code: 'submission_rejected', path: '/', message: 'Review' }] };
  state.manifest.states.pending.status = 'running';
  state.manifest.states.pending.attempts=1;
  assert.equal(progressSnapshot(state).usage.unarchived_attempts,1);
  state.manifest.states.pending.failure = active;
  const review = progressSnapshot(state, 1000);
  assert.equal(review.running, 0);
  assert.equal(review.repairing, 1, 'a rejected draft is a content repair');
  active.errors[0].code = 'missing_evidence';
  assert.equal(progressSnapshot(state, 1000).repairing, 1);
  const preparing = progressSnapshot(state, 1000, new Set(['pending']));
  assert.equal(preparing.preparing, 1);
  assert.equal(preparing.running + preparing.repairing + preparing.queued, 0);
  assert.equal(preparing.updated_at, '1970-01-01T00:00:01.000Z');
});

test("attribution progress reports business session states instead of internal task acceptance", () => {
  const tasks: PlannedTask[] = [];
  for (let index = 0; index < 12; index++) {
    const id = `session-${index + 1}`;
    tasks.push(
      { id: `${id}-component`, stage: "attribution-component", inputIds: {}, dependencies: {},
        data: { stage: "attribution-component", candidate: { input_id: id } } },
      { id: `${id}-session`, stage: "attribution-session", inputIds: {},
        dependencies: { component: `${id}-component` }, data: { stage: "attribution-session", candidate: { input_id: id } } },
    );
  }
  const states: Record<string, TaskState> = Object.fromEntries(tasks.map(task => [task.id, { status: "pending", attempts: 0 }]));
  states["session-1-session"] = { status: "succeeded", attempts: 1 };
  states["session-2-component"] = { status: "running", attempts: 1 };
  states["session-3-component"] = { status: "blocked", attempts: 1 };
  states["session-4-component"] = { status: "failed", attempts: 1 };
  const state: RunState = {
    manifest: {
      format: "evaluation-run", runId: "attribution-progress", status: "running", debug: false,
      engine: { engine: "pi", version: "test", commit: "test", buildId: "test" }, evaluatorVersion: "test",
      config: {}, inputs: {}, preflight: {}, startedAt: 1, states, tasks,
    },
    receipts: {}, usage: emptyUsage(), recordedAttempts: 0,
  };
  const progress = progressSnapshot(state, 1, new Set(), attributionScheduling.sessionAdmission);
  assert.deepEqual({
    total: progress.total_sessions,
    active: progress.active_sessions,
    completed: progress.completed_sessions,
    waiting: progress.waiting_sessions,
    failed: progress.failed_sessions,
    blocked: progress.blocked_sessions,
  }, { total: 12, active: 8, completed: 1, waiting: 1, failed: 1, blocked: 1 });
  assert.equal(progress.accepted, 0, "internal task acceptance remains a separate count");
});
