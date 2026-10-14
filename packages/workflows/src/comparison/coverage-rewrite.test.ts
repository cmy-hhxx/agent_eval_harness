import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { emptyUsage, type PlannedTask, type RunState, type SubmissionReceipt, type WorkflowDefinition } from "@eval/contracts";
import { attributionResult, criteriaResultForTask, emptyAudit, fakeIdentity, fixtureConfig, raw } from "../../../../tests/fixtures/comparison.js";
import { attributionSlots } from "./commentary.js";
import { buildPlan } from "./input.js";
import { comparisonWorkflow } from "./workflow.js";
import type { TaskData } from "./types.js";

async function setup(t: test.TestContext) {
  const fixture = await fixtureConfig([[raw()], [], [raw()], []], true);
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const plan = await buildPlan(fixture.config), sources = plan.tasks.filter(task => task.stage === "attribution");
  const state: RunState = { receipts: {}, recordedAttempts: 0, usage: emptyUsage(), manifest: {
    format: "evaluation-run", runId: "coverage-rewrite", debug: false, status: "running", startedAt: 1,
    engine: fakeIdentity, evaluatorVersion: "fixture", config: fixture.config, tasks: plan.tasks,
    inputCatalog: plan.catalog, inputs: {}, preflight: plan.summary,
    states: Object.fromEntries(plan.tasks.map(task => [task.id, { status: "pending", attempts: 0 }])),
  } };
  const accept = (task: PlannedTask, evaluation: unknown) => {
    state.receipts[task.id] = { taskId: task.id, attemptId: task.id, submissionId: task.id, acceptedAt: 1,
      status: "succeeded", evaluatorVersion: "fixture", judge: "fixture", audit: emptyAudit(), usage: emptyUsage(), evaluation };
    state.manifest.states[task.id] = { status: "succeeded", attempts: 1 };
  };
  for (const task of plan.tasks.filter(task => task.stage === "criteria")) accept(task, criteriaResultForTask(task, plan.inputs));
  for (const source of sources) {
    const value = attributionResult(true, "2+2=4", true, source.inputIds.answer);
    value.task_analysis = state.receipts[source.dependencies.criteria]!.evaluation as typeof value.task_analysis;
    value.findings[0].assessment.requirement_index = null; value.findings[0].type = "problem";
    value.findings[0].problem = { component: ["模型自身推理"], label: "计算过程缺口", definition: "缺少中间计算说明。" };
    accept(source, value);
  }
  const apply = (change: ReturnType<NonNullable<WorkflowDefinition["advance"]>>) => {
    for (const replacement of change.replace ?? []) state.manifest.tasks[state.manifest.tasks.findIndex(task => task.id === replacement.id)] = replacement;
    for (const task of change.tasks) { state.manifest.tasks.push(task); state.manifest.states[task.id] = { status: "pending", attempts: 0 }; }
  };
  return { fixture, plan, sources, state, accept, apply };
}

for (const history of ["unpaid", "paid", "running", "accepted"] as const)
  test(`coverage handoff reuses only unpaid placeholders and preserves ${history} history without new old-source groups`, async t => {
    const { fixture, plan, sources, state, accept, apply } = await setup(t), source = sources[0];
    const original = plan.tasks.find(task => task.stage === "rewrite" && task.dependencies.source === source.id)!;
    if (history === "paid") state.manifest.states[original.id] = { status: "pending", attempts: 2,
      failure: { errors: [], contentSubmissions: 1, fileErrors: 0, repeatedErrors: 0, stopped: false, attemptId: "paid" } };
    if (history === "running") state.manifest.states[original.id] = { status: "running", attempts: 1, attemptId: "running" };
    if (history === "accepted") accept(original, { rewrites: attributionSlots(state.receipts[source.id]!.evaluation as ReturnType<typeof attributionResult>)
      .map(slot => ({ id: slot.id, text: "已接受：" + slot.text })) });
    const before = structuredClone({ task: original, progress: state.manifest.states[original.id], receipt: state.receipts[original.id] });
    const change = comparisonWorkflow.advance!(source, state.receipts[source.id]!, state, plan.inputs);
    assert.equal(change.tasks.filter(task => (task.data as TaskData).coverageReview).length, 2);
    assert(![...change.tasks, ...change.replace ?? []].some(task => task.stage === "rewrite" && task.dependencies.source === source.id),
      "a source handed off by every comparison must not receive newly planned polish groups");
    apply(change);
    const review = state.manifest.tasks.find(task => (task.data as TaskData).coverageReview && (task.data as TaskData).reviewOf?.taskId === source.id)!;
    const current = state.manifest.tasks.find(task => task.id === original.id)!;
    if (history === "unpaid") assert.equal(current.dependencies.source, review.id, "the unused placeholder becomes the reviewed source's placeholder");
    else {
      assert.deepEqual(current, before.task); assert.deepEqual(state.manifest.states[original.id], before.progress);
      assert.deepEqual(state.receipts[original.id], before.receipt, "paid and accepted history keeps its original source and ledger");
      assert.equal(comparisonWorkflow.canStart!(current, state.manifest), true, "existing paid work retains its normal continuation semantics");
    }
    for (const old of sources) assert.deepEqual(comparisonWorkflow.advance!(old, state.receipts[old.id]!, state, plan.inputs), { tasks: [] });
    const oldIds = state.manifest.tasks.filter(task => task.stage === "rewrite" && sources.some(old => old.id === task.dependencies.source)).map(task => task.id);
    await comparisonWorkflow.reconcile!(fixture.directory, state, fixture.config);
    assert.deepEqual(state.manifest.tasks.filter(task => task.stage === "rewrite" && sources.some(old => old.id === task.dependencies.source)).map(task => task.id), oldIds,
      "same-run reconciliation never expands the superseded source again");
  });

test("coverage handoff keeps a shared source active while another current comparison still consumes it", async t => {
  const { plan, sources, state, apply } = await setup(t), source = sources[0];
  const original = plan.tasks.find(task => task.stage === "rewrite" && task.dependencies.source === source.id)!;
  const pair = plan.tasks.find(task => task.stage === "comparison")!, waiting = { ...sources[1], id: "waiting-source" };
  const shared = { ...pair, id: "shared-comparison", dependencies: { ...pair.dependencies, B: waiting.id } };
  state.manifest.tasks.push(waiting, shared);
  state.manifest.states[waiting.id] = state.manifest.states[shared.id] = { status: "pending", attempts: 0 };
  const change = comparisonWorkflow.advance!(source, state.receipts[source.id] as SubmissionReceipt, state, plan.inputs);
  apply(change);
  const current = state.manifest.tasks.find(task => task.id === original.id)!;
  assert.equal(current.dependencies.source, source.id, "a review for one pair cannot steal another pair's original-source placeholder");
  assert.equal(state.manifest.tasks.find(task => task.id === shared.id)!.dependencies.A, source.id);
  assert(state.manifest.tasks.some(task => task.stage === "rewrite" && task.dependencies.source === source.id && (task.data as TaskData).rewriteSlotIds),
    "the shared source still needs its own accepted-result polish groups");
});
