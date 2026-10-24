import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { emptyUsage, type RunState, type SubmissionReceipt } from "@eval/contracts";
import { readJsonl, writeJsonl } from "@eval/data";
import { answerReviewRepository, planAnswerReview, type AnswerReviewConfig } from "@eval/workflows/answer-review";
import { createClusteringJobRepository, createClusteringJobWorkflow, prepareClusteringJob, reportClusteringJob,
  validateClusteringJob, type ClusteringJobConfig } from "@eval/workflows/comparison";
import { readClusteringSource } from "../../../apps/host/src/clustering-sources.js";
import { attributionResult, emptyAudit, fakeEvaluatorVersion, fakeIdentity, fakeJudge, fixtureConfig, raw } from "../../fixtures/comparison.js";
import { ROOT } from "../../fixtures/services.js";

const receipt = (taskId: string, evaluation: unknown): SubmissionReceipt => ({ taskId, evaluation,
  attemptId: randomUUID(), submissionId: randomUUID(), acceptedAt: 1, status: "succeeded", evaluatorVersion: fakeEvaluatorVersion,
  judge: fakeJudge, audit: emptyAudit(), usage: emptyUsage() });

test("AIME freezes current accepted attributions, clusters them and exports all answers without changing the source", async t => {
  const fixture = await fixtureConfig([[raw("bad", "4", "2+2=5"), raw("good")], [], [], []]);
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const config: AnswerReviewConfig = { ...fixture.config, workflow: "answer-review", reviewStages: ["attribution"],
    inputs: { ...fixture.config.inputs, versions: fixture.config.inputs.versions.slice(0, 1) }, rewrite: { attribution: false } };
  const plan = await planAnswerReview(config), run = path.join(config.output.path, "answers");
  const state: RunState = { manifest: { format: "evaluation-run", debug: false, runId: "answers", status: "finished",
    engine: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion, config, tasks: plan.tasks, inputCatalog: plan.catalog,
    inputs: {}, states: Object.fromEntries(plan.tasks.map(task => [task.id, { status: "pending", attempts: 0 }])),
    preflight: plan.summary, startedAt: 1 }, receipts: {}, usage: emptyUsage(), recordedAttempts: 0 };
  const base = { ...fixture.config, rewrite: { ...fixture.config.rewrite, clustering: false },
    clustering: { ...fixture.config.clustering, minSupport: 1 } };
  await answerReviewRepository.writeRun(run, state);
  await assert.rejects(prepareClusteringJob([run], base, { readSource: readClusteringSource }), /归因尚未全部结束/);
  for (const task of plan.tasks) {
    const candidate = plan.catalog.find(candidate => candidate.input_id === task.inputIds.answer)!;
    state.receipts[task.id] = receipt(task.id, attributionResult(candidate.case_id === "good",
      candidate.case_id === "good" ? "2+2=4" : "2+2=5", true, candidate.input_id));
    state.manifest.states[task.id] = { status: "succeeded", attempts: 1 };
  }
  await answerReviewRepository.createResultWriter(run, plan.inputs)(state);
  await answerReviewRepository.writeRun(run, state);
  const sourceFiles = [path.join(run, "state.json"), path.join(run, "results/attribution.jsonl")];
  const before = await Promise.all(sourceFiles.map(file => readFile(file)));
  const prepared = await prepareClusteringJob([run], base, { readSource: readClusteringSource });
  assert.equal(prepared.config.clusteringJob.sources.length, 2);
  assert.equal(prepared.plan.summary.attribution_answers, 2);
  const cluster = path.join(base.output.path, "tree"), repository = createClusteringJobRepository(readClusteringSource);
  const workflow = createClusteringJobWorkflow(readClusteringSource);
  const clustered: RunState = { ...state, manifest: { ...state.manifest, runId: "tree", config: prepared.config,
    tasks: prepared.plan.tasks, inputCatalog: [], preflight: prepared.plan.summary,
    states: Object.fromEntries(prepared.plan.tasks.map(task => [task.id, { status: "pending", attempts: 0 }])) }, receipts: {} };
  const writer = repository.createResultWriter(cluster, prepared.plan.inputs);
  for (const task of prepared.plan.tasks) {
    const binding = workflow.bind(task, prepared.plan.inputs, {}, { tasks: prepared.plan.tasks });
    const items = binding.request.input.items as { id: string; component: string }[];
    const result = { assignments: items.map(item => ({ item_id: item.id, new_class_key: "arithmetic" })),
      new_classes: items.length ? [{ key: "arithmetic", component: items[0].component, label: "算术错误",
        definition: "算术运算给出错误结果。", closest_existing: null, novelty: "首次发现。", category_paths: [["计算错误"]] }] : [],
      merges: [], class_updates: [] };
    clustered.receipts[task.id] = receipt(task.id, result);
    clustered.manifest.states[task.id] = { status: "succeeded", attempts: 1 };
    await writer(clustered);
    await repository.writeRun(cluster, clustered);
  }
  await reportClusteringJob(cluster, readClusteringSource);
  assert.equal((await validateClusteringJob(cluster, readClusteringSource)).valid, true);
  for (const command of ["validate", "report"]) {
    const { stdout } = await promisify(execFile)(process.execPath, [path.join(ROOT, "dist/tests/fixtures/cli.js"),
      fixture.directory, command, "--run", cluster], { env: { ...process.env, EVAL_CONFIG_FILE: path.join(fixture.directory, "config.ini") } });
    const result = JSON.parse(stdout);
    if (command === "validate") assert.equal(result.valid, true);
    else assert.equal(result.workflow, "clustering-job");
  }
  const tree = [];
  for await (const node of readJsonl(path.join(cluster, "cluster_tree.jsonl"))) tree.push(node as Record<string, any>);
  assert.deepEqual(tree.map(node => node.level), [0, 1, 2, 3]);
  assert.equal(tree[0].count, 1);
  assert.equal(tree[0].meta.answer_ids.length, 2, "healthy answers remain in full cohort coverage");
  assert.equal(tree[3].samples.length, 1);
  assert.equal(tree[3].samples[0].attribution.run, run);
  assert.deepEqual(await Promise.all(sourceFiles.map(file => readFile(file))), before);
  await writeJsonl(path.join(cluster, "cluster_tree.jsonl"), tree.map(node => ({ ...node, count: 999 })));
  await assert.rejects(validateClusteringJob(cluster, readClusteringSource), /聚类树与当前冻结来源或问题库不一致/);
  await reportClusteringJob(cluster, readClusteringSource);
  const sources = prepared.config.clusteringJob.sources;
  await assert.rejects(prepareClusteringJob([run], base, { inputIds: ["missing"], readSource: readClusteringSource }), /缺少已接受归因/);
  const rows = [];
  for await (const row of readJsonl(sourceFiles[1])) rows.push(row);
  await writeJsonl(sourceFiles[1], rows.map((row, index) => index ? row : { ...row as object, submission_id: randomUUID() }));
  await assert.rejects(readClusteringSource(run, [sources[0].task_id]), /来源收据不一致/);
  assert.equal((clustered.manifest.config as ClusteringJobConfig).clusteringJob.sources.length, 2);
});
