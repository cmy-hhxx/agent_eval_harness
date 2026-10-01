import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { AgentBackend } from "@eval/contracts";
import { writeJsonl } from "@eval/data";
import { runEvaluation, progressSnapshot } from "@eval/host";
import { startWorker } from "@eval/runtime/worker";
import {
  buildPlan, readRunState, prepareComparisonRewrites, prepareFailedTasks, deliveryCoverage,
  comparisonRewriteReview, pilotTaskIds, type TaskData,
  validateRun as validateDelivery,
} from "@eval/workflows/comparison";
import { services, validateRun, agents } from "../../fixtures/services.js";
import { draftFor, fakeEvaluatorVersion, fakeIdentity, fixtureConfig, raw, taskResult } from "../../fixtures/comparison.js";

test("slot repairs preview without mutation, preserve every other field and exclude appended inputs", async () => {
  const records = [raw("q1"), raw("q2")];
  const { directory, config, modelForStage } = await fixtureConfig([records, [], records, []]);
  let calls = 0;
  const backend: AgentBackend = { identity: fakeIdentity, async createSession(options) {
    return { async run() {
      calls++;
      const result = taskResult(options.spec);
      if (options.spec.evaluation.id === "rewrite")
        for (const item of (result as { rewrites: { text: string }[] }).rewrites) item.text += `（修辞${calls}）`;
      const submission = await options.execute("submit_evaluation", draftFor(options.spec, result));
      assert.equal(submission.isError, undefined, JSON.stringify(submission));
    }, async abort() {}, async dispose() {} };
  } };
  const worker = await startWorker(backend, path.join(directory, "worker"));
  const run = path.join(config.output.path, "repair");
  try {
    const plan = await buildPlan(config);
    const options = { ...services, runId: "repair", output: config.output, engine: "pi" as const,
      identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion, config, plan, policy: config.execution,
      modelForStage, concurrency: 1, retries: 0, retryDelaySeconds: 0, workerUrls: [worker.url] };
    await runEvaluation(options);
    const baseline = await readRunState(run), checkpoint = await readFile(path.join(run, "state.json"), "utf8");
    const comparisons = plan.tasks.filter((task) => task.stage === "comparison"), source = comparisons[0]!;
    const resultId = (source.data as TaskData).comparisonId!;
    const selection = { scope: "items" as const, mode: "missing" as const, resultIds: [resultId], slotIds: ["comparison.0.A.summary"] };
    const preview = await prepareComparisonRewrites(run, selection);
    assert.equal(preview.slots, 1);
    assert.equal(preview.selected[0]!.rewrite_task_id, null, "missing rewrite task can be prepared without input replan");
    await assert.rejects(prepareComparisonRewrites(run, { ...selection, slotIds: ["comparison.99.A.summary"], apply: true }), /没有槽位/);
    await assert.rejects(prepareComparisonRewrites(run, { scope: "items", mode: "refresh", apply: true }), /显式 --all/);
    await assert.rejects(prepareFailedTasks(run, { taskIds: ["unknown"], apply: true }), /未知任务/);
    assert.equal(await readFile(path.join(run, "state.json"), "utf8"), checkpoint);

    const applied = await prepareComparisonRewrites(run, { ...selection, apply: true });
    for (const version of config.inputs.versions) {
      const file = version.sources[0]!.path;
      await writeJsonl(file, [...records, raw("appended")]);
      await rename(file, file + ".unavailable");
    }
    const resume = { ...options, plan: { tasks: [], inputs: {}, summary: {} } };
    await runEvaluation(resume);
    assert.equal(calls, 9, "eight original judgments including shared criteria plus one selected rewrite");
    let after = await readRunState(run);
    assert.equal(after.manifest.tasks.filter((task) => task.stage === "comparison").length, 2);
    for (const task of baseline.manifest.tasks) {
      assert.deepEqual(after.receipts[task.id]!.evaluation, baseline.receipts[task.id]!.evaluation);
      assert.equal(after.receipts[task.id]!.submissionId, baseline.receipts[task.id]!.submissionId);
      assert.equal(after.manifest.states[task.id].attempts, baseline.manifest.states[task.id].attempts);
    }
    const pendingCoverage = deliveryCoverage(after, { rewriteScopes: ["items"] });
    assert.equal(pendingCoverage.valid, false);
    assert.equal(pendingCoverage.required_slots, 4);
    assert.equal(pendingCoverage.filled_slots, 1);
    const missing = await prepareComparisonRewrites(run, { scope: "items", mode: "missing", apply: true });
    assert.equal(missing.slots, 3, "filled slot stays out of the second request");
    await runEvaluation(resume);
    after = await readRunState(run);
    const beforeRefresh = structuredClone(after.receipts[source.id]!.exported!.row);
    assert.equal(deliveryCoverage(after, { rewriteScopes: ["items"], batchIds: ["b1"] }).valid, true);
    assert.equal(deliveryCoverage(after, { rewriteScopes: ["items", "verdicts"] }).valid, false);
    assert.equal(deliveryCoverage(after, { batchIds: ["b2"] }).valid, false);
    assert.equal((await prepareComparisonRewrites(run, { scope: "items", mode: "missing", apply: true })).count, 0);
    const refresh = await prepareComparisonRewrites(run, { ...selection, mode: "refresh", apply: true });
    assert.deepEqual(refresh.selected[0]!.slots, selection.slotIds);
    assert.equal(deliveryCoverage(await readRunState(run), { rewriteScopes: ["items"] }).valid, false,
      "old text cannot make a prepared but unfinished refresh pass acceptance");
    await runEvaluation(resume);
    after = await readRunState(run);
    const afterRefresh = structuredClone(after.receipts[source.id]!.exported!.row);
    const rewrites = (row: typeof afterRefresh) => (row.rewritten as { rewrites: { id: string; text: string }[] }).rewrites;
    const beforeSlot = rewrites(beforeRefresh).find((item) => item.id === selection.slotIds[0])!;
    const afterSlot = rewrites(afterRefresh).find((item) => item.id === selection.slotIds[0])!;
    assert.notEqual(afterSlot.text, beforeSlot.text);
    beforeSlot.text = afterSlot.text;
    assert.deepEqual(afterRefresh, beforeRefresh, "only one text slot changes");
    const review = comparisonRewriteReview(after, [resultId], 1);
    assert.equal(review.semantic_review, "required");
    assert.equal(review.cases[0]!.slots.length, 3, "review includes preference and every cell with source/context");
    assert.deepEqual(after.manifest.executionScope, [applied.selected[0]!.rewrite_task_id]);
    for (const version of config.inputs.versions) await rename(version.sources[0]!.path + ".unavailable", version.sources[0]!.path);
    const storedRows = comparisons.map((task) => structuredClone(after.receipts[task.id]!.exported!.row));
    const originalRows = structuredClone(storedRows);
    const hiddenSlot = rewrites(storedRows[0]!).find((item) => item.id === "comparison.0.B.summary")!;
    hiddenSlot.text = "没有已证实的单方优势：" + hiddenSlot.text;
    await writeJsonl(path.join(run, "results/comparison.jsonl"), storedRows);
    const invalid = await validateDelivery(run, (binding, result, audit) => agents.validate(binding, result, audit),
      { rewriteScopes: ["items"], selectedOnly: true });
    assert.equal(invalid.results.valid, true, "judge fields and latest receipt still match");
    assert.equal(invalid.rewrites.valid, false, "acceptance checks older slots outside the latest partial rewrite receipt");
    await writeJsonl(path.join(run, "results/comparison.jsonl"), originalRows);
    await runEvaluation({ ...resume, discoverInputs: true });
    after = await readRunState(run);
    assert.equal(after.manifest.executionScope, undefined);
    assert.equal(after.manifest.tasks.filter((task) => task.stage === "comparison").length, 3);
    for (const task of baseline.manifest.tasks) assert.equal(after.manifest.states[task.id].attempts, 1);
    assert.equal((await validateRun(run)).valid, true);
  } finally { await worker.close(); await rm(directory, { recursive: true, force: true }); }
});

test("failure circuit preserves healthy downstream work, survives restart and recovers only its frozen scope", async () => {
  const records = [raw("healthy"), raw("broken-1"), raw("broken-2"), raw("broken-3")];
  const { directory, config, modelForStage } = await fixtureConfig([records, [], records, []], true, true);
  config.rewrite.attribution = false;
  const plan = await buildPlan(config), healthy = plan.tasks.find((task) => task.stage === "comparison")!;
  let fail = false;
  const backend: AgentBackend = { identity: fakeIdentity, async createSession(options) {
    return { async run() {
      if (fail && options.spec.evaluation.id === "attribution") throw new Error("injected provider failure");
      const submitted = await options.execute("submit_evaluation", draftFor(options.spec, taskResult(options.spec)));
      assert.equal(submitted.isError, undefined, JSON.stringify(submitted));
    }, async abort() {}, async dispose() {} };
  } };
  const worker = await startWorker(backend, path.join(directory, "worker"));
  const run = path.join(config.output.path, "circuit");
  try {
    const options = { ...services, runId: "circuit", output: config.output, engine: "pi" as const,
      identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion, config, plan, policy: config.execution,
      modelForStage, concurrency: 1, retries: 5, retryDelaySeconds: 0, workerUrls: [worker.url],
      failureGuard: { windowSize: 4, threshold: 2 } };
    await runEvaluation({ ...options, taskIds: Object.values(healthy.dependencies) });
    fail = true;
    const resume = { ...options, plan: { tasks: [], inputs: {}, summary: {} } };
    await runEvaluation({ ...resume, discoverInputs: true });
    const paused = await readRunState(run);
    assert.equal(paused.manifest.pausedStages!.length, 1);
    assert.equal(paused.manifest.pausedStages![0]!.stage, "attribution");
    assert.equal(progressSnapshot(paused).stages.attribution!.ready, 0);
    assert.equal(progressSnapshot(paused).eta_status, "paused");
    assert(paused.receipts[healthy.id], "comparison with healthy dependencies commits during the circuit break");
    const healthyRewrite = paused.manifest.tasks.find((task) => (task.data as TaskData).rewriteOf?.taskId === healthy.id)!;
    assert(paused.receipts[healthyRewrite.id]);
    const neverStarted = plan.tasks.filter((task) => task.stage === "attribution" && !paused.manifest.states[task.id].attempts);
    assert(neverStarted.length >= 2, "shared failures stop new attempts before exhausting all inputs");
    await runEvaluation(resume);
    const stopped = await readRunState(run);
    for (const task of plan.tasks) assert.equal(stopped.manifest.states[task.id].attempts, paused.manifest.states[task.id].attempts);
    const failed = plan.tasks.find((task) => stopped.manifest.states[task.id].status === "failed")!;
    const preview = await prepareFailedTasks(run, { taskIds: [failed.id] });
    assert(preview.count >= 3, "recovery includes required counterpart attribution, comparison and rewrite");
    assert(!preview.selected.some((task) => task.stage === "clustering"), "a shared clustering shard cannot drag other failed cases into local recovery");
    assert(!preview.selected.some((task) => stopped.receipts[task.task_id]));
    const before = await readFile(path.join(run, "state.json"), "utf8");
    await prepareFailedTasks(run, { taskIds: [failed.id] });
    assert.equal(await readFile(path.join(run, "state.json"), "utf8"), before);
    await prepareFailedTasks(run, { taskIds: [failed.id], apply: true });
    fail = false;
    await runEvaluation({ ...resume, resumeStages: ["attribution"] });
    const repaired = await readRunState(run), selected = new Set(repaired.manifest.executionScope);
    for (const task of plan.tasks) {
      if (selected.has(task.id)) assert.equal(repaired.manifest.states[task.id].status, "succeeded");
      else {
        assert.equal(repaired.manifest.states[task.id].attempts, stopped.manifest.states[task.id].attempts);
        assert.equal(repaired.receipts[task.id]?.submissionId, stopped.receipts[task.id]?.submissionId);
      }
    }
    assert.equal(deliveryCoverage(repaired, { selectedOnly: true, rewriteScopes: ["verdicts"] }).valid, true);
    assert.equal(deliveryCoverage(repaired).valid, false, "a partial repair is not full delivery");
  } finally { await worker.close(); await rm(directory, { recursive: true, force: true }); }
});

test("pilot samples date/group strata and includes only their dependencies and rewrites", async () => {
  const records = [raw("q1"), raw("q2"), { ...raw("q3"), batch_id: "b2" }];
  const { directory, config } = await fixtureConfig([records, records, records, records], true);
  try {
    config.comparisons = [["a_fast", "b_fast"], ["a_expert", "b_expert"]];
    const plan = await buildPlan(config), selected = new Set(pilotTaskIds(plan, 4));
    const comparisons = plan.tasks.filter((task) => selected.has(task.id) && task.stage === "comparison");
    assert.equal(comparisons.length, 4);
    assert.equal(new Set(comparisons.map((task) => JSON.stringify([(task.data as TaskData).group, Object.values((task.data as TaskData).candidates)[0]!.batch_id]))).size, 4);
    for (const task of plan.tasks.filter((task) => selected.has(task.id)))
      for (const id of Object.values(task.dependencies)) assert(selected.has(id));
    assert(!plan.tasks.filter((task) => selected.has(task.id)).some((task) => task.stage === "clustering"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
