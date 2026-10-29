import test from "node:test";
import assert from "node:assert/strict";
import { emptyUsage, type PlannedTask, type RunState, type SubmissionReceipt, type TaskState } from "@eval/contracts";
import { attributionScheduling } from "@eval/workflows/attribution";
import { progressSnapshot, inputDiagnostics } from "./progress.js";

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
  const receipt: SubmissionReceipt = { taskId: 'complete', attemptId: 'a', submissionId: 's', evaluatorVersion: 'test',
    judge: 'test', status: 'succeeded', acceptedAt: 500, evaluation: {},
    audit: { calls: 0, requiredReadCalls: 0, traceReads: [], viewedImages: [], calculations: [], artifacts: [] }, usage: emptyUsage() };
  for (const id of ['complete', 'partial']) {
    state.manifest.tasks.push({ id, stage: 'summary', inputIds: {}, dependencies: {}, data: {} });
    state.manifest.states[id] = { status: 'succeeded', attempts: 1 };
    state.receipts[id] = { ...receipt, taskId: id, ...(id === 'partial' ? { incompleteDependencies: ['timed_out'] } : {}) };
  }
  for (const [id, source, settled] of [['soft', 'timed_out', true], ['strict', 'timed_out', false], ['paused', 'cancelled', true]] as const) {
    state.manifest.tasks.push({ id, stage: 'summary', inputIds: {}, dependencies: { source },
      ...(settled ? { settledDependencies: ['source'] } : {}), data: {} });
    state.manifest.states[id] = { status: 'pending', attempts: 0 };
  }
  const counted = progressSnapshot(state, 1000);
  assert.deepEqual([counted.accepted, counted.complete, counted.partial], [2, 1, 1]);
  assert.equal(counted.formal_result_count, 0, "accepted internal receipts are not yet formal rows");
  state.receipts.complete.exported = { file: "summary.jsonl", id: "same-row", row: {} };
  state.receipts.partial.exported = { file: "summary.jsonl", id: "same-row", row: {} };
  assert.equal(progressSnapshot(state, 1000).formal_result_count, 1, "multiple internal tasks can refer to one formal row");
  assert.deepEqual([counted.stages.summary!.accepted, counted.stages.summary!.complete, counted.stages.summary!.partial], [2, 1, 1]);
  assert.equal(counted.stages.summary!.ready, 1, 'only a terminal failure can release a settled dependency');
  assert.equal(progressSnapshot(state, 1000, new Set(['timed_out'])).stages.summary!.ready, 0);
});

test("input diagnostics count rejected source rows separately from unlocated group issues", () => {
  assert.deepEqual(inputDiagnostics({ issues: [
    { source: "/input/a.jsonl", line: 2, version: "a" },
    { version: "a", sources: [{ source: "/input/a.jsonl", line: 2 }, { source: "/input/a.jsonl", line: 3 }] },
    { case_id: "unmatched", reason: "no matching comparison" },
  ] }), { input_rejected: 2, input_issue_count: 3 });
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
      config: { execution: { sessionWindow: 8 } }, inputs: {}, preflight: {}, startedAt: 1, states, tasks,
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
