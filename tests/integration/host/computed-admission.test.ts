import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { rm } from "node:fs/promises";
import type { AgentBackend, PlannedTask } from "@eval/contracts";
import { runEvaluation } from "@eval/host";
import { startWorker } from "@eval/runtime/worker";
import { attributionRepository, attributionWorkflow, planAttribution } from "@eval/workflows/attribution";
import { services } from "../../fixtures/services.js";
import { fakeEvaluatorVersion, fakeIdentity, fixtureConfig, raw, submitFor, taskResult } from "../../fixtures/comparison.js";

test("computed aggregation proceeds while all worker slots finish accepted model calls", { timeout: 15000 }, async () => {
  const f = await fixtureConfig([[raw()], [], [], []]);
  const config = { ...f.config, workflow: "attribution" as const,
    inputs: { ...f.config.inputs, versions: f.config.inputs.versions.slice(0, 1) } };
  const plan = await planAttribution(config);
  const fields = plan.tasks.filter(task => task.stage === "attribution-compact-field");
  const held = new Set(fields.slice(-2).map(task => task.id));
  let release!: () => void;
  const aggregated = new Promise<void>(resolve => { release = resolve; });
  let heldStarted = 0, timedOut = false, computedWhileBusy = false, modelCalls = 0;
  const backend: AgentBackend = { identity: fakeIdentity, async createSession(options) {
    return { async run() {
      modelCalls++;
      if (held.has(options.spec.taskId)) heldStarted++;
      const result = await submitFor(options, taskResult(options.spec));
      assert.notEqual(result.isError, true, JSON.stringify(result));
    }, async abort() {}, async dispose() {
      if (!held.has(options.spec.taskId)) return;
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { timedOut = true; resolve(); }, 3000);
        void aggregated.then(() => { clearTimeout(timer); resolve(); });
      });
    } };
  } };
  const workers = await Promise.all([0, 1].map(index => startWorker(backend, path.join(f.directory, `worker-${index}`))));
  try {
    const taskSource = { ...attributionWorkflow,
      isComputedTask: (task: PlannedTask) => task.stage === "attribution-compact",
      bind(...args: Parameters<typeof attributionWorkflow.bind>) {
        if (args[0].stage === "attribution-compact") {
          computedWhileBusy = heldStarted === 2 && !timedOut;
          release();
        }
        return attributionWorkflow.bind(...args);
      } };
    const result = await runEvaluation({ ...services, repository: attributionRepository, taskSource,
      runId: "computed-admission", output: config.output, config, plan, engine: "pi", identity: fakeIdentity,
      evaluatorVersion: fakeEvaluatorVersion, policy: config.execution, modelForStage: f.modelForStage,
      concurrency: 2, taskConcurrency: 2, retries: 0, retryDelaySeconds: 0,
      workerUrls: workers.map(worker => worker.url), report: async () => ({}) });
    assert.equal(result.execution_task_statuses.succeeded, plan.tasks.length);
    assert(computedWhileBusy, "code aggregation must not wait for occupied model worker slots");
    assert.equal(modelCalls, fields.length + 1, "aggregation never creates a model session");
  } finally { release(); await Promise.all(workers.map(worker => worker.close())); await rm(f.directory, { recursive: true, force: true }); }
});
