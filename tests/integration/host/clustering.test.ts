import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { AgentBackend, JsonObject, RunState, SubmissionReceipt } from "@eval/contracts";
import { exists, readJson, readJsonl, writeJson, writeJsonl } from "@eval/data";
import { startWorker } from "@eval/runtime/worker";
import { emptyLibrary, type ClusteringResult } from "@eval/agents/clustering";
import { runEvaluation } from "@eval/host";
import { buildPlan, reportRun, readRunState, syncProblemLibrary } from "@eval/workflows/comparison";
import type { AttributionResult } from "@eval/workflows/comparison";
import { services, validateRun } from "../../fixtures/services.js";
import { attributionResult, draftFor, fakeEvaluatorVersion, fakeIdentity, fixtureConfig, raw, taskResult } from "../../fixtures/comparison.js";

async function rows(file: string): Promise<JsonObject[]> {
  const result: JsonObject[] = [];
  for await (const row of readJsonl(file)) result.push(row as JsonObject);
  return result;
}

/** Attribution result carrying a problem proposal so clustering has observations to classify. */
function problemAttribution(): AttributionResult {
  const result = attributionResult(true);
  result.findings[0] = {
    ...result.findings[0]!,
    type: "problem",
    problem: { component: "模型自身推理", label: "算术错误", definition: "计算与事实不符。" },
  };
  return result;
}

function proposedClass(): ClusteringResult {
  return {
    assignments: [{ item_id: "o1", new_class_key: "new" }],
    new_classes: [{ key: "new", component: "模型自身推理", label: "算术错误", definition: "计算不符。", closest_existing: null, novelty: "首次出现。" }],
    merges: [],
  };
}

function backendWith(calls: { value: number }): AgentBackend {
  return {
    identity: fakeIdentity,
    async createSession(options) {
      return {
        async run() {
          calls.value++;
          let result = taskResult(options.spec);
          if (options.spec.evaluation.id === "attribution") result = problemAttribution();
          await options.execute("submit_evaluation", draftFor(options.spec, result));
        },
        async abort() {},
        async dispose() {},
      };
    },
  };
}

test("clustering builds a bounded per-model library and recalls classes across runs", async () => {
  const { directory, config, modelForStage } = await fixtureConfig(
    [
      [raw("q1"), raw("q2")],
      [],
      [raw("q1"), raw("q2")],
      [],
    ],
    false,
    true,
  );
  const calls = { value: 0 };
  const worker = await startWorker(backendWith(calls), path.join(directory, "worker"));
  try {
    const plan = await buildPlan(config);
    assert.equal(plan.summary.attribution_tasks, 4);
    assert.equal(plan.summary.comparison_tasks, 2);
    assert.equal(plan.summary.clustering_tasks, 2);
    for (const task of plan.tasks.filter((item) => item.stage === "clustering")) {
      assert.deepEqual(task.inputIds, {}, "clustering must not fetch input material");
      assert.equal(Object.keys(task.dependencies).length, 2, "one dependency per answer");
    }
    const options = {
      runId: "cluster-first",
      output: config.output,
      engine: "pi" as const,
      identity: fakeIdentity,
      evaluatorVersion: fakeEvaluatorVersion,
      config,
      ...services,
      plan,
      policy: config.execution,
      modelForStage,
      concurrency: 2,
      retries: 0,
      retryDelaySeconds: 0,
      workerUrls: [worker.url],
    };
    const summary = await runEvaluation(options);
    assert.equal(summary.completed_comparisons, 2);
    assert.equal(calls.value, 8, "4 attribution + 2 comparison + 2 clustering");
    const run = path.join(config.output.path, "cluster-first");

    const clustering = await rows(path.join(run, "results", "clustering.jsonl"));
    assert.equal(clustering.length, 2);
    for (const row of clustering) {
      assert.equal(row.clustering_type, "problem_library");
      assert((row.result as { new_classes: unknown[] }).new_classes.length === 1);
    }
    for (const model of ["a_fast", "aa_fast"]) {
      const library = await readJson<{
        model: string;
        components: Record<string, unknown>;
        classes: Record<string, { label: string; status: string }>;
        occurrences: { class_id: string; case_id: string; classification: string }[];
      }>(path.join(config.problemLibrary.path, `${model}.json`));
      assert.equal(library.model, model);
      assert.equal(Object.keys(library.components).length, 1);
      assert.equal(Object.keys(library.classes).length, 1);
      assert.equal(Object.values(library.classes)[0]!.label, "算术错误");
      assert.equal(library.occurrences.length, 2);
      assert.deepEqual(
        library.occurrences.map((occurrence) => occurrence.case_id).sort(),
        ["q1", "q2"],
      );
      assert(library.occurrences.every((occurrence) => occurrence.classification === "created"));
    }
    const stats = summary.problem_library as Record<string, { classes: number; occurrences: number; proposed_new_classes: number }>;
    assert.equal(stats.a_fast!.classes, 1);
    assert.equal(stats.a_fast!.occurrences, 2);
    assert.equal(stats.a_fast!.proposed_new_classes, 1);
    assert.equal((await validateRun(run)).valid, true);
    const clusteringFile = path.join(run, "results", "clustering.jsonl");
    await writeJsonl(clusteringFile, [
      { ...clustering[0], evaluator_version: "wrong" }, ...clustering.slice(1),
    ]);
    await assert.rejects(readRunState(run), /结果评测器版本与收据不一致/);
    await writeJsonl(clusteringFile, clustering);

    // Rebuilding a report re-applies receipts idempotently: no duplicate classes or occurrences.
    await reportRun(run);
    const replay = await readJson<{ classes: Record<string, unknown>; occurrences: unknown[] }>(
      path.join(config.problemLibrary.path, "a_fast.json"),
    );
    assert.equal(Object.keys(replay.classes).length, 1);
    assert.equal(replay.occurrences.length, 2);
    assert.equal((await validateRun(run)).valid, true);

    // Disabling new clustering work on resume still keeps and reports accepted receipts.
    const resumed = await runEvaluation({
      ...options,
      config: { ...config, clustering: { ...config.clustering, enabled: false } },
      plan: { tasks: [], inputs: {}, summary: {} },
    });
    assert.equal(calls.value, 8);
    assert.equal((resumed.problem_library as Record<string, { occurrences: number }>).a_fast?.occurrences, 2);

    // A new run recalls the existing class instead of creating another one.
    await runEvaluation({
      ...options,
      runId: "cluster-second",
      plan: await buildPlan(config),
    });
    assert.equal(calls.value, 16);
    const recalled = await readJson<{ classes: Record<string, unknown>; occurrences: { classification: string }[] }>(
      path.join(config.problemLibrary.path, "a_fast.json"),
    );
    assert.equal(Object.keys(recalled.classes).length, 1, "the second run reuses the class");
    assert.equal(recalled.occurrences.length, 4);
    assert(
      recalled.occurrences.slice(2).every((occurrence) => occurrence.classification === "assigned"),
    );
    assert.equal((await validateRun(path.join(config.output.path, "cluster-second"))).valid, true);
    assert.equal((await readRunState(run)).manifest.tasks.filter((task) => task.stage === "clustering").length, 2);
  } finally {
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("accepted clustering is still written when the stage is disabled on resume", async () => {
  const { directory, config } = await fixtureConfig(undefined, false, true);
  try {
    const plan = await buildPlan(config);
    const task = plan.tasks.find((entry) => entry.stage === "clustering")!;
    const attributionReceipts = Object.values(task.dependencies).map((id) => [id, {
      evaluation: attributionResult(false),
    }]);
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
      receipts: { [dependencyId]: { evaluation: attributionResult(false) }, [task.id]: receipt(run) },
    }) as unknown as RunState;
    const model = (task.data as { scope: { version: string } }).scope.version;
    for (let attempt = 0; attempt < 3; attempt++) {
      // Each iteration uses a distinct model path, without touching persisted run data.
      const states = [state(`one-${attempt}`), state(`two-${attempt}`)];
      for (const item of states) (item.manifest.config as typeof config).problemLibrary = {
        kind: "directory", path: path.join(directory, `library-${attempt}`),
      };
      await Promise.all(states.map(syncProblemLibrary));
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
    previous.components.c1 = { id: "c1", label: "模型自身推理", definition: "", aliases: [], first_seen: null };
    previous.classes.k1 = { id: "k1", component_id: "c1", label: "其他问题", definition: "d", aliases: [], status: "active", merged_into: null, first_seen: null };
    await writeJson(path.join(config.problemLibrary.path, `${modelB}.json`), previous);
    const receipts: Record<string, unknown> = {};
    for (const task of tasks) {
      for (const dependency of Object.values(task.dependencies))
        receipts[dependency] = { evaluation: attributionResult(false) };
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

test("a clustering task over budget fails without growing the library", async () => {
  const { directory, config, modelForStage } = await fixtureConfig(undefined, false, true);
  config.clustering.maxNewClassesPerTask = 0;
  const calls = { value: 0 };
  const worker = await startWorker(backendWith(calls), path.join(directory, "worker"));
  try {
    const summary = await runEvaluation({
      runId: "cluster-budget",
      output: config.output,
      engine: "pi" as const,
      identity: fakeIdentity,
      evaluatorVersion: fakeEvaluatorVersion,
      config,
      ...services,
      plan: await buildPlan(config),
      policy: config.execution,
      modelForStage,
      concurrency: 1,
      retries: 0,
      retryDelaySeconds: 0,
      workerUrls: [worker.url],
    });
    assert.equal(summary.completed_comparisons, 1);
    assert.equal((summary.task_statuses as Record<string, number>).failed, 2, "one clustering task per model");
    assert.equal(await exists(path.join(config.problemLibrary.path, "a_fast.json")), false);
    assert.equal((await validateRun(path.join(config.output.path, "cluster-budget"))).valid, true);
  } finally {
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  }
});
