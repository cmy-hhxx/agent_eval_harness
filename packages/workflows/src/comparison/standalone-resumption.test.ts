import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { emptyUsage, type PlannedTask, type RunState } from "@eval/contracts";
import { attributionResult, comparisonResult, criteriaResultForTask, emptyAudit, fakeEvaluatorVersion, fakeIdentity, fakeJudge, fixtureConfig } from "../../../../tests/fixtures/comparison.js";
import { buildPlan } from "./input.js";
import { reconcileRun } from "./run-data.js";
import type { TaskData } from "./types.js";

for (const accepted of [false, true]) for (const frozen of [false, true])
  test(`standalone comparison keeps its identity on resume (accepted: ${accepted}, frozen: ${frozen})`, async () => {
    const fixture = await fixtureConfig();
    try {
      const plan = await buildPlan(fixture.config), comparison = plan.tasks.find(task => task.stage === "comparison")!;
      const criterion = plan.tasks.find(task => task.stage === "criteria")!;
      const analysis = criteriaResultForTask(criterion, plan.inputs);
      const state: RunState = { usage: emptyUsage(), receipts: {}, recordedAttempts: 0, manifest: {
        format: "evaluation-run", runId: "standalone-resumption", debug: false, status: "interrupted", startedAt: 1,
        evaluatorVersion: fakeEvaluatorVersion, engine: fakeIdentity, config: fixture.config,
        tasks: plan.tasks, inputCatalog: plan.catalog, inputs: {}, preflight: plan.summary,
        states: Object.fromEntries(plan.tasks.map(task => [task.id, { status: "pending", attempts: 0, revision: 1 }])),
      } };
      const accept = (task: PlannedTask, evaluation: unknown) => {
        state.receipts[task.id] = { taskId: task.id, attemptId: task.id, submissionId: task.id, status: "succeeded",
          evaluatorVersion: fakeEvaluatorVersion, judge: fakeJudge, evaluation,
          audit: emptyAudit(), usage: emptyUsage(), acceptedAt: 1 };
        state.manifest.states[task.id] = { status: "succeeded", attempts: 1, revision: 1 };
      };
      for (const task of plan.tasks) {
        if (task.stage === "criteria") accept(task, analysis);
        else if (task.stage === "attribution") {
          const result = attributionResult(true, "2+2=4", true, task.inputIds.answer);
          result.task_analysis = analysis;
          accept(task, result);
        }
      }
      if (accepted) accept(comparison, comparisonResult(undefined, analysis));
      else state.manifest.states[comparison.id] = { status: "failed", attempts: 1, revision: 1,
        failure: { contentSubmissions: 2, fileErrors: 1, errors: [], repeatedErrors: 0, stopped: false, attemptId: "paid-attempt" } };
      if (frozen) state.manifest.executionScope = [comparison.id];
      const before = structuredClone(state.receipts), progress = structuredClone(state.manifest.states[comparison.id]);
      const identity = (comparison.data as TaskData).comparisonId;
      for (let attempt = 0; attempt < 2; attempt++) {
        const resumed = await reconcileRun(fixture.directory, state, fixture.config);
        const comparisons = resumed.tasks.filter(task => task.stage === "comparison");
        assert.equal(comparisons.length, 1);
        assert.equal(comparisons[0].id, comparison.id);
        assert.equal((comparisons[0].data as TaskData).comparisonId, identity);
        assert.equal((comparisons[0].data as TaskData).verificationAudit, undefined);
        assert.deepEqual(comparisons[0].dependencies, comparison.dependencies);
        assert.deepEqual(state.manifest.states[comparison.id], progress, "planning preserves accepted work and paid attempt counters");
        assert.deepEqual(state.receipts, before);
        assert.deepEqual(state.manifest.executionScope, frozen ? [comparison.id] : undefined);
      }
    } finally { await rm(fixture.directory, { recursive: true, force: true }); }
  });
