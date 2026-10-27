import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { emptyUsage, type SubmissionReceipt } from "@eval/contracts";
import { comparisonProfile } from "@eval/agents/comparison";
import { buildPlan } from "./input.js";
import { bindTask } from "./binding.js";
import { attributionResult, criteriaResultForTask, emptyAudit, fakeEvaluatorVersion, fakeJudge, fixtureConfig, raw } from "../../../../tests/fixtures/comparison.js";

test("comparison presents long delivery exactly once without requiring a duplicate read", async t => {
  const answer = "完整交付不得截断。".repeat(3000);
  const f = await fixtureConfig([[raw("q1", "4", answer)], [], [raw()], []]);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const plan = await buildPlan(f.config), task = plan.tasks.find(task => task.stage === "comparison")!;
  const dependencies = Object.fromEntries(Object.entries(task.dependencies).map(([label, taskId]) => [label, {
    taskId, attemptId: "attempt", submissionId: "submission", acceptedAt: 1, status: "succeeded",
    evaluatorVersion: fakeEvaluatorVersion, judge: fakeJudge, audit: emptyAudit(), usage: emptyUsage(),
    evaluation: label === "criteria" ? criteriaResultForTask(task, plan.inputs) : attributionResult(),
  } satisfies SubmissionReceipt]));
  const before = structuredClone(dependencies);
  const binding = bindTask(task, plan.inputs, dependencies, { tasks: plan.tasks });
  const prompt = comparisonProfile.renderPrompt(binding.modelInput!);
  assert.equal(prompt.split(answer).length - 1, 1);
  assert.deepEqual(comparisonProfile.requiredReads!(binding.request), []);
  assert.deepEqual(dependencies, before);
  assert.equal(comparisonProfile.jsonStringSubmission, undefined);
});
