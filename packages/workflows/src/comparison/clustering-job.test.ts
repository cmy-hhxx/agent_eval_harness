import test from "node:test";
import assert from "node:assert/strict";
import { emptyUsage, type PlannedTask, type RunState, type SubmissionReceipt } from "@eval/contracts";
import { clusteringJobWorkflow } from "./clustering-job.js";

function fixture(frozen: boolean): RunState {
  const source = (id: string): PlannedTask => ({ id, stage: "clustering", inputIds: {}, dependencies: {},
    data: { model: "model", itemIds: [], consolidate: true } });
  const rewrite = (id: string, from: string): PlannedTask => ({ id, stage: "rewrite", inputIds: {},
    dependencies: { source: from }, data: { model: "model", itemIds: [], rewriteOf: from } });
  const tasks = [source("empty"), rewrite("empty-rewrite", "empty"), rewrite("failed-empty-rewrite", "empty"),
    source("words"), rewrite("words-rewrite", "words"), rewrite("accepted-rewrite", "words"),
    source("pending"), rewrite("pending-rewrite", "pending"),
    { ...source("next"), dependencies: { previous: "empty" } }];
  const receipt = (taskId: string, evaluation: unknown): SubmissionReceipt => ({ taskId, evaluation,
    attemptId: taskId + "-attempt", submissionId: taskId + "-submission", evaluatorVersion: "fixture",
    judge: "fixture", status: "succeeded", acceptedAt: 1, audit: {} as SubmissionReceipt["audit"], usage: emptyUsage() });
  const receipts = {
    empty: receipt("empty", { assignments: [], new_classes: [], merges: [], class_updates: [] }),
    words: receipt("words", { assignments: [{ item_id: "item", deferred_reason: "独立回答数量不足。" }],
      new_classes: [], merges: [] }),
    "accepted-rewrite": receipt("accepted-rewrite", { rewrites: [{ id: "assignments.0.deferred_reason", text: "样本还不够。" }] }),
  };
  return { manifest: { runId: "fixture", config: { clusteringJob: { runs: [], sources: [] } },
    tasks, states: Object.fromEntries(tasks.map(task => [task.id, task.id === "failed-empty-rewrite"
      ? { status: "failed", attempts: 2, attemptId: "paid-attempt", reason: "API 400", failure: { code: "empty_enum" } }
      : { status: Object.hasOwn(receipts, task.id) ? "succeeded" : "pending", attempts: Object.hasOwn(receipts, task.id) ? 1 : 0 }])),
    ...(frozen ? { executionScope: tasks.map(task => task.id) } : {}), preflight: {} },
    receipts, usage: emptyUsage(), recordedAttempts: 4 } as unknown as RunState;
}

test("standalone clustering skips zero-slot Rewrite after acceptance and on resume while retaining the attempt ledger", async () => {
  for (const frozen of [false, true]) {
    for (const resumed of [false, true]) {
      const state = fixture(frozen), before = structuredClone(state), source = state.manifest.tasks[0]!;
      if (resumed) await clusteringJobWorkflow.reconcile!("/fixture-unused", state, state.manifest.config);
      else clusteringJobWorkflow.advance?.(source, state.receipts.empty!, state, {});
      assert(state.manifest.executionScope, "empty text work is excluded through the Host execution scope");
      assert(!state.manifest.executionScope.includes("empty-rewrite"), "no zero-slot request reaches the Rewrite schema");
      assert(!state.manifest.executionScope.includes("failed-empty-rewrite"), "resume does not redispatch a paid empty request");
      for (const id of ["empty", "words-rewrite", "accepted-rewrite", "pending-rewrite", "next"])
        assert(state.manifest.executionScope.includes(id), "other work remains selected: " + id);
      assert.equal(state.manifest.tasks.find(task => task.id === "next")!.dependencies.previous, "empty",
        "the next clustering task depends on the accepted clustering source, not its skipped prose");
      assert.deepEqual(state.receipts, before.receipts, "skipping must not create accepted Rewrite receipts");
      assert.deepEqual(state.manifest.tasks, before.manifest.tasks, "all planned task identities are retained");
      assert.deepEqual(state.manifest.states, before.manifest.states, "paid attempts, failures and progress remain intact");
      assert.deepEqual(state.usage, before.usage);
      assert.equal(state.recordedAttempts, before.recordedAttempts);
    }
  }
});
