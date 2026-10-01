import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile, rm } from "node:fs/promises";
import type { AgentBackend, TaskAnalysis } from "@eval/contracts";
import { writeJsonl } from "@eval/data";
import { runEvaluation } from "@eval/host";
import { startWorker } from "@eval/runtime/worker";
import {
  buildPlan, readRunState, reconcileRun, deliveryCoverage, loadRunInputs,
  type AttributionResult, type TaskData,
} from "@eval/workflows/comparison";
import { services, validateRun } from "../../fixtures/services.js";
import {
  attributionResult, draftFor, fakeEvaluatorVersion, fakeIdentity, fixtureConfig, parsedMaterial, raw, taskResult,
} from "../../fixtures/comparison.js";

interface FormalComparison {
  comparison_id: string;
  criteria_task_id: string;
  attribution_task_ids: Record<string, string>;
  ground_truth: { available: boolean; value: unknown };
  assessments: Record<string, { meets_core: boolean | null }>;
  evaluations: Record<string, Pick<AttributionResult, "findings">>;
  ranking: string[][];
}
const formalRows = async (run: string): Promise<FormalComparison[]> =>
  (await readFile(path.join(run, "results/comparison.jsonl"), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));

async function resumeExperiment(change: "none" | "rubric" | "reference" | "source") {
  const setup = await fixtureConfig([[raw()], [], [raw()], []]);
  const { directory, config, modelForStage } = setup;
  const plan = await buildPlan(config);
  const entered: { taskId: string; stage: string; material: unknown }[] = [];
  let expanded = false;
  const backend: AgentBackend = {
    identity: fakeIdentity,
    async createSession(options) {
      return {
        async run() {
          const properties = (options.spec.evaluation.outputSchema as { properties: Record<string, unknown> }).properties;
          const stage = "requirements" in properties ? "criteria"
            : "decision_basis" in properties ? "comparison" : "attribution";
          const material = parsedMaterial(options.spec) as {
            task_analysis: TaskAnalysis; answer?: { final_answer: string };
          };
          entered.push({ taskId: options.spec.taskId, stage, material });
          let result = taskResult(options.spec);
          if (stage === "attribution" && material.answer?.final_answer === "2+2=5") {
            const incorrect = attributionResult(false, material.answer.final_answer);
            incorrect.task_analysis = material.task_analysis;
            incorrect.correctness_reason = "最终回答给出5，标准答案为4。";
            incorrect.findings[0].reason = "把2+2的结果写成5，与标准答案4不符。";
            incorrect.findings[0].assessment.impact = "错误数值导致加法要求未完成。";
            result = incorrect;
          }
          if (stage === "criteria" && expanded && change === "rubric") {
            const criteria = result as TaskAnalysis;
            criteria.requirements[0].text = "给出算式和正确的整数结果";
            criteria.requirements[0].acceptance_rule = "回答写出2+2以及整数结果4。";
          }
          const response = await options.execute("submit_evaluation", draftFor(options.spec, result));
          assert.equal(response.isError, undefined, JSON.stringify(response));
        },
        async abort() {},
        async dispose() {},
      };
    },
  };
  const worker = await startWorker(backend, path.join(directory, "worker"));
  const options = {
    ...services,
    // Daily automation explicitly extends the model selection on the existing run.
    taskSource: { ...services.taskSource,
      reconcile: (run: string, state: Parameters<typeof reconcileRun>[1], current: unknown) =>
        reconcileRun(run, state, current, { extendVersions: true }) },
    plan, config, runId: "professional-resume", output: config.output,
    engine: "pi" as const, identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion,
    workerUrls: [worker.url], policy: config.execution, modelForStage,
    concurrency: 2, retries: 0, retryDelaySeconds: 0,
  };
  return { ...setup, worker, options, entered,
    run: path.join(config.output.path, options.runId),
    async extend() {
      expanded = true;
      const reference = change === "reference" ? "4（整数）" : "4";
      if (change === "reference") {
        for (const id of ["a_fast", "b_fast"])
          await writeJsonl(config.inputs.versions.find((version) => version.id === id)!.sources[0].path,
            [raw("q1", reference)]);
      }
      if (change === "source")
        await writeJsonl(config.inputs.versions.find((version) => version.id === "a_fast")!.sources[0].path,
          [raw("q1", reference, "2+2=5")]);
      const source = path.join(directory, "c_fast.jsonl");
      await writeJsonl(source, [raw("q1", reference)]);
      config.inputs.versions.push({ id: "c_fast", name: "C Fast", comparison_tier: "Fast",
        adapter: "a", sources: [{ kind: "file", path: source }] });
      config.comparisons = [["a_fast", "b_fast", "c_fast"]];
      return runEvaluation({ ...options, discoverInputs: true });
    },
  };
}

test("same-run AB to ABC expansion reuses accepted sources when the shared criteria are unchanged", async () => {
  const experiment = await resumeExperiment("none");
  try {
    assert.equal((await runEvaluation(experiment.options)).completed_comparisons, 1);
    const original = await readRunState(experiment.run);
    const originalRows = await formalRows(experiment.run);
    const sourceIds = originalRows[0].attribution_task_ids;
    const sourceReceipts = structuredClone(original.receipts);
    const acceptedIds = new Set(Object.keys(original.receipts));
    assert.deepEqual(experiment.entered.map((item) => item.stage).sort(),
      ["attribution", "attribution", "comparison", "criteria"]);

    assert.equal((await experiment.extend()).completed_comparisons, 3);
    const expanded = await readRunState(experiment.run);
    const rows = await formalRows(experiment.run);
    const counts = Object.fromEntries(["criteria", "attribution", "comparison"].map((stage) =>
      [stage, expanded.manifest.tasks.filter((task) => task.stage === stage && expanded.receipts[task.id]).length]));
    assert.deepEqual(counts, { criteria: 2, attribution: 3, comparison: 3 });
    for (const id of acceptedIds)
      assert.deepEqual(expanded.receipts[id], sourceReceipts[id], "accepted AB receipts remain exact durable sources");
    assert.deepEqual(rows.find((row) => row.comparison_id === originalRows[0].comparison_id), originalRows[0]);
    assert.equal(rows.length, 3);
    assert.equal(new Set(rows.map((row) => Object.keys(row.attribution_task_ids).sort().join("/"))).size, 3);

    const additions = experiment.entered.filter((item) => !acceptedIds.has(item.taskId));
    assert.deepEqual(additions.map((item) => item.stage).sort(), ["attribution", "comparison", "comparison", "criteria"]);
    const newCriteria = expanded.manifest.tasks.find((task) => task.stage === "criteria" && !acceptedIds.has(task.id))!;
    assert.deepEqual(expanded.receipts[newCriteria.id].evaluation,
      original.receipts[originalRows[0].criteria_task_id].evaluation);
    const newAttribution = expanded.manifest.tasks.find((task) => task.stage === "attribution" && !acceptedIds.has(task.id))!;
    assert.equal((newAttribution.data as TaskData).candidates.A.version, "c_fast");
    assert.equal((newAttribution.data as TaskData).reviewOf, undefined);
    for (const row of rows.filter((item) => item.comparison_id !== originalRows[0].comparison_id)) {
      assert.equal(row.criteria_task_id, newCriteria.id);
      assert.equal(row.attribution_task_ids.c_fast, newAttribution.id);
      for (const version of Object.keys(row.attribution_task_ids).filter((version) => version !== "c_fast"))
        assert.equal(row.attribution_task_ids[version], sourceIds[version], "new pairs point to the original accepted attribution");
    }
    const validation = await validateRun(experiment.run);
    assert(validation.valid, JSON.stringify(validation));
    assert(deliveryCoverage(expanded).valid);
    const calls = experiment.entered.length;
    await runEvaluation({ ...experiment.options, discoverInputs: true });
    assert.equal(experiment.entered.length, calls, "a further resume never repeats accepted criteria or pair verdicts");
    assert.deepEqual(await formalRows(experiment.run), rows);
  } finally { await experiment.worker.close(); await rm(experiment.directory, { recursive: true, force: true }); }
});

for (const change of ["rubric", "reference"] as const)
  test(`same-run new pairs independently reassess changed ${change} and retain the original receipts`, async () => {
    const experiment = await resumeExperiment(change);
    try {
      await runEvaluation(experiment.options);
      const original = await readRunState(experiment.run);
      const originalRows = await formalRows(experiment.run);
      const sourceIds = originalRows[0].attribution_task_ids;
      const originalReceipts = structuredClone(original.receipts);
      const acceptedIds = new Set(Object.keys(original.receipts));

      assert.equal((await experiment.extend()).completed_comparisons, 3);
      const expanded = await readRunState(experiment.run);
      const rows = await formalRows(experiment.run);
      for (const id of acceptedIds) assert.deepEqual(expanded.receipts[id], originalReceipts[id]);
      assert.deepEqual(rows.find((row) => row.comparison_id === originalRows[0].comparison_id), originalRows[0]);
      assert.equal(rows.length, 3);
      assert.equal(expanded.manifest.tasks.filter((task) => task.stage === "criteria").length, 2);
      const reviews = expanded.manifest.tasks.filter((task) => task.stage === "attribution" && (task.data as TaskData).reviewOf);
      assert.equal(reviews.length, 2, "each accepted AB source is reassessed once for the new shared standard");
      assert.deepEqual(new Set(reviews.map((task) => (task.data as TaskData).reviewOf!.taskId)), new Set(Object.values(sourceIds)));
      assert.equal(expanded.manifest.tasks.filter((task) => task.stage === "attribution" && expanded.receipts[task.id]).length, 5);
      const newCriteria = expanded.manifest.tasks.find((task) => task.stage === "criteria" && !acceptedIds.has(task.id))!;
      const criteria = expanded.receipts[newCriteria.id].evaluation;
      if (change === "rubric") assert.notDeepEqual(criteria, original.receipts[originalRows[0].criteria_task_id].evaluation);
      else assert.deepEqual(criteria, original.receipts[originalRows[0].criteria_task_id].evaluation,
        "a changed reference requires reassessment even when rubric text stays equal");
      for (const review of reviews) {
        const data = review.data as TaskData;
        assert.equal(data.reviewOf!.round, 1);
        assert.equal(review.inputIds.answer, original.manifest.tasks.find((task) => task.id === data.reviewOf!.taskId)!.inputIds.answer);
        assert.equal(review.dependencies.criteria, newCriteria.id);
        assert.deepEqual((expanded.receipts[review.id].evaluation as AttributionResult).task_analysis, criteria);
        const material = experiment.entered.find((item) => item.taskId === review.id)!.material as Record<string, unknown>;
        assert.deepEqual(material.review_context, { reasons: data.reviewOf!.reasons });
        assert.equal(material.attributions, undefined, "independent review receives the source material and new criteria");
      }
      for (const row of rows.filter((item) => item.comparison_id !== originalRows[0].comparison_id)) {
        assert.equal(row.criteria_task_id, newCriteria.id);
        if (change === "reference") assert.equal(row.ground_truth.value, "4（整数）");
        for (const version of Object.keys(row.attribution_task_ids).filter((version) => version !== "c_fast")) {
          const review = reviews.find((task) => (task.data as TaskData).reviewOf!.taskId === sourceIds[version])!;
          assert.equal(row.attribution_task_ids[version], review.id, "formal new pairs cite the independently reassessed source");
        }
      }
      const validation = await validateRun(experiment.run);
      assert(validation.valid, JSON.stringify(validation));
      const calls = experiment.entered.length;
      await runEvaluation({ ...experiment.options, discoverInputs: true });
      assert.equal(experiment.entered.length, calls);
      assert.deepEqual(await formalRows(experiment.run), rows);
    } finally { await experiment.worker.close(); await rm(experiment.directory, { recursive: true, force: true }); }
  });

test("same-run source changes independently reassess stale evidence for new pairs while retaining accepted AB", async () => {
  const experiment = await resumeExperiment("source");
  try {
    await runEvaluation(experiment.options);
    const original = await readRunState(experiment.run);
    const originalRows = await formalRows(experiment.run);
    const originalReceipts = structuredClone(original.receipts);
    const oldA = originalRows[0].attribution_task_ids.a_fast;
    const oldB = originalRows[0].attribution_task_ids.b_fast;
    const acceptedIds = new Set(Object.keys(original.receipts));

    assert.equal((await experiment.extend()).completed_comparisons, 3);
    const expanded = await readRunState(experiment.run);
    const rows = await formalRows(experiment.run);
    assert.equal(rows.length, 3);
    for (const id of acceptedIds) assert.deepEqual(expanded.receipts[id], originalReceipts[id]);
    assert.deepEqual(rows.find((row) => row.comparison_id === originalRows[0].comparison_id), originalRows[0]);
    const reviews = expanded.manifest.tasks.filter((task) => task.stage === "attribution" && (task.data as TaskData).reviewOf);
    assert.equal(reviews.length, 1, "only A's stale evidence requires an independent reassessment");
    const review = reviews[0], data = review.data as TaskData;
    assert.equal(data.reviewOf!.taskId, oldA);
    assert.equal(data.reviewOf!.round, 1);
    assert.equal(review.inputIds.answer, original.manifest.tasks.find((task) => task.id === oldA)!.inputIds.answer,
      "the persistent input UUID remains the business identity");
    const newCriteria = expanded.manifest.tasks.find((task) => task.stage === "criteria" && !acceptedIds.has(task.id))!;
    assert.deepEqual(expanded.receipts[newCriteria.id].evaluation,
      original.receipts[originalRows[0].criteria_task_id].evaluation, "criteria and reference are unchanged");
    const reassessed = expanded.receipts[review.id].evaluation as AttributionResult;
    assert.equal(reassessed.is_correct, false);
    assert.equal(reassessed.core_assessment.meets_core, false);
    assert.equal(reassessed.findings[0].evidence[0].quote, "2+2=5");
    assert.equal((expanded.receipts[oldA].evaluation as AttributionResult).findings[0].evidence[0].quote, "2+2=4");
    const ac = rows.find((row) => row.attribution_task_ids.a_fast && row.attribution_task_ids.c_fast)!;
    const bc = rows.find((row) => row.attribution_task_ids.b_fast && row.attribution_task_ids.c_fast)!;
    assert.equal(ac.attribution_task_ids.a_fast, review.id);
    assert.equal(bc.attribution_task_ids.b_fast, oldB);
    assert.equal(ac.evaluations.a_fast.findings[0].evidence[0].quote, "2+2=5");
    assert.equal(ac.assessments.a_fast.meets_core, false);
    assert.equal(ac.assessments.c_fast.meets_core, true);
    assert.deepEqual(ac.ranking, [["c_fast"], ["a_fast"]]);

    const inputs = await loadRunInputs(expanded.manifest);
    for (const task of expanded.manifest.tasks.filter((item) => !acceptedIds.has(item.id))) {
      const dependencies = Object.fromEntries(Object.entries(task.dependencies)
        .map(([label, id]) => [label, expanded.receipts[id]]));
      assert.doesNotThrow(() => services.agents.validate(
        services.taskSource.bind(task, inputs, dependencies), expanded.receipts[task.id].evaluation,
        expanded.receipts[task.id].audit), `new task ${task.id} validates against the current source`);
    }
    // Accepted AB still records the original evidence; changing its source does not rewrite that receipt.
    const validation = await validateRun(experiment.run);
    assert.equal(validation.evidence.valid, false);
    assert(validation.evidence.errors.length > 0);
    assert(validation.evidence.errors.every((error) => error.startsWith(oldA + ":")), JSON.stringify(validation.evidence));
    const calls = experiment.entered.length;
    await runEvaluation({ ...experiment.options, discoverInputs: true });
    assert.equal(experiment.entered.length, calls);
    assert.deepEqual(await formalRows(experiment.run), rows);
  } finally { await experiment.worker.close(); await rm(experiment.directory, { recursive: true, force: true }); }
});
