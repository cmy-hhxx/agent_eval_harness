import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { AgentBackend, JsonObject } from "@eval/contracts";
import { readJsonl, writeJsonl } from "@eval/data";
import { startWorker } from "@eval/runtime/worker";
import { runEvaluation } from "@eval/host";
import { buildPlan, reportRun, readRunState } from "@eval/workflows/comparison";
import type { TaskData } from "@eval/workflows/comparison";
import { services, validateRun } from "../../fixtures/services.js";
import { draftFor, fakeEvaluatorVersion, fakeIdentity, fixtureConfig, taskResult } from "../../fixtures/comparison.js";

async function rows(file: string): Promise<JsonObject[]> {
  const result: JsonObject[] = [];
  for await (const row of readJsonl(file)) result.push(row as JsonObject);
  return result;
}

test("rewrite polishes conclusions into commentary without touching formal results", async () => {
  const { directory, config, modelForStage } = await fixtureConfig(undefined, true);
  let calls = 0;
  const backend: AgentBackend = {
    identity: fakeIdentity,
    async createSession(options) {
      return {
        async run() {
          calls++;
          const result = await options.execute(
            "submit_evaluation",
            draftFor(options.spec, taskResult(options.spec)),
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
    assert.equal(plan.summary.rewrite_tasks, 3);
    assert.deepEqual(
      plan.tasks.map((task) => task.stage).sort(),
      ["attribution", "attribution", "comparison", "rewrite", "rewrite", "rewrite"],
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
    assert.equal(calls, 6);
    const run = path.join(config.output.path, "rewrite");

    // Formal results keep the judge wording; polish never rewrites accepted verdicts.
    const comparisons = await rows(path.join(run, "results", "comparison.jsonl"));
    assert.equal(comparisons.length, 1);
    assert.equal(
      (comparisons[0]!.assessments as Record<string, { summary: string }>).a_fast!.summary,
      "正确给出了结果。",
    );
    assert(!JSON.stringify(comparisons[0]).includes("精简："));
    const attributions = await rows(path.join(run, "results", "attribution.jsonl"));
    assert.equal(attributions.length, 2);
    for (const row of attributions) assert(!JSON.stringify(row).includes("精简："));

    // Commentary is a first-class artifact joined to the source result by business id.
    const commentary = await rows(path.join(run, "results", "commentary.jsonl"));
    assert.equal(commentary.length, 3);
    assert.deepEqual(
      [...new Set(commentary.map((row) => row.commentary_type))].sort(),
      ["attribution", "comparison"],
    );
    const comparisonCommentary = commentary.find((row) => row.commentary_type === "comparison")!;
    assert.equal(comparisonCommentary.source_result_id, comparisons[0]!.comparison_id);
    const comparisonRewrites = comparisonCommentary.rewrites as { id: string; text: string }[];
    assert(comparisonRewrites.some((item) => item.id === "tradeoff"));
    assert(comparisonRewrites.some((item) => item.id === "assessment.A.summary"));
    assert(comparisonRewrites.some((item) => /^verdict\..+\.reason$/.test(item.id)));
    assert(comparisonRewrites.every((item) => item.text.startsWith("精简：")));
    const attributionCommentary = commentary.filter((row) => row.commentary_type === "attribution");
    assert.deepEqual(
      [attributionCommentary.map((row) => row.source_result_id)].flat().sort(),
      attributions.map((row) => row.task_id).sort(),
    );

    // Reports prefer polished text; formal artifacts stay raw.
    const taskSummaries = await readFile(path.join(run, "task_summaries.md"), "utf8");
    assert(taskSummaries.includes("精简：正确给出了结果。"));
    assert(!(await readFile(path.join(run, "results", "comparison.jsonl"), "utf8")).includes("精简："));
    assert.deepEqual((summary.artifacts as { results: string[] }).results, [
      "results/attribution.jsonl",
      "results/comparison.jsonl",
      "results/commentary.jsonl",
    ]);

    // State and offline validation round-trip the rewrite receipts.
    const state = await readRunState(run);
    const rewriteTasks = state.manifest.tasks.filter((task) => task.stage === "rewrite");
    assert.equal(rewriteTasks.length, 3);
    for (const task of rewriteTasks) {
      const evaluation = state.receipts[task.id]!.evaluation as { rewrites: unknown[] };
      assert(evaluation.rewrites.length > 0);
      assert.equal((task.data as TaskData).rewriteOf!.taskId, task.dependencies.source);
    }
    assert.equal((await validateRun(run)).valid, true);
    const commentaryFile = path.join(run, "results", "commentary.jsonl");
    await writeJsonl(commentaryFile, [
      { ...commentary[0], evaluator_version: "wrong" }, ...commentary.slice(1),
    ]);
    await assert.rejects(readRunState(run), /结果评测器版本与收据不一致/);
    await writeJsonl(commentaryFile, commentary);

    // Resume keeps accepted polish and does not call the model again.
    await runEvaluation({ ...options, plan: { tasks: [], inputs: {}, summary: {} } });
    assert.equal(calls, 6);
    assert.equal((await reportRun(run)).completed_comparisons, 1);

    // Disabling rewrite on resume keeps accepted commentary and stops planning pending polish.
    config.rewrite = { comparison: false, attribution: false };
    await runEvaluation({ ...options, plan: { tasks: [], inputs: {}, summary: {} } });
    assert.equal(calls, 6);
    const disabled = await readRunState(run);
    assert.equal(disabled.manifest.tasks.filter((task) => task.stage === "rewrite").length, 3);
    assert.equal((await validateRun(run)).valid, true);
  } finally {
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  }
});
