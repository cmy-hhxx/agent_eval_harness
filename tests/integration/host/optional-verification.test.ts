import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { AgentBackend } from "@eval/contracts";
import { runEvaluation } from "@eval/host";
import { startWorker } from "@eval/runtime/worker";
import { buildPlan, deliveryCoverage, readRunState, reportRun, type TaskData } from "@eval/workflows/comparison";
import { prepareComparisonVerification } from "../../../packages/workflows/src/comparison/verification-preparation.js";
import { services } from "../../fixtures/services.js";
import { draftFor, fakeEvaluatorVersion, fakeIdentity, fixtureConfig, inspectFor, submitFor,
  raw, taskResult } from "../../fixtures/comparison.js";

for (const fail of [false, true]) test(`an optional ${fail ? "failed" : "successful"} audit preserves the accepted evaluation and publication`, async () => {
  const records = fail ? [raw("q1"), raw("q2")] : [raw("q1")];
  const { directory, config, modelForStage } = await fixtureConfig([records, [], records, []]);
  const profiles: string[] = [];
  const backend: AgentBackend = { identity: fakeIdentity, async createSession(options) {
    return { async run() {
      profiles.push(options.spec.evaluation.profile);
      if (fail && options.spec.evaluation.profile === "verification") throw new Error("optional audit provider failure");
      await inspectFor(options);
      const result = await submitFor(options, draftFor(options.spec, taskResult(options.spec)));
      assert.equal(result.isError, undefined, JSON.stringify(result));
    }, async abort() {}, async dispose() {} };
  } };
  const worker = await startWorker(backend, path.join(directory, "worker")), runId = "optional-verification";
  const run = path.join(config.output.path, runId);
  try {
    const plan = await buildPlan(config), options = { ...services, runId, output: config.output, engine: "pi" as const,
      identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion, config, plan, policy: config.execution,
      modelForStage, concurrency: 1, retries: 0, retryDelaySeconds: 0, workerUrls: [worker.url],
      failureGuard: { threshold: 2, windowSize: 2 } };
    await runEvaluation(options);
    const baseline = await readRunState(run);
    assert.equal(profiles.length, records.length * 4, "one Criteria, two Attributions and one Comparison complete each default case");
    assert(!profiles.includes("verification"));
    assert.equal(deliveryCoverage(baseline).valid, true);
    const sources = baseline.manifest.tasks.filter(task => task.stage === "comparison"), source = sources[0]!;
    const primary = await readFile(path.join(run, "results/comparison.jsonl"), "utf8");
    const prepared = await prepareComparisonVerification(run, { apply: true,
      resultIds: sources.map(task => (task.data as TaskData).comparisonId!) });
    assert.equal(prepared.count, records.length);
    const ids = prepared.selected.map(item => item.verification_task_id!), id = ids[0]!;
    await runEvaluation({ ...options, plan: { tasks: [], inputs: {}, summary: {} } });
    const state = await readRunState(run);
    assert.equal(profiles.length, records.length * 5);
    assert.equal(profiles.at(-1), "verification");
    assert.deepEqual(state.manifest.executionScope, ids);
    assert.equal(state.manifest.tasks.length, baseline.manifest.tasks.length + records.length, "audit never queues attribution reviews or follow-up comparisons");
    for (const task of baseline.manifest.tasks) {
      assert.deepEqual(state.receipts[task.id], baseline.receipts[task.id]);
      assert.deepEqual(state.manifest.tasks.find(item => item.id === task.id), task);
    }
    assert.equal(await readFile(path.join(run, "results/comparison.jsonl"), "utf8"), primary);
    assert.equal(deliveryCoverage(state).valid, true, "an optional check does not enter delivery coverage");
    const summary = await reportRun(run);
    assert.equal(await readFile(path.join(run, "results/comparison.jsonl"), "utf8"), primary);
    assert.equal(summary.completed_comparisons, records.length);
    if (fail) {
      for (const id of ids) {
        assert.equal(state.manifest.states[id].status, "failed");
        assert.equal(state.receipts[id], undefined);
      }
      assert.deepEqual(state.manifest.pausedStages ?? [], [], "two audit failures cannot trip the primary comparison failure guard");
    } else {
      assert.equal(state.manifest.states[id].status, "succeeded");
      assert(state.receipts[id].audit.inspection, "optional audit keeps the independent blind inspection gate");
      assert.equal(state.receipts[id].exported!.file, "comparison-verification.jsonl");
      assert.equal(state.receipts[id].exported!.id, id);
      const row = JSON.parse(await readFile(path.join(run, "results/comparison-verification.jsonl"), "utf8"));
      assert.equal(row.comparison_id, (source.data as TaskData).comparisonId);
      assert.equal(row.source_task_id, source.id);
      assert.equal(row.evaluation_type, "comparison_verification");
      assert.equal((await prepareComparisonVerification(run, { apply: true })).count, 0);
    }
  } finally { await worker.close(); await rm(directory, { recursive: true, force: true }); }
});
