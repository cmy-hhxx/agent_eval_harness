import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { runEvaluation } from "@eval/host";
import { startWorker } from "@eval/runtime/worker";
import { buildPlan, readRunState, prepareComparisonRewrites, pilotTaskIds, type TaskData } from "@eval/workflows/comparison";
import { services } from "../../fixtures/services.js";
import { submitFor, inspectFor, draftFor, fakeEvaluatorVersion, fakeIdentity, fixtureConfig, raw, taskResult } from "../../fixtures/comparison.js";

for (const configured of [false, true]) test(`repeated comparison rewrite preparation preserves an exhausted ${configured ? "default" : "targeted"} content ledger and cannot dispatch again`, async () => {
  const { directory, config, modelForStage } = await fixtureConfig(undefined, configured);
  config.rewrite.attribution = false;
  let calls = 0;
  const worker = await startWorker({ identity: fakeIdentity, async createSession(options) {
    return { async run() {
      await inspectFor(options); calls++;
      const result = taskResult(options.spec);
      if (options.spec.evaluation.id === "rewrite") {
        for (const item of (result as { rewrites: { text: string }[] }).rewrites) item.text = "";
        for (let index = 0; index <= options.spec.policy.repairAttempts; index++)
          assert.equal((await submitFor(options, draftFor(options.spec, result))).isError, true);
      } else assert.equal((await submitFor(options, draftFor(options.spec, result))).isError, undefined);
    }, async abort() {}, async dispose() {} };
  } }, path.join(directory, "worker"));
  const run = path.join(config.output.path, "exhausted-rewrite");
  try {
    const options = { ...services, runId: "exhausted-rewrite", output: config.output, engine: "pi" as const,
      identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion, config, plan: await buildPlan(config), policy: config.execution,
      modelForStage, concurrency: 1, retries: 0, retryDelaySeconds: 0, workerUrls: [worker.url] };
    await runEvaluation(options);
    const state = await readRunState(run), source = state.manifest.tasks.find(task => task.stage === "comparison" && !(task.data as TaskData).verificationAudit)!;
    const selection = { scope: configured ? "verdicts" as const : "items" as const, mode: "missing" as const, taskIds: [source.id], apply: true };
    const prepared = await prepareComparisonRewrites(run, selection), id = prepared.selected[0]!.rewrite_task_id!;
    if (configured) assert.equal(id, state.manifest.tasks.find(task => (task.data as TaskData).rewriteOf?.taskId === source.id)!.id,
      "default slot ownership is the same work even when its slot list was implicit");
    const resume = { ...options, plan: { tasks: [], inputs: {}, summary: {} } };
    await runEvaluation(resume);
    const spent = await readRunState(run), failure = structuredClone(spent.manifest.states[id].failure!);
    assert.equal(failure.contentSubmissions, 1 + config.execution.repairAttempts);
    const callsAfterFailure = calls;
    for (let index = 0; index < 2; index++) {
      assert.equal((await prepareComparisonRewrites(run, selection)).selected[0]!.rewrite_task_id, id);
      assert.deepEqual((await readRunState(run)).manifest.states[id].failure, failure);
      await runEvaluation(resume);
      assert.equal(calls, callsAfterFailure, "no model session can start after the cumulative cap is spent");
    }
  } finally { await worker.close(); await rm(directory, { recursive: true, force: true }); }
});

test("pilot samples date/group strata and includes only their dependencies and rewrites", async () => {
  const records = [raw("q1"), raw("q2"), { ...raw("q3"), batch_id: "b2" }];
  const { directory, config } = await fixtureConfig([records, records, records, records], true);
  try {
    config.comparisons = [["a_fast", "b_fast"], ["a_expert", "b_expert"]];
    const plan = await buildPlan(config), selected = new Set(pilotTaskIds(plan, 4));
    const comparisons = plan.tasks.filter((task) => selected.has(task.id) && task.stage === "comparison" && !(task.data as { verificationAudit?: boolean }).verificationAudit);
    assert.equal(comparisons.length, 4);
    assert.equal(new Set(comparisons.map((task) => JSON.stringify([(task.data as TaskData).group, Object.values((task.data as TaskData).candidates)[0]!.batch_id]))).size, 4);
    for (const task of plan.tasks.filter((task) => selected.has(task.id)))
      for (const id of Object.values(task.dependencies)) assert(selected.has(id));
    assert(!plan.tasks.filter((task) => selected.has(task.id)).some((task) => task.stage === "clustering"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
