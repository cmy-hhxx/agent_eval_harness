import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { AgentBackend } from "@eval/contracts";
import { runEvaluation } from "@eval/host";
import { startWorker } from "@eval/runtime/worker";
import { buildPlan, prepareClustering, readRunState, writeRunState, type TaskData } from "@eval/workflows/comparison";
import { services } from "../../fixtures/services.js";
import { draftFor, fakeEvaluatorVersion, fakeIdentity, fixtureConfig, inspectFor, raw, submitFor, taskResult } from "../../fixtures/comparison.js";

test("post-evaluation clustering uses accepted receipts, excludes failed answers and freezes only maintenance", async () => {
  const records = [raw("q1"), raw("q2")];
  const { directory, config, modelForStage } = await fixtureConfig([records, [], records, []]);
  config.rewrite.clustering = true;
  const plan = await buildPlan(config);
  const failed = plan.tasks.find(task => task.stage === "attribution" &&
    (task.data as TaskData).candidates.A.version === "a_fast" && (task.data as TaskData).candidates.A.case_id === "q2")!;
  const calls: string[] = [];
  const backend: AgentBackend = { identity: fakeIdentity, async createSession(options) {
    return { async run() {
      calls.push(options.spec.evaluation.id);
      if (options.spec.evaluation.id === "attribution" && options.spec.inputs.some(input => input.id === failed.inputIds.answer))
        throw new Error("injected answer failure");
      await inspectFor(options);
      const submitted = await submitFor(options, draftFor(options.spec, taskResult(options.spec)));
      assert.equal(submitted.isError, undefined, JSON.stringify(submitted));
    }, async abort() {}, async dispose() {} };
  } };
  const worker = await startWorker(backend, path.join(directory, "worker"));
  const run = path.join(config.output.path, "separate-clustering");
  try {
    const options = { ...services, runId: "separate-clustering", output: config.output, engine: "pi" as const,
      identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion, config, plan, policy: config.execution,
      modelForStage, concurrency: 1, retries: 0, retryDelaySeconds: 0, workerUrls: [worker.url] };
    await runEvaluation(options);
    const before = await readRunState(run);
    assert.equal(before.manifest.states[failed.id].status, "failed");
    const successful = before.manifest.tasks.find(task => task.stage === "attribution" && before.receipts[task.id])!;
    // Optional review is outside the base queue and cannot hold up retrospective clustering.
    const optional = { ...structuredClone(successful), id: "optional-attribution-review",
      data: { ...(successful.data as TaskData), reviewOf: { taskId: successful.id, round: 1, reasons: ["显式复核。"] } } };
    before.manifest.tasks.push(optional);
    before.manifest.states[optional.id] = { status: "pending", attempts: 0, revision: 1 };
    await writeRunState(run, before);
    for (const version of config.inputs.versions) await rename(version.sources[0]!.path, version.sources[0]!.path + ".unavailable");
    const checkpoint = await readFile(path.join(run, "state.json"), "utf8");
    const preview = await prepareClustering(run);
    assert.equal(preview.count, 2);
    assert.equal(preview.attribution_answers, 3);
    assert.equal(preview.excluded_attributions, 1);
    assert.equal(preview.rewrite_tasks, 2);
    assert(preview.selected.every(item => item.task_id === null));
    assert.equal(await readFile(path.join(run, "state.json"), "utf8"), checkpoint, "preview does not save a new plan");
    const prepared = await prepareClustering(run, { apply: true });
    const frozen = await readRunState(run), scope = new Set(frozen.manifest.executionScope);
    assert.equal(scope.size, 4);
    assert.equal((frozen.manifest.config as typeof config).clustering.enabled, false, "explicit maintenance does not enable clustering in ordinary evaluation");
    const clusters = frozen.manifest.tasks.filter(task => prepared.selected.some(item => item.task_id === task.id));
    for (const task of clusters) {
      assert(Object.values(task.dependencies).every(id => frozen.receipts[id] && frozen.manifest.tasks.find(item => item.id === id)!.stage === "attribution"));
      assert(!Object.values(task.dependencies).includes(failed.id));
    }
    for (const task of frozen.manifest.tasks.filter(task => scope.has(task.id)))
      assert(task.stage === "clustering" || (task.data as TaskData).rewriteOf?.stage === "clustering");
    const ids = frozen.manifest.tasks.map(task => task.id);
    await prepareClustering(run, { apply: true });
    assert.deepEqual((await readRunState(run)).manifest.tasks.map(task => task.id), ids, "repeated preparation reuses unfinished maintenance UUIDs");
    const callsBefore = calls.length;
    await runEvaluation({ ...options, plan: { tasks: [], inputs: {}, summary: {} } });
    assert.deepEqual(calls.slice(callsBefore).sort(), ["clustering", "clustering", "rewrite", "rewrite"]);
    const after = await readRunState(run);
    for (const task of before.manifest.tasks) {
      assert.deepEqual(after.manifest.states[task.id], before.manifest.states[task.id]);
      assert.deepEqual(after.receipts[task.id], before.receipts[task.id]);
    }
    const finished = await readFile(path.join(run, "state.json"), "utf8");
    assert.equal((await prepareClustering(run, { apply: true })).count, 0);
    assert.equal(await readFile(path.join(run, "state.json"), "utf8"), finished, "completed maintenance needs no new tasks");
  } finally { await worker.close(); await rm(directory, { recursive: true, force: true }); }
});

test("post-evaluation clustering waits until every base attribution has finished", async () => {
  const { directory, config, modelForStage } = await fixtureConfig();
  const plan = await buildPlan(config), run = path.join(config.output.path, "cluster-after-attribution");
  const worker = await startWorker({ identity: fakeIdentity, async createSession(options) {
    return { async run() {
      await inspectFor(options);
      assert.equal((await submitFor(options, draftFor(options.spec, taskResult(options.spec)))).isError, undefined);
    }, async abort() {}, async dispose() {} };
  } }, path.join(directory, "worker"));
  try {
    await runEvaluation({ ...services, runId: "cluster-after-attribution", output: config.output, engine: "pi",
      identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion, config, plan, policy: config.execution,
      modelForStage, concurrency: 1, retries: 0, retryDelaySeconds: 0, workerUrls: [worker.url] });
    const state = await readRunState(run), task = state.manifest.tasks.find(task => task.stage === "attribution")!;
    for (const status of ["pending", "running"] as const) {
      state.manifest.states[task.id].status = status;
      await writeRunState(run, state);
      const checkpoint = await readFile(path.join(run, "state.json"), "utf8");
      await assert.rejects(prepareClustering(run, { apply: true }), /归因尚未全部结束/);
      assert.equal(await readFile(path.join(run, "state.json"), "utf8"), checkpoint);
    }
  } finally { await worker.close(); await rm(directory, { recursive: true, force: true }); }
});
