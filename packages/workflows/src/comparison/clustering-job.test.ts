import test from "node:test";
import assert from "node:assert/strict";
import { emptyUsage, type PlannedTask, type RunState, type SubmissionReceipt } from "@eval/contracts";
import { clusteringJobWorkflow } from "./clustering-job.js";
import { planClusteringTasks, planDeferredRecall } from "./clustering-job-plan.js";
import type { ClusteringJobConfig, ClusteringJobMaterial } from "./clustering-job-types.js";
import { acceptedClusteringOrder, discoverAfterAssignments, parallelClusteringAssignments } from "./clustering-job-parallel.js";
import type { ClusteringJobTask } from "./clustering-job-types.js";
import type { ClusteringRequest, ClusteringObservation } from "@eval/agents/clustering";

test("directory completion recalls only deferred observations once, without creating classes or attribution work", () => {
  const config = { clusteringJob: { sources: [] }, clustering: { maxCasesPerTask: 1 },
    rewrite: { clustering: false } } as unknown as ClusteringJobConfig;
  const observations = ["a", "b"].map(id => ({ id, component: "模型自身推理", refs: [{ input_id: id }] })) as ClusteringObservation[];
  const tasks = planClusteringTasks("model", observations, config);
  const state = { manifest: { tasks }, receipts: Object.fromEntries(tasks.slice(0, 2).map((t, i) =>
    [t.id, { evaluation: { assignments: [{ item_id: observations[i]!.id,
      ...(i ? { class_id: "class" } : { deferred_reason: "首批没有适用类" }) }] } }])) } as unknown as RunState;
  const inputs = { model: { config, observations } as ClusteringJobMaterial };
  const final = tasks.at(-1)!;
  const recall = planDeferredRecall(final, state, inputs);
  assert.equal(recall.length, 1);
  assert.deepEqual(recall[0]!.data, { model: "model", itemIds: ["a"], reclassify: true, revisit: true });
  assert.deepEqual(recall[0]!.dependencies, { previous: final.id });
  state.manifest.tasks.push(...recall);
  assert.deepEqual(planDeferredRecall(final, state, inputs), []);
  assert.deepEqual(planDeferredRecall(recall[0]!, state, inputs), []);
  assert(planClusteringTasks("model", observations, { ...config, clusteringJob: { sources: [], runs: [], assignmentOnly: true } })
    .every(t => t.stage === "clustering" && !(t.data as { consolidate?: true }).consolidate));
});

function fixture(frozen: boolean): RunState {
  const source = (id: string): PlannedTask => ({ id, stage: "clustering", inputIds: {}, dependencies: {},
    data: { model: "model", itemIds: [], consolidate: true } });
  const rewrite = (id: string, from: string): PlannedTask => ({ id, stage: "rewrite", inputIds: {},
    dependencies: { source: from }, data: { model: "model", itemIds: [], rewriteOf: from } });
  const tasks = [source("empty"), rewrite("empty-rewrite", "empty"), rewrite("failed-empty-rewrite", "empty"),
    source("words"), rewrite("words-rewrite", "words"), rewrite("accepted-rewrite", "words"),
    source("pending"), rewrite("pending-rewrite", "pending"),
    { ...source("next"), dependencies: { previous: "empty" } }];
  const receipt = (taskId: string, evaluation: unknown): SubmissionReceipt => ({ taskId, evaluation,
    attemptId: taskId + "-attempt", submissionId: taskId + "-submission", evaluatorVersion: "fixture",
    judge: "fixture", status: "succeeded", acceptedAt: 1, audit: {} as SubmissionReceipt["audit"], usage: emptyUsage() });
  const receipts = {
    empty: receipt("empty", { assignments: [], new_classes: [], merges: [], class_updates: [] }),
    words: receipt("words", { assignments: [{ item_id: "item", deferred_reason: "独立回答数量不足。" }],
      new_classes: [], merges: [] }),
    "accepted-rewrite": receipt("accepted-rewrite", { rewrites: [{ id: "assignments.0.deferred_reason", text: "样本还不够。" }] }),
  };
  return { manifest: { runId: "fixture", config: { clusteringJob: { runs: [], sources: [] } },
    tasks, states: Object.fromEntries(tasks.map(task => [task.id, task.id === "failed-empty-rewrite"
      ? { status: "failed", attempts: 2, attemptId: "paid-attempt", reason: "API 400", failure: { code: "empty_enum" } }
      : { status: Object.hasOwn(receipts, task.id) ? "succeeded" : "pending", attempts: Object.hasOwn(receipts, task.id) ? 1 : 0 }])),
    ...(frozen ? { executionScope: tasks.map(task => task.id) } : {}), preflight: {} },
    receipts, usage: emptyUsage(), recordedAttempts: 4 } as unknown as RunState;
}

test("standalone clustering skips zero-slot Rewrite after acceptance and on resume while retaining the attempt ledger", async () => {
  for (const frozen of [false, true]) {
    for (const resumed of [false, true]) {
      const state = fixture(frozen), before = structuredClone(state), source = state.manifest.tasks[0]!;
      if (resumed) await clusteringJobWorkflow.reconcile!("/fixture-unused", state, state.manifest.config);
      else clusteringJobWorkflow.advance?.(source, state.receipts.empty!, state, {});
      assert(state.manifest.executionScope, "empty text work is excluded through the Host execution scope");
      assert(!state.manifest.executionScope.includes("empty-rewrite"), "no zero-slot request reaches the Rewrite schema");
      assert(!state.manifest.executionScope.includes("failed-empty-rewrite"), "resume does not redispatch a paid empty request");
      for (const id of ["empty", "words-rewrite", "accepted-rewrite", "pending-rewrite", "next"])
        assert(state.manifest.executionScope.includes(id), "other work remains selected: " + id);
      assert.equal(state.manifest.tasks.find(task => task.id === "next")!.dependencies.previous, "empty",
        "the next clustering task depends on the accepted clustering source, not its skipped prose");
      assert.deepEqual(state.receipts, before.receipts, "skipping must not create accepted Rewrite receipts");
      assert.deepEqual(state.manifest.tasks, before.manifest.tasks, "all planned task identities are retained");
      assert.deepEqual(state.manifest.states, before.manifest.states, "paid attempts, failures and progress remain intact");
      assert.deepEqual(state.usage, before.usage);
      assert.equal(state.recordedAttempts, before.recordedAttempts);
    }
  }
});

test("known-directory assignments run in parallel and unmatched observations retain serial discovery", () => {
  const config = { clusteringJob: { sources: [] }, clustering: { maxCasesPerTask: 1 },
    rewrite: { clustering: true } } as unknown as ClusteringJobConfig;
  const observations = Array.from({ length: 8 }, (_, index) => ({ id: `o${index}`,
    component: "模型自身推理", refs: [{ input_id: `answer${index}` }] })) as ClusteringObservation[];
  const inputs = { model: { config, observations, library: { components: [
    { id: "component", label: "模型自身推理", aliases: [], classes: [{ id: "known" }] },
  ] } } as unknown as ClusteringJobMaterial };
  const serial = planClusteringTasks("model", observations, config);
  const tasks = parallelClusteringAssignments(serial, inputs);
  const readers = tasks.filter(t => (t.data as ClusteringJobTask).assignmentPass);
  assert.equal(readers.length, 8);
  assert(readers.every(t => !Object.keys(t.dependencies).length));
  const final = tasks.find(t => t.stage === "clustering" && (t.data as ClusteringJobTask).consolidate)!;
  assert.deepEqual(new Set(Object.values(final.dependencies)), new Set(readers.map(t => t.id)));
  for (const reader of readers) {
    const input = clusteringJobWorkflow.bind(reader, inputs, {}, { tasks }).request.input as unknown as ClusteringRequest;
    assert.equal(input.budget.assignment_only, true);
    assert.equal(input.budget.max_new_classes, 0);
    assert.equal(input.budget.consolidate, false);
  }
  const state = { manifest: { tasks }, receipts: {} } as unknown as RunState;
  for (const [index, reader] of readers.toReversed().entries()) {
    state.receipts[reader.id] = { evaluation: { assignments: [{ item_id: (reader.data as ClusteringJobTask).itemIds[0],
      ...(index < 2 ? { deferred_reason: "没有匹配类" } : { class_id: "known" }) }] } } as unknown as SubmissionReceipt;
    const advance = discoverAfterAssignments(reader, state, inputs);
    if (index < 7) { assert.equal(advance, undefined, "no directory mutation while readers remain"); continue; }
    assert(advance);
    const discovery = advance.tasks.filter(t => t.stage === "clustering");
    assert.equal(discovery.length, 2);
    assert.deepEqual(new Set(discovery.flatMap(t => (t.data as ClusteringJobTask).itemIds)), new Set(["o7", "o6"]));
    assert.deepEqual(discovery[0].dependencies, final.dependencies);
    assert.equal(discovery[1].dependencies.previous, discovery[0].id);
    assert.deepEqual(advance.replace[0].dependencies, { previous: discovery[1].id });
    state.manifest.tasks = state.manifest.tasks.map(t => t.id === final.id ? advance.replace[0] : t);
    state.manifest.tasks.push(...advance.tasks);
    for (const task of [...discovery, advance.replace[0]]) state.receipts[task.id] = {} as SubmissionReceipt;
    const order = acceptedClusteringOrder(state).map(t => t.id);
    assert(order.indexOf(discovery[1].id) < order.indexOf(final.id), "replay honors appended discovery dependencies");
    assert.equal(discoverAfterAssignments(reader, state, inputs), undefined, "resume cannot create discovery twice");
    assert.deepEqual(parallelClusteringAssignments(state.manifest.tasks, inputs), state.manifest.tasks);
  }
});

test("parallel assignment planning preserves paid prefixes, task IDs, receipts and narrowed scope", () => {
  const config = { clusteringJob: { sources: [] }, clustering: { maxCasesPerTask: 1 }, rewrite: { clustering: true } } as unknown as ClusteringJobConfig;
  const observations = ["a", "b", "c"].map(id => ({ id, component: "推理", refs: [{ input_id: id }] })) as ClusteringObservation[];
  const inputs = { model: { config, observations, library: { components: [{ label: "推理", aliases: [], classes: [{}] }] } } as unknown as ClusteringJobMaterial };
  const tasks = planClusteringTasks("model", observations, config), first = tasks[0];
  const states = { [first.id]: { status: "cancelled" as const, attempts: 1 } };
  const planned = parallelClusteringAssignments(tasks, inputs, states);
  assert.equal(planned[0], first);
  const readers = planned.filter(t => (t.data as ClusteringJobTask).assignmentPass);
  assert.equal(readers.length, 2);
  assert(readers.every(t => t.dependencies.previous === first.id));
  assert.deepEqual(planned.map(t => t.id), tasks.map(t => t.id));
  const interruptedStates = { ...states, ...Object.fromEntries(tasks.slice(1).map(task => [task.id,
    { status: "blocked" as const, attempts: 0 }])) };
  assert.equal(parallelClusteringAssignments(tasks, inputs, interruptedStates)
    .filter(task => (task.data as ClusteringJobTask).assignmentPass).length, 2,
    "unattempted descendants blocked by interruption remain eligible on resume");
  assert.deepEqual(parallelClusteringAssignments(tasks, inputs, states, {}, [first.id]), tasks);
  const revisit = planClusteringTasks("model", observations, config, "directory", true);
  assert(revisit.filter(t => t.stage === "clustering").every(t => t.dependencies.previous === "directory"));
});
