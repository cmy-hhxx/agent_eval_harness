import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { emptyUsage, type PlannedTask, type RunState } from "@eval/contracts";
import { attributionResult, criteriaResultForTask, emptyAudit, fakeEvaluatorVersion, fakeIdentity, fakeJudge, fixtureConfig } from "../../../../tests/fixtures/comparison.js";
import { agents } from "../../../../tests/fixtures/services.js";
import { attributionSlots, attributionRewriteGroups } from "./commentary.js";
import { buildPlan } from "./input.js";
import { bindTask } from "./binding.js";
import { prepareAttributionRewrites } from "./repair.js";
import { comparisonRepository, readRunState } from "./run-data.js";
import { acceptedRewriteProjection } from "./rewrite-projection.js";
import { attributionJobWorkflow } from "./attribution-job.js";
import type { TaskData } from "./types.js";

function accept(state: RunState, task: PlannedTask, evaluation: unknown, acceptedAt = 1) {
  state.receipts[task.id] = { taskId: task.id, attemptId: randomUUID(), submissionId: randomUUID(), status: "succeeded",
    acceptedAt, evaluatorVersion: fakeEvaluatorVersion, judge: fakeJudge, evaluation, audit: emptyAudit(), usage: emptyUsage() };
  state.manifest.states[task.id] = { status: "succeeded", attempts: 1 };
}
async function setup(t: test.TestContext, rewritten = false) {
  const fixture = await fixtureConfig(undefined, true);
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const plan = await buildPlan(fixture.config), source = plan.tasks.find(task => task.stage === "attribution")!;
  const rewrite = plan.tasks.find(task => (task.data as TaskData).rewriteOf?.taskId === source.id)!;
  const criteria = plan.tasks.find(task => task.id === source.dependencies.criteria)!;
  const state: RunState = { receipts: {}, usage: emptyUsage(), recordedAttempts: 0, manifest: { format: "evaluation-run", runId: "refresh",
    debug: false, status: "interrupted", startedAt: 1, engine: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion,
    config: { ...fixture.config, attributionJob: { runs: [] } }, tasks: plan.tasks, inputCatalog: plan.catalog,
    inputs: {}, preflight: {}, executionScope: [criteria.id, source.id, rewrite.id],
    states: Object.fromEntries(plan.tasks.map(task => [task.id, { status: "pending", attempts: 0 }])) } };
  accept(state, criteria, criteriaResultForTask(source, plan.inputs));
  const result = attributionResult(false, "2+2=4", true, source.inputIds.answer);
  result.task_analysis = state.receipts[criteria.id]!.evaluation as typeof result.task_analysis;
  result.findings.push({ ...structuredClone(result.findings[0]!), finding_id: "f1" });
  accept(state, source, result);
  if (rewritten) accept(state, rewrite, { rewrites: attributionSlots(result).map(item => ({ id: item.id, text: "旧改写：" + item.text })) });
  const run = path.join(fixture.directory, "refresh");
  await comparisonRepository.createResultWriter(run, plan.inputs)(state);
  await comparisonRepository.writeRun(run, state);
  return { run, state, source, rewrite, result };
}

test("attribution refresh previews semantic groups without mutation and preserves frozen pilot scope", async t => {
  const { run, source, result, state } = await setup(t, true), before = await readFile(path.join(run, "state.json"), "utf8");
  const selection = { mode: "refresh" as const, taskIds: [source.id] };
  const preview = await prepareAttributionRewrites(run, selection);
  assert.deepEqual(preview.selected.map(item => item.slots), attributionRewriteGroups(result));
  assert.equal(preview.sources, 1); assert.equal(preview.slots, attributionSlots(result).length);
  assert.equal(await readFile(path.join(run, "state.json"), "utf8"), before);
  await assert.rejects(prepareAttributionRewrites(run, { ...selection, slotIds: ["findings.99.text"], apply: true }), /没有槽位/u);
  await assert.rejects(prepareAttributionRewrites(run, { mode: "refresh", apply: true }), /显式 --all/u);
  await assert.rejects(prepareAttributionRewrites(run, { ...selection, all: true }), /不能/u);
  assert.equal(await readFile(path.join(run, "state.json"), "utf8"), before);
  const prepared = await prepareAttributionRewrites(run, { ...selection, apply: true }), after = await readRunState(run);
  assert.equal(prepared.count, 4);
  assert.deepEqual(new Set(after.manifest.executionScope), new Set([...state.manifest.executionScope!, ...prepared.selected.map(item => item.rewrite_task_id!)]));
  assert(!after.manifest.executionScope!.some(id => after.manifest.tasks.find(task => task.id === id)?.stage === "comparison"));
});

test("targeted attribution text refresh preserves judgments, evidence and historical rewrites", async t => {
  const { run, source, rewrite } = await setup(t, true), before = await readRunState(run);
  const slotIds = ["findings.1.problem.label", "findings.1.problem.definition"];
  const prepared = await prepareAttributionRewrites(run, { mode: "refresh", taskIds: [rewrite.id], slotIds, apply: true });
  assert.equal(prepared.count, 1); assert.deepEqual(prepared.selected[0]!.slots, slotIds);
  const after = await readRunState(run), task = after.manifest.tasks.find(task => task.id === prepared.selected[0]!.rewrite_task_id)!;
  const binding = bindTask(task, {}, { source: after.receipts[source.id] }, { tasks: after.manifest.tasks });
  const items = binding.request.input.items as { id: string; text: string }[];
  const result = { rewrites: items.map(item => ({ id: item.id, text: "新点评：" + item.text })) };
  agents.validate(binding, result, emptyAudit()); accept(after, task, result, 2);
  await comparisonRepository.createResultWriter(run, {})(after);
  await comparisonRepository.writeRun(run, after);
  const restored = await readRunState(run), projection = acceptedRewriteProjection(restored, source.id)!;
  assert.deepEqual(restored.receipts[source.id]!.evaluation, before.receipts[source.id]!.evaluation);
  assert.deepEqual(restored.receipts[rewrite.id]!.evaluation, before.receipts[rewrite.id]!.evaluation);
  assert.equal(restored.receipts[rewrite.id]!.submissionId, before.receipts[rewrite.id]!.submissionId);
  assert.equal(restored.manifest.states[source.id]!.attempts, 1);
  for (const item of projection.rewritten.rewrites) {
    assert.equal(projection.owners.get(item.id), slotIds.includes(item.id) ? task.id : rewrite.id);
    assert(item.text.startsWith(slotIds.includes(item.id) ? "新点评：" : "旧改写："));
  }
  assert.equal((await prepareAttributionRewrites(run, { mode: "missing", resultIds: [source.id] })).count, 0);
});

test("attribution preparation reuses unfinished groups without resetting spent content budgets", async t => {
  const { run, source } = await setup(t), selection = { mode: "missing" as const, resultIds: [source.id], apply: true };
  const first = await prepareAttributionRewrites(run, selection), state = await readRunState(run), id = first.selected[0]!.rewrite_task_id!;
  state.manifest.states[id] = { status: "failed", attempts: 2,
    failure: { errors: [], repeatedErrors: 1, stopped: true, contentSubmissions: 5, fileErrors: 1, attemptId: "spent" } };
  await comparisonRepository.writeRun(run, state);
  const second = await prepareAttributionRewrites(run, selection), restored = await readRunState(run);
  assert.deepEqual(second.selected.map(item => item.rewrite_task_id), first.selected.map(item => item.rewrite_task_id));
  assert.deepEqual(restored.manifest.states[id]!.failure, state.manifest.states[id]!.failure);
  assert.equal(restored.manifest.states[id]!.attempts, 2);
  await assert.rejects(prepareAttributionRewrites(run, { mode: "missing", taskIds: ["missing"] }), /只能选择/u);
  await assert.rejects(prepareAttributionRewrites(run, { mode: "missing", slotIds: ["summary", "summary"] }), /重复/u);
});

test("complete groups retire an unaccepted whole request from execution while preserving its paid ledger", async t => {
  const { run, source, rewrite, state } = await setup(t);
  state.manifest.states[rewrite.id] = { status: "failed", attempts: 2,
    failure: { errors: [], repeatedErrors: 1, stopped: true, contentSubmissions: 5, fileErrors: 1, attemptId: "paid-whole" } };
  await comparisonRepository.writeRun(run, state);
  const before = await readRunState(run), prepared = await prepareAttributionRewrites(run, { mode: "refresh", taskIds: [source.id], apply: true });
  const current = await readRunState(run);
  assert.equal(prepared.count, 4);
  assert(!current.manifest.executionScope!.includes(rewrite.id));
  assert.deepEqual(current.manifest.tasks.find(task => task.id === rewrite.id), before.manifest.tasks.find(task => task.id === rewrite.id));
  assert.deepEqual(current.manifest.states[rewrite.id], before.manifest.states[rewrite.id]);
  assert(prepared.selected.every(item => current.manifest.executionScope!.includes(item.rewrite_task_id!)));
  delete current.manifest.executionScope;
  await attributionJobWorkflow.reconcile!(run, current, current.manifest.config);
  assert(!current.manifest.executionScope!.includes(rewrite.id), "input discovery cannot reactivate the covered whole request");
  assert.deepEqual(current.manifest.states[rewrite.id], before.manifest.states[rewrite.id]);
});
