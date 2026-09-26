import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { emptyUsage, type PlannedTask, type SubmissionReceipt, type TaskPlan } from "@eval/contracts";
import {
  buildPlan,
  comparisonRow,
  createResultWriter,
  reportRun,
  writeRunState,
} from "@eval/workflows/comparison";
import type { ComparisonResult, TaskData } from "@eval/workflows/comparison";
import { validateEvaluation } from "../../fixtures/services.js";
import { attributionResult, emptyAudit, fakeIdentity, fixtureConfig, raw } from "../../fixtures/comparison.js";

function comparisonTask(plan: TaskPlan): PlannedTask {
  return plan.tasks.find((task) => task.stage === "comparison")!;
}
function attributionReceipts(task: PlannedTask, correct = true): Map<string, SubmissionReceipt> {
  const receipts = new Map<string, SubmissionReceipt>();
  for (const [label, id] of Object.entries(task.dependencies))
    receipts.set(id, {
      taskId: id,
      attemptId: `a-${label}`,
      submissionId: randomUUID(),
      evaluation: attributionResult(correct, "2+2=4", false),
      audit: emptyAudit(),
      usage: emptyUsage(),
      status: "succeeded",
      acceptedAt: 0,
    });
  return receipts;
}
function group(labels: string[], meets: Record<string, boolean> = {}): ComparisonResult {
  return {
    task_analysis: {
      task_type: "整数加法",
      goal: "计算2+2",
      requirements: ["给出正确的加法结果"],
      scoring_points: ["使用指定操作数"],
      red_flags: ["擅自替换操作数"],
    },
    ranking: [labels],
    assessments: Object.fromEntries(
      labels.map((label) => [label, { meets_core: meets[label] ?? true, summary: "结论。" }]),
    ),
    decision_basis: {
      tradeoff: "并列。",
      decisive_findings: labels.map((label) => ({ candidate: label, finding_index: 0 })),
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
      labels = Object.keys((task.data as TaskData).candidates),
      receipts = attributionReceipts(task),
      names = Object.fromEntries(config.inputs.versions.map((v) => [v.id, v.display_name || v.name])),
      pairKey = "a_fast__vs__aa_fast";

    const oneSided = group(labels, { [labels[0]!]: true, [labels[1]!]: false });
    const win = comparisonRow(plan.inputs, task, oneSided, receipts, names);
    const winVerdict = (win.verdicts as Record<string, { result: string; winner_version: string }>)[
      pairKey
    ]!;
    assert.equal(winVerdict.result, "win");
    assert.equal(winVerdict.winner_version, "a_fast");

    const nearMiss = group(labels);
    nearMiss.ranking = [[labels[0]!], [labels[1]!]];
    const tiered = comparisonRow(plan.inputs, task, nearMiss, receipts, names);
    assert.equal(
      (tiered.verdicts as Record<string, { result: string; winner_version: string }>)[pairKey]!.result,
      "win",
    );

    const allBad = comparisonRow(
      plan.inputs,
      task,
      group(labels, Object.fromEntries(labels.map((label) => [label, false]))),
      receipts,
      names,
    );
    assert.equal((allBad.verdicts as Record<string, { result: string }>)[pairKey]!.result, "both_bad");

    const even = comparisonRow(plan.inputs, task, group(labels), receipts, names);
    assert.equal((even.verdicts as Record<string, { result: string }>)[pairKey]!.result, "both_good");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("report aggregates rankings and derived verdicts", async () => {
  const { directory, config } = await fixtureConfig([[raw()], [], [raw()], []]);
  try {
    const plan = await buildPlan(config),
      task = comparisonTask(plan),
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
    state.receipts[task.id] = {
      taskId: task.id,
      attemptId: "cmp",
      submissionId: randomUUID(),
      evaluation: group(labels),
      audit: emptyAudit(),
      usage: emptyUsage(),
      status: "succeeded",
      acceptedAt: 0,
    };
    await createResultWriter(run, plan.inputs)(state);
    await writeRunState(run, state);
    const summary = await reportRun(run);
    assert.equal(summary.completed_comparisons, 1);
    const standings = summary.standings as Record<string, { entered: number; first_tier: number }>;
    assert.equal(standings.a_fast!.entered, 1);
    assert.equal(standings.aa_fast!.entered, 1);
    assert.equal(standings.a_fast!.first_tier, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
