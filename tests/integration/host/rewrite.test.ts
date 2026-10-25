import { canonicalEvidence } from "../../fixtures/evidence.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, readdir } from "node:fs/promises";
import path from "node:path";
import { object, type AgentBackend, type JsonObject, type EvaluationLog } from "@eval/contracts";
import { readJsonl, writeJsonl } from "@eval/data";
import { startWorker } from "@eval/runtime/worker";
import { runEvaluation } from "@eval/host";
import { buildPlan, reportRun, readRunState, readRunTasks, readCaseDetail, readTaskResult, stageResult, prepareComparisonRewrites } from "@eval/workflows/comparison";
import type { TaskData, AttributionResult } from "@eval/workflows/comparison";
import { services, validateRun } from "../../fixtures/services.js";
import { submitFor, inspectFor, draftFor, fakeEvaluatorVersion, fakeIdentity, fixtureConfig, taskResult, parsedMaterial, raw, attributionResult } from "../../fixtures/comparison.js";

async function rows(file: string): Promise<JsonObject[]> {
  const result: JsonObject[] = [];
  for await (const row of readJsonl(file)) result.push(row as JsonObject);
  return result;
}

for (const clustering of [false, true]) test(`rewrite embeds named text in stage outputs (clustering: ${clustering})`, async () => {
  const { directory, config, modelForStage } = await fixtureConfig(
    clustering ? Array.from({ length: 4 }, () => [raw("q1", "4", "2+2=5")]) : undefined, true, clustering,
  );
  const initialRewrites = clustering ? 5 : 3;
  const expectedCalls = clustering ? 17 : 13;
  const expectedRewrites = clustering ? 9 : 7;
  let calls = 0;
  const logged: EvaluationLog[] = [];
  const backend: AgentBackend = {
    identity: fakeIdentity,
    async createSession(options) {
      return {
        async run() {
          await inspectFor(options);
          calls++;
          if (options.spec.evaluation.id === "rewrite") {
            const input = parsedMaterial(options.spec) as { case?: Record<string, unknown>; items: { label: string; text: string }[] };
            if (input.case) assert.deepEqual(Object.keys(input.case).sort(), ["batch_id", "case_id"]);
            assert(!input.items.some((item) => /候选[A-Z]/.test(item.label + item.text)));
          }
          const evaluation = taskResult(options.spec);
          if (options.spec.evaluation.id === "rewrite")
            for (const item of (evaluation as { rewrites: { text: string }[] }).rewrites) item.text += `（润色${calls}）`;
          if (clustering && options.spec.evaluation.id === "attribution") {
            const attribution = evaluation as AttributionResult;
            const material = parsedMaterial(options.spec) as { answer: { final_message_index: number; final_answer: string } };
            const evidence = [canonicalEvidence(options.spec.inputs.find(input => input.name === "answer")!.id, material.answer.final_message_index, material.answer.final_answer)];
            attribution.is_correct = false;
            attribution.correct_reason = "最终结果5与标准结果4不符。";




            attribution.summary = "最终加法结果错误。";
            attribution.Problem = attributionResult(false, material.answer.final_answer, true, options.spec.inputs.find(input => input.name === "answer")!.id).Problem;
            const finding = attribution.Problem[0]!;

            finding.evidence = evidence.map(e=>({...e,purposes:["问题"]}));
            finding.text = "加法结果错误";
            finding.reason = "原文给出5，正确结果应为4。";

            finding.reason = "唯一所求结果错误，未完成计算要求。";
            Object.assign(finding, { ...attributionResult(false, material.answer.final_answer, true,
              options.spec.inputs.find(input => input.name === "answer")!.id).Problem[0]!,
              text: "计算错误", reason: "计算与事实不符。" });
          }
          const result = await submitFor(options, draftFor(options.spec, evaluation));
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
    assert.equal(plan.summary.rewrite_tasks, initialRewrites, "attribution groups expand only after their source is accepted");
    assert.deepEqual(
      plan.tasks.map((task) => task.stage).sort(),
      ["criteria", "attribution", "attribution", "comparison", "rewrite", "rewrite", "rewrite", ...(clustering ? ["clustering", "clustering", "rewrite", "rewrite"] : [])].sort(),
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
      clustering ? "关键结果错误。" : "正确给出了结果。",
    );
    const attributions = await rows(path.join(run, "results", "attribution.jsonl"));
    assert.equal(attributions.length, 2);
    const comparisonTask = plan.tasks.find((task) => task.stage === "comparison" && !(task.data as TaskData).verificationAudit)!;
    const dashboard = (await readTaskResult(run, comparisonTask.id))!.result!;
    const evaluations = dashboard.evaluations as Record<string, JsonObject>;
    for (const attribution of attributions) {
      const version = String(object(attribution.meta).version);
      const source = attribution as JsonObject;
      const formalEvidence = (source.Problem as AttributionResult['Problem']).flatMap(problem=>problem.evidence);
      assert(formalEvidence.every(item=>item.evidence_id.startsWith('ev_')));
      assert.deepEqual((evaluations[version].Problem as AttributionResult['Problem']).flatMap(problem=>problem.evidence),formalEvidence);
      const rewritten = object(evaluations[version].meta).rewritten as {rewrites:{path:string;text:string}[]};
      assert(rewritten.rewrites.some(item=>item.path==='summary'&&item.text.startsWith('精简：')));
    }
    const detail = (await readCaseDetail(run, "b1", "q1"))!;
    assert.equal(detail.tasks.find((task) => task.id === comparisonTask.id)!.rewrite_submission_ids.length, 7,
      "comparison includes its own rewrite and all three accepted rewrite groups from each attribution");
    for (const row of [...comparisons, ...attributions]) {
      const rewritten = object(stageResult(Object.hasOwn(row,"Problem") ? "attribution" : "comparison", row).meta).rewritten as { rewrites: { id: string; text: string }[] };
      assert(rewritten, "source result must contain rewritten");
      assert(rewritten.rewrites.every((item) => item.id.startsWith("verdict.") ? /^(?:(?:双方都好|双方都差)(?:；相对更倾向[^：]+)?|.+更好)：/.test(item.text) : item.text.startsWith("精简：")));
      assert(!rewritten.rewrites.some((item) => /候选[A-Z]|(?<![A-Za-z])[AB](?![A-Za-z]|组)/u.test(item.text)));
    }
    if (clustering) {
      const clustered = await rows(path.join(run, "results", "clustering.jsonl"));
      assert.equal(clustered.length, 2);
      for (const row of clustered) {
        const result = row.result as { new_classes: { label: string }[]; rewritten: { rewrites: { text: string }[] } };
        assert.equal(result.new_classes[0]!.label, "计算错误");
        assert.equal(result.rewritten.rewrites.length, 3);
        assert(result.rewritten.rewrites.every((item) => item.text.startsWith("精简：")));
        assert(!Object.hasOwn(row, "rewritten"));
      }
    }
    assert(!(await readdir(path.join(run, "results"))).includes("commentary.jsonl"));
    const taskSummaries = await readFile(path.join(run, "task_summaries.md"), "utf8");
    assert(taskSummaries.includes(clustering ? "关键结果错误。" : "正确给出了结果。"));
    assert.deepEqual((summary.artifacts as { results: string[] }).results, [
      "results/attribution.jsonl", "results/criteria.jsonl", "results/comparison.jsonl", ...(clustering ? ["results/clustering.jsonl"] : []),
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

    // Refresh one field, preserving other existing presentation text and every judge receipt.
    const existing = await readRunState(run);
    const cmp = existing.receipts[comparisonTask.id]!;
    const cmpRewrite = existing.manifest.tasks.find((task) => task.stage === "rewrite" && (task.data as TaskData).rewriteOf?.taskId === comparisonTask.id)!;
    const originalPolish = structuredClone(existing.receipts[cmpRewrite.id]!);
    const prior = await rows(comparisonFile);
    const originalJudge = structuredClone(cmp.evaluation);
    const preferenceRefresh = await prepareComparisonRewrites(run, { scope: "verdicts", mode: "refresh", all: true, apply: true });
    assert.equal(preferenceRefresh.count, 1);
    const preferenceRewriteId = preferenceRefresh.selected[0]!.rewrite_task_id!;
    assert.notEqual(preferenceRewriteId, cmpRewrite.id);
    assert.deepEqual((await readRunState(run)).receipts[cmpRewrite.id]!.evaluation, originalPolish.evaluation);
    await runEvaluation({ ...options, evaluatorVersion: "refreshed-polish", plan: { tasks: [], inputs: {}, summary: {} } });
    assert.equal(calls, expectedCalls + 1, "only one rewrite executes; accepted judgments stay accepted");
    const refreshed = await readRunState(run);
    assert.deepEqual(refreshed.receipts[comparisonTask.id]!.evaluation, originalJudge);
    const newRows = await rows(comparisonFile);
    const oldSlot = (prior[0]!.rewritten as any).rewrites.find((item: any) => item.id.startsWith("verdict."));
    const newSlot = (newRows[0]!.rewritten as any).rewrites.find((item: any) => item.id.startsWith("verdict."));
    assert.notEqual(newSlot.text, oldSlot.text);
    oldSlot.text = newSlot.text;
    (prior[0]!.rewritten as JsonObject).evaluator_version = "refreshed-polish";
    assert.deepEqual(newRows[0], prior[0], "only the requested verdict reason changes");
    assert.equal((refreshed.receipts[cmpRewrite.id]!.evaluation as any).rewrites.length, 1);
    assert.deepEqual(refreshed.receipts[cmpRewrite.id]!.evaluation, originalPolish.evaluation);
    assert.equal(refreshed.receipts[cmpRewrite.id]!.evaluatorVersion, originalPolish.evaluatorVersion);
    assert((await readFile(path.join(run, "task_summaries.md"), "utf8")).includes(newSlot.text), "reports prefer the latest accepted presentation");
    const refreshedCheckpoint = JSON.parse(await readFile(path.join(run, "state.json"), "utf8"));
    assert.equal(refreshedCheckpoint.tasks[cmpRewrite.id].receipt.evaluation, undefined);
    assert.equal(refreshedCheckpoint.tasks[preferenceRewriteId].receipt.evaluation, undefined);
    assert.equal(refreshedCheckpoint.tasks[preferenceRewriteId].receipt.evaluationPatch, undefined, "latest text is read from JSONL");
    assert.deepEqual(refreshedCheckpoint.tasks[cmpRewrite.id].receipt.evaluationPatch,
      [{ path: ["rewrites", "0", "text"], value: (originalPolish.evaluation as any).rewrites[0].text }],
      "the compact checkpoint retains exactly the overridden historical text");
    const refreshedValidation = await validateRun(run);
    assert.equal(refreshedValidation.valid, true, JSON.stringify(refreshedValidation));

    // Refresh overall and checklist prose while the accepted raw cells remain immutable.
    const beforeItems = structuredClone(newRows);
    const itemRefresh = await prepareComparisonRewrites(run, { scope: "items", mode: "refresh", all: true, apply: true });
    assert.equal(itemRefresh.count, 1);
    const itemRewriteId = itemRefresh.selected[0]!.rewrite_task_id!;
    await runEvaluation({ ...options, evaluatorVersion: "refreshed-items", plan: { tasks: [], inputs: {}, summary: {} } });
    assert.equal(calls, expectedCalls + 2);
    const afterItems = await rows(comparisonFile);
    const proseIds = new Set(["assessment.A.summary", "assessment.B.summary", "tradeoff",
      ...Array.from({length: 5}, (_, index) => [`comparison.${index}.A.summary`, `comparison.${index}.B.summary`]).flat()]);
    const prose = (afterItems[0]!.rewritten as any).rewrites.filter((item: any) => proseIds.has(item.id));
    assert.equal(prose.length, 13);
    assert(prose.every((item: any) => item.text.startsWith("精简：")));
    assert((afterItems[0]!.rewritten as any).rewrites.some((item: any) => item.id.startsWith("comparison.")));
    assert.deepEqual(afterItems[0]!.decision_basis, beforeItems[0]!.decision_basis);
    (afterItems[0]!.rewritten as any).rewrites = (afterItems[0]!.rewritten as any).rewrites.filter((item: any) => !proseIds.has(item.id));
    (beforeItems[0]!.rewritten as JsonObject).evaluator_version = "refreshed-items";
    assert.deepEqual(afterItems, beforeItems, "only selected display prose is added");
    const itemState = await readRunState(run);
    assert.deepEqual(itemState.receipts[comparisonTask.id]!.evaluation, originalJudge);
    assert.equal((itemState.manifest.tasks.find((task) => task.id === itemRewriteId)!.data as TaskData).comparisonRewriteScope, "items");
    assert.equal((itemState.manifest.tasks.find((task) => task.id === cmpRewrite.id)!.data as TaskData).comparisonRewriteScope,
      (cmpRewrite.data as TaskData).comparisonRewriteScope, "historical task keeps its original scope");
    assert.equal((await validateRun(run)).valid, true);
    await runEvaluation({ ...options, plan: { tasks: [], inputs: {}, summary: {} } });
    assert.equal(calls, expectedCalls + 2, "accepted overall rewrites are not rerun");

    // Disabling rewrite on resume keeps accepted commentary and stops planning pending polish.
    config.rewrite = { comparison: false, attribution: false, clustering: false };
    await runEvaluation({ ...options, plan: { tasks: [], inputs: {}, summary: {} } });
    assert.equal(calls, expectedCalls + 2);
    const disabled = await readRunState(run);
    assert.equal(disabled.manifest.tasks.filter((task) => task.stage === "rewrite").length, expectedRewrites + 2);
    assert.equal((await validateRun(run)).valid, true);
  } finally {
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  }
});
