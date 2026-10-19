import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { emptyUsage, type PlannedTask, type RunState } from "@eval/contracts";
import { readJson, readJsonl, writeJson, writeJsonl } from "@eval/data";
import { comparisonResult, criteriaResultForTask, attributionResult, emptyAudit, fakeEvaluatorVersion, fakeIdentity,
  fakeJudge, fixtureConfig, raw } from "../../../../tests/fixtures/comparison.js";
import { prepareStability, createStabilityWorkflow, stabilityRepository, type StabilityCase, type StabilityTaskData } from "./stability.js";
import { stabilityReport, reportStability } from "./stability-report.js";
import { caseBootstrap, exactSignTest, seededRandom } from "./stability-statistics.js";
import type { ComparisonResult, TaskData } from "./types.js";
import { comparisonRepository } from "./run-data.js";
import type { SemanticReviewRecord } from "./stability-semantic-review.js";

async function fixture(t: { after(fn: () => Promise<void>): void }, selected = true) {
  const fixture = await fixtureConfig();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const item: StabilityCase = { batch_id: "b1", case_id: "q1", answers: fixture.config.inputs.versions.filter(version => ["a_fast", "b_fast"].includes(version.id)).map(version => ({
    version: version.id, name: version.name, adapter: version.adapter, source: version.sources[0].path, line: 1,
    comparison_tier: version.comparison_tier,
  })) as StabilityCase["answers"], risks: ["test"], rewrite: selected, end_to_end: selected };
  const prepared = await prepareStability(fixture.config, [item], { seed: 3 });
  const state: RunState = { receipts: {}, recordedAttempts: 0, usage: emptyUsage(), manifest: {
    format: "evaluation-run", runId: "stability-test", debug: false, status: "interrupted", startedAt: 1,
    engine: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion, config: prepared.config,
    tasks: prepared.plan.tasks, inputs: {}, inputCatalog: prepared.plan.catalog, preflight: prepared.plan.summary,
    states: Object.fromEntries(prepared.plan.tasks.map(task => [task.id, { status: "pending", attempts: 0 }])),
  } };
  return { ...fixture, ...prepared, state, item };
}
function accept(state: RunState, task: PlannedTask, evaluation: unknown, attempts = 1) {
  state.receipts[task.id] = { taskId: task.id, attemptId: randomUUID(), submissionId: randomUUID(), status: "succeeded", acceptedAt: 1,
    evaluatorVersion: fakeEvaluatorVersion, judge: fakeJudge, evaluation, audit: emptyAudit(), usage: emptyUsage() };
  state.manifest.states[task.id] = { status: "succeeded", attempts };
}
function baselineReceipts(state: RunState, inputs: Record<string, unknown>) {
  for (const task of state.manifest.tasks.filter(task => (task.data as StabilityTaskData).stability.purpose === "baseline")) {
    const data = task.data as TaskData;
    if (task.stage === "criteria") accept(state, task, criteriaResultForTask(task, inputs));
    if (task.stage === "attribution") {
      const result = attributionResult(true, "2+2=4", true, data.candidates.A.input_id);
      result.task_analysis = state.receipts[task.dependencies.criteria].evaluation as typeof result.task_analysis;
      for (const finding of result.findings) finding.assessment.evidence_status = "established";
      accept(state, task, result);
    }
    if (task.stage === "comparison") accept(state, task, comparisonResult(["A", "B"], state.receipts[task.dependencies.criteria].evaluation as ComparisonResult["task_analysis"]));
  }
}

test("experiment plans fresh independent tasks, true swaps and one whole-verdict rewrite per repeat", async t => {
  const f = await fixture(t), workflow = await createStabilityWorkflow(f.config);
  assert.equal(f.plan.tasks.length, 34);
  assert.deepEqual(f.plan.summary.by_phase, { baseline: 4, comparison: 10, rewrite: 5, end_to_end: 15 });
  assert.equal(new Set(f.plan.tasks.map(task => task.id)).size, 34);
  const firstChain = f.plan.tasks.filter(task => (task.data as StabilityTaskData).stability.purpose === "baseline");
  const { apiKeyEnv: _key, ...model } = f.modelForStage("criteria");
  (firstChain[0].data as StabilityTaskData).stability.condition = { engine: "pi", model, execution: f.config.execution };
  assert(firstChain.slice(1).every(task => (task.data as StabilityTaskData).stability.condition === undefined));
  const comparisons = f.plan.tasks.filter(task => (task.data as StabilityTaskData).stability.purpose === "comparison");
  const [ab, ba] = comparisons;
  assert.deepEqual(comparisons.map(task => (task.data as StabilityTaskData).stability.orientation), Array.from({ length: 5 }, () => ["AB", "BA"]).flat());
  assert.equal((ab.data as TaskData).candidates.A.input_id, (ba.data as TaskData).candidates.B.input_id);
  assert.equal(ab.inputIds.A, ba.inputIds.B);
  assert.equal(ab.dependencies.A, ba.dependencies.B);
  assert.equal(ab.dependencies.criteria, ba.dependencies.criteria);
  assert.equal(workflow.canStart!(ab, f.state.manifest), false);
  baselineReceipts(f.state, f.plan.inputs);
  assert.equal(workflow.canStart!(ab, f.state.manifest), true);
  assert.equal(workflow.canStart!(ba, f.state.manifest), false);
  f.state.manifest.states[ab.id].status = "failed";
  assert.equal(workflow.canStart!(ba, f.state.manifest), true);
  const rewrite = f.plan.tasks.find(task => (task.data as StabilityTaskData).stability.purpose === "rewrite")!;
  const binding = workflow.bind(rewrite, f.plan.inputs, { source: f.state.receipts[rewrite.dependencies.source] }, { tasks: f.plan.tasks });
  assert.equal((binding.request.input.items as unknown[]).length, 1);
  assert.deepEqual(binding.request.sources, {});
  const baBinding = workflow.bind(ba, f.plan.inputs, Object.fromEntries(Object.entries(ba.dependencies).map(([label, id]) => [label, f.state.receipts[id]])), { tasks: f.plan.tasks });
  assert.equal(baBinding.request.sources.A.id, ba.inputIds.A);
});

test("checkpoint-only accepted receipts recover, then reference independent experimental result rows", async t => {
  const f = await fixture(t), run = path.join(f.directory, "experiment"), first = f.plan.tasks[0];
  accept(f.state, first, criteriaResultForTask(first, f.plan.inputs), 2);
  await stabilityRepository.writeRun(run, f.state);
  const interim = await stabilityRepository.readRun(run);
  assert.deepEqual(interim.receipts[first.id].evaluation, f.state.receipts[first.id].evaluation);
  assert.equal(interim.manifest.states[first.id].attempts, 2);
  await stabilityRepository.createResultWriter(run, f.plan.inputs)(interim);
  await stabilityRepository.writeRun(run, interim);
  const stored = await readJson<{ receipts: Record<string, { result?: unknown; evaluation?: unknown }> }>(path.join(run, "state.json"));
  assert(stored.receipts[first.id].result);
  assert.equal(stored.receipts[first.id].evaluation, undefined);
  const restored = await stabilityRepository.readRun(run);
  assert.deepEqual(restored.receipts[first.id].evaluation, f.state.receipts[first.id].evaluation);
  const workflow = await createStabilityWorkflow(f.config), before = restored.manifest.tasks.map(task => task.id);
  await workflow.reconcile!(run, restored, f.config);
  assert.deepEqual(restored.manifest.tasks.map(task => task.id), before);
  assert.equal(restored.manifest.states[first.id].attempts, 2);
  const rows = [];
  for await (const row of readJsonl(path.join(run, "results/stability-results.jsonl"))) rows.push(row);
  assert.equal(rows.length, 1);
});

test("resume rejects changed evaluation metadata before pairing new material with saved tasks", async t => {
  for (const accepted of [false, true]) {
    const f = await fixture(t, false), workflow = await createStabilityWorkflow(f.config);
    if (accepted) baselineReceipts(f.state, f.plan.inputs);
    const before = structuredClone(f.state);
    const changes = [
      (value: ReturnType<typeof raw>) => value.messages.splice(1, 0, { role: "assistant", content: "仍在计算，最终回答随后给出。" }),
      (value: ReturnType<typeof raw>) => { value.messages[0].content = "计算3+3"; },
      (value: ReturnType<typeof raw>) => { value.meta!.ground_truth = "6"; },
      (value: ReturnType<typeof raw>) => { value.meta!.finish_answer_time_cost = 2400; },
    ];
    for (const change of changes) {
      const updated = raw(); change(updated);
      await writeJsonl(f.item.answers[0].source, [updated]);
      await assert.rejects(workflow.reconcile!(f.directory, f.state, f.config), /Experiment input metadata changed/);
      assert.deepEqual(f.state, before, "rejected material cannot mutate accepted results, task identities or paid progress");
    }
  }
});

test("resume locates reordered source rows without changing persisted input identities", async t => {
  const f = await fixture(t, false), workflow = await createStabilityWorkflow(f.config);
  const before = structuredClone(f.state);
  await writeJsonl(f.item.answers[0].source, [raw("other"), raw()]);
  const restored = await workflow.reconcile!(f.directory, f.state, f.config);
  const answer = (f.plan.tasks.find(task => task.stage === "attribution")!.data as TaskData).candidates.A;
  assert.equal((restored.inputs[answer.input_id] as ReturnType<typeof raw>).messages[answer.final_index].content, "2+2=4");
  assert.deepEqual(f.state.receipts, before.receipts);
  assert.deepEqual(f.state.manifest.tasks.map(task => [task.id, task.inputIds]), before.manifest.tasks.map(task => [task.id, task.inputIds]));
});

test("five independent rewrites persist separately and cannot mutate their accepted source verdict", async t => {
  const f = await fixture(t), run = path.join(f.directory, "rewrites");
  baselineReceipts(f.state, f.plan.inputs);
  const rewrites = f.plan.tasks.filter(task => (task.data as StabilityTaskData).stability.purpose === "rewrite");
  const source = f.state.receipts[rewrites[0].dependencies.source], original = structuredClone(source.evaluation);
  for (const [index, task] of rewrites.entries()) accept(f.state, task, { rewrites: [{ id: "verdict:A:B", text: "independent " + index }] });
  await stabilityRepository.createResultWriter(run, f.plan.inputs)(f.state);
  await stabilityRepository.writeRun(run, f.state);
  const restored = await stabilityRepository.readRun(run);
  assert.deepEqual(restored.receipts[rewrites[0].dependencies.source].evaluation, original);
  assert.equal(new Set(rewrites.map(task => JSON.stringify(restored.receipts[task.id].evaluation))).size, 5);
});

test("postprocessing references current accepted upstream receipts and never modifies its source run", async t => {
  const f = await fixture(t, false), sourceRun = path.join(f.directory, "source");
  baselineReceipts(f.state, f.plan.inputs);
  const source = structuredClone(f.state);
  source.manifest.tasks = source.manifest.tasks.filter(task => (task.data as StabilityTaskData).stability.purpose === "baseline");
  source.manifest.states = Object.fromEntries(source.manifest.tasks.map(task => [task.id, source.manifest.states[task.id]]));
  const originalComparison = source.manifest.tasks.find(task => task.stage === "comparison")!;
  const anotherComparison = structuredClone(originalComparison);
  anotherComparison.id = randomUUID(); (anotherComparison.data as TaskData).comparisonId = "cmp_" + randomUUID();
  source.manifest.tasks.push(anotherComparison);
  source.manifest.states[anotherComparison.id] = { status: "succeeded", attempts: 1 };
  source.receipts[anotherComparison.id] = { ...source.receipts[originalComparison.id], taskId: anotherComparison.id, submissionId: randomUUID() };
  await comparisonRepository.createResultWriter(sourceRun, f.plan.inputs)(source);
  await comparisonRepository.writeRun(sourceRun, source);
  const before = await readJson(path.join(sourceRun, "state.json"));
  const prepared = await prepareStability(f.config, undefined, { sourceRun });
  assert.equal(prepared.plan.tasks.length, 10);
  assert.equal(prepared.config.stability.sourceReceipts.length, 4);
  assert.equal(prepared.config.stability.cases.length, 1);
  assert(prepared.plan.tasks.every(task => !Object.keys(task.dependencies).length));
  const workflow = await createStabilityWorkflow(prepared.config), trial = prepared.plan.tasks[0];
  const binding = workflow.bind(trial, prepared.plan.inputs, {}, { tasks: prepared.plan.tasks });
  assert.equal(binding.agent, "comparison");
  assert.deepEqual(await readJson(path.join(sourceRun, "state.json")), before);
  const changed = raw(); changed.messages.splice(1, 0, { role: "assistant", content: "中间回复" });
  await writeJsonl(f.item.answers[0].source, [changed]);
  await assert.rejects(prepareStability(f.config, undefined, { sourceRun }), /Experiment input metadata changed/);
  assert.deepEqual(await readJson(path.join(sourceRun, "state.json")), before);
});

test("case-level report normalizes swapped identities, includes missingness and preserves attempt accounting", async t => {
  const f = await fixture(t, false);
  baselineReceipts(f.state, f.plan.inputs);
  const comparisons = f.plan.tasks.filter(task => (task.data as StabilityTaskData).stability.purpose === "comparison");
  const winnerVersion = f.item.answers[0].version;
  for (const task of comparisons) {
    const data = task.data as TaskData, result = comparisonResult();
    const winner = Object.entries(data.candidates).find(([, candidate]) => candidate.version === winnerVersion)![0];
    result.ranking = [[winner], [winner === "A" ? "B" : "A"]];
    accept(f.state, task, result);
  }
  f.state.manifest.states[comparisons[0].id].attempts = 3;
  f.state.manifest.executionLimits = { maxAttempts: 240, stopStartingAt: 1792368000000 };
  f.state.manifest.executionStopReason = "attempt_limit";
  const report = stabilityReport(f.state);
  assert.equal(report.samples[0].paired.outcome_agreements, 5);
  assert.equal(report.samples[0].paired.core_agreements, 5);
  assert.equal(report.samples[0].paired.ranking_agreements, 5);
  assert.equal(report.scope.complete_comparison_cases, 1);
  assert.equal(report.statistics.direction_sign_test.p_value, null);
  assert.equal(report.statistics.t_test.status, "not_applicable");
  assert.equal(report.budget.attempted, 16);
  assert.equal(report.budget.stop_reason, "attempt_limit");
  const run = path.join(f.directory, "report");
  await stabilityRepository.createResultWriter(run, f.plan.inputs)(f.state);
  await stabilityRepository.writeRun(run, f.state);
  await reportStability(run);
  assert.equal((await readJson(path.join(run, "validation.json"))).status, "completed");
  delete f.state.receipts[comparisons[0].id];
  f.state.manifest.states[comparisons[0].id].status = "failed";
  const incomplete = stabilityReport(f.state);
  assert.equal(incomplete.samples[0].paired.complete_pairs, 4);
  assert.equal(incomplete.scope.complete_comparison_cases, 0);
  assert.equal(incomplete.samples[0].original.unresolved, 1);
});

test("mixed judge conditions suppress pooled inference and counts are per case", async t => {
  const f = await fixture(t, false), trials = f.plan.tasks.filter(task => (task.data as StabilityTaskData).stability.purpose === "comparison");
  for (const task of trials) accept(f.state, task, comparisonResult());
  f.state.receipts[trials[0].id].judge = "changed";
  const report = stabilityReport(f.state);
  assert.equal(report.statistics.status, "mixed_conditions");
  assert.equal(report.statistics.direction_sign_test.p_value, null);
  assert.equal(report.scope.complete_comparison_cases, 1);
});

test("execution report retains every planned stage, current failures, waits and budget stops", async t => {
  const f = await fixture(t);
  baselineReceipts(f.state, f.plan.inputs);
  const rewrite = f.plan.tasks.find(task => (task.data as StabilityTaskData).stability.purpose === "rewrite")!;
  const chain = f.plan.tasks.filter(task => (task.data as StabilityTaskData).stability.purpose === "end_to_end");
  const attribution = chain.find(task => task.stage === "attribution")!, comparison = chain.find(task => task.stage === "comparison")!;
  const chainRewrite = chain.find(task => task.stage === "rewrite")!, attemptId = randomUUID();
  f.state.manifest.states[rewrite.id] = { status: "failed", attempts: 2, reason: "Rewrite provider disconnected", attemptId };
  f.state.manifest.states[attribution.id] = { status: "timed_out", attempts: 1, failure: {
    attemptId, errors: [{ category: "transport", code: "transport_failed", path: "/", message: "Connection timeout " + "x".repeat(600) }],
    contentSubmissions: 0, fileErrors: 0, repeatedErrors: 0, stopped: false,
    draft: { private_draft: "Do not copy into reports" }, evidenceBank: [],
  } };
  f.state.manifest.states[comparison.id] = { status: "blocked", attempts: 0, reason: "Dependency did not succeed" };
  f.state.manifest.executionScope = [rewrite.id];
  f.state.manifest.executionStopReason = "attempt_limit";
  f.state.manifest.executionLimits = { maxAttempts: 7 };
  f.state.manifest.cumulativeAttempts = 7;
  f.state.manifest.pausedStages = [{ stage: "attribution", category: "transport", code: "transport_failed", path: "/", taskIds: [attribution.id], at: 1 }];
  const original = structuredClone(f.state), report = stabilityReport(f.state);
  assert.equal(report.status, "incomplete");
  assert.equal(report.budget.planned_stage_attempts, 34);
  assert.equal(report.budget.remaining, 0);
  assert.equal(report.execution.stop_reason, "attempt_limit");
  assert.deepEqual(report.execution.tasks.map(task => task.task_id), f.plan.tasks.map(task => task.id));
  assert.deepEqual(report.execution.paused_stages, f.state.manifest.pausedStages);
  const rewritten = report.execution.tasks.find(task => task.task_id === rewrite.id)!;
  assert.equal(rewritten.current_reason, "Rewrite provider disconnected");
  assert.equal(rewritten.attempts, 2);
  assert.equal(rewritten.in_execution_scope, true);
  const failed = report.execution.tasks.find(task => task.task_id === attribution.id)!;
  assert.equal(failed.current_reason!.length, 500);
  assert.equal(failed.attempt_id, attemptId);
  assert.deepEqual(failed.current_failure_codes, [{ category: "transport", code: "transport_failed", path: "/" }]);
  assert(!JSON.stringify(report.execution).includes("private_draft"));
  assert.equal(report.execution.tasks.find(task => task.task_id === comparison.id)!.current_reason, "Dependency did not succeed");
  const pending = report.execution.tasks.find(task => task.task_id === chainRewrite.id)!;
  assert.equal(pending.status, "pending");
  assert.equal(pending.attempts, 0);
  assert.equal(pending.in_execution_scope, false);
  assert.deepEqual(pending.waiting_for_task_ids, [comparison.id]);
  assert.deepEqual(f.state, original, "reporting must not rewrite failed states or the planned denominator");
  const run = path.join(f.directory, "execution-report");
  await stabilityRepository.createResultWriter(run, f.plan.inputs)(f.state);
  await stabilityRepository.writeRun(run, f.state);
  await reportStability(run);
  assert.deepEqual((await readJson(path.join(run, "validation.json"))).execution, report.execution);
});

test("recovered tasks retain attempt counts without inventing cleared historical failure details", async t => {
  const f = await fixture(t, false);
  baselineReceipts(f.state, f.plan.inputs);
  const recovered = f.plan.tasks[0];
  f.state.manifest.states[recovered.id].attempts = 3;
  const report = stabilityReport(f.state), row = report.execution.tasks.find(task => task.task_id === recovered.id)!;
  assert.equal(row.status, "succeeded");
  assert.equal(row.attempts, 3);
  assert.equal(row.current_reason, null);
  assert.deepEqual(row.current_failure_codes, []);
  assert.equal(row.submission_id, f.state.receipts[recovered.id].submissionId);
  assert.equal(report.execution.history.file, "log/runtime.log");
  assert.deepEqual(report.execution.history.lookup_keys, ["run_id", "task_id", "attempt_id"]);
  assert.equal(report.execution.stop_reason, null);
});

test("stable tie verdicts do not hide relative-preference flips, missing provenance, or needs-review results", async t => {
  const f = await fixture(t, false), trials = f.plan.tasks.filter(task => (task.data as StabilityTaskData).stability.purpose === "comparison");
  for (const task of trials) {
    accept(f.state, task, comparisonResult());
    f.state.receipts[task.id].submitted = { relative_preference: "A" };
  }
  const report = stabilityReport(f.state);
  assert.equal(report.samples[0].paired.outcome_agreements, 5);
  assert.equal(report.samples[0].relative_preference.complete_pairs, 5);
  assert.equal(report.samples[0].relative_preference.agreements, 0);
  delete f.state.receipts[trials[0].id].submitted;
  const unavailable = stabilityReport(f.state);
  assert.equal(unavailable.samples[0].relative_preference.complete_pairs, 4);
  assert.equal(unavailable.samples[0].relative_preference.original.unresolved, 1);
  const review = comparisonResult(); review.status = "needs_review";
  accept(f.state, trials[1], review);
  delete f.state.receipts[trials[2].id]; f.state.manifest.states[trials[2].id].status = "failed";
  const unresolved = stabilityReport(f.state);
  assert.equal(unresolved.quality.accepted_needs_review, 1);
  assert.equal(unresolved.budget.accepted_needs_review, 1);
  assert.equal(unresolved.samples[0].swapped.unresolved_by_status.needs_review, 1);
  assert.equal(unresolved.samples[0].original.unresolved_by_status.failed, 1);
  assert.equal(unresolved.samples[0].trials[1].review_status, "needs_review");
  assert.equal(unresolved.execution.tasks.find(task => task.task_id === trials[1].id)!.status, "succeeded");
  assert.equal(unresolved.samples[0].swapped.completed, 4);
  assert.equal(unresolved.samples[0].original.completed, 4);
  assert.equal(unresolved.samples[0].paired.complete_pairs, 3);
});

test("a review stop preserves unattempted rewrites and separates run status from receipt coverage", async t => {
  const f = await fixture(t), workflow = await createStabilityWorkflow(f.config);
  baselineReceipts(f.state, f.plan.inputs);
  const rewrite = f.plan.tasks.find(task => task.stage === "rewrite")!;
  const source = f.plan.tasks.find(task => task.id === rewrite.dependencies.source)!;
  const pending = structuredClone(f.state.receipts[source.id].evaluation as ComparisonResult);
  pending.status = "needs_review";
  pending.ranking = [];
  pending.review_requests = Object.keys(pending.assessments).map(candidate => ({ candidate,
    criterion_ids: [pending.task_analysis.requirements[0].id], finding_indices: [], reason: "双方核心期间门槛不同，需要统一。" }));
  Object.values(pending.assessments).forEach(assessment => { assessment.meets_core = null; assessment.core_failure_refs = []; });
  pending.decision_basis = { comparisons: [], decisive_findings: [], tradeoff: "待复核共同口径。" };
  accept(f.state, source, pending);
  const reason = workflow.blockedReason!(rewrite, { source: f.state.receipts[source.id] });
  assert.equal(reason, "Comparison remains unresolved");
  f.state.manifest.states[rewrite.id] = { status: "blocked", attempts: 0, reason };
  f.state.manifest.status = "finished";
  const before = structuredClone(Object.values(f.state.receipts).map(receipt => receipt.evaluation));
  const run = path.join(f.directory, "review-stop");
  await stabilityRepository.createResultWriter(run, f.plan.inputs)(f.state);
  await stabilityRepository.writeRun(run, f.state);
  await reportStability(run);
  const report = await readJson<ReturnType<typeof stabilityReport>>(path.join(run, "validation.json"));
  assert.equal(report.execution.status, "finished");
  assert.equal(report.status, "incomplete");
  assert.equal(report.quality.accepted_needs_review, 1);
  assert.equal(report.samples[0].baseline, null);
  const stopped = report.execution.tasks.find(task => task.task_id === rewrite.id)!;
  assert.equal(stopped.status, "blocked");
  assert.equal(stopped.attempts, 0);
  assert.equal(report.budget.statuses.failed, undefined);
  assert.equal(report.semantic_review.summary.failed, 0);
  const text = await readFile(path.join(run, "validation.md"), "utf8");
  assert.match(text, /运行状态：finished。计划收据覆盖：incomplete/);
  assert.match(text, /待核单列为未裁决，不算执行失败、平局或胜负/);
  assert.deepEqual(Object.values(f.state.receipts).map(receipt => receipt.evaluation), before);
});

test("resume records material changes without changing accepted trial conditions or rejecting continuation", async t => {
  const f = await fixture(t, false), workflow = await createStabilityWorkflow(f.config);
  baselineReceipts(f.state, f.plan.inputs);
  const baseline = f.plan.tasks[0], before = structuredClone((baseline.data as StabilityTaskData).stability.materials);
  assert.equal(stabilityReport(f.state).statistics.status, "exploratory_pilot");
  await writeJsonl(f.item.answers[0].source, [raw("q1", "4", "changed answer after interruption")]);
  await workflow.reconcile!(f.directory, f.state, f.config);
  assert.deepEqual((baseline.data as StabilityTaskData).stability.materials, before);
  const trial = f.plan.tasks.find(task => (task.data as StabilityTaskData).stability.purpose === "comparison")!;
  assert.notEqual((trial.data as StabilityTaskData).stability.materials![f.item.answers[0].source], before![f.item.answers[0].source]);
  accept(f.state, trial, comparisonResult());
  const report = stabilityReport(f.state);
  assert.equal(report.material_changes.length, 1);
  assert.equal(report.statistics.status, "mixed_conditions");
  assert.equal(report.statistics.direction_sign_test.p_value, null);
});

test("slot-A bias remains positive when baseline blind mappings differ across cases; ties count as nonwins", async t => {
  const f = await fixture(t, false);
  for (const answer of f.item.answers) await writeJsonl(answer.source, [raw("q1"), raw("q2")]);
  const second = { ...structuredClone(f.item), case_id: "q2" };
  second.answers.forEach(answer => { answer.line = 2; });
  let seed = 0;
  for (;; seed++) { const random = seededRandom(seed); if ((random() < .5) !== (random() < .5)) break; }
  const prepared = await prepareStability(f.config, [f.item, second], { seed });
  f.state.manifest.config = prepared.config; f.state.manifest.tasks = prepared.plan.tasks;
  f.state.manifest.states = Object.fromEntries(prepared.plan.tasks.map(task => [task.id, { status: "pending", attempts: 0 }]));
  const trials = prepared.plan.tasks.filter(task => (task.data as StabilityTaskData).stability.purpose === "comparison");
  for (const task of trials) { const result = comparisonResult(); result.ranking = [["A"], ["B"]]; accept(f.state, task, result); }
  const report = stabilityReport(f.state);
  assert.deepEqual(report.samples.map(sample => sample.paired.position.difference_A_minus_B), [1, 1]);
  assert.equal(report.statistics.direction_sign_test.p_value, .5);
  for (const sample of report.samples) {
    assert.equal(sample.paired.position.win_rate_at_A, 1);
    assert.equal(sample.paired.position.win_rate_at_B, 0);
    assert.equal(sample.paired.transitions.reduce((sum, transition) => sum + transition.count, 0), 5);
  }
  for (const task of trials) accept(f.state, task, comparisonResult());
  const ties = stabilityReport(f.state);
  assert(ties.samples.every(sample => sample.paired.position.win_rate_at_A === 0 && sample.paired.position.win_rate_at_B === 0));
});

test("exact sign test, fixed-seed case bootstrap and degenerate cases have honest uncertainty", () => {
  assert.equal(exactSignTest([1, 1, 1, 1, 1]).p_value, 0.0625);
  assert.equal(exactSignTest([1, -1, 0]).p_value, 1);
  assert.equal(exactSignTest([0, 0]).p_value, null);
  assert.equal(caseBootstrap([1, 1, 1], 4).interval_95, null);
  assert.equal(caseBootstrap([1], 4).status, "insufficient_cases");
  assert.deepEqual(caseBootstrap([0, .2, .8, 1], 7), caseBootstrap([0, .2, .8, 1], 7));
  assert.throws(() => exactSignTest([NaN]), /finite/);
});

test("invalid coordinates and insufficient attempt budgets fail before model work", async t => {
  const f = await fixture(t, false);
  await assert.rejects(prepareStability(f.config, [f.item], { maxAttempts: 13 }), /exceed budget/);
  await assert.rejects(prepareStability(f.config, [{ ...f.item, case_id: "wrong" }]), /coordinate disagrees/);
  await assert.rejects(prepareStability(f.config, [f.item, f.item]), /Duplicate/);
  await assert.rejects(prepareStability(f.config, [f.item], { maxAttempts: 241 }), /Invalid experiment/);
});

function semanticRecord(state: RunState, task: PlannedTask, result: SemanticReviewRecord["result"] = "passed"): SemanticReviewRecord {
  return { task_id: task.id, submission_id: state.receipts[task.id].submissionId,
    reviewer: { kind: "agent", name: "fixture reviewer" }, result,
    rationale: result === "passed" ? "核对本测试槽位的源结论和改写，含义一致。" : "本测试改写改变了源结论的适用范围。" };
}

test("semantic coverage includes end-to-end rewrites and never treats a partial review as passed", async t => {
  const f = await fixture(t), rewrites = f.plan.tasks.filter(task => task.stage === "rewrite");
  assert.equal(rewrites.length, 8);
  for (const task of rewrites.slice(0, 2)) accept(f.state, task, { rewrites: [{ id: "test", text: "测试文本。" }] });
  const firstReviews = rewrites.slice(0, 2).map(task => semanticRecord(f.state, task));
  const partialOutputs = stabilityReport(f.state, undefined, firstReviews);
  assert.deepEqual(partialOutputs.semantic_review.summary, { status: "incomplete", planned: 8, accepted: 2, reviewed: 2, failed: 0, unreviewed: 0 });
  for (const task of rewrites.slice(2)) accept(f.state, task, { rewrites: [{ id: "test", text: "测试文本。" }] });
  const unreviewed = stabilityReport(f.state);
  assert.equal(unreviewed.quality.rewrite_semantic_review, "required");
  assert.equal(unreviewed.semantic_review.summary.unreviewed, 8);
  const onlyRepeatedRewrites = rewrites.filter(task => (task.data as StabilityTaskData).stability.purpose === "rewrite")
    .map(task => semanticRecord(f.state, task));
  const partialReview = stabilityReport(f.state, undefined, onlyRepeatedRewrites);
  assert.deepEqual(partialReview.samples[0].semantic_review,
    { status: "required", planned: 8, accepted: 8, reviewed: 5, failed: 0, unreviewed: 3 });
  const records = rewrites.map(task => semanticRecord(f.state, task));
  records[0].rationale = "局部句子略显冗长；主体、条件、否定方向和取舍均保留，可带措辞缺陷通过。";
  const allReviewed = stabilityReport(f.state, undefined, records);
  assert.equal(allReviewed.quality.rewrite_semantic_review, "passed");
  assert.equal(allReviewed.samples[0].semantic_review.status, "passed");
  assert.equal(allReviewed.semantic_review.records[0].rationale, records[0].rationale);
  assert.equal(allReviewed.semantic_review.summary.failed, 0);
});

test("semantic reviews reject stale receipts, unknown or nonrewrite tasks, duplicate records and blank reasons", async t => {
  const f = await fixture(t), task = f.plan.tasks.find(task => task.stage === "rewrite")!;
  accept(f.state, task, { rewrites: [{ id: "test", text: "测试文本。" }] });
  const record = semanticRecord(f.state, task);
  assert.throws(() => stabilityReport(f.state, undefined, [{ ...record, submission_id: randomUUID() }]), /stale submission/);
  assert.throws(() => stabilityReport(f.state, undefined, [{ ...record, task_id: randomUUID() }]), /current accepted rewrite/);
  assert.throws(() => stabilityReport(f.state, undefined, [{ ...record, task_id: f.plan.tasks[0].id }]), /current accepted rewrite/);
  const unaccepted = f.plan.tasks.find(candidate => candidate.stage === "rewrite" && candidate.id !== task.id)!;
  assert.throws(() => stabilityReport(f.state, undefined, [{ ...record, task_id: unaccepted.id }]), /current accepted rewrite/);
  assert.throws(() => stabilityReport(f.state, undefined, [record, record]), /Duplicate semantic review/);
  assert.throws(() => stabilityReport(f.state, undefined, { records: [record] }), /Invalid semantic-review/);
  assert.throws(() => stabilityReport(f.state, undefined, [{ ...record, rationale: " \n " }]), /Invalid semantic-review/);
  assert.throws(() => stabilityReport(f.state, undefined, [{ ...record, reviewer: { kind: "agent", name: " " } }]), /Invalid semantic-review/);
});

test("a failed end-to-end semantic audit survives report rebuilding and leaves source results untouched", async t => {
  const f = await fixture(t), run = path.join(f.directory, "semantic-review"), rewrites = f.plan.tasks.filter(task => task.stage === "rewrite");
  for (const task of rewrites) accept(f.state, task, { rewrites: [{ id: "test", text: "测试文本。" }] });
  const failed = rewrites.find(task => (task.data as StabilityTaskData).stability.purpose === "end_to_end")!;
  const records = rewrites.map(task => semanticRecord(f.state, task, task.id === failed.id ? "failed" : "passed"));
  const before = structuredClone(f.state.receipts);
  const report = stabilityReport(f.state, undefined, records);
  assert.equal(report.samples[0].rewrite.semantic_review, "passed");
  assert.equal(report.samples[0].semantic_review.status, "failed");
  assert.equal(report.quality.rewrite_semantic_review, "failed");
  assert.equal(report.semantic_review.summary.failed, 1);
  assert.deepEqual(f.state.receipts, before);
  await stabilityRepository.createResultWriter(run, f.plan.inputs)(f.state);
  await stabilityRepository.writeRun(run, f.state);
  const checkpointBefore = await readJson(path.join(run, "state.json"));
  await writeJson(path.join(run, "semantic-review.json"), records);
  await reportStability(run);
  await reportStability(run);
  const entry = fileURLToPath(new URL("../../../../tests/fixtures/cli.js", import.meta.url));
  const imports = process.execArgv.flatMap((value, index) => value === "--import" ? [value, process.execArgv[index + 1]!] : []);
  const cli = await promisify(execFile)(process.execPath, [...imports, entry, f.directory, "report", "--run", run],
    { env: { ...process.env }, timeout: 20000 });
  assert.equal(JSON.parse(cli.stdout).quality.rewrite_semantic_review, "failed");
  const persisted = await readJson<{ quality: { rewrite_semantic_review: string }; semantic_review: { records: SemanticReviewRecord[] } }>(path.join(run, "validation.json"));
  assert.equal(persisted.quality.rewrite_semantic_review, "failed");
  assert.deepEqual(persisted.semantic_review.records, records);
  assert.deepEqual(await readJson(path.join(run, "semantic-review.json")), records);
  assert.deepEqual(await readJson(path.join(run, "state.json")), checkpointBefore);
});
