import { isTraceAttributionTask } from "@eval/workflows/attribution";
import { compactReceipt } from "../../../../tests/fixtures/compact.js";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { rm } from "node:fs/promises";
import { writeJsonl } from "@eval/data";
import { emptyUsage } from "@eval/contracts";
import { traceAttributionProfile } from "@eval/agents/attribution";
import { Ajv2020 } from "ajv/dist/2020.js";
import { buildPlan } from "./input.js";
import { bindTask } from "./binding.js";
import { comparisonRow } from "./results.js";
import { outputSchema } from "./schema.js";
import { predictionReadiness, readPredictionAnswers, type PredictionAnswer } from "./prediction.js";
import type { TaskData } from "./types.js";
import { attributionResult, comparisonResult, emptyAudit, fixtureConfig, raw } from "../../../../tests/fixtures/comparison.js";

const answer: PredictionAnswer = {
  question_id: "selected", batch_id: "2026-09-22", text: "计算2+2", question_time: "2026-09-22T12:00:00+08:00",
  prediction_results: [{ target_id: "one", start_date: "2026-09-23", end_date: "2026-09-23",
    status: "resolved", answer: "4", answer_scope: "actual_outcome" }],
};
test("prediction readiness separates elapsed deadlines, resolved outcomes, probability and past-event questions", () => {
  const during = Date.parse("2026-09-23T15:00:00+08:00"), after = Date.parse("2026-09-24T00:00:00+08:00");
  assert.equal(predictionReadiness(answer, during).ready, false);
  assert.equal(predictionReadiness(answer, after).ready, true);
  for (const target of [
    { status: "pending" }, { answer: "" }, { answer_scope: "event_realization_only" as const },
    { start_date: "2026-09-22", end_date: "2026-09-22" },
    { start_date: "2026-09-21", end_date: "2026-09-21" },
  ]) assert.equal(predictionReadiness({ ...answer, prediction_results: [{ ...answer.prediction_results[0], ...target }] }, after).ready, false);
  const multiple = { ...answer, prediction_results: [...answer.prediction_results, {
    ...answer.prediction_results[0], target_id: "later", end_date: "2026-10-01",
  }] };
  assert.equal(predictionReadiness(multiple, after).ready, false, "do not permanently accept a partially matured case");
});

test("prediction plan selects accepted pairs, supplies outcome evidence and preserves original answers and standards", async t => {
  const input = { ...raw("original", null), batch_id: answer.batch_id, has_standard_answer: false };
  const other = { ...input, case_id: "untouched" };
  const fixture = await fixtureConfig([[input, other], [input], [input, other], [input]]);
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const file = path.join(fixture.directory, "answers.jsonl");
  await writeJsonl(file, [answer]);
  fixture.config.inputs.batches = [answer.batch_id];
  fixture.config.prediction = { answersFile: file, evaluationTaskId: "original-task", selections: [{
    batchId: answer.batch_id, caseId: "original", questionId: answer.question_id,
    versions: ["a_fast", "b_fast"], sourceRunId: "daily-2026-09-22", sourceComparisonId: "old-comparison", targetIds: ["one"],
  }] };
  const plan = await buildPlan(fixture.config);
  assert.equal(plan.tasks.filter(task => task.stage === "comparison").length, 1);
  assert.equal(plan.tasks.filter(task => isTraceAttributionTask(task)).length, 2);
  assert.equal((plan.summary.issues as unknown[]).length, 0);
  const task = plan.tasks.find(task => isTraceAttributionTask(task))!, data = task.data as TaskData;
  assert.equal(data.prediction?.source_comparison_id, "old-comparison");
  assert.deepEqual((data.reference as { prediction_results: unknown[] }).prediction_results, answer.prediction_results);
  assert.deepEqual(plan.inputs[task.inputIds.answer], input);
  const binding = bindTask(task, plan.inputs, { compact: compactReceipt() }, { tasks: plan.tasks });
  assert.equal((binding.modelInput!.ground_truth as { available: boolean }).available, true);
  assert(traceAttributionProfile.renderPrompt!(binding.modelInput!).includes("事前预测"));
  assert(!JSON.stringify(binding.request.sources).includes("old-comparison"));
  const comparison = plan.tasks.find(item => item.stage === "comparison")!;
  const receipts = new Map(plan.tasks.filter(item => item.stage === "attribution-session").map(item => [item.id, {
    taskId: item.id, attemptId: "attribution", submissionId: "attribution", acceptedAt: 1, status: "succeeded" as const,
    evaluatorVersion: "fixture", judge: "fixture", audit: emptyAudit(), usage: emptyUsage(),
    evaluation: attributionResult(true, "2+2=4", true, (item.data as TaskData).candidate!.input_id),
  }]));
  const row = comparisonRow(plan.inputs, comparison, comparisonResult(), receipts, {}, "fixture");
  const validate = new Ajv2020({ strict: false }).compile(outputSchema);
  assert(validate(row), JSON.stringify(validate.errors));
  assert.equal(row.evaluation_purpose, "prediction");
  assert.equal(row.has_standard_answer, true);
  assert.deepEqual(row.prediction, data.prediction);
  const missingMarker = { ...row }; delete missingMarker.evaluation_purpose;
  assert.equal(validate(missingMarker), false, "prediction provenance must always carry its purpose marker");
  await writeJsonl(file, [answer, answer]);
  await assert.rejects(readPredictionAnswers(file), /Duplicate prediction/);
});
