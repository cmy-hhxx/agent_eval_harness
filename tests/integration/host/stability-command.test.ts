import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { rm } from "node:fs/promises";
import type { AgentBackend, ModelConfig } from "@eval/contracts";
import { runEvaluation } from "@eval/host";
import { startWorker } from "@eval/runtime/worker";
import { createStabilityWorkflow, prepareStability, reportStability, stabilityReport, stabilityRepository,
  type StabilityCase, type StabilityTaskData } from "@eval/workflows/comparison";
import { createStabilityModelResolver } from "../../../apps/host/src/stability-command.js";
import { draftFor, submitFor, taskResult, fakeEvaluatorVersion, fakeIdentity, fixtureConfig } from "../../fixtures/comparison.js";
import { services } from "../../fixtures/services.js";

test("stability resume records actual model capabilities and withholds pooled inference after they change", async () => {
  const previousConfig = process.env.EVAL_CONFIG_FILE;
  const fixture = await fixtureConfig();
  const { directory, models, modelForStage } = fixture;
  Object.assign(models.models.judge, { contextWindow: 16384, maxOutputTokens: 4096,
    supportsDeveloperRole: false, supportsExplicitPromptCaching: true });
  const seen = new Map<string, ModelConfig>();
  const backend: AgentBackend = { identity: fakeIdentity, async createSession(options) { return {
    async run() {
      seen.set(options.spec.taskId, structuredClone(options.spec.model));
      assert.equal((await submitFor(options, draftFor(options.spec, taskResult(options.spec)))).terminate, true);
    }, async abort() {}, async dispose() {},
  }; } };
  const worker = await startWorker(backend, path.join(directory, "worker"));
  try {
    const item: StabilityCase = { batch_id: "b1", case_id: "q1", risks: ["test"], rewrite: false, end_to_end: false,
      answers: fixture.config.inputs.versions.filter(version => ["a_fast", "b_fast"].includes(version.id)).map(version => ({
        version: version.id, name: version.name, adapter: version.adapter, comparison_tier: version.comparison_tier,
        source: version.sources[0].path, line: 1,
      })) as StabilityCase["answers"] };
    const { config, plan } = await prepareStability(fixture.config, [item]);
    const options = { ...services, taskSource: await createStabilityWorkflow(config), repository: stabilityRepository,
      report: reportStability, runId: "model-conditions", output: config.output, config, plan,
      engine: "pi" as const, identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion,
      modelForStage, modelForTask: createStabilityModelResolver(modelForStage, "pi", config.execution),
      policy: config.execution, concurrency: 1, retries: 0, retryDelaySeconds: 0, workerUrls: [worker.url] };
    const run = path.join(config.output.path, options.runId);
    const firstAttempts = plan.tasks.filter(task => (task.data as StabilityTaskData).stability.purpose === "baseline").length + 1;
    const first = await runEvaluation({ ...options, maxAttempts: firstAttempts });
    assert.deepEqual(first.execution_task_statuses, { succeeded: firstAttempts, pending: plan.tasks.length - firstAttempts });
    const before = await stabilityRepository.readRun(run);
    assert.equal(stabilityReport(before).statistics.status, "exploratory_pilot");
    for (const task of before.manifest.tasks.filter(task => before.receipts[task.id])) {
      const { apiKeyEnv, ...publicModel } = seen.get(task.id)!;
      const condition = (task.data as StabilityTaskData).stability.condition!;
      assert.deepEqual(condition.model, publicModel);
      assert(!JSON.stringify(condition).includes(apiKeyEnv));
      assert(!Object.hasOwn(condition.model, "apiKeyEnv"));
    }

    models.models.judge.maxOutputTokens = 8192;
    const resumed = await runEvaluation({ ...options, maxAttempts: config.stability.maxAttempts });
    assert.deepEqual(resumed.execution_task_statuses, { succeeded: plan.tasks.length });
    const after = await stabilityRepository.readRun(run), report = stabilityReport(after);
    for (const [id, receipt] of Object.entries(before.receipts)) {
      assert.equal(after.receipts[id].submissionId, receipt.submissionId);
      assert.equal(seen.get(id)!.maxOutputTokens, 4096, "accepted trials must not run again");
    }
    assert.equal(report.statistics.status, "mixed_conditions");
    assert.equal(report.statistics.swap_agreement.mean, null);
    assert.equal(report.statistics.direction_sign_test.p_value, null);
    assert.deepEqual(new Set(report.conditions.filter(condition => condition.stage === "comparison")
      .map(condition => condition.parameters!.model.maxOutputTokens)), new Set([4096, 8192]));
  } finally {
    await worker.close();
    await rm(directory, { recursive: true, force: true });
    if (previousConfig === undefined) delete process.env.EVAL_CONFIG_FILE; else process.env.EVAL_CONFIG_FILE = previousConfig;
  }
});
