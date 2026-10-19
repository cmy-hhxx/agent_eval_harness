import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { emptyUsage, type JsonObject, type PlannedTask, type SubmissionReceipt, type TaskPlan } from "@eval/contracts";
import {
  buildPlan,
  comparisonRow,
  createResultWriter,
  reportRun,
  writeRunState,
} from "@eval/workflows/comparison";
import type { ComparisonResult, TaskData } from "@eval/workflows/comparison";
import { validateEvaluation } from "../../fixtures/services.js";
import { attributionResult, emptyAudit, fakeEvaluatorVersion, fakeIdentity, fakeJudge, fixtureConfig, criteriaResult, raw } from "../../fixtures/comparison.js";
import { LocalAnalysisData } from "../../../apps/host/src/assistant-data.js";

function comparisonTask(plan: TaskPlan): PlannedTask {
  return plan.tasks.find((task) => task.stage === "comparison")!;
}
function attributionReceipts(task: PlannedTask, correct: boolean | Record<string, boolean> = true): Map<string, SubmissionReceipt> {
  const receipts = new Map<string, SubmissionReceipt>();
  for (const [label, id] of Object.entries(task.dependencies))
    receipts.set(id, {
      taskId: id,
      attemptId: `a-${label}`,
      submissionId: randomUUID(),
      evaluation: label === "criteria" ? criteriaResult() : attributionResult(typeof correct === "boolean" ? correct : correct[label] ?? true, "2+2=4", (task.data as TaskData).reference !== null, task.inputIds[label]),
      evaluatorVersion: fakeEvaluatorVersion,
      judge: fakeJudge,
      audit: emptyAudit(),
      usage: emptyUsage(),
      status: "succeeded",
      acceptedAt: 0,
    });
  return receipts;
}
function group(labels: string[], meets: Record<string, boolean> = {}): ComparisonResult {
  return {
    status: "decided", review_requests: [],
    task_analysis: criteriaResult(),
    ranking: [labels.filter((label) => meets[label] ?? true), labels.filter((label) => meets[label] === false)].filter((tier) => tier.length),
    assessments: Object.fromEntries(
      labels.map((label) => [label, { meets_core: meets[label] ?? true, core_failure_refs: meets[label] === false ? ["r1"] : [], summary: "结论。" }]),
    ),
    decision_basis: {
      tradeoff: "并列。",
      comparisons: [{ aspect: "计算结果", criterion_ids: ["r1"], importance: "high", better_candidates: [], assessments: Object.fromEntries(
        labels.map((label) => [label, { status: meets[label] === false ? "unmet" : "met", evidence_status: "established", summary: "给出计算结果。", finding_indices: [0] }]),
      ) }],
      decisive_findings: labels.some(label => meets[label] === false) && labels.some(label => meets[label] !== false)
        ? labels.map(label => ({ candidate: label, finding_index: 0 })) : [],
    },
  };
}

test("group comparison validation enforces a partition over the candidates", async () => {
  const { directory, config } = await fixtureConfig([[raw()], [], [raw()], []]);
  try {
    const plan = await buildPlan(config),
      task = comparisonTask(plan),
      labels = Object.keys((task.data as TaskData).candidates);
    assert.equal(labels.length, 2);
    const receipts = attributionReceipts(task);
    const dependencies = Object.fromEntries(
      Object.entries(task.dependencies).map(([label, id]) => [label, receipts.get(id)]),
    );
    const check = (result: ComparisonResult) =>
      validateEvaluation(task, plan.inputs, result, emptyAudit(), dependencies);
    check(group(labels));

    const duplicate = group(labels);
    duplicate.ranking = [[labels[0]!, labels[0]!]];
    assert.throws(() => check(duplicate), /重复/);

    const incomplete = group(labels);
    incomplete.ranking = [[labels[0]!]];
    assert.throws(() => check(incomplete), /恰好包含本组全部候选/);

    const missingAssessment = group(labels);
    delete missingAssessment.assessments[labels[1]!];
    assert.throws(() => check(missingAssessment), /每个候选/);

    const forged = group(labels);
    forged.decision_basis.decisive_findings = [{ candidate: labels[0]!, finding_index: 9 }];
    assert.throws(() => check(forged), /既有 finding/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("two-way verdicts are derived from ranking and core classification", async () => {
  const { directory, config } = await fixtureConfig([[raw()], [], [raw()], []]);
  try {
    const plan = await buildPlan(config),
      task = comparisonTask(plan),
      candidates = (task.data as TaskData).candidates,
      labels = Object.keys(candidates),
      receipts = attributionReceipts(task),
      names = Object.fromEntries(config.inputs.versions.map((v) => [v.id, v.display_name || v.name])),
      pairKey = "a_fast__vs__b_fast";

    const oneSided = group(labels, { [labels[0]!]: true, [labels[1]!]: false });
    const oneSidedReceipts = attributionReceipts(task, { [labels[0]!]: true, [labels[1]!]: false });
    validateEvaluation(task, plan.inputs, oneSided, emptyAudit(), Object.fromEntries(Object.entries(task.dependencies).map(([label, id]) => [label, oneSidedReceipts.get(id)])));
    const win = comparisonRow(plan.inputs, task, oneSided, oneSidedReceipts, names, fakeEvaluatorVersion);
    const winVerdict = (win.verdicts as Record<string, { result: string; winner_version: string }>)[
      pairKey
    ]!;
    assert.equal(winVerdict.result, "win");
    assert.equal(winVerdict.winner_version, candidates[labels[0]!].version);

    const nearMiss = group(labels);
    nearMiss.ranking = [[labels[0]!], [labels[1]!]];
    const tiered = comparisonRow(plan.inputs, task, nearMiss, receipts, names, fakeEvaluatorVersion);
    const tieredVerdict = (tiered.verdicts as Record<string, { result: string; winner_version: string }>)[pairKey]!;
    assert.equal(tieredVerdict.result, "win");
    assert.equal(tieredVerdict.winner_version, candidates[labels[0]!].version);

    const failed = group(labels, Object.fromEntries(labels.map((label) => [label, false])));
    failed.decision_basis.tradeoff = `双方都没答对，但候选${labels[0]}保留了正确操作数，比另一方替换操作数相对更好。`;
    const allBad = comparisonRow(
      plan.inputs,
      task,
      failed,
      attributionReceipts(task, false),
      names,
      fakeEvaluatorVersion,
    );
    assert.equal((allBad.verdicts as Record<string, { result: string }>)[pairKey]!.result, "both_bad");
    const badVerdict = (allBad.verdicts as Record<string, JsonObject>)[pairKey]!;
    assert.equal(badVerdict.winner_version, null);
    assert.equal(badVerdict.winner_name, null);
    assert.deepEqual(allBad.ranking, [labels.map((label) => candidates[label].version)]);
    assert.match((allBad.decision_basis as JsonObject).tradeoff as string, /相对更好/);

    const even = comparisonRow(plan.inputs, task, group(labels), receipts, names, fakeEvaluatorVersion);
    assert.equal((even.verdicts as Record<string, { result: string }>)[pairKey]!.result, "both_good");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("report preserves aligned comparison reasoning without reloading inputs", async () => {
  const first = raw(), second = raw();
  first.meta!.usage = { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 80 } };
  second.meta!.usage = { input_tokens: 1000, output_tokens: 200, cached_read_tokens: 400 };
  second.meta!.finish_answer_time_cost = 40000;
  const { directory, config } = await fixtureConfig([[first], [], [second], []]);
  try {
    const plan = await buildPlan(config),
      task = plan.tasks.find(item => item.stage === "comparison" && !(item.data as TaskData).verificationAudit)!,
      receipts = attributionReceipts(task),
      run = path.join(directory, "run"),
      labels = Object.keys((task.data as TaskData).candidates);
    const state = {
      manifest: {
        format: "evaluation-run" as const,
        debug: false,
        runId: "verdicts",
        status: "finished" as const,
        engine: fakeIdentity,
        evaluatorVersion: fakeEvaluatorVersion,
        config,
        tasks: plan.tasks,
        inputs: {},
        states: Object.fromEntries(
          plan.tasks.map((t) => [t.id, { status: "succeeded" as const, attempts: 0 }]),
        ),
        preflight: plan.summary,
        startedAt: 0,
        finishedAt: 1000,
      },
      receipts: Object.fromEntries(receipts) as Record<string, SubmissionReceipt>,
      usage: emptyUsage(),
      recordedAttempts: plan.tasks.length,
    };
    const evaluation = group(labels);
    const labelOf = new Map(Object.entries((task.data as TaskData).candidates).map(([label, candidate]) => [candidate.version, label]));
    evaluation.decision_basis.tradeoff = `内容质量：双方都正确给出4。完成耗时：候选${labelOf.get("a_fast")}为1.2秒，候选${labelOf.get("b_fast")}为40秒；总token：候选${labelOf.get("a_fast")}为120，候选${labelOf.get("b_fast")}为1200。`;
    state.receipts[task.id] = {
      taskId: task.id,
      attemptId: "cmp",
      submissionId: randomUUID(),
      evaluation,
      evaluatorVersion: fakeEvaluatorVersion,
      judge: fakeJudge,
      audit: emptyAudit(),
      usage: emptyUsage(),
      status: "succeeded",
      acceptedAt: 0,
    };
    await createResultWriter(run, plan.inputs)(state);
    const formalRows = (await readFile(path.join(run, "results", "comparison.jsonl"), "utf8")).trim().split("\n");
    assert.equal(formalRows.length, 1, "one accepted primary comparison enters formal results");
    await writeRunState(run, state);
    for (const version of config.inputs.versions)
      await rm(path.join(directory, version.id + ".jsonl"));
    const eris = new LocalAnalysisData(directory);
    eris.raw = async () => { throw new Error("Formal standings must not read original answer sources"); };
    const erisDirectory = await eris.list({ runId: "run", limit: 1 });
    assert(erisDirectory.kind === "inputs");
    assert(erisDirectory.summary.formalComparisonStats);
    assert.equal(erisDirectory.summary.formalComparisonStats.formalResultCount, 1);
    assert.equal(erisDirectory.summary.formalComparisonStats.comparisonCount, 1);
    assert.deepEqual(erisDirectory.summary.formalComparisonStats.tiers[0]!.outcomes, { win: 0, both_good: 1, both_bad: 0 });
    const erisResult = await eris.read({ runId: "run", taskId: task.id });
    assert.equal((erisResult.comparisonScope as { comparisonTier: string }).comparisonTier, "Fast");
    assert.deepEqual(erisResult.result, state.receipts[task.id]!.exported!.row, "the business scope does not replace or rewrite the full formal result");
    const summary = await reportRun(run);
    assert.equal(summary.completed_comparisons, 1);
    const standings = summary.standings as Record<string, { entered: number; core_decidable_count: number; meets_core: number }>;
    assert.equal(standings.a_fast!.entered, 1);
    assert.equal(standings.b_fast!.entered, 1);
    assert.equal(standings.a_fast!.core_decidable_count, 1);
    assert.equal(standings.a_fast!.meets_core, 1);
    const markdown = await readFile(path.join(run, "task_summaries.md"), "utf8");
    assert.match(markdown, /## 同项对比/);
    assert.match(markdown, /\| 比较点 \| 重要性 \|/);
    assert.match(markdown, /\| 计算结果 \| 高 \| 给出计算结果。 \| 给出计算结果。 \|/);
    assert.match(markdown, /内容质量：.*都正确给出4/);
    assert.match(markdown, /完成耗时：.*1.2秒.*40秒/);
    assert.match(markdown, /总token：.*120.*1200/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
