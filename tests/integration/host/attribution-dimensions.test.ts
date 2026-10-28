import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { AgentBackend } from "@eval/contracts";
import { runEvaluation } from "@eval/host";
import { startWorker } from "@eval/runtime/worker";
import { buildPlan, readRunState } from "@eval/workflows/comparison";
import { services, validateRun } from "../../fixtures/services.js";
import { draftFor, fakeEvaluatorVersion, fakeIdentity, fixtureConfig, inspectFor, raw, submitFor, taskResult } from "../../fixtures/comparison.js";

test("an independent dimension can fail while atomic attribution and comparisons remain valid through resume", async t => {
  const records = (version: string) => ["q1", "q2"].map(caseId => {
    const record = raw(caseId);
    return { ...record, meta: { ...record.meta, session_id: `${version}-${caseId}` } };
  });
  const { directory, config, modelForStage } = await fixtureConfig([records("a"), [], records("b"), []]);
  t.after(() => rm(directory, { recursive: true, force: true }));
  let failedDimension: string | undefined;
  const executions = new Map<string, number>();
  const backend: AgentBackend = { identity: fakeIdentity, async createSession(options) {
    return { async run() {
      const { taskId } = options.spec;
      executions.set(taskId, (executions.get(taskId) ?? 0) + 1);
      if (options.spec.evaluation.id === "instruction-review" && !failedDimension) {
        failedDimension = taskId;
        throw new Error("fixture dimension failure");
      }
      await inspectFor(options);
      const result = await submitFor(options, draftFor(options.spec, taskResult(options.spec)));
      assert.equal(result.isError, undefined, JSON.stringify(result));
    }, async abort() {}, async dispose() {} };
  } };
  const worker = await startWorker(backend, path.join(directory, "worker"));
  t.after(() => worker.close());
  const plan = await buildPlan(config), runId = "dimension-isolation", run = path.join(config.output.path, runId);
  const options = { ...services, runId, output: config.output, engine: "pi" as const, identity: fakeIdentity,
    evaluatorVersion: fakeEvaluatorVersion, config, plan, policy: config.execution, modelForStage,
    concurrency: 2, retries: 0, retryDelaySeconds: 0, workerUrls: [worker.url] };
  await runEvaluation(options);
  const state = await readRunState(run);
  assert(failedDimension);
  assert.equal(state.manifest.states[failedDimension].status, "failed");
  const dimensions = state.manifest.tasks.filter(task => task.stage === "instruction-review");
  assert.equal(dimensions.length, 4);
  assert.equal(dimensions.filter(task => state.receipts[task.id]).length, 3);
  assert.equal(state.manifest.tasks.filter(task => task.stage === "attribution-session" && state.receipts[task.id]).length, 4);
  assert.equal(state.manifest.tasks.filter(task => task.stage === "comparison" && state.receipts[task.id]).length, 2);
  const validation = await validateRun(run);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  const before = await Promise.all(["attribution", "comparison"].map(name => readFile(path.join(run, "results", name + ".jsonl"), "utf8")));
  await runEvaluation({ ...options, plan: { tasks: [], inputs: {}, summary: {} } });
  const resumed = await readRunState(run);
  assert.equal(resumed.manifest.tasks.filter(task => task.stage === "instruction-review").length, 4);
  for (const task of state.manifest.tasks.filter(task => state.receipts[task.id])) assert.equal(executions.get(task.id), 1);
  const after = await Promise.all(["attribution", "comparison"].map(name => readFile(path.join(run, "results", name + ".jsonl"), "utf8")));
  assert.deepEqual(after, before);
});
