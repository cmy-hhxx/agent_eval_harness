import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { rm } from "node:fs/promises";
import { runEvaluation } from "@eval/host";
import { startWorker } from "@eval/runtime/worker";
import { buildPlan } from "@eval/workflows/comparison";
import { services } from "../../fixtures/services.js";
import { fixtureConfig, raw, fakeIdentity, fakeEvaluatorVersion, inspectFor, submitFor, draftFor, taskResult } from "../../fixtures/comparison.js";

test("one unavailable external Worker does not reject healthy capacity or spend task attempts", async t => {
  const f = await fixtureConfig([[raw()], [], [raw()], []]);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const worker = await startWorker({ identity: fakeIdentity, async createSession(options) { return {
    async run() { await inspectFor(options); await submitFor(options, draftFor(options.spec, taskResult(options.spec))); },
    async abort() {}, async dispose() {},
  }; } }, path.join(f.directory, "worker"));
  t.after(() => worker.close());
  const result = await runEvaluation({ ...services, runId: "external-health", output: f.config.output,
    config: f.config, plan: await buildPlan(f.config), engine: "pi", identity: fakeIdentity,
    evaluatorVersion: fakeEvaluatorVersion, policy: f.config.execution, modelForStage: f.modelForStage,
    concurrency: 2, retries: 0, retryDelaySeconds: 0, workerUrls: ["http://127.0.0.1:1", worker.url], signal: AbortSignal.timeout(15_000) });
  assert.deepEqual(Object.keys(result.execution_task_statuses), ["succeeded"]);
  assert.equal(result.outcome, "complete");
});
