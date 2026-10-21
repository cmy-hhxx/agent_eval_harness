import test from "node:test";
import assert from "node:assert/strict";
import { completedTopicScope, frozenTopicScope } from "./topic-clustering-scope.mjs";

function fixture() {
  return { checkpoint: { runId: "topic", status: "finished", pausedStages: [],
    inputs: { answer: { version: "b_post_train_fast", batch_id: "2026-10-19" } },
    tasks: { task: { stage: "attribution", inputIds: { answer: "answer" }, status: "succeeded",
      receipt: { submissionId: "accepted", acceptedAt: 1 } } } },
  job: { date: "2026-10-19", runIds: ["topic"], evaluation: "completed", sourceReady: true,
    download: "ready", observed: { b_post_train_fast: 1 }, downloaded: { b_post_train_fast: 1 } } };
}
const scope = f => completedTopicScope(f.checkpoint, f.job, "b_post_train_fast", "2026-10-19", "2026-10-21T00:00:00Z");

test("completed topic scope waits for both evaluation and full input promotion", () => {
  for (const change of [f => { f.checkpoint.status = "running"; }, f => { f.job.download = "downloading"; },
    f => { f.job.evaluation = "pending"; }, f => { f.job.observed.b_post_train_fast++; },
    f => { f.checkpoint.tasks.task.status = "pending"; }, f => { f.checkpoint.pausedStages = [{ stage: "attribution" }]; }]) {
    const f = fixture(); change(f); assert.throws(() => scope(f), /unfinished/);
  }
  const result = scope(fixture());
  assert.equal(result.kind, "full-evaluation"); assert.equal(result.sourceEvaluationComplete, true);
  assert.deepEqual(result.accepted, [{ taskId: "task", inputId: "answer", submissionId: "accepted", acceptedAt: 1 }]);
});

test("final scope explicitly accounts for terminal exclusions and selects the latest accepted answer receipt", () => {
  const f = fixture();
  f.checkpoint.inputs.excluded = { version: "b_post_train_fast", batch_id: "2026-10-19" };
  f.checkpoint.tasks.failed = { stage: "attribution", status: "failed", inputIds: { answer: "excluded" } };
  f.checkpoint.tasks.review = { ...structuredClone(f.checkpoint.tasks.task), receipt: { submissionId: "reviewed", acceptedAt: 2 } };
  f.checkpoint.tasks.comparison = { stage: "comparison", status: "succeeded", inputIds: { B: "answer" } };
  const result = scope(f);
  assert.equal(result.targetAttributions, 2); assert.equal(result.acceptedAttributions, 1); assert.equal(result.excludedAttributions, 1);
  assert.equal(result.accepted[0].submissionId, "reviewed");
  assert.deepEqual(result.excluded, [{ taskId: "failed", inputId: "excluded", status: "failed" }]);
  delete f.checkpoint.tasks.review.receipt;
  assert.throws(() => scope(f), /missing its receipt/);
});

test("retired pair work outside the execution scope does not block completed B-model clustering", () => {
  const f = fixture();
  f.checkpoint.executionScope = ["task"];
  f.checkpoint.tasks.retired = { stage: "rewrite", status: "pending" };
  assert.equal(scope(f).acceptedAttributions, 1);
  f.checkpoint.executionScope.push("retired");
  assert.throws(() => scope(f), /unfinished/);
});

test("a frozen topic cutoff excludes later results and rejects changed accepted identities", () => {
  const f = fixture(), full = scope(f);
  const frozen = { ...full, kind: "accepted-at-cutoff", sourceEvaluationComplete: false };
  f.checkpoint.status = "running";
  f.checkpoint.tasks.later = { ...structuredClone(f.checkpoint.tasks.task), inputIds: { answer: "later" } };
  f.checkpoint.inputs.later = { version: "b_post_train_fast", batch_id: "2026-10-19" };
  assert.deepEqual(frozenTopicScope(f.checkpoint, frozen, "b_post_train_fast", "2026-10-19").selectedInputs, ["answer"]);
  for (const change of [
    (checkpoint, cut) => { checkpoint.tasks.task.receipt.submissionId = "changed"; },
    (checkpoint, cut) => { checkpoint.inputs.answer.version = "b_fast"; },
    (checkpoint, cut) => { cut.accepted.push(cut.accepted[0]); },
    (checkpoint, cut) => { cut.sourceEvaluationComplete = true; },
    (checkpoint, cut) => { cut.capturedAt = "1970-01-01T00:00:00Z"; },
  ]) {
    const checkpoint = structuredClone(f.checkpoint), cut = structuredClone(frozen);
    change(checkpoint, cut);
    assert.throws(() => frozenTopicScope(checkpoint, cut, "b_post_train_fast", "2026-10-19"));
  }
});
