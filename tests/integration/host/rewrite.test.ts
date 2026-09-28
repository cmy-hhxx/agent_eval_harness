import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, readdir } from "node:fs/promises";
import path from "node:path";
import type { AgentBackend, JsonObject, EvaluationLog } from "@eval/contracts";
import { readJsonl, writeJsonl } from "@eval/data";
import { startWorker } from "@eval/runtime/worker";
import { runEvaluation } from "@eval/host";
import { buildPlan, reportRun, readRunState, readRunTasks, readCaseDetail, readTaskResult, stageResult } from "@eval/workflows/comparison";
import type { TaskData, AttributionResult } from "@eval/workflows/comparison";
import { services, validateRun } from "../../fixtures/services.js";
import { draftFor, fakeEvaluatorVersion, fakeIdentity, fixtureConfig, taskResult, parsedMaterial } from "../../fixtures/comparison.js";

async function rows(file: string): Promise<JsonObject[]> {
  const result: JsonObject[] = [];
  for await (const row of readJsonl(file)) result.push(row as JsonObject);
  return result;
}

for (const clustering of [false, true]) test(`rewrite embeds named text in stage outputs (clustering: ${clustering})`, async () => {
  const { directory, config, modelForStage } = await fixtureConfig(undefined, true, clustering);
  const expectedCalls = clustering ? 10 : 6;
  const expectedRewrites = clustering ? 5 : 3;
  let calls = 0;
  const logged: EvaluationLog[] = [];
  const backend: AgentBackend = {
    identity: fakeIdentity,
    async createSession(options) {
      return {
        async run() {
          calls++;
          if (options.spec.evaluation.id === "rewrite") {
            const input = parsedMaterial(options.spec) as { case?: Record<string, unknown>; items: { label: string; text: string }[] };
            if (input.case) assert.deepEqual(Object.keys(input.case).sort(), ["batch_id", "case_id"]);
            assert(!input.items.some((item) => /候选[A-Z]/.test(item.label + item.text)));
          }
          const evaluation = taskResult(options.spec);
          if (clustering && options.spec.evaluation.id === "attribution") {
            const finding = (evaluation as AttributionResult).findings[0]!;
            finding.type = "problem";
            finding.problem = { component: "模型自身推理", label: "计算错误", definition: "计算与事实不符。" };
          }
          const result = await options.execute(
            "submit_evaluation",
            draftFor(options.spec, evaluation),
          );
          assert.equal(result.isError, undefined, JSON.stringify(result));
        },
        async abort() {},
        async dispose() {},
      };
    },
  };
  const worker = await startWorker(backend, path.join(directory, "worker"));
  try {
    const plan = await buildPlan(config);
    assert.equal(plan.summary.rewrite_tasks, expectedRewrites);
    assert.deepEqual(
      plan.tasks.map((task) => task.stage).sort(),
      ["attribution", "attribution", "comparison", "rewrite", "rewrite", "rewrite", ...(clustering ? ["clustering", "clustering", "rewrite", "rewrite"] : [])].sort(),
    );
    for (const task of plan.tasks.filter((task) => task.stage === "rewrite")) {
      assert.deepEqual(task.inputIds, {}, "rewrite tasks must not fetch input material");
      assert.equal(task.dependencies.source, (task.data as TaskData).rewriteOf!.taskId);
    }
    const options = {
      runId: "rewrite",
      output: config.output,
      engine: "pi" as const,
      identity: fakeIdentity,
      evaluatorVersion: fakeEvaluatorVersion,
      config,
      ...services,
      logger: { error: async () => {}, evaluation: async (record: EvaluationLog) => { logged.push(record); return true; } },
      plan,
      policy: config.execution,
      modelForStage,
      concurrency: 2,
      retries: 0,
      retryDelaySeconds: 0,
      workerUrls: [worker.url],
    };
    const summary = await runEvaluation(options);
    assert.equal(summary.completed_comparisons, 1);
    assert.equal(calls, expectedCalls);
    assert(!logged.some((row) => row.stage === "rewrite"));
    const run = path.join(config.output.path, "rewrite");

    // Formal results keep the judge wording; polish never rewrites accepted verdicts.
    const comparisons = await rows(path.join(run, "results", "comparison.jsonl"));
    assert.equal(comparisons.length, 1);
    assert.equal(
      (comparisons[0]!.assessments as Record<string, { summary: string }>).a_fast!.summary,
      "正确给出了结果。",
    );
    const attributions = await rows(path.join(run, "results", "attribution.jsonl"));
    assert.equal(attributions.length, 2);
    const comparisonTask = plan.tasks.find((task) => task.stage === "comparison")!;
    const dashboard = (await readTaskResult(run, comparisonTask.id))!.result!;
    const evaluations = dashboard.evaluations as Record<string, JsonObject>;
    for (const attribution of attributions) {
      const version = String(attribution.version);
      const source = attribution.evaluation as JsonObject;
      assert.deepEqual(evaluations[version].task_analysis, source.task_analysis);
      assert.deepEqual(evaluations[version].correctness_evidence, source.correctness_evidence);
      const rewritten = evaluations[version].rewritten as { rewrites: { path: string; text: string }[] };
      assert(rewritten.rewrites.some((item) => item.path === "findings.0.text" && item.text.startsWith("精简：")));
    }
    const detail = (await readCaseDetail(run, "b1", "q1"))!;
    assert.equal(detail.tasks.find((task) => task.id === comparisonTask.id)!.rewrite_submission_ids.length, 3,
      "comparison refreshes when its own or either attribution rewrite is accepted");
    for (const row of [...comparisons, ...attributions]) {
      const rewritten = stageResult(row.evaluation_type === "attribution" ? "attribution" : "comparison", row).rewritten as { rewrites: { id: string; text: string }[] };
      assert(rewritten, "source result must contain rewritten");
      assert(rewritten.rewrites.every((item) => item.text.startsWith("精简：")));
      assert(!rewritten.rewrites.some((item) => /候选[A-Z]|(?<![A-Za-z])[AB](?![A-Za-z]|组)/u.test(item.text)));
    }
    if (clustering) {
      const clustered = await rows(path.join(run, "results", "clustering.jsonl"));
      assert.equal(clustered.length, 2);
      for (const row of clustered) {
        const result = row.result as { new_classes: { label: string }[]; rewritten: { rewrites: { text: string }[] } };
        assert.equal(result.new_classes[0]!.label, "计算错误");
        assert.equal(result.rewritten.rewrites.length, 2);
        assert(result.rewritten.rewrites.every((item) => item.text.startsWith("精简：")));
        assert(!Object.hasOwn(row, "rewritten"));
      }
    }
    assert(!(await readdir(path.join(run, "results"))).includes("commentary.jsonl"));
    const taskSummaries = await readFile(path.join(run, "task_summaries.md"), "utf8");
    assert(taskSummaries.includes("精简：正确给出了结果。"));
    assert.deepEqual((summary.artifacts as { results: string[] }).results, [
      "results/attribution.jsonl", "results/comparison.jsonl", ...(clustering ? ["results/clustering.jsonl"] : []),
    ]);

    // State and offline validation round-trip the rewrite receipts.
    const state = await readRunState(run);
    const rewriteTasks = state.manifest.tasks.filter((task) => task.stage === "rewrite");
    assert.equal(rewriteTasks.length, expectedRewrites);
    for (const task of rewriteTasks) {
      const evaluation = state.receipts[task.id]!.evaluation as { rewrites: unknown[] };
      assert(evaluation.rewrites.length > 0);
      assert.equal((task.data as TaskData).rewriteOf!.taskId, task.dependencies.source);
    }
    assert(!(await readFile(path.join(run, "state.json"), "utf8")).includes("精简："));
    const selected = await readRunTasks(run, [rewriteTasks[0]!.id]);
    assert.deepEqual(selected.receipts[rewriteTasks[0]!.id]!.evaluation, state.receipts[rewriteTasks[0]!.id]!.evaluation);
    assert.equal((await validateRun(run)).valid, true);
    const comparisonFile = path.join(run, "results", "comparison.jsonl");
    await writeJsonl(comparisonFile, [{ ...comparisons[0], rewritten: {
      ...(comparisons[0]!.rewritten as JsonObject), evaluator_version: "wrong",
    } }]);
    await assert.rejects(readRunState(run), /结果评测器版本与收据不一致/);
    await writeJsonl(comparisonFile, comparisons);

    // Resume keeps accepted polish and does not call the model again.
    await runEvaluation({ ...options, plan: { tasks: [], inputs: {}, summary: {} } });
    assert.equal(calls, expectedCalls);
    assert.equal((await reportRun(run)).completed_comparisons, 1);

    // Disabling rewrite on resume keeps accepted commentary and stops planning pending polish.
    config.rewrite = { comparison: false, attribution: false, clustering: false };
    await runEvaluation({ ...options, plan: { tasks: [], inputs: {}, summary: {} } });
    assert.equal(calls, expectedCalls);
    const disabled = await readRunState(run);
    assert.equal(disabled.manifest.tasks.filter((task) => task.stage === "rewrite").length, expectedRewrites);
    assert.equal((await validateRun(run)).valid, true);
  } finally {
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  }
});
