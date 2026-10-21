import test from "node:test";
import assert from "node:assert/strict";
import { emptyUsage, type RunState } from "@eval/contracts";
import { comparisonCodec, restore } from "./codec.js";

test("repeated checkpoints reuse immutable submission differences and refresh replaced bodies", () => {
  let reads = 0;
  const evaluation = { items: ["first", "second"] };
  const submitted = { get items() { reads++; return ["second", "first"]; } };
  const receipt = {
    taskId: "task", submissionId: "submission", attemptId: "attempt", status: "succeeded",
    acceptedAt: 1, evaluatorVersion: "test", evaluation, submitted,
  };
  const state = {
    manifest: { format: "evaluation-run", evaluatorVersion: "test", config: { inputs: {} },
      preflight: { by_batch: {} }, inputCatalog: [],
      tasks: [{ id: "task", stage: "criteria", inputIds: {}, dependencies: [], data: { stage: "criteria", candidates: {} } }],
      states: { task: { status: "succeeded", attempts: 1 } } },
    receipts: { task: receipt }, usage: emptyUsage(), recordedAttempts: 1,
  } as unknown as RunState;
  const first = comparisonCodec.encode(state), firstReads = reads;
  assert(firstReads > 0);
  state.receipts.task = { ...state.receipts.task };
  const second = comparisonCodec.encode(state);
  assert.equal(reads, firstReads, "copying a receipt wrapper must not traverse its accepted submission again");
  assert.deepEqual(second, first);
  assert.deepEqual(restore(evaluation, second.tasks.task.receipt!.submittedPatch!), { items: ["second", "first"] });

  state.receipts.task.submitted = { items: ["replacement"] };
  const replaced = comparisonCodec.encode(state);
  assert.deepEqual(restore(evaluation, replaced.tasks.task.receipt!.submittedPatch!), { items: ["replacement"] });
  state.receipts.task.evaluation = { items: ["replacement"] };
  assert.deepEqual(comparisonCodec.encode(state).tasks.task.receipt!.submittedPatch, []);
});

test("exported recovery patches reuse immutable rows and refresh either replaced body", () => {
  let reads = 0;
  const evaluation = { items: ["original"] };
  const row = { get result() { reads++; return { items: ["published"] }; } };
  const state = {
    manifest: { format: "evaluation-run", evaluatorVersion: "test", config: { inputs: {} },
      preflight: { by_batch: {} }, inputCatalog: [],
      tasks: [{ id: "task", stage: "criteria", inputIds: {}, dependencies: [], data: { stage: "criteria", candidates: {} } }],
      states: { task: { status: "succeeded", attempts: 1 } } },
    receipts: { task: { taskId: "task", submissionId: "submission", attemptId: "attempt", status: "succeeded",
      acceptedAt: 1, evaluatorVersion: "test", evaluation, exported: { id: "task", row } } },
    usage: emptyUsage(), recordedAttempts: 1,
  } as unknown as RunState;
  const first = comparisonCodec.encode(state), firstReads = reads;
  assert(firstReads > 0);
  state.receipts.task = { ...state.receipts.task };
  assert.deepEqual(comparisonCodec.encode(state), first);
  assert.equal(reads, firstReads, "saved receipt wrappers must not re-project the same accepted row");
  const replacement = { result: { items: ["original"] } };
  state.receipts.task.exported = { id: "task", row: replacement };
  assert.equal(comparisonCodec.encode(state).tasks.task.receipt!.evaluationPatch, undefined);
  state.receipts.task.evaluation = { items: ["updated"] };
  const patch = comparisonCodec.encode(state).tasks.task.receipt!.evaluationPatch!;
  assert.deepEqual(restore(replacement.result, patch), { items: ["updated"] });
});

test("exported comparison patches keep candidate identity when the label mapping changes", () => {
  const basis = { tradeoff: "", comparisons: [], decisive_findings: [] };
  const evaluation = { status: "decided", review_requests: [], task_analysis: {},
    ranking: [["A"], ["B"]], assessments: { A: {}, B: {} }, decision_basis: basis };
  const row = { task_analysis: {}, ranking: [["a_fast"], ["b_fast"]],
    assessments: { a_fast: {}, b_fast: {} }, decision_basis: basis };
  const data = { stage: "comparison", candidates: { A: { version: "a_fast" }, B: { version: "b_fast" } } };
  const state = {
    manifest: { format: "evaluation-run", evaluatorVersion: "test", config: { inputs: {} },
      preflight: { by_batch: {} }, inputCatalog: [],
      tasks: [{ id: "task", stage: "comparison", inputIds: {}, dependencies: [], data }],
      states: { task: { status: "succeeded", attempts: 1 } } },
    receipts: { task: { taskId: "task", submissionId: "submission", attemptId: "attempt", status: "succeeded",
      acceptedAt: 1, evaluatorVersion: "test", evaluation, exported: { id: "comparison", row } } },
    usage: emptyUsage(), recordedAttempts: 1,
  } as unknown as RunState;
  assert.equal(comparisonCodec.encode(state).tasks.task.receipt!.evaluationPatch, undefined);
  data.candidates = { A: { version: "b_fast" }, B: { version: "a_fast" } };
  const patch = comparisonCodec.encode(state).tasks.task.receipt!.evaluationPatch!;
  assert(patch.length > 0);
  assert.deepEqual(restore({ ...evaluation, ranking: [["B"], ["A"]] }, patch), evaluation);
});
