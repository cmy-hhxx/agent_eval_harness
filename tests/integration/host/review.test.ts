import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile, rm } from "node:fs/promises";
import type { AgentBackend } from "@eval/contracts";
import { runEvaluation } from "@eval/host";
import { startWorker } from "@eval/runtime/worker";
import { buildPlan, deliveryCoverage, readRunState, type ComparisonResult, type TaskData } from "@eval/workflows/comparison";
import { services, validateRun } from "../../fixtures/services.js";
import { draftFor, fakeEvaluatorVersion, fakeIdentity, fixtureConfig, parsedMaterial, raw, taskResult } from "../../fixtures/comparison.js";

async function experiment(unresolved = false) {
  const setup = await fixtureConfig([[raw()], [], [raw()], []], false, true);
  const { directory, config, modelForStage } = setup;
  const plan = await buildPlan(config);
  let comparisons = 0, reviews = 0;
  const backend: AgentBackend = { identity: fakeIdentity, async createSession(options) {
    return { async run() {
      const material = parsedMaterial(options.spec) as { review_context?: unknown };
      if (material.review_context) reviews++;
      const result = taskResult(options.spec);
      if ("decision_basis" in (result as object)) {
        comparisons++;
        if (comparisons === 1 || unresolved) {
          const value = result as ComparisonResult;
          value.status = "needs_review";
          value.ranking = [];
          value.decision_basis.decisive_findings = [];
          value.review_requests = [{ candidate: "A", criterion_ids: ["r1"], finding_indices: [], reason: "交付范围需要独立核实。" }];
          value.assessments.A.meets_core = null;
          value.assessments.A.core_failure_refs = [];
        }
      }
      const response = await options.execute("submit_evaluation", draftFor(options.spec, result));
      assert.equal(response.isError, undefined, JSON.stringify(response));
    }, async abort() {}, async dispose() {} };
  } };
  const worker = await startWorker(backend, path.join(directory, "worker"));
  const options = { ...services, plan, config, runId: "review", output: config.output,
    engine: "pi" as const, identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion,
    workerUrls: [worker.url], policy: config.execution, modelForStage, concurrency: 1, retries: 0, retryDelaySeconds: 0 };
  return { ...setup, plan, worker, options, counts: () => ({ comparisons, reviews }) };
}

test("independent review preserves the source, persists lineage and gates formal delivery", async () => {
  const run = await experiment();
  try {
    const summary = await runEvaluation(run.options);
    assert.equal(summary.completed_comparisons, 1);
    assert.deepEqual(run.counts(), { comparisons: 2, reviews: 1 });
    const directory = path.join(run.config.output.path, "review");
    const state = await readRunState(directory);
    const original = run.plan.tasks.find((task) => task.stage === "comparison")!;
    const stored = state.manifest.tasks.find((task) => task.id === original.id)!;
    const followup = state.manifest.tasks.find((task) => task.id === (stored.data as TaskData).supersededBy)!;
    assert.equal((state.receipts[original.id].evaluation as ComparisonResult).status, "needs_review");
    assert.equal((followup.data as TaskData).reviewOf?.taskId, original.id);
    assert.equal((state.receipts[followup.id].evaluation as ComparisonResult).status, "decided");
    assert.equal((await readFile(path.join(directory, "results/comparison.jsonl"), "utf8")).trim().split("\n").length, 1);
    assert.equal((await readFile(path.join(directory, "results/comparison-review.jsonl"), "utf8")).trim().split("\n").length, 1);
    assert(deliveryCoverage(state).valid);
    const validation = await validateRun(directory);
    assert(validation.valid, JSON.stringify(validation));
    await runEvaluation({ ...run.options, plan: { ...run.plan, tasks: state.manifest.tasks } });
    assert.deepEqual(run.counts(), { comparisons: 2, reviews: 1 }, "resume never repeats accepted source or review tasks");
  } finally { await run.worker.close(); await rm(run.directory, { recursive: true, force: true }); }
});

test("a second unresolved verdict stops review and excludes verdicts and problem-library admission", async () => {
  const run = await experiment(true);
  try {
    const summary = await runEvaluation(run.options);
    assert.equal(summary.completed_comparisons, 0);
    assert.deepEqual(run.counts(), { comparisons: 2, reviews: 1 });
    const state = await readRunState(path.join(run.config.output.path, "review"));
    assert.equal(state.manifest.tasks.filter((task) => task.stage === "comparison").length, 2);
    assert(!deliveryCoverage(state).valid);
    for (const task of state.manifest.tasks.filter((task) => task.stage === "clustering")) {
      assert.equal(state.manifest.states[task.id].status, "blocked");
      assert.equal(state.receipts[task.id], undefined);
    }
    await runEvaluation(run.options);
    assert.deepEqual(run.counts(), { comparisons: 2, reviews: 1 });
    const resumed = await readRunState(path.join(run.config.output.path, "review"));
    for (const task of resumed.manifest.tasks.filter((task) => task.stage === "clustering"))
      assert.equal(resumed.manifest.states[task.id].status, "blocked", "ordinary resume cannot admit unresolved observations");
  } finally { await run.worker.close(); await rm(run.directory, { recursive: true, force: true }); }
});
