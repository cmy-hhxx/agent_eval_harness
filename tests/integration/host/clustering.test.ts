import { responsibilityFixture } from "../../fixtures/responsibility.js";
import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { RunState, SubmissionReceipt } from "@eval/contracts";
import { exists, readJson, writeJson } from "@eval/data";
import { clusteringProfile, emptyLibrary, type ClusteringResult } from "@eval/agents/clustering";
import { buildPlan, comparisonWorkflow, syncProblemLibrary } from "@eval/workflows/comparison";
import type { AttributionResult, TaskData } from "@eval/workflows/comparison";
import { attributionResult, emptyAudit, fakeEvaluatorVersion, fixtureConfig, raw } from "../../fixtures/comparison.js";

/** Attribution result carrying a problem proposal so clustering has observations to classify. */
function problemAttribution(answer: string, inputId: string): AttributionResult {
  const result = attributionResult(false, answer, true, inputId);
  result.correct_reason = "最终结果5与标准结果4不符。";
  result.Problem[0] = {
    ...result.Problem[0]!,
    ...responsibilityFixture("最终回答组织"),
    reason: "原文给出5，正确结果应为4。",
    text: "算术错误",
  };
  return result;
}

function proposedClass(): ClusteringResult {
  return {
    assignments: [{ item_id: "o1", new_class_key: "new" }],
    new_classes: [{ key: "new", component: "回答生成：本题事实关系推导与结果使用（消息 1） / 数据解释与计算 / 事实关系推导", label: "算术错误", definition: "计算不符。", closest_existing: null, novelty: "首次出现。", category: "数值可靠性" }],
    merges: [],
  };
}

const attributedReceipt = (taskId: string, evaluation: AttributionResult) => ({
  taskId, submissionId: randomUUID(), evaluatorVersion: fakeEvaluatorVersion, evaluation,
});

test("a batch may create every component its own observations use", async () => {
  const { directory, config } = await fixtureConfig(undefined, false, true);
  try {
    const plan = await buildPlan(config);
    const task = plan.tasks.find((entry) => entry.stage === "clustering")!;
    const inputId = Object.keys(task.dependencies)[0]!;
    const finding = attributionResult(false).Problem[0]!;
    const evaluation = {
      ...attributionResult(false),
      Problem: [
        { ...finding, problem_id: "p1", ...responsibilityFixture("Search"), related_responsibilities:[{...responsibilityFixture("最终回答组织"),evidence_ids:[]}], text: "检索不足", reason: "检索结果不完整，模型仍给出确定结论。" },
      ],
    };
    const dependencies = { [inputId]: { evaluation } } as unknown as Record<string, SubmissionReceipt | undefined>;
    const bound = comparisonWorkflow.bind(task, {}, dependencies, { tasks: plan.tasks }).request.input as {
      items: unknown[];
      budget: { max_new_components: number };
    };
    assert.equal(bound.items.length, 2);
    assert.equal(bound.budget.max_new_components, 2, "two unseen components are both allowed");

    const known = structuredClone(task);
    (known.data as { projection: unknown }).projection = {
      components: [{ id: "c1", label: "Search", definition: "", aliases: [], classes: [] }],
    };
    const narrowed = comparisonWorkflow.bind(known, {}, dependencies, { tasks: plan.tasks.map(item => item.id === known.id ? known : item) }).request.input as {
      budget: { max_new_components: number };
    };
    assert.equal(narrowed.budget.max_new_components, 1, "the known component and its alias do not count again");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("clustering bind preserves each shard's reserved component headroom", async () => {
  const { directory, config } = await fixtureConfig(
    [[raw("q1"), raw("q2")], [], [raw("q1"), raw("q2")], []], false, true,
  );
  config.clustering.maxCasesPerTask = 1;
  config.clustering.maxComponentsPerModel = 1;
  try {
    const plan = await buildPlan(config);
    const shards = plan.tasks.filter((task) =>
      task.stage === "clustering" && (task.data as TaskData).scope?.version === "a_fast",
    );
    assert.equal(shards.length, 2);
    assert.deepEqual(shards.map((task) => (task.data as TaskData).scope!.budget.max_new_components), [1, 0]);
    const bound = shards.map((task, index) => {
      const inputId = Object.keys(task.dependencies)[0]!;
      const evaluation = attributionResult(false);
      const component = index === 0 ? "Search" : "最终回答组织";
      evaluation.Problem[0] = { ...evaluation.Problem[0], ...responsibilityFixture(component), text: "算术错误", reason: "计算不符。" };
      const dependencies = { [inputId]: { evaluation } } as unknown as Record<string, SubmissionReceipt>;
      const request = comparisonWorkflow.bind(task, {}, dependencies, { tasks: plan.tasks }).request;
      return { request, component: (request.input.items as {component:string}[])[0].component };
    });
    assert.deepEqual(bound.map(({ request }) => (request.input as { budget: { max_new_components: number } }).budget.max_new_components), [1, 0]);
    for (const [index, { request, component }] of bound.entries()) {
      const proposal = proposedClass();
      proposal.new_classes[0]!.component = component;
      if (index === 0) assert.doesNotThrow(() => clusteringProfile.validate!(request, proposal, emptyAudit()));
      else assert.throws(() => clusteringProfile.validate!(request, proposal, emptyAudit()), /新增组件数超过 budget\.max_new_components/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("accepted clustering is still written when the stage is disabled on resume", async () => {
  const { directory, config } = await fixtureConfig(undefined, false, true);
  try {
    const plan = await buildPlan(config);
    const task = plan.tasks.find((entry) => entry.stage === "clustering")!;
    const attributionReceipts = Object.values(task.dependencies).map(id => [id, attributedReceipt(id, attributionResult(false))]);
    const state = {
      manifest: {
        runId: "resumed",
        config: { ...config, clustering: { ...config.clustering, enabled: false } },
        tasks: [task],
      },
      receipts: {
        ...Object.fromEntries(attributionReceipts),
        [task.id]: {
          submissionId: "cluster-submission",
          evaluation: proposedClass(),
        },
      },
    } as unknown as RunState;
    const stats = await syncProblemLibrary(state);
    assert.equal(stats[(task.data as { scope: { version: string } }).scope.version]?.occurrences, 1);
    assert.equal(await exists(path.join(config.problemLibrary.path, `${(task.data as { scope: { version: string } }).scope.version}.json`)), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("two runs writing the same model cannot lose each other's occurrences", async () => {
  const { directory, config } = await fixtureConfig(undefined, false, true);
  try {
    const plan = await buildPlan(config);
    const task = plan.tasks.find((entry) => entry.stage === "clustering")!;
    const inputId = Object.keys(task.dependencies)[0]!;
    const dependencyId = task.dependencies[inputId]!;
    const receipt = (run: string): SubmissionReceipt => ({
      submissionId: run,
      evaluatorVersion: fakeEvaluatorVersion,
      evaluation: proposedClass(),
    }) as SubmissionReceipt;
    const state = (run: string): RunState => ({
      manifest: { runId: run, config, tasks: [{
        ...task,
        data: { ...task.data as object, scope: {
          ...(task.data as { scope: object }).scope,
          cases: { [`${run}-${inputId}`]: (task.data as { scope: { cases: Record<string, unknown> } }).scope.cases[inputId] },
        } },
        dependencies: { [`${run}-${inputId}`]: dependencyId },
      }] },
      receipts: { [dependencyId]: attributedReceipt(dependencyId, attributionResult(false)), [task.id]: receipt(run) },
    }) as unknown as RunState;
    const model = (task.data as { scope: { version: string } }).scope.version;
    for (let attempt = 0; attempt < 3; attempt++) {
      // Each iteration uses a distinct model path, without touching persisted run data.
      const states = [state(`one-${attempt}`), state(`two-${attempt}`)];
      for (const item of states) (item.manifest.config as typeof config).problemLibrary = {
        kind: "directory", path: path.join(directory, `library-${attempt}`),
      };
      const settled = await Promise.allSettled(states.map(syncProblemLibrary));
      for (const result of settled) if (result.status === "rejected") throw result.reason;
      const library = await readJson<{ occurrences: unknown[] }>(path.join(directory, `library-${attempt}`, `${model}.json`));
      assert.equal(library.occurrences.length, 2);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a model over the library cap cannot partially commit another model", async () => {
  const { directory, config } = await fixtureConfig(undefined, false, true);
  try {
    config.clustering.maxClassesPerModel = 1;
    const tasks = (await buildPlan(config)).tasks.filter((task) => task.stage === "clustering");
    const [first, second] = tasks;
    assert(first && second);
    const modelA = (first.data as { scope: { version: string } }).scope.version;
    const modelB = (second.data as { scope: { version: string } }).scope.version;
    const previous = emptyLibrary(modelB);
    previous.components.c1 = { id: "c1", label: "回答生成：本题事实关系推导与结果使用（消息 1） / 数据解释与计算 / 事实关系推导", definition: "", aliases: [], first_seen: null };
    previous.classes.k1 = { id: "k1", component_id: "c1", label: "其他问题", definition: "d", aliases: [], status: "active", merged_into: null, first_seen: null };
    await writeJson(path.join(config.problemLibrary.path, `${modelB}.json`), previous);
    const receipts: Record<string, unknown> = {};
    for (const task of tasks) {
      for (const dependency of Object.values(task.dependencies))
        receipts[dependency] = attributedReceipt(dependency, attributionResult(false));
      receipts[task.id] = {
        submissionId: `s-${task.id}`,
        evaluatorVersion: fakeEvaluatorVersion,
        evaluation: proposedClass(),
      };
    }
    const state = { manifest: { runId: "cap", config, tasks }, receipts } as unknown as RunState;
    await assert.rejects(syncProblemLibrary(state), /超过上限/);
    assert.equal(await exists(path.join(config.problemLibrary.path, `${modelA}.json`)), false);
    assert.deepEqual(await readJson(path.join(config.problemLibrary.path, `${modelB}.json`)), previous);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("library statistics count a jointly attributed finding once", async () => {
  const { directory, config } = await fixtureConfig(undefined, false, true);
  try {
    const plan = await buildPlan(config), task = plan.tasks.find(task => task.stage === "clustering")!;
    const evaluation = problemAttribution("5", "7c4e3ba8-8f7c-46cc-b8fb-3016e10ea2dd");
    evaluation.Problem[0]!.related_responsibilities=[{...responsibilityFixture("Search"),evidence_ids:[]}];
    const receipts = Object.fromEntries(Object.values(task.dependencies).map(id => [id, attributedReceipt(id, evaluation)]));
    const { taskObservations } = await import("@eval/workflows/comparison");
    const observations = taskObservations(task, id => receipts[id]);
    assert.equal(observations.length, 2);
    const result: ClusteringResult = {
      assignments: observations.map((item, index) => ({ item_id: item.id, new_class_key: `n${index}` })), merges: [],
      new_classes: observations.map((item, index) => ({ key: `n${index}`, component: item.component, label: item.label,
        definition: item.definition, closest_existing: null, novelty: "首例。", category: "可靠性" })),
    };
    const state = { manifest: { runId: "joint", config, tasks: [task] }, receipts: { ...receipts,
      [task.id]: { submissionId: "joint-submission", evaluatorVersion: fakeEvaluatorVersion, evaluation: result } } } as unknown as RunState;
    const stats = await syncProblemLibrary(state), model = (task.data as TaskData).scope!.version;
    assert.equal(stats[model]!.assigned, 1);
    assert.equal(stats[model]!.occurrences, 1);
    const library = await readJson<{ occurrences: unknown[] }>(path.join(config.problemLibrary.path, model + ".json"));
    assert.equal(library.occurrences.length, 2, "both component associations stay persisted");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
