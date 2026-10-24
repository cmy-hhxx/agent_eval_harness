import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { emptyUsage, type RunState } from "@eval/contracts";
import { answerReviewRepository, planAnswerReview, answerReviewTaskInput, type AnswerReviewConfig } from "@eval/workflows/answer-review";
import { CatalogAnalysisData } from "../../../apps/host/src/assistant-catalog.js";
import { fixtureConfig, raw, attributionResult, emptyAudit, fakeIdentity, fakeEvaluatorVersion } from "../../fixtures/comparison.js";

test("catalog reads current AIME without overviews, namespaces equal run IDs and preserves code-point evidence", async t => {
  const row = raw("one"); row.messages.at(-1)!.content = "答案😀正确";
  const f = await fixtureConfig([[row], [], [], []]); t.after(() => rm(f.directory, { recursive: true, force: true }));
  const config: AnswerReviewConfig = { ...f.config, workflow: "answer-review", reviewStages: ["attribution"],
    comparisons: [], rewrite: { ...f.config.rewrite, attribution: false }, inputs: { ...f.config.inputs, versions: f.config.inputs.versions.slice(0, 1) } };
  const plan = await planAnswerReview(config), task = plan.tasks[0];
  const inputId = answerReviewTaskInput(task), evaluation = attributionResult(true,"答案😀正确",true,inputId);
  const sourceId = evaluation.findings[0].evidence[0].evidence_id;
  const state: RunState = { manifest: { format: "evaluation-run", debug: false, runId: "same", status: "finished", engine: fakeIdentity,
    evaluatorVersion: fakeEvaluatorVersion, config, tasks: plan.tasks, inputCatalog: plan.catalog, inputs: {},
    states: { [task.id]: { status: "succeeded", attempts: 1 } }, preflight: plan.summary, startedAt: 1 },
    receipts: { [task.id]: { taskId: task.id, attemptId: randomUUID(), submissionId: randomUUID(), evaluatorVersion: fakeEvaluatorVersion,
      judge: "fixture", status: "succeeded", acceptedAt: 1, evaluation, audit: emptyAudit(), usage: emptyUsage() } }, usage: emptyUsage(), recordedAttempts: 1 };
  const root = path.join(f.directory, "data"), collectionId = "1_aime/0_daily_eval";
  const runs = ["1_aime/eval_output/0_daily_eval/same", "0_wencai/eval_output/1_task_eval/task/same", "1_aime/eval_output/test_eval/same"];
  for (const relative of runs) {
    const run = path.join(root, relative); await mkdir(run, { recursive: true });
    await answerReviewRepository.createResultWriter(run, plan.inputs)(state); await answerReviewRepository.writeRun(run, state);
  }
  const clustering = path.join(root, "0_wencai/eval_output/1_task_eval/task/clustering/job");
  await mkdir(clustering, { recursive: true });
  await writeFile(path.join(clustering, "state.json"), JSON.stringify({ kind: "clustering-job" }));
  const archived = path.join(root,"1_aime/eval_output/0_daily_eval/.archive/old/same");
  await mkdir(archived,{recursive:true}); await writeFile(path.join(archived,"state.json"),"{}");
  const catalog = new CatalogAnalysisData(root);
  const directory = await catalog.list({});
  assert.equal((directory.runDirectory as { complete: boolean }).complete, true, "standalone clustering jobs are not evaluation runs");
  assert.equal((directory.items as unknown[]).length, 2);
  assert.equal((await catalog.list({ includeTests: true })).total, 3);
  const run = path.join(root, runs[0]), before = await readFile(path.join(run, "state.json"));
  // Directory discovery must not read accepted bodies.
  const resultFile = path.join(run, "results/attribution.jsonl"), result = await readFile(resultFile);
  await writeFile(resultFile, "not JSON\n"); assert.equal((await catalog.list({})).total, 2); await writeFile(resultFile, result);
  const inputs = await catalog.list({ collectionId, runId: "same", view: "inputs" });
  assert.equal((inputs.items as { reference: { collectionId: string } }[])[0].reference.collectionId, collectionId);
  const accepted = await catalog.read({ collectionId, runId: "same", taskId: task.id });
  assert.equal(accepted.workflow, "answer-review");
  const evidence = await catalog.read({ collectionId, runId: "same", taskId: task.id, sourceId }, { offset: 2, limit: 1 });
  assert.equal(evidence.text, "😀"); assert.equal(evidence.unit, "unicode_code_points");
  const shifted = structuredClone(row);
  shifted.messages.splice(1, 0, { role: "assistant", type: "reasoning", content: "新采集的推理节点" });
  await writeFile(config.inputs.versions[0].sources[0].path, JSON.stringify(shifted) + "\n");
  await assert.rejects(catalog.read({ collectionId, runId: "same", taskId: task.id, sourceId }), /evidence|证据/);
  await assert.rejects(catalog.list({ runId: "same" }), /collectionId/);
  await assert.rejects(catalog.list({ collectionId, runId: "same", view: "comparisons" }), /没有两两胜负/);
  await assert.rejects(catalog.read({ collectionId: "../escape", runId: "same", taskId: task.id }), /不存在/);
  assert.deepEqual(await readFile(path.join(run, "state.json")), before);
  assert.deepEqual(await readFile(resultFile), result);
  const broken = path.join(root, "2_ifind/eval_output/0_daily_eval/broken");
  await mkdir(broken, { recursive: true }); await writeFile(path.join(broken, "state.json"), "{}");
  const partial = (await catalog.list({})).runDirectory as { complete: boolean; errors: { runId: string; message: string }[] };
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.errors.map(item => item.runId), ["broken"]);
  assert.match(partial.errors[0].message, /缺少 overview/);
});
