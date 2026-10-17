import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { rm } from "node:fs/promises";
import { emptyUsage, type PlannedTask, type RunState } from "@eval/contracts";
import { readJson, writeJson, writeJsonl } from "@eval/data";
import { attributionResult, criteriaResultForTask, emptyAudit, fakeEvaluatorVersion, fakeIdentity, fakeJudge, fixtureConfig, raw } from "../../../../tests/fixtures/comparison.js";
import { agents } from "../../../../tests/fixtures/services.js";
import { adapt } from "./input.js";
import { attributionJobWorkflow, loadAttributionJobInputs, prepareAttributionJob, type AttributionJobConfig } from "./attribution-job.js";
import { comparisonRepository } from "./run-data.js";
import { prepareClusteringJob } from "./clustering-job.js";
import { reportRun } from "./report.js";
import { validateRun } from "./validate.js";
import { prepareFailedTasks } from "./repair.js";
import { attributionRewriteGroups } from "./commentary.js";
import { supersededAttributionRewriteIds } from "./attribution-rewrite-planning.js";
import type { Candidate, EvalConfig, RawInput, TaskData } from "./types.js";

/** Source fixtures contain only the persisted selection index; no old judgments enter the new run. */
async function sourceRun(directory: string, config: EvalConfig, catalog: Candidate[], acceptedAt = 1) {
  const tasks: Record<string, unknown> = {}, rows: unknown[] = [];
  const cases = new Map<string, Candidate[]>();
  for (const candidate of catalog) {
    const key = JSON.stringify([candidate.batch_id, candidate.case_id]);
    cases.set(key, [...(cases.get(key) ?? []), candidate]);
  }
  for (const answers of cases.values()) for (const pair of [["a_fast", "b_fast"], ["a_expert", "b_expert"]]) {
    const selected = pair.map(version => answers.find(answer => answer.version === version)).filter((candidate): candidate is Candidate => !!candidate);
    if (selected.length !== 2) continue;
    const id = randomUUID(), comparisonId = "cmp_" + randomUUID();
    tasks[id] = { stage: "comparison", status: "succeeded", attempts: 1,
      inputIds: Object.fromEntries(selected.map((candidate, index) => ["AB"[index], candidate.input_id])),
      dependencies: {}, data: { comparisonId },
      receipt: { taskId: id, status: "succeeded", acceptedAt, submissionId: randomUUID() } };
    rows.push({ comparison_id: comparisonId, case: { batch_id: selected[0]!.batch_id, case_id: selected[0]!.case_id },
      models: Object.fromEntries(selected.map(candidate => [candidate.version, {}])) });
  }
  await writeJson(path.join(directory, "state.json"), { format: "evaluation-run", config,
    inputs: Object.fromEntries(catalog.map(({ input_id, ...candidate }) => [input_id, candidate])), tasks });
  await writeJsonl(path.join(directory, "results/comparison.jsonl"), rows);
}
async function inputCatalog(config: EvalConfig, rows: RawInput[]) {
  const catalog: Candidate[] = [];
  for (const version of config.inputs.versions) {
    const file = version.sources[0]!.path;
    await writeJsonl(file, rows);
    rows.forEach((row, index) => catalog.push(adapt(row, version, file, index + 1)));
  }
  return catalog;
}
function runState(config: AttributionJobConfig, plan: Awaited<ReturnType<typeof prepareAttributionJob>>["plan"], executionScope?: string[]): RunState {
  return { receipts: {}, usage: emptyUsage(), recordedAttempts: 0, manifest: { format: "evaluation-run", runId: "fresh-attributions",
    debug: false, status: "interrupted", startedAt: 1, engine: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion, config,
    tasks: plan.tasks, inputCatalog: plan.catalog, inputs: {}, preflight: plan.summary,
    states: Object.fromEntries(plan.tasks.map(task => [task.id, { status: "pending", attempts: 0 }])), ...(executionScope ? { executionScope } : {}) } };
}
function accept(state: RunState, task: PlannedTask, evaluation: unknown) {
  state.receipts[task.id] = { taskId: task.id, attemptId: randomUUID(), submissionId: randomUUID(), status: "succeeded",
    acceptedAt: 1, evaluatorVersion: fakeEvaluatorVersion, judge: fakeJudge, evaluation, audit: emptyAudit(), usage: emptyUsage() };
  state.manifest.states[task.id] = { status: "succeeded", attempts: 1 };
}

test("new attribution plan deduplicates formal answers, filters dates and owns no comparison or old receipt", async t => {
  const fixture = await fixtureConfig(undefined, true);
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const catalog = await inputCatalog(fixture.config, [
    { ...raw("prior"), batch_id: "2026-09-30" }, { ...raw("current"), batch_id: "2026-10-01" },
  ]);
  const first = path.join(fixture.directory, "source-first"), latest = path.join(fixture.directory, "source-latest");
  await sourceRun(first, fixture.config, catalog);
  await sourceRun(latest, fixture.config, catalog, 2);
  const prepared = await prepareAttributionJob([first, latest], fixture.config, { fromBatch: "2026-10-01", pilotAnswers: 3 });
  assert.equal(prepared.plan.summary.attribution_answers, 4);
  assert.equal(prepared.plan.summary.duplicate_answers, 4);
  assert.equal(prepared.plan.tasks.filter(task => task.stage === "attribution").length, 4);
  assert.equal(prepared.plan.tasks.filter(task => task.stage === "criteria").length, 1);
  assert.equal(prepared.plan.tasks.filter(task => task.stage === "rewrite").length, 4);
  assert(prepared.plan.tasks.every(task => ["criteria", "attribution", "rewrite"].includes(task.stage)));
  assert.equal(prepared.executionScope!.filter(id => prepared.plan.tasks.find(task => task.id === id)!.stage === "attribution").length, 3);
  assert((prepared.plan.catalog as Candidate[]).every(candidate => candidate.batch_id === "2026-10-01"));
  assert((prepared.plan.summary.selected_answers as unknown[]).length === 3);
  const state = runState(prepared.config, prepared.plan, prepared.executionScope);
  assert.deepEqual(state.receipts, {});
  const source = await readJson<{ tasks: Record<string, unknown> }>(path.join(first, "state.json"));
  assert(prepared.plan.tasks.every(task => !Object.hasOwn(source.tasks, task.id)));
});

test("30 answers cover 13 dates, four models and both standard-answer groups with distinct cases", async t => {
  const fixture = await fixtureConfig(undefined, true);
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const rows = Array.from({ length: 13 }, (_, index) => [false, true].flatMap(standard =>
    Array.from({ length: 3 }, (_, sample) => ({ ...raw(`${standard}-${sample}`, standard ? "4" : null), batch_id: `2026-10-${String(index + 1).padStart(2, "0")}` })))).flat();
  const catalog = await inputCatalog(fixture.config, rows), run = path.join(fixture.directory, "source");
  await sourceRun(run, fixture.config, catalog);
  const prepared = await prepareAttributionJob([run], fixture.config, { fromBatch: "2026-10-01", pilotAnswers: 30 });
  const selected = prepared.plan.summary.selected_answers as { batch_id: string; case_id: string; version: string; has_standard_answer: boolean }[];
  assert.equal(selected.length, 30);
  assert.equal(prepared.plan.summary.attribution_answers, 312);
  assert.equal(new Set(selected.map(answer => answer.batch_id)).size, 13);
  for (const date of new Set(selected.map(answer => answer.batch_id))) assert(selected.filter(answer => answer.batch_id === date).length >= 2);
  for (const model of fixture.config.inputs.versions) assert([7, 8].includes(selected.filter(answer => answer.version === model.id).length));
  assert.deepEqual(new Set(selected.map(answer => answer.has_standard_answer)), new Set([true, false]));
  assert.equal(new Set(selected.map(answer => JSON.stringify([answer.batch_id, answer.case_id]))).size, 30);
  assert.equal(prepared.plan.tasks.filter(task => task.stage === "attribution").length, 312);
});

test("input loading follows business identity after row reorder and rejects duplicates and changed standards", async t => {
  const fixture = await fixtureConfig(undefined, true);
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const rows = [{ ...raw("first"), batch_id: "2026-10-01" }, { ...raw("second"), batch_id: "2026-10-01" }];
  const catalog = await inputCatalog(fixture.config, rows), run = path.join(fixture.directory, "source");
  await sourceRun(run, fixture.config, catalog);
  for (const version of fixture.config.inputs.versions) await writeJsonl(version.sources[0]!.path, [...rows].reverse());
  const prepared = await prepareAttributionJob([run], fixture.config);
  const fresh = prepared.plan.catalog as Candidate[];
  assert(fresh.filter(candidate => candidate.case_id === "first").every(candidate => candidate.line === 2));
  const manifest = { tasks: prepared.plan.tasks, config: prepared.config, inputCatalog: prepared.plan.catalog };
  const file = fixture.config.inputs.versions[0]!.sources[0]!.path;
  await writeJsonl(file, [rows[0]!, rows[0]!, rows[1]!]);
  await assert.rejects(loadAttributionJobInputs(manifest), /业务标识重复/u);
  await writeJsonl(file, [{ ...rows[0]!, meta: { ...rows[0]!.meta, ground_truth: "5" } }, rows[1]!]);
  await assert.rejects(loadAttributionJobInputs(manifest), /标准答案与选择索引不一致/u);
});

test("frozen pilot resume keeps the complete plan and loads only unfinished material", async t => {
  const fixture = await fixtureConfig(undefined, true);
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const catalog = await inputCatalog(fixture.config, [{ ...raw("q1"), batch_id: "2026-10-01" }]), run = path.join(fixture.directory, "source");
  await sourceRun(run, fixture.config, catalog);
  const prepared = await prepareAttributionJob([run], fixture.config, { pilotAnswers: 1 }), state = runState(prepared.config, prepared.plan, prepared.executionScope);
  for (const task of state.manifest.tasks.filter(task => state.manifest.executionScope!.includes(task.id) && task.stage !== "rewrite")) {
    if (task.stage === "criteria") accept(state, task, criteriaResultForTask(task, prepared.plan.inputs));
    else {
      const result = attributionResult(true, "2+2=4", true, task.inputIds.answer);
      result.task_analysis = state.receipts[task.dependencies.criteria]!.evaluation as typeof result.task_analysis;
      accept(state, task, result);
    }
  }
  await attributionJobWorkflow.reconcile!(run, state, fixture.config);
  assert.equal(state.manifest.tasks.filter(task => task.stage === "rewrite" && state.manifest.executionScope!.includes(task.id)).length, 3,
    "accepted attribution expands overview, criteria and its finding into independent rewrite groups");
  const rewrite = state.manifest.tasks.find(task => task.stage === "rewrite" && state.manifest.executionScope!.includes(task.id))!;
  state.manifest.states[rewrite.id] = { status: "failed", attempts: 3,
    failure: { errors: [], repeatedErrors: 0, stopped: false, contentSubmissions: 2, fileErrors: 1, attemptId: "paid" } };
  for (const version of fixture.config.inputs.versions) await rm(version.sources[0]!.path);
  const original = structuredClone(state), current = { ...fixture.config, execution: { ...fixture.config.execution, concurrency: 4 } };
  const resumed = await attributionJobWorkflow.reconcile!(run, state, current);
  assert.equal(resumed.tasks.length, original.manifest.tasks.length);
  assert.deepEqual(resumed.inputs, {});
  assert.deepEqual(state.manifest.executionScope, original.manifest.executionScope);
  assert.deepEqual(state.manifest.states, original.manifest.states);
  assert.deepEqual(state.receipts, original.receipts);
  assert.equal((state.manifest.config as AttributionJobConfig).execution.concurrency, 4);
});

test("accepted pilot attribution expands its pristine placeholder into bounded semantic groups inside the same answer scope", async t => {
  const fixture = await fixtureConfig(undefined, true);
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const catalog = await inputCatalog(fixture.config, [{ ...raw("q1"), batch_id: "2026-10-01" }]), run = path.join(fixture.directory, "source");
  await sourceRun(run, fixture.config, catalog);
  const prepared = await prepareAttributionJob([run], fixture.config, { pilotAnswers: 1 });
  const state = runState(prepared.config, prepared.plan, prepared.executionScope), scope = new Set(prepared.executionScope);
  const source = state.manifest.tasks.find(task => task.stage === "attribution" && scope.has(task.id))!;
  const placeholder = state.manifest.tasks.find(task => task.stage === "rewrite" && task.dependencies.source === source.id)!;
  const result = attributionResult(true, "2+2=4", true, source.inputIds.answer);
  result.findings = Array.from({ length: 8 }, (_, index) => ({ ...structuredClone(result.findings[0]!), id: `finding_${index}` }));
  accept(state, source, result);
  const receipt = structuredClone(state.receipts[source.id]);
  const advance = attributionJobWorkflow.advance!(source, state.receipts[source.id]!, state, prepared.plan.inputs);
  assert.equal(advance.replace!.length, 1);
  assert.equal(advance.replace![0]!.id, placeholder.id);
  assert.equal((advance.replace![0]!.data as TaskData).revision, state.manifest.states[placeholder.id]!.revision ?? 1,
    "advance replacement keeps the pristine task progress revision in sync");
  const groups = [...advance.replace!, ...advance.tasks].map(task => (task.data as TaskData).rewriteSlotIds!);
  assert.equal(groups.length, 10, "overview, criteria and eight independent findings");
  assert(groups.every(group => group.length <= 20));
  for (const group of groups) {
    const findings = new Set(group.filter(id => id.startsWith("findings.")).map(id => id.split(".")[1]));
    assert(findings.size <= 1, "a request never combines separate finding contexts");
  }
  assert.deepEqual(groups.flat(), attributionRewriteGroups(result).flat());
  for (const task of advance.replace!) state.manifest.tasks[state.manifest.tasks.findIndex(item => item.id === task.id)] = task;
  for (const task of advance.tasks) {
    state.manifest.tasks.push(task);
    state.manifest.states[task.id] = { status: "pending", attempts: 0 };
    state.manifest.executionScope!.push(task.id);
  }
  assert.deepEqual(state.receipts[source.id], receipt);
  const count = state.manifest.tasks.length;
  const resumed = await attributionJobWorkflow.reconcile!(run, state, fixture.config);
  assert.equal(resumed.tasks.length, count, "reconcile preserves planned groups without creating another whole request");
  assert.equal(state.manifest.tasks.filter(task => task.stage === "rewrite" && task.dependencies.source === source.id).length, 10);
  assert.deepEqual(new Set(state.manifest.executionScope!.filter(id => state.manifest.tasks.find(task => task.id === id)?.stage === "attribution")), new Set([source.id]));
  assert(state.manifest.tasks.filter(task => task.stage === "attribution" && task.id !== source.id).every(task => !state.manifest.executionScope!.includes(task.id)));
});

test("frozen group reconciliation keeps paid request ledgers and retires only fully covered work through discovery", async t => {
  const fixture = await fixtureConfig(undefined, true);
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const catalog = await inputCatalog(fixture.config, [{ ...raw("q1"), batch_id: "2026-10-01" }]), run = path.join(fixture.directory, "source");
  await sourceRun(run, fixture.config, catalog);
  const prepared = await prepareAttributionJob([run], fixture.config, { pilotAnswers: 1 });
  const state = runState(prepared.config, prepared.plan, prepared.executionScope);
  const source = state.manifest.tasks.find(task => task.stage === "attribution" && state.manifest.executionScope!.includes(task.id))!;
  const whole = state.manifest.tasks.find(task => task.stage === "rewrite" && task.dependencies.source === source.id)!;
  accept(state, source, attributionResult(true, "2+2=4", true, source.inputIds.answer));
  state.manifest.states[whole.id] = { status: "failed", attempts: 3, failure: {
    errors: [], repeatedErrors: 0, stopped: false, contentSubmissions: 2, fileErrors: 1, attemptId: "paid-whole" } };
  const progress = structuredClone(state.manifest.states[whole.id]), task = structuredClone(whole), originalScope = new Set(state.manifest.executionScope);
  assert.deepEqual(supersededAttributionRewriteIds(state), new Set());
  await attributionJobWorkflow.reconcile!(run, state, fixture.config);
  const rewrites = state.manifest.tasks.filter(task => task.stage === "rewrite" && task.dependencies.source === source.id && task.id !== whole.id);
  assert.equal(rewrites.length, 3);
  assert.deepEqual(state.manifest.states[whole.id], progress);
  assert.deepEqual(state.manifest.tasks.find(item => item.id === whole.id), task);
  assert.deepEqual(supersededAttributionRewriteIds(state), new Set([whole.id]));
  assert(!state.manifest.executionScope!.includes(whole.id));
  assert(rewrites.every(rewrite => state.manifest.executionScope!.includes(rewrite.id)));
  assert(state.manifest.executionScope!.every(id => originalScope.has(id) || rewrites.some(rewrite => rewrite.id === id)));
  const partial = { ...structuredClone(rewrites[0]!), id: randomUUID() };
  (partial.data as TaskData).rewriteSlotIds = [(rewrites[0]!.data as TaskData).rewriteSlotIds![0]!];
  state.manifest.tasks.push(partial);
  state.manifest.states[partial.id] = { status: "pending", attempts: 0 };
  assert(!supersededAttributionRewriteIds(state).has(rewrites[0]!.id), "partial overlap keeps the uncovered request active");
  delete state.manifest.executionScope;
  await attributionJobWorkflow.reconcile!(run, state, fixture.config);
  assert(!state.manifest.executionScope!.includes(whole.id), "all-answer discovery cannot revive covered work");
  assert(state.manifest.tasks.filter(item => item.stage === "attribution").every(item => state.manifest.executionScope!.includes(item.id)));
  assert.deepEqual(state.manifest.states[whole.id], progress);
});

test("fresh attribution results and embedded rewrites remain readable by reports and independent clustering", async t => {
  const fixture = await fixtureConfig(undefined, true);
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const catalog = await inputCatalog(fixture.config, [{ ...raw("q1"), batch_id: "2026-10-01" }]), source = path.join(fixture.directory, "source");
  await sourceRun(source, fixture.config, catalog);
  const prepared = await prepareAttributionJob([source], fixture.config), state = runState(prepared.config, prepared.plan);
  for (const task of state.manifest.tasks) {
    if (task.stage === "criteria") accept(state, task, criteriaResultForTask(task, prepared.plan.inputs));
    if (task.stage === "attribution") {
      const result = attributionResult(true, "2+2=4", true, task.inputIds.answer);
      result.task_analysis = state.receipts[task.dependencies.criteria]!.evaluation as typeof result.task_analysis;
      result.findings[0]!.evidence.push(result.criterion_assessments[0]!.evidence[1]!);
      accept(state, task, result);
    }
    if (task.stage === "rewrite") {
      const binding = attributionJobWorkflow.bind(task, prepared.plan.inputs, { source: state.receipts[task.dependencies.source] }, { tasks: state.manifest.tasks });
      const items = binding.request.input.items as { id: string; text: string }[];
      accept(state, task, { rewrites: items.map(item => ({ id: item.id, text: item.text })) });
    }
  }
  const run = path.join(fixture.directory, "fresh-attributions");
  await comparisonRepository.createResultWriter(run, prepared.plan.inputs)(state);
  await comparisonRepository.writeRun(run, state);
  const restored = await comparisonRepository.readRun(run);
  assert.equal(restored.manifest.tasks.filter(task => task.stage === "comparison").length, 0);
  assert.equal(Object.keys(restored.receipts).length, state.manifest.tasks.length);
  const report = await reportRun(run);
  assert.equal((report as { evaluated_comparisons?: number }).evaluated_comparisons ?? 0, 0);
  const clustering = await prepareClusteringJob([run], prepared.config);
  assert.equal(clustering.plan.summary.attribution_answers, 4);
  assert(clustering.config.clusteringJob.sources.every(source => source.evaluator_version === fakeEvaluatorVersion));
});

test("selected pilot delivery keeps original prose when rewrite is incomplete and ignores unselected answers", async t => {
  const fixture = await fixtureConfig(undefined, true);
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const catalog = await inputCatalog(fixture.config, [
    { ...raw("q1"), batch_id: "2026-10-01" }, { ...raw("q2"), batch_id: "2026-10-01" },
  ]), source = path.join(fixture.directory, "source");
  await sourceRun(source, fixture.config, catalog);
  const prepared = await prepareAttributionJob([source], fixture.config, { pilotAnswers: 1 });
  const state = runState(prepared.config, prepared.plan, prepared.executionScope), scope = new Set(prepared.executionScope);
  for (const task of state.manifest.tasks.filter(task => scope.has(task.id))) {
    if (task.stage === "criteria") accept(state, task, criteriaResultForTask(task, prepared.plan.inputs));
    if (task.stage === "attribution") {
      const result = attributionResult(true, "2+2=4", true, task.inputIds.answer);
      result.task_analysis = state.receipts[task.dependencies.criteria]!.evaluation as typeof result.task_analysis;
      result.findings[0]!.evidence.push(result.criterion_assessments[0]!.evidence[1]!);
      accept(state, task, result);
    }
  }
  const run = path.join(fixture.directory, "fresh-attributions");
  const save = async () => {
    await comparisonRepository.createResultWriter(run, prepared.plan.inputs)(state);
    await comparisonRepository.writeRun(run, state);
  };
  const validate = () => validateRun(run, (binding, result, audit) => agents.validate(binding, result, audit), { selectedOnly: true });
  await save();
  const incomplete = await validate();
  assert.equal(incomplete.valid, true);
  assert.equal(incomplete.results.valid, true);
  assert.equal(incomplete.delivery.valid, true);
  assert(incomplete.delivery.missing_slots.length > 0, "missing polish remains visible without blocking original text");
  const rewrite = state.manifest.tasks.find(task => task.stage === "rewrite" && scope.has(task.id))!;
  const binding = attributionJobWorkflow.bind(rewrite, prepared.plan.inputs, { source: state.receipts[rewrite.dependencies.source] }, { tasks: state.manifest.tasks });
  const items = binding.request.input.items as { id: string; text: string }[];
  accept(state, rewrite, { rewrites: items.map(item => ({ id: item.id, text: item.text })) });
  await save();
  const completed = await validate();
  assert.equal(completed.valid, true, JSON.stringify(completed.errors));
  assert.deepEqual(completed.delivery.by_batch, { "2026-10-01": { planned: 1, accepted: 1, delivered: 1 } });
  assert(state.manifest.tasks.some(task => task.stage === "attribution" && !scope.has(task.id) && state.manifest.states[task.id]?.status === "pending"));
  const full = await validateRun(run, (binding, result, audit) => agents.validate(binding, result, audit));
  assert.equal(full.delivery.valid, false, "full delivery still requires the unreleased answers");
});

test("repairing one failed pilot answer preserves the original clustering scope and cumulative ledger", async t => {
  const fixture = await fixtureConfig(undefined, true);
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const catalog = await inputCatalog(fixture.config, [
    { ...raw("q1"), batch_id: "2026-10-01" }, { ...raw("q2"), batch_id: "2026-10-01" },
  ]), source = path.join(fixture.directory, "source");
  await sourceRun(source, fixture.config, catalog);
  const prepared = await prepareAttributionJob([source], fixture.config, { pilotAnswers: 3 });
  const state = runState(prepared.config, prepared.plan, prepared.executionScope), scope = new Set(prepared.executionScope);
  const failed = state.manifest.tasks.find(task => task.stage === "attribution" && scope.has(task.id))!;
  const blocked = state.manifest.tasks.find(task => task.stage === "rewrite" && task.dependencies.source === failed.id)!;
  for (const task of state.manifest.tasks.filter(task => scope.has(task.id) && task.id !== failed.id && task.id !== blocked.id)) {
    if (task.stage === "criteria") accept(state, task, criteriaResultForTask(task, prepared.plan.inputs));
    if (task.stage === "attribution") {
      const result = attributionResult(true, "2+2=4", true, task.inputIds.answer);
      result.task_analysis = state.receipts[task.dependencies.criteria]!.evaluation as typeof result.task_analysis;
      result.findings[0]!.evidence.push(result.criterion_assessments[0]!.evidence[1]!);
      accept(state, task, result);
    }
    if (task.stage === "rewrite") {
      const binding = attributionJobWorkflow.bind(task, prepared.plan.inputs, { source: state.receipts[task.dependencies.source] }, { tasks: state.manifest.tasks });
      const items = binding.request.input.items as { id: string; text: string }[];
      accept(state, task, { rewrites: items.map(item => ({ id: item.id, text: item.text })) });
    }
  }
  state.manifest.states[failed.id] = { status: "failed", attempts: 2, attemptId: "paid-attempt", reason: "stream interrupted",
    failure: { contentSubmissions: 0, fileErrors: 1, errors: [{ category: "transport", code: "upstream_stream_interrupted", path: "/stream", message: "ended before response.completed" }],
      repeatedErrors: 0, stopped: false, attemptId: "paid-attempt" } };
  state.manifest.states[blocked.id] = { status: "blocked", attempts: 0, reason: "failed source" };
  state.usage.totalTokens = 123;
  state.recordedAttempts = 5;
  const run = path.join(fixture.directory, "fresh-attributions");
  await comparisonRepository.createResultWriter(run, prepared.plan.inputs)(state);
  await comparisonRepository.writeRun(run, state);
  const before = await comparisonRepository.readRun(run);
  const preview = await prepareFailedTasks(run, { taskIds: [failed.id] });
  assert.equal(preview.count, 2);
  assert.deepEqual((await comparisonRepository.readRun(run)).manifest.executionScope, before.manifest.executionScope);
  await prepareFailedTasks(run, { taskIds: [failed.id], apply: true });
  const repaired = await comparisonRepository.readRun(run);
  assert.deepEqual(repaired.manifest.executionScope, before.manifest.executionScope,
    "all three pilot answers remain available to clustering after a local repair");
  assert.deepEqual(repaired.receipts, before.receipts);
  assert.deepEqual(repaired.usage, before.usage);
  assert.equal(repaired.recordedAttempts, before.recordedAttempts);
  assert.equal(repaired.manifest.states[failed.id]!.attempts, 2);
  assert.deepEqual(repaired.manifest.states[failed.id]!.failure, before.manifest.states[failed.id]!.failure);
  for (const task of repaired.manifest.tasks.filter(task => ![failed.id, blocked.id].includes(task.id)))
    assert.deepEqual(repaired.manifest.states[task.id], before.manifest.states[task.id], "accepted and unreleased work keep their progress");
  const resumed = await attributionJobWorkflow.reconcile!(run, repaired, fixture.config);
  assert.deepEqual(repaired.manifest.executionScope, before.manifest.executionScope);
  const result = attributionResult(true, "2+2=4", true, failed.inputIds.answer);
  result.task_analysis = repaired.receipts[failed.dependencies.criteria]!.evaluation as typeof result.task_analysis;
  result.findings[0]!.evidence.push(result.criterion_assessments[0]!.evidence[1]!);
  const paidAttempts = repaired.manifest.states[failed.id]!.attempts;
  accept(repaired, failed, result);
  repaired.manifest.states[failed.id]!.attempts = paidAttempts + 1;
  const binding = attributionJobWorkflow.bind(blocked, resumed.inputs, { source: repaired.receipts[failed.id] }, { tasks: repaired.manifest.tasks });
  const items = binding.request.input.items as { id: string; text: string }[];
  accept(repaired, blocked, { rewrites: items.map(item => ({ id: item.id, text: item.text })) });
  await comparisonRepository.createResultWriter(run, resumed.inputs)(repaired);
  await comparisonRepository.writeRun(run, repaired);
  const clustered = await prepareClusteringJob([run], prepared.config);
  assert.equal(clustered.plan.summary.attribution_answers, 3, "clustering keeps the two answers accepted before repair");
  assert.equal(clustered.config.clusteringJob.sources.length, 3);
  const outside = repaired.manifest.tasks.filter(task => task.stage === "attribution" && !scope.has(task.id));
  assert(outside.length > 0);
  assert(outside.every(task => repaired.manifest.states[task.id]!.status === "pending" && !repaired.manifest.executionScope!.includes(task.id)));
});

for (const accepted of [false, true]) test(`repairing a shared pilot criterion excludes its unreleased answer descendants (accepted: ${accepted})`, async t => {
  const fixture = await fixtureConfig(undefined, true);
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const catalog = await inputCatalog(fixture.config, [{ ...raw("q1"), batch_id: "2026-10-01" }]), source = path.join(fixture.directory, "source");
  await sourceRun(source, fixture.config, catalog);
  const prepared = await prepareAttributionJob([source], fixture.config, { pilotAnswers: 1 });
  const state = runState(prepared.config, prepared.plan, prepared.executionScope), scope = new Set(prepared.executionScope);
  const failed = state.manifest.tasks.find(task => task.stage === "criteria" && scope.has(task.id))!;
  if (accepted) accept(state, failed, criteriaResultForTask(failed, prepared.plan.inputs));
  else state.manifest.states[failed.id] = { status: "failed", attempts: 2, failure: {
    contentSubmissions: 1, fileErrors: 1, errors: [], repeatedErrors: 0, stopped: false, attemptId: "paid-criterion" } };
  for (const task of state.manifest.tasks.filter(task => scope.has(task.id) && task.id !== failed.id))
    state.manifest.states[task.id] = { status: "blocked", attempts: 0 };
  const run = path.join(fixture.directory, "fresh-attributions");
  await comparisonRepository.writeRun(run, state);
  const before = await comparisonRepository.readRun(run);
  const repair = await prepareFailedTasks(run, { taskIds: [failed.id], apply: true });
  assert.equal(repair.count, scope.size - Number(accepted), "only the selected pilot answer follows its shared criterion into repair");
  const resumed = await comparisonRepository.readRun(run);
  assert.deepEqual(resumed.manifest.executionScope, before.manifest.executionScope);
  assert.deepEqual(resumed.receipts, before.receipts);
  assert.deepEqual(resumed.manifest.states[failed.id]!.failure, before.manifest.states[failed.id]!.failure);
  for (const task of resumed.manifest.tasks.filter(task => !scope.has(task.id)))
    assert.deepEqual(resumed.manifest.states[task.id], before.manifest.states[task.id]);
});
