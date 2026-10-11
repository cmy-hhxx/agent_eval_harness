import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { emptyUsage, evidenceId, type AgentBackend, type ProblemLibrary, type RunState, type SubmissionReceipt } from "@eval/contracts";
import { exists, readJson, problemLibraryFile, writeJson } from "@eval/data";
import { runEvaluation } from "@eval/host";
import { startWorker } from "@eval/runtime/worker";
import { buildPlan, createResultWriter, prepareClusteringJob, readRunState, writeRunState,
  clusteringJobWorkflow, clusteringJobRepository, reportClusteringJob, reviewProblemOccurrences,
  readConfiguredProblemClass,
  type TaskData } from "@eval/workflows/comparison";
import { ROOT, services } from "../../fixtures/services.js";
import { attributionResult, criteriaResultForTask, emptyAudit, draftFor, fakeEvaluatorVersion, fakeIdentity,
  fixtureConfig, parsedMaterial, raw, submitFor, taskResult } from "../../fixtures/comparison.js";

async function fixture() {
  const days = ["2026-10-08", "2026-10-09"];
  const records = days.flatMap(batch_id => ["q1", "q2"].map(id => ({ ...raw(id, "4", "2+2=5"), batch_id })));
  const f = await fixtureConfig([records, [], records, []]);
  f.config.rewrite.clustering = true;
  f.config.clustering.maxCasesPerTask = 1;
  const runs: string[] = [];
  for (const day of days) {
    const config = { ...f.config, inputs: { ...f.config.inputs, batches: [day] } };
    const plan = await buildPlan(config), runId = "daily-" + day, run = path.join(config.output.path, runId);
    const receipts: Record<string, SubmissionReceipt> = {};
    for (const task of plan.tasks.filter(task => task.stage === "attribution" || task.stage === "criteria")) {
      const candidate = (task.data as TaskData).candidates.A;
      const evaluation = task.stage === "criteria" ? criteriaResultForTask(task, plan.inputs) : attributionResult(false, "2+2=5", true, candidate.input_id);
      if (task.stage === "attribution") {
        const result = evaluation as ReturnType<typeof attributionResult>;
        result.task_analysis = criteriaResultForTask(task, plan.inputs);
        result.findings[0].problem!.definition += candidate.case_id;
      }
      receipts[task.id] = { taskId: task.id, attemptId: randomUUID(), submissionId: randomUUID(),
        evaluation, evaluatorVersion: fakeEvaluatorVersion, judge: "fixture", acceptedAt: days.indexOf(day) + 1,
        status: "succeeded", audit: emptyAudit(), usage: emptyUsage() };
    }
    const state: RunState = { manifest: { format: "evaluation-run", runId, status: "interrupted", config,
      engine: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion, debug: false, tasks: plan.tasks, inputCatalog: plan.catalog,
      inputs: {}, states: Object.fromEntries(plan.tasks.map(task => [task.id, { status: receipts[task.id] ? "succeeded" : "pending", attempts: 0 }])),
      preflight: plan.summary, startedAt: 1 }, receipts, usage: emptyUsage(), recordedAttempts: 0 };
    await createResultWriter(run, plan.inputs)(state);
    await writeRunState(run, state);
    runs.push(run);
  }
  return { ...f, runs };
}
const sourceFiles = (runs: string[]) => runs.flatMap(run => ["state.json", "results/attribution.jsonl"].map(file => path.join(run, file)));
const contents = (files: string[]) => Promise.all(files.map(file => readFile(file, "utf8")));

test("multi-run clustering pools dates per model without reading raw answers or modifying source runs", async () => {
  const f = await fixture();
  try {
    const before = await contents(sourceFiles(f.runs));
    for (const version of f.config.inputs.versions) await rename(version.sources[0].path, version.sources[0].path + ".offline");
    for (const run of f.runs) await rm(path.join(run, "results/criteria.jsonl"));
    const { config, plan } = await prepareClusteringJob([...f.runs, f.runs[0]], f.config);
    assert.equal(config.clusteringJob.sources.length, 8);
    assert.equal(plan.summary.clustering_tasks, 6);
    for (const task of plan.tasks.filter(task => task.stage === "clustering")) {
      const request = clusteringJobWorkflow.bind(task, plan.inputs, {}, { tasks: plan.tasks }).request.input;
      assert.deepEqual(request.batch_ids, ["2026-10-08", "2026-10-09"]);
      const items = request.items as { count: number }[];
      if (items.length) assert.equal(items[0].count, 2);
      else assert.equal((request.budget as { consolidate: boolean }).consolidate, true);
    }
    assert.equal(plan.tasks.filter(task => task.stage === "clustering" && task.dependencies.previous).length, 4);
    assert.deepEqual(await contents(sourceFiles(f.runs)), before);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("cluster CLI accepts repeated run selections and previews without creating a job", async () => {
  const f = await fixture();
  try {
    const configFile = path.join(f.directory, "host.json"), output = path.join(f.directory, "clustering");
    await writeJson(configFile, { ...f.config, evaluatorVersion: fakeEvaluatorVersion });
    const args = [path.join(ROOT, "dist/apps/host/src/cli.js"), "cluster",
      "--config", path.join(ROOT, "configs/host.json"), "--config", configFile,
      ...f.runs.flatMap(run => ["--run", run]), "--run-id", "preview", "--output", output];
    const exec = promisify(execFile), before = await contents(sourceFiles(f.runs));
    const result = await exec(process.execPath, args, { env: process.env });
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.attribution_answers, 8);
    assert.deepEqual(summary.models.a_fast.dates, ["2026-10-08", "2026-10-09"]);
    assert.equal(await exists(path.join(output, "preview", "state.json")), false);
    assert.deepEqual(await contents(sourceFiles(f.runs)), before);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("independent clustering resumes failed tasks, recalls prior shards and retains auditable source evidence", async () => {
  const f = await fixture(), calls: string[] = [], reused: string[] = [];
  let fail = true;
  const backend: AgentBackend = { identity: fakeIdentity, async createSession(options) {
    return { async run() {
      assert(["clustering", "rewrite"].includes(options.spec.evaluation.id));
      calls.push(options.spec.taskId);
      const material = parsedMaterial(options.spec) as { model?: string; library?: { components: { classes: unknown[] }[] } };
      if (material.library?.components.some(component => component.classes.length)) {
        reused.push(material.model!);
        if (fail && material.model === "a_fast") { fail = false; throw new Error("injected interruption before submission"); }
      }
      const result = await submitFor(options, draftFor(options.spec, taskResult(options.spec)));
      assert.equal(result.isError, undefined, JSON.stringify(result));
    }, async abort() {}, async dispose() {} };
  } };
  const worker = await startWorker(backend, path.join(f.directory, "worker"));
  try {
    const before = await contents(sourceFiles(f.runs));
    const output = { kind: "directory" as const, path: path.join(f.directory, "clustering") };
    const { config, plan } = await prepareClusteringJob(f.runs, { ...f.config, output });
    const options = { ...services, taskSource: clusteringJobWorkflow, repository: clusteringJobRepository, report: reportClusteringJob,
      runId: "joint", output, engine: "pi" as const, identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion,
      config, plan, policy: config.execution, modelForStage: f.modelForStage, concurrency: 2, retries: 0,
      retryDelaySeconds: 0, workerUrls: [worker.url] };
    const run = path.join(output.path, "joint");
    await runEvaluation(options);
    const interrupted = await clusteringJobRepository.readRun(run);
    assert(Object.values(interrupted.manifest.states).some(state => state.status === "failed"));
    const acceptedIds = Object.keys(interrupted.receipts), callCount = calls.length;
    await runEvaluation({ ...options, plan: { tasks: [], inputs: {}, summary: {} }, evaluatorVersion: "next-evaluator" });
    const finished = await clusteringJobRepository.readRun(run);
    assert(Object.values(finished.manifest.states).every(state => state.status === "succeeded"));
    assert(calls.slice(callCount).every(id => !acceptedIds.includes(id)));
    for (const id of acceptedIds) assert.equal(finished.receipts[id].submissionId, interrupted.receipts[id].submissionId);
    assert(reused.includes("a_fast") && reused.includes("b_fast"));
    assert.deepEqual(await contents(sourceFiles(f.runs)), before);
    const checkpoint = await readFile(path.join(run, "state.json"), "utf8");
    assert(!checkpoint.includes('"findings"') && !checkpoint.includes('"evaluation"'));
    const file = problemLibraryFile(config.problemLibrary, "a_fast"), library = await readJson<ProblemLibrary>(file);
    assert.equal(Object.values(library.classes).filter(item => item.status === "active").length, 1);
    assert.equal(library.occurrences.length, 4);
    assert.deepEqual([...new Set(library.occurrences.map(item => item.batch_id))].sort(), ["2026-10-08", "2026-10-09"]);
    assert(library.occurrences.every(item => item.clustering_run === run && f.runs.includes(item.attribution!.run)));
    const recalled = await readConfiguredProblemClass(f.config, "a_fast", library.occurrences[0].class_id, 1);
    assert(recalled!.occurrences.every(item => item.recall.available && item.recall.url?.includes("daily-")));
    await reportClusteringJob(run);
    assert.equal((await readJson<ProblemLibrary>(file)).occurrences.length, 4);
    const occurrence = library.occurrences[0];
    const review = await reviewProblemOccurrences(f.config, { id: randomUUID(), model: "a_fast", items: [{
      occurrence_id: occurrence.id, reason: "来源审计测试", evidence: [{ evidence_id: evidenceId(occurrence.input_id, 1, "text", "/content", 0, 5) }],
    }] }, { evaluatorVersion: "audit" });
    assert.equal(review.after, 3);
    const beforeResume = calls.length;
    await runEvaluation({ ...options, plan: { tasks: [], inputs: {}, summary: {} } });
    assert.equal(calls.length, beforeResume);
  } finally { await worker.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("selection gates unfinished attribution, skips failures and rejects changed pinned receipts", async () => {
  const f = await fixture();
  try {
    const state = await readRunState(f.runs[0]), task = state.manifest.tasks.find(task => task.stage === "attribution")!;
    state.manifest.states[task.id].status = "pending";
    await writeRunState(f.runs[0], state);
    await assert.rejects(prepareClusteringJob(f.runs, f.config), /归因尚未全部结束/);
    state.manifest.states[task.id].status = "failed";
    delete state.receipts[task.id];
    await writeRunState(f.runs[0], state);
    const { config, plan } = await prepareClusteringJob(f.runs, f.config);
    assert.equal(config.clusteringJob.sources.length, 7);
    assert.equal(plan.summary.excluded_attributions, 1);
    const source = config.clusteringJob.sources[0], original = await readRunState(source.run);
    original.receipts[source.task_id].submissionId = randomUUID();
    await writeRunState(source.run, original);
    const independent: RunState = { ...original, manifest: { ...original.manifest, config, tasks: plan.tasks } };
    await assert.rejects(clusteringJobWorkflow.reconcile!("unused", independent, config), /原归因引用已缺失或改变|身份不一致/);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("overlapping runs select the latest accepted dated answer once", async () => {
  const f = await fixture();
  try {
    const state = await readRunState(f.runs[0]), run = path.join(f.config.output.path, "rerun");
    state.manifest.runId = "rerun";
    for (const receipt of Object.values(state.receipts)) receipt.acceptedAt += 100;
    await createResultWriter(run, {})(state);
    await writeRunState(run, state);
    const result = await prepareClusteringJob([...f.runs, run], f.config);
    assert.equal(result.config.clusteringJob.sources.length, 8);
    assert.equal(result.plan.summary.duplicate_answers, 4);
    assert(result.config.clusteringJob.sources.filter(source => source.batch_id === "2026-10-08").every(source => source.run === run));
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
