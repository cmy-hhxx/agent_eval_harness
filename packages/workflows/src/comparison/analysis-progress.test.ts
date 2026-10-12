import test from "node:test";
import assert from "node:assert/strict";
import { analysisProgress, analysisTaskPurpose } from "./analysis-progress.js";
import type { Checkpoint } from "./codec.js";

type Task = Checkpoint["tasks"][string];
const task = (stage: Task["stage"], status: Task["status"], data: Task["data"] = { reference: null }, inputIds: Task["inputIds"] = {}, file?: string): Task => ({
  stage, status, data, inputIds, dependencies: {}, attempts: 1,
  ...(file !== undefined ? { receipt: { exported: { ...(file ? { file } : {}), comparisonId: "comparison" } } as Task["receipt"] } : {}),
});

test("time scope distinguishes evaluation, accepted-result dates and unknown source dates", () => {
  const start = Date.parse("2026-10-09T23:00:00Z"), end = Date.parse("2026-10-10T12:00:00Z");
  const accepted = task("comparison", "succeeded", { reference: null }, {}, "");
  accepted.receipt!.acceptedAt = start + 3600000;
  const ignored = task("comparison", "succeeded", { reference: null }, {}, "comparison-review.jsonl");
  ignored.receipt!.acceptedAt = end;
  const saved = { runId: "run", status: "finished", startedAt: start, finishedAt: end,
    config: { inputs: { versions: [] } }, inputs: {}, tasks: { accepted, ignored } } as unknown as Parameters<typeof analysisProgress>[0];
  assert.deepEqual(analysisProgress(saved).timeScope, { timeZone: "Asia/Shanghai",
    evaluation: { from: "2026-10-10T07:00:00.000+08:00", to: "2026-10-10T20:00:00.000+08:00" },
    acceptedResults: { from: "2026-10-10T08:00:00.000+08:00", through: "2026-10-10T08:00:00.000+08:00" }, sampleTimeRange: null });
  assert.deepEqual(analysisProgress({ ...saved, status: "running", finishedAt: undefined, tasks: {} }).timeScope,
    { timeZone: "Asia/Shanghai", evaluation: { from: "2026-10-10T07:00:00.000+08:00", to: null },
      acceptedResults: { from: null, through: null }, sampleTimeRange: null });
});

test("whole-run progress counts business identities and accepted outputs without counting peers or optional audits as formal results", () => {
  const saved = {
    runId: "run", status: "finished", startedAt: 10, finishedAt: 20,
    config: { inputs: { versions: [
      { id: "a_fast", name: "A", display_name: "A组Fast", comparison_tier: "Fast" },
      { id: "a_expert", name: "A Expert", comparison_tier: "Expert" },
      { id: "b_fast", name: "B Fast" },
    ] } },
    inputs: {
      own: { version: "a_fast", batch_id: "batch-one", case_id: "same-case" },
      expert: { version: "a_expert", batch_id: "batch-one", case_id: "same-case" },
      peer: { version: "b_fast", batch_id: "batch-one", case_id: "same-case" },
      otherBatch: { version: "a_fast", batch_id: "batch-two", case_id: "same-case" },
    },
    tasks: {
      criteria: task("criteria", "pending"),
      attribution: task("attribution", "succeeded", { reference: null }, { answer: "own", peer_B: "peer" }, "attribution.jsonl"),
      repeatedAttribution: task("attribution", "succeeded", { reference: null }, { answer: "own" }, "attribution.jsonl"),
      timedOut: task("attribution", "timed_out"),
      audit: task("comparison", "succeeded", { reference: null, verificationAudit: true, verificationOf: { taskId: "acceptedComparison" } }, {}, "comparison-verification.jsonl"),
      acceptedComparison: task("comparison", "succeeded", { reference: null }, {}, ""),
      failedVerification: task("comparison", "failed", { reference: null, verificationAudit: true, verificationOf: { taskId: "acceptedComparison" } }),
      pendingReview: task("comparison", "succeeded", { reference: null }, {}, "comparison-review.jsonl"),
      directComparison: task("comparison", "running"),
      rewrite: task("rewrite", "blocked"),
      clustering: task("clustering", "cancelled"),
    },
  } as unknown as Parameters<typeof analysisProgress>[0];
  const before = structuredClone(saved), summary = analysisProgress(saved);
  assert.equal(summary.inputCount, 4);
  assert.equal(summary.evaluatedInputCount, 1, "successful review of one answer does not evaluate its factual peer; repeated reviews do not create more answers");
  assert.equal(summary.caseCount, 2, "both tiers share the same question; the same case ID in another batch is another question");
  assert.deepEqual(summary.models.map(({ modelName, comparisonTier, inputCount, caseCount }) => ({ modelName, comparisonTier, inputCount, caseCount })), [
    { modelName: "A组Fast", comparisonTier: "Fast", inputCount: 2, caseCount: 2 },
    { modelName: "A Expert", comparisonTier: "Expert", inputCount: 1, caseCount: 1 },
    { modelName: "B Fast", comparisonTier: null, inputCount: 1, caseCount: 1 },
  ]);
  assert.equal(summary.tasks.total, 11);
  assert.deepEqual(summary.tasks.states, { pending: 1, running: 1, succeeded: 5, failed: 1, blocked: 1, cancelled: 1, timed_out: 1 });
  assert.equal(summary.tasks.byPurpose.comparison_verification.total, 2);
  assert.equal(summary.tasks.byPurpose.comparison_formal.total, 3);
  assert.equal(summary.formalComparisonsAccepted, 1);
  assert.deepEqual(summary.formalComparisonReferences, [{ runId: "run", taskId: "acceptedComparison" }]);
  assert.equal(summary.comparisonsPendingReview, 1);
  assert.deepEqual(summary.comparisonReviewReferences, [{ runId: "run", taskId: "pendingReview" }]);
  assert.equal(summary.startedAt, 10);
  assert.equal(summary.finishedAt, 20);
  assert.equal(analysisTaskPurpose(saved.tasks.audit!), "comparison_verification");
  assert.deepEqual(saved, before, "the projection neither modifies the checkpoint nor copies its source material");
});
