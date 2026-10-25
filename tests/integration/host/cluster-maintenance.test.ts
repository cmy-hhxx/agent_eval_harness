import { responsibilityFixture } from "../../fixtures/responsibility.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { emptyUsage, evidenceId, type AgentBackend, type ProblemLibrary, type ProblemProjection, type RunState, type SubmissionReceipt } from "@eval/contracts";
import { applyClustering, effectiveProblemOccurrences, emptyLibrary, type ClusteringRequest, type ClusteringResult } from "@eval/agents/clustering";
import type { ClusteringJobMaterial } from "../../../packages/workflows/src/comparison/clustering-job-types.js";
import { exists, fileSourceReader, readJson, problemLibraryFile, writeJson, writeProblemLibrary } from "@eval/data";
import { runEvaluation } from "@eval/host";
import { startWorker } from "@eval/runtime/worker";
import { buildPlan, createResultWriter, prepareClusteringJob, readRunState, writeRunState,
  clusteringJobWorkflow, clusteringJobRepository, reportClusteringJob, reviewProblemOccurrences,
  readConfiguredProblemClass, prepareAttributionRewrites, clusteringSlots,
  type TaskData } from "@eval/workflows/comparison";
import { ROOT, services } from "../../fixtures/services.js";
import { attributionResult, criteriaResultForTask, emptyAudit, draftFor, fakeEvaluatorVersion, fakeIdentity,
  fixtureConfig, parsedMaterial, raw, submitFor, taskResult } from "../../fixtures/comparison.js";

async function fixture(caseCount = 2, components?: string[], uniqueProblems = false) {
  const days = ["2026-10-08", "2026-10-09"];
  const records = days.flatMap(batch_id => Array.from({ length: caseCount }, (_, index) => `q${index + 1}`)
    .map(id => ({ ...raw(id, "4", "2+2=5"), batch_id })));
  const f = await fixtureConfig([records, [], records, []]);
  f.config.rewrite.clustering = true;
  f.config.clustering.maxCasesPerTask = 1;
  f.config.clustering.minSupport = 1;
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
        if (uniqueProblems) result.findings[0].problem!.label += " " + candidate.batch_id + " " + candidate.case_id;
        if (components) result.findings = components.map((component, index) => ({ ...structuredClone(result.findings[0]),
          finding_id: "f" + index, problem: { ...result.findings[0].problem!, component: [responsibilityFixture(component, {evidence_ids: result.findings[0].evidence.map(item=>item.evidence_id)})] } }));
        result.findings.forEach(finding => { finding.problem!.definition += candidate.case_id; });
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

test("live clustering ignores unrelated progress but rejects changed selected source receipts", async t => {
  const f = await fixture(1); t.after(() => rm(f.directory, { recursive: true, force: true }));
  const run = f.runs[0], file = path.join(run, "state.json");
  const state = await readRunState(run), answer = state.manifest.tasks.find(task => task.stage === "attribution")!;
  const unrelated = state.manifest.tasks.find(task => task.stage === "comparison")!;
  const original = await readFile(file, "utf8"), revision = fileSourceReader.revision.bind(fileSourceReader);
  for (const changeSelected of [false, true]) {
    await writeFile(file, original);
    let reads = 0;
    const mocked = t.mock.method(fileSourceReader, "revision", async (target: string) => {
      if (target === file && ++reads === 2) {
        const checkpoint = JSON.parse(await readFile(file, "utf8"));
        if (changeSelected) checkpoint.tasks[answer.id].receipt.submissionId = randomUUID();
        else checkpoint.tasks[unrelated.id].status = "running";
        await writeJson(file, checkpoint);
      }
      return revision(target);
    });
    try {
      const prepared = prepareClusteringJob([run], f.config, { inputIds: [answer.inputIds.answer] });
      if (changeSelected) await assert.rejects(prepared, /来源.*变化|原归因引用.*改变/);
      else assert.deepEqual((await prepared).config.clusteringJob.sources.map(source => source.submission_id),
        [state.receipts[answer.id].submissionId]);
    } finally { mocked.mock.restore(); }
  }
});

test("deferred findings persist across jobs and recall their pinned attribution without reading raw answers", async t => {
  const f = await fixture(); t.after(() => rm(f.directory, { recursive: true, force: true }));
  f.config.rewrite.clustering = false;
  const before = await contents(sourceFiles(f.runs));
  const { config, plan } = await prepareClusteringJob([f.runs[0]], f.config, { assignmentOnly: true });
  const receipts = Object.fromEntries(plan.tasks.map(task => [task.id, {
    taskId: task.id, attemptId: randomUUID(), submissionId: randomUUID(), evaluatorVersion: fakeEvaluatorVersion,
    judge: "fixture", acceptedAt: 1, status: "succeeded" as const, audit: emptyAudit(), usage: emptyUsage(),
    evaluation: { assignments: (task.data as { itemIds: string[] }).itemIds.map(item_id =>
      ({ item_id, deferred_reason: "固定目录尚无适用类。" })), new_classes: [], merges: [] },
  }]));
  const state: RunState = { manifest: { format: "evaluation-run", runId: "defer", status: "finished", config, engine: fakeIdentity,
    evaluatorVersion: fakeEvaluatorVersion, debug: false, tasks: plan.tasks, inputs: {},
    states: Object.fromEntries(plan.tasks.map(task => [task.id, { status: "succeeded", attempts: 1 }])),
    preflight: plan.summary, startedAt: 1 }, receipts, usage: emptyUsage(), recordedAttempts: plan.tasks.length };
  const run = path.join(f.directory, "defer");
  await clusteringJobRepository.createResultWriter(run, plan.inputs)(state);
  await clusteringJobRepository.writeRun(run, state);
  for (const model of ["a_fast", "b_fast"]) {
    const library = await readJson<ProblemLibrary>(problemLibraryFile(config.problemLibrary, model));
    assert.equal(library.pending_observations!.length, 2);
    assert.equal(library.occurrences.length, 0);
  }
  for (const version of f.config.inputs.versions) await rename(version.sources[0].path, version.sources[0].path + ".offline");
  const next = await prepareClusteringJob([f.runs[1]], f.config);
  assert.equal(next.config.clusteringJob.sources.length, 4);
  assert.equal(next.config.clusteringJob.recall!.length, 4);
  assert.equal(next.plan.summary.recalled_answers, 4);
  assert(next.plan.tasks.every(task => ["clustering", "rewrite"].includes(task.stage)));
  const item = (next.plan.inputs.a_fast as { observations: { count: number }[] }).observations[0];
  assert.equal(item.count, 2, "old and new dates contribute support together");
  assert.deepEqual(await contents(sourceFiles(f.runs)), before);
  const broken = structuredClone(next.config);
  broken.clusteringJob.recall![0].finding_id = "missing-finding";
  const restored = { ...state, manifest: { ...state.manifest, config: broken, tasks: next.plan.tasks } };
  await assert.rejects(clusteringJobWorkflow.reconcile!(run, restored, broken), /原发现已缺失或改变/);
  const source = next.config.clusteringJob.recall![0].attribution;
  const original = await readRunState(source.run);
  original.receipts[source.task_id].submissionId = randomUUID();
  await writeRunState(source.run, original);
  await assert.rejects(prepareClusteringJob([f.runs[1]], f.config), /原归因引用已缺失或改变|身份不一致/);
});

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

for (const standalone of [false, true]) test(`clustering retains all accepted answers after a ${standalone ? "standalone" : "comparison-run"} attribution rewrite freezes execution`, async t => {
  const f = await fixture(); t.after(() => rm(f.directory, { recursive: true, force: true }));
  const run = f.runs[0], state = await readRunState(run);
  if (standalone) {
    state.manifest.config = { ...f.config, attributionJob: { runs: [] } };
    await writeRunState(run, state);
  }
  const before = (await prepareClusteringJob([run], f.config)).config.clusteringJob.sources;
  const source = state.manifest.tasks.find(task => task.stage === "attribution")!;
  await prepareAttributionRewrites(run, { mode: "refresh", taskIds: [source.id], apply: true });
  const frozen = await readRunState(run);
  assert(frozen.manifest.executionScope!.length > 0);
  assert(frozen.manifest.executionScope!.every(id => frozen.manifest.tasks.find(task => task.id === id)!.stage === "rewrite"));
  const files = sourceFiles([run]), unchanged = await contents(files);
  const { config, plan } = await prepareClusteringJob([run], f.config);
  assert.deepEqual(config.clusteringJob.sources, before, "rewriting one answer must not exclude the other accepted answers");
  assert.equal(plan.summary.out_of_scope_attributions, 0);
  assert.deepEqual(await contents(files), unchanged, "clustering must preserve the repair scope and original receipts");
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

test("new clustering plans isolate responsibility buckets and preserve each model's budget chain", async t => {
  const f = await fixture(2, ["最终回答组织", "FinQuery"]); t.after(() => rm(f.directory, { recursive: true, force: true }));
  f.config.clustering.maxCasesPerTask = 100; f.config.clustering.maxNewClassesPerTask = 3; f.config.clustering.minSupport = 3;
  const { plan } = await prepareClusteringJob(f.runs, f.config), tasks = plan.tasks.filter(task => task.stage === "clustering");
  assert.equal(tasks.length, 6, "two responsibility buckets plus one directory pass per model");
  for (const model of ["a_fast", "b_fast"]) {
    const own = tasks.filter(task => (task.data as { model: string }).model === model); assert.equal(own.length, 3);
    assert.equal(own[0].dependencies.previous, undefined);
    assert.equal(own[1].dependencies.previous, own[0].id); assert.equal(own[2].dependencies.previous, own[1].id);
    const components = new Set<string>();
    for (const task of own) {
      const input = clusteringJobWorkflow.bind(task, plan.inputs, {}, { tasks: plan.tasks }).request.input as {
        items: { component: string }[]; budget: { max_new_classes: number; min_support: number; consolidate: boolean } };
      assert.equal(input.budget.min_support, 3);
      if ((task.data as { consolidate?: true }).consolidate) { assert.deepEqual(input.items, []); assert.equal(input.budget.max_new_classes, 0); }
      else { const bucket = new Set(input.items.map(item => item.component)); assert.equal(bucket.size, 1);
        components.add([...bucket][0]); assert.equal(input.budget.max_new_classes, 3); }
    }
    assert.deepEqual(components, new Set(["FinQuery / 数据解释与计算 / 结果完整性", "回答生成：本题事实关系推导与结果使用（消息 1） / 数据解释与计算 / 事实关系推导"]));
  }
});

test("ordinary targeted attribution reviews in scope must finish before clustering uses prior accepted answers", async t => {
  const f = await fixture(); t.after(() => rm(f.directory, { recursive: true, force: true }));
  const run = f.runs[0], state = await readRunState(run), source = state.manifest.tasks.find(task => task.stage === "attribution")!;
  const review = { ...source, id: randomUUID(), data: { ...(source.data as TaskData), reviewOf: { taskId: source.id, round: 1, reasons: ["责任定位复核"] } } };
  state.manifest.tasks.push(review); state.manifest.states[review.id] = { status: "pending", attempts: 0 };
  await writeRunState(run, state);
  await assert.rejects(prepareClusteringJob([run], f.config), /归因尚未全部结束/);
  state.manifest.executionScope = state.manifest.tasks.filter(task => task.id !== review.id).map(task => task.id);
  await writeRunState(run, state);
  assert((await prepareClusteringJob([run], f.config)).config.clusteringJob.sources.length > 0);
});

test("bucket requests omit unrelated class examples while keeping model-wide caps and complete consolidation", async t => {
  const f = await fixture(2, ["最终回答组织", "FinQuery"]); t.after(() => rm(f.directory, { recursive: true, force: true }));
  f.config.clustering.maxCasesPerTask = 100;
  const { plan } = await prepareClusteringJob(f.runs, f.config);
  const material = plan.inputs.a_fast as { library: ProblemProjection; config: { clustering: { maxClassesPerModel: number } } };
  material.library = { components: ["回答生成：本题事实关系推导与结果使用（消息 1） / 数据解释与计算 / 事实关系推导", "查询工具", "未涉及工具"].map((label, index) => ({
    id: randomUUID(), label, definition: "组件职责", aliases: index === 1 ? [" FinQuery / 数据解释与计算 / 结果完整性 "] : [],
    classes: [{ id: randomUUID(), label: "具体问题" + index, definition: "问题边界", aliases: [], occurrences: 1,
      examples: [{ input_id: randomUUID(), batch_id: "2026-10-01", case_id: "case", finding_id: "f0", evidence_status: "established",
        run_id: "source", task_id: randomUUID(), submission_id: randomUUID(), reason: index === 2 ? "UNRELATED_EXAMPLE" : "相关样本" }] }],
  })) };
  material.config.clustering.maxClassesPerModel = 3;
  const own = plan.tasks.filter(task => task.stage === "clustering" && (task.data as { model: string }).model === "a_fast");
  const ordinary = own[0], input = clusteringJobWorkflow.bind(ordinary, plan.inputs, {}, { tasks: plan.tasks }).request.input as {
    library: ProblemProjection; budget: { active_classes: number; active_components: number; max_new_classes: number; max_new_components: number } };
  assert.deepEqual(input.library.components.map(component => component.label), ["查询工具"], "normalized aliases identify the bucket's complete existing component");
  assert.equal(JSON.stringify(input).includes("UNRELATED_EXAMPLE"), false);
  assert.equal(input.budget.active_classes, 3); assert.equal(input.budget.active_components, 3);
  assert.equal(input.budget.max_new_classes, 0); assert.equal(input.budget.max_new_components, 0);
  const mixed = { ...ordinary, data: { model: "a_fast", itemIds: own.slice(0, 2).flatMap(task => (task.data as { itemIds: string[] }).itemIds) } };
  const mixedInput = clusteringJobWorkflow.bind(mixed, plan.inputs, {}, { tasks: plan.tasks }).request.input as { library: ProblemProjection };
  assert.deepEqual(mixedInput.library.components.map(component => component.label), ["回答生成：本题事实关系推导与结果使用（消息 1） / 数据解释与计算 / 事实关系推导", "查询工具"]);
  const finalInput = clusteringJobWorkflow.bind(own[2], plan.inputs, {}, { tasks: plan.tasks }).request.input as { library: ProblemProjection };
  assert.equal(finalInput.library, material.library); assert.equal(finalInput.library.components.length, 3);
  assert.equal(JSON.stringify(finalInput).includes("UNRELATED_EXAMPLE"), true);
  assert.equal(material.library.components.length, 3, "filtering does not mutate the model bank");
});

test("independent clustering resumes failed tasks, recalls prior shards and retains auditable source evidence", async () => {
  const f = await fixture(), calls: string[] = [], reused: string[] = [];
  let fail = true;
  const backend: AgentBackend = { identity: fakeIdentity, async createSession(options) {
    return { async run() {
      assert(["clustering", "rewrite"].includes(options.spec.evaluation.id));
      calls.push(options.spec.taskId);
      const material = parsedMaterial(options.spec) as { model?: string; library?: { components: {
        classes: { examples: { input_id: string; finding?: string; reason?: string }[] }[] }[] } };
      if (material.library?.components.some(component => component.classes.length)) {
        for (const problem of material.library.components.flatMap(component => component.classes)) {
          assert(problem.examples.length > 0 && problem.examples.length <= 3);
          assert.equal(new Set(problem.examples.map(example => example.input_id)).size, problem.examples.length);
          assert(problem.examples.every(example => example.finding && typeof example.reason === "string"), "prior accepted findings are actually recalled");
        }
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
    assert(finished.manifest.executionScope);
    const scope = new Set(finished.manifest.executionScope);
    for (const task of finished.manifest.tasks) {
      if (scope.has(task.id)) assert.equal(finished.manifest.states[task.id].status, "succeeded");
      else {
        assert.equal(task.stage, "rewrite");
        const source = finished.receipts[task.dependencies.source]!;
        assert(source, "only accepted sources may skip empty prose");
        assert.deepEqual(clusteringSlots(source.evaluation as Parameters<typeof clusteringSlots>[0]), []);
        assert.equal(finished.receipts[task.id], undefined, "empty prose must not create a receipt");
        assert.equal(finished.manifest.states[task.id].attempts, 0);
        assert.equal(calls.includes(task.id), false, "empty prose must not reach a Worker");
      }
    }
    assert(finished.manifest.tasks.some(task => !scope.has(task.id)), "the fixture exercises an omitted empty rewrite");
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

test("explicit input selection decodes only matching attribution families and freezes the latest accepted sources", async t => {
  const f = await fixture(); t.after(() => rm(f.directory, { recursive: true, force: true }));
  const original = await readRunState(f.runs[0]), answers = original.manifest.tasks.filter(task => task.stage === "attribution");
  const inputIds = answers.slice(0, 2).map(task => task.inputIds.answer), selected = new Set(inputIds);
  const rerun = path.join(f.config.output.path, "selected-rerun"), newer = structuredClone(original);
  newer.manifest.runId = "selected-rerun";
  for (const receipt of Object.values(newer.receipts)) receipt.acceptedAt += 100;
  const source = answers[0], review = { ...source, id: randomUUID(),
    data: { ...(source.data as TaskData), reviewOf: { taskId: source.id, round: 1, reasons: ["责任复核"] } } };
  newer.manifest.tasks.push(review); newer.manifest.states[review.id] = { status: "succeeded", attempts: 1 };
  newer.receipts[review.id] = { ...structuredClone(newer.receipts[source.id]), taskId: review.id,
    attemptId: randomUUID(), submissionId: randomUUID(), acceptedAt: 200 };
  delete newer.receipts[review.id].exported;
  await createResultWriter(rerun, {})(newer); await writeRunState(rerun, newer);
  original.manifest.executionScope = [answers[2].id];
  original.manifest.states[answers[2].id].status = "pending";
  delete original.receipts[answers[2].id];
  await writeRunState(f.runs[0], original);
  for (const run of [f.runs[0], rerun]) {
    const file = path.join(run, "results/attribution.jsonl"), rows = (await readFile(file, "utf8")).trim().split("\n");
    await writeFile(file, rows.filter(row => selected.has(JSON.parse(row).input_id)).join("\n") + "\n");
  }
  for (const version of f.config.inputs.versions) await rename(version.sources[0].path, version.sources[0].path + ".offline");
  const before = await contents(sourceFiles([f.runs[0], rerun]));
  const { config, plan } = await prepareClusteringJob([f.runs[0], rerun], f.config, { inputIds });
  assert.deepEqual(new Set(config.clusteringJob.sources.map(item => item.input_id)), selected);
  assert.equal(config.clusteringJob.sources.length, 2);
  assert(config.clusteringJob.sources.every(item => item.run === rerun));
  assert.equal(config.clusteringJob.sources.find(item => item.input_id === source.inputIds.answer)!.task_id, review.id);
  assert(plan.tasks.every(task => task.stage === "clustering" || task.stage === "rewrite"));
  assert.deepEqual(await contents(sourceFiles([f.runs[0], rerun])), before, "source state and accepted JSONL remain byte-identical");
});

test("explicit input selection guards only its pending families and rejects missing accepted inputs", async t => {
  const f = await fixture(); t.after(() => rm(f.directory, { recursive: true, force: true }));
  const run = f.runs[0], state = await readRunState(run), answers = state.manifest.tasks.filter(task => task.stage === "attribution");
  const inputIds = answers.slice(0, 2).map(task => task.inputIds.answer), missing = answers[1];
  delete state.receipts[missing.id]; state.manifest.states[missing.id].status = "pending";
  await writeRunState(run, state);
  await assert.rejects(prepareClusteringJob([run], f.config, { inputIds }), /归因尚未全部结束/);
  state.manifest.states[missing.id].status = "cancelled";
  await writeRunState(run, state);
  await assert.rejects(prepareClusteringJob([run], f.config, { inputIds }), error =>
    error instanceof Error && error.message.includes("缺少已接受归因") && error.message.includes(missing.inputIds.answer));
  const single = await prepareClusteringJob([run], f.config, { inputIds: [inputIds[0]] });
  assert.equal(single.config.clusteringJob.sources.length, 1);
  await assert.rejects(prepareClusteringJob([run], f.config, { inputIds: [] }), /输入选择不能为空/);
  await assert.rejects(prepareClusteringJob([run], f.config, { inputIds: [inputIds[0], inputIds[0]] }), /重复 input_id/);
});

test("an accepted-only clustering snapshot retains accepted answers while their review is pending", async t => {
  const f = await fixture(); t.after(() => rm(f.directory, { recursive: true, force: true }));
  const run = f.runs[0], state = await readRunState(run);
  const answer = state.manifest.tasks.find(task => task.stage === "attribution")!;
  const review = { ...answer, id: randomUUID(), data: { ...(answer.data as TaskData),
    reviewOf: { taskId: answer.id, round: 1, reasons: ["待复核"] } } };
  state.manifest.tasks.push(review);
  state.manifest.states[review.id] = { status: "pending", attempts: 0 };
  state.manifest.status = "running";
  await writeRunState(run, state);
  const before = await contents(sourceFiles([run]));
  const options = { inputIds: [answer.inputIds.answer], acceptedOnly: true };
  const prepared = await prepareClusteringJob([run], f.config, options);
  assert.deepEqual(prepared.config.clusteringJob.sources.map(source => [source.task_id, source.submission_id]),
    [[answer.id, state.receipts[answer.id].submissionId]]);
  assert.equal(prepared.plan.summary.excluded_attributions, 1);
  assert.deepEqual(await contents(sourceFiles([run])), before);
  await assert.rejects(prepareClusteringJob([run], f.config, { inputIds: options.inputIds }), /归因尚未全部结束/);
});

test("a frozen attribution plan clusters only its 30 selected answers", async () => {
  const f = await fixture(20);
  try {
    const run = f.runs[0], state = await readRunState(run);
    const attributions = state.manifest.tasks.filter(task => task.stage === "attribution");
    const selected = attributions.slice(0, 30), outside = attributions.slice(30);
    state.manifest.executionScope = selected.map(task => task.id);
    for (const task of outside.slice(1)) {
      state.manifest.states[task.id].status = "pending";
      delete state.receipts[task.id];
    }
    await writeRunState(run, state);
    const file = path.join(run, "results/attribution.jsonl"), rows = (await readFile(file, "utf8")).trim().split("\n");
    await writeFile(file, rows.filter(row => JSON.parse(row).task_id !== outside[0]!.id).join("\n") + "\n");
    const { config, plan } = await prepareClusteringJob([run], f.config);
    assert.equal(config.clusteringJob.sources.length, 30);
    assert.equal(plan.summary.out_of_scope_attributions, 10);
    assert.equal(plan.summary.excluded_attributions, 0);
    assert(config.clusteringJob.sources.every(source => state.manifest.executionScope!.includes(source.task_id)));
    const saved = await readJson<{ tasks: Record<string, unknown> }>(path.join(run, "state.json"));
    assert.equal(Object.keys(saved.tasks).length, state.manifest.tasks.length);
    state.manifest.states[selected[0]!.id].status = "pending";
    await writeRunState(run, state);
    await assert.rejects(prepareClusteringJob([run], f.config), /归因尚未全部结束/);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("eight workers classify one component concurrently before serial novelty discovery and replay", async t => {
  const f = await fixture(4, undefined, true); t.after(() => rm(f.directory, { recursive: true, force: true }));
  f.config.rewrite.clustering = false;
  const seed = await prepareClusteringJob(f.runs, f.config);
  const sourceIds = seed.config.clusteringJob.sources.filter(source => source.model === "a_fast").map(source => source.input_id);
  const material = seed.plan.inputs.a_fast as ClusteringJobMaterial, observation = material.observations[0];
  assert.equal(material.observations.length, 8);
  const library = applyClustering(emptyLibrary("a_fast"), { run_id: "seed", run_path: f.directory,
    evaluator_version: fakeEvaluatorVersion, task_id: randomUUID(), submission_id: randomUUID(), version: "a_fast", batch_id: "",
    observations: [observation], result: { assignments: [{ item_id: observation.id, new_class_key: "known" }], merges: [],
      new_classes: [{ key: "known", component: observation.component, label: "已知算术错误", definition: "算术计算出错。",
        closest_existing: null, novelty: "首次建立。", category_paths: [["数值可靠性"]] }] } });
  await writeProblemLibrary(problemLibraryFile(f.config.problemLibrary, "a_fast"), library);
  const output = { kind: "directory" as const, path: path.join(f.directory, "parallel") };
  const { config, plan } = await prepareClusteringJob(f.runs, { ...f.config, output }, { inputIds: sourceIds });
  let active = 0, peak = 0, readers = 0, discoveries = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const backend: AgentBackend = { identity: fakeIdentity, async createSession(options) {
    return { async run() {
      const request = parsedMaterial(options.spec) as unknown as ClusteringRequest;
      assert.equal(options.spec.evaluation.id, "clustering");
      let result = taskResult(options.spec) as ClusteringResult;
      if (request.budget.assignment_only && request.items.length) {
        const index = readers++; active++; peak = Math.max(peak, active);
        if (readers === 8) release();
        await gate;
        assert.equal(request.budget.max_new_classes, 0);
        if (index < 2) result = { assignments: request.items.map(item => ({ item_id: item.id, deferred_reason: "尚无适用类，保留后续发现。" })), new_classes: [], merges: [] };
        active--;
      } else if (request.items.length) {
        assert.equal(readers, 8, "no directory writer before all parallel readers started");
        discoveries++;
        const classes = request.library.components.flatMap(component => component.classes);
        const found = classes.find(problem => problem.label === "新的计算错误");
        if (found) result = { assignments: request.items.map(item => ({ item_id: item.id, class_id: found.id })), new_classes: [], merges: [] };
        else result = { assignments: request.items.map(item => ({ item_id: item.id, new_class_key: "novel" })), merges: [],
          new_classes: [{ key: "novel", component: request.items[0].component, label: "新的计算错误", definition: "与已有边界不同的计算错误。",
            closest_existing: classes[0].id, novelty: "不同计算边界。", category_paths: [["数值可靠性"]] }] };
      }
      const submitted = await submitFor(options, draftFor(options.spec, result));
      assert.equal(submitted.isError, undefined, JSON.stringify(submitted));
    }, async abort() { release(); }, async dispose() {} };
  } };
  const workers = await Promise.all(Array.from({ length: 8 }, (_, index) => startWorker(backend, path.join(f.directory, `worker-${index}`))));
  t.after(() => Promise.all(workers.map(worker => worker.close())));
  const options = { ...services, taskSource: clusteringJobWorkflow, repository: clusteringJobRepository, report: reportClusteringJob,
    runId: "parallel", output, engine: "pi" as const, identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion,
    config, plan, policy: { ...config.execution, timeoutSeconds: 10 }, modelForStage: f.modelForStage,
    concurrency: 8, retries: 0, retryDelaySeconds: 0, workerUrls: workers.map(worker => worker.url) };
  await runEvaluation(options);
  assert.equal(peak, 8, "the actual Host must dispatch eight same-component tasks simultaneously");
  assert.equal(readers, 8); assert.equal(discoveries, 2, "unmatched observations retain the full serial discovery path");
  const run = path.join(output.path, "parallel"), before = await clusteringJobRepository.readRun(run);
  assert(Object.values(before.manifest.states).every(state => state.status === "succeeded"));
  const bank = await readJson<ProblemLibrary>(problemLibraryFile(config.problemLibrary, "a_fast"));
  assert.equal(Object.values(bank.classes).filter(item => item.status === "active").length, 2);
  assert.equal(effectiveProblemOccurrences(bank).length, 8, "no duplicate, missing or overwritten active assignments");
  assert(bank.occurrences.length >= 8, "prior assignment history remains available");
  await runEvaluation({ ...options, plan: { tasks: [], inputs: {}, summary: {} } });
  const after = await clusteringJobRepository.readRun(run);
  assert.deepEqual(after.receipts, before.receipts, "resuming preserves every accepted submission");
  assert.equal(readers, 8); assert.equal(discoveries, 2);
});
