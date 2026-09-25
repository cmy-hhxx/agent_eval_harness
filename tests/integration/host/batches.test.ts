import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { emptyUsage, type JsonObject, type RunState, type TaskPlan } from "@eval/contracts";
import { readJsonl, writeJsonl } from "@eval/data";
import { buildPlan } from "@eval/workflows/pairwise";
import { reportRun } from "@eval/workflows/pairwise";
import { readRunState, writeRunState } from "@eval/workflows/pairwise";
import type { BatchPreflight, EvalConfig, RawInput, TaskData } from "@eval/workflows/pairwise";
import { validateRun } from "../../fixtures/services.js";
import { emptyAudit, fakeIdentity, fixtureConfig, pairResult, raw } from "../../fixtures/pairwise.js";

const firstDay = "2026-09-23",
  secondDay = "2026-09-24";
function sample(batch: string, id = "q1", reference: unknown = null): RawInput {
  return { ...raw(id, reference), batch_id: batch };
}
function runState(config: EvalConfig, plan: TaskPlan): RunState {
  return {
    manifest: {
      format: "evaluation-run",
      debug: false,
      runId: "batches",
      status: "finished",
      engine: fakeIdentity,
      config,
      tasks: plan.tasks,
      inputs: {},
      states: Object.fromEntries(plan.tasks.map((task) => [task.id, { status: "pending", attempts: 0 }])),
      preflight: plan.summary,
      startedAt: 0,
      finishedAt: 1000,
    },
    receipts: {},
    usage: emptyUsage(),
    recordedAttempts: 0,
  };
}
function accept(state: RunState, id: string, evaluation: unknown) {
  state.manifest.states[id] = { status: "succeeded", attempts: 1 };
  state.recordedAttempts++;
  state.receipts[id] = {
    taskId: id,
    attemptId: id,
    submissionId: randomUUID(),
    evaluation,
    audit: emptyAudit(),
    usage: emptyUsage(),
    acceptedAt: 1,
    status: "succeeded",
  };
}
interface BatchStats {
  planned: {
    cases: number;
    tasks: number;
    skipped_pairs: number;
    input_issues: number;
  };
  completed_comparisons: number;
  task_statuses: Record<string, number>;
  pairs: Record<
    string,
    {
      evaluated: number;
      wins: Record<string, number>;
      both_good: number;
      both_bad: number;
    }
  >;
  per_version?: Record<string, { correct: number; incorrect: number; evaluated: number }>;
}

test("100 + 120 daily samples retain repeated questions through planning, export and validation", async () => {
  const rows = [
    [firstDay, 100],
    [secondDay, 120],
  ].flatMap(([batch, count]) =>
    Array.from({ length: Number(count) }, (_, index) =>
      sample(String(batch), `q${String(index).padStart(3, "0")}`),
    ),
  );
  const { directory, config } = await fixtureConfig([rows, rows, rows, rows]);
  try {
    const plan = await buildPlan(config);
    assert.equal(plan.summary.cases, 220);
    assert.equal(plan.summary.valid_inputs, 880);
    assert.equal(plan.tasks.length, 440);
    assert.equal(new Set(plan.tasks.map((task) => task.id)).size, 440);
    assert.equal(plan.summary.correctness_tasks, 0);
    assert.deepEqual(plan.summary.issues, []);
    assert.deepEqual(plan.summary.skipped, []);
    const batches = plan.summary.by_batch as Record<string, BatchPreflight>;
    assert.deepEqual(batches[firstDay], {
      cases: 100,
      valid_inputs: 400,
      correctness_tasks: 0,
      pairwise_tasks: 200,
      skipped_pairs: 0,
      input_issues: 0,
    });
    assert.deepEqual(batches[secondDay], {
      cases: 120,
      valid_inputs: 480,
      correctness_tasks: 0,
      pairwise_tasks: 240,
      skipped_pairs: 0,
      input_issues: 0,
    });
    for (const task of plan.tasks) {
      const data = task.data as TaskData;
      assert.equal(data.candidates.A.batch_id, data.candidates.B.batch_id);
    }
    for (const version of config.inputs.versions) await writeJsonl(version.path, [...rows].reverse());
    const reordered = await buildPlan(config, plan);
    assert.deepEqual(
      reordered.tasks.map(({ id, dependencies, inputIds }) => ({
        id,
        dependencies,
        inputIds,
      })),
      plan.tasks.map(({ id, dependencies, inputIds }) => ({
        id,
        dependencies,
        inputIds,
      })),
    );
    assert.deepEqual(reordered.summary, plan.summary);

    const state = runState(config, reordered),
      run = path.join(directory, "run");
    for (const task of plan.tasks) accept(state, task.id, pairResult());
    await writeRunState(run, state);
    const stats = await reportRun(run);
    assert.equal(stats.completed_comparisons, 440);
    assert.equal((stats.planned as JsonObject).cases, 220);
    const daily = stats.by_batch as Record<string, BatchStats>;
    assert.equal(daily[firstDay].completed_comparisons, 200);
    assert.equal(daily[secondDay].completed_comparisons, 240);
    assert.equal(daily[firstDay].planned.cases, 100);
    assert.equal(daily[secondDay].planned.cases, 120);
    assert.equal(daily[firstDay].pairs.a_fast__vs__aa_fast.both_good, 100);
    assert.equal(daily[secondDay].pairs.a_expert__vs__aa_expert.both_good, 120);
    const comparisonIds = new Set();
    for (const pair of ["a_fast__vs__aa_fast", "a_expert__vs__aa_expert"])
      for await (const row of readJsonl(path.join(run, "results", pair + ".jsonl")))
        comparisonIds.add((row as JsonObject).comparison_id);
    assert.equal(comparisonIds.size, 440);
    assert.equal((await validateRun(run)).valid, true);
    assert.deepEqual((await reportRun(run)).by_batch, daily);
    assert.equal((await validateRun(run)).valid, true);
    const markdown = await readFile(path.join(run, "task_summaries.md"), "utf8");
    assert(markdown.includes(`# ${firstDay} / q000`));
    assert(markdown.includes(`# ${secondDay} / q000`));
    const overview = await readFile(path.join(run, "report.md"), "utf8");
    assert(overview.includes(`| ${firstDay} | 100 | 200 | 200 |`));
    assert(overview.includes(`| ${secondDay} | 120 | 240 | 240 |`));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("batch and case selection preserve batch identities and apply one global case limit", async () => {
  const rows = [sample(firstDay), sample(firstDay, "q2"), sample(secondDay)];
  rows[0].meta!.request_time = "2026-09-24 23:59:59";
  rows[2].meta!.ask_time = 0;
  const { directory, config } = await fixtureConfig([rows, rows, rows, rows]);
  try {
    config.inputs.batches = [secondDay];
    let plan = await buildPlan(config);
    assert.equal(plan.tasks.length, 2);
    assert.deepEqual(Object.keys(plan.summary.by_batch as object), [secondDay]);
    config.inputs.batches = [firstDay, secondDay];
    config.inputs.case_ids = ["q1"];
    plan = await buildPlan(config);
    assert.equal(plan.tasks.length, 4);
    assert.equal(plan.summary.cases, 2);
    config.inputs.limit = 1;
    plan = await buildPlan(config);
    assert.equal(plan.tasks.length, 2);
    assert.deepEqual(Object.keys(plan.summary.by_batch as object), [firstDay]);
    assert.equal((plan.tasks[0].data as TaskData).candidates.A.batch_id, firstDay);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("references, invalid answers and identity conflicts stay within their input batch", async () => {
  const rows = [sample(firstDay, "q", "4"), sample(secondDay, "q", "5")];
  const invalid = sample(firstDay, "invalid");
  invalid.meta!.ok = false;
  const noBatch = raw("unknown", null);
  delete noBatch.batch_id;
  const { directory, config } = await fixtureConfig([
    [
      ...rows,
      sample(firstDay, "split"),
      sample(firstDay, "duplicate"),
      sample(firstDay, "duplicate"),
      invalid,
      noBatch,
    ],
    [],
    [...rows, sample(secondDay, "split"), sample(firstDay, "duplicate"), invalid],
    [],
  ]);
  try {
    await appendFile(config.inputs.versions[0].path, "not-json\n");
    const plan = await buildPlan(config);
    assert.equal(plan.tasks.length, 6);
    assert.equal(plan.summary.cases, 6);
    const pairs = plan.tasks.filter((task) => task.stage === "pairwise");
    assert.deepEqual(
      pairs.map((task) => (task.data as TaskData).reference),
      ["4", "5"],
    );
    for (const task of pairs)
      for (const id of Object.values(task.dependencies)) {
        const dependency = plan.tasks.find((check) => check.id === id)!;
        assert.equal(
          (dependency.data as TaskData).candidates.A.batch_id,
          (task.data as TaskData).candidates.A.batch_id,
        );
      }
    const issues = plan.summary.issues as JsonObject[];
    assert.equal(issues.filter((issue) => !issue.batch_id).length, 2);
    const duplicate = issues.find((issue) => String(issue.reason).includes("duplicate_input"))!;
    assert.equal(duplicate.batch_id, firstDay);
    assert.equal(duplicate.case_id, "duplicate");
    assert.deepEqual(duplicate.sources, [
      { source: config.inputs.versions[0].path, version: "a_fast", line: 4 },
      { source: config.inputs.versions[0].path, version: "a_fast", line: 5 },
    ]);
    const skipped = plan.summary.skipped as JsonObject[];
    const split = skipped.filter(
      (item) => item.case_id === "split" && (item.versions as string[]).includes("a_fast"),
    );
    assert.equal(split.length, 2);
    assert(
      split.every((item) => (item.sources as JsonObject[]).every((source) => source.source && source.line)),
    );
    const batches = plan.summary.by_batch as Record<string, BatchPreflight>;
    assert.equal(batches[firstDay].cases, 4);
    assert.equal(batches[firstDay].input_issues, 3);
    assert.equal(batches[secondDay].cases, 2);
    assert.equal(batches[secondDay].input_issues, 0);
    assert.equal(batches[firstDay].correctness_tasks, 2);
    assert.equal(batches[secondDay].correctness_tasks, 2);
    assert.equal(batches[firstDay].skipped_pairs + batches[secondDay].skipped_pairs, skipped.length);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("batch reports distinguish verdicts, correctness, failures, pending tasks and skipped inputs", async () => {
  const rows = [
    sample(firstDay, "objective", "4"),
    sample(firstDay, "good"),
    sample(secondDay, "objective", "4"),
    ...["bad", "unknown", "failed", "pending"].map((id) => sample(secondDay, id)),
  ];
  const { directory, config } = await fixtureConfig([[...rows, sample(secondDay, "missing")], [], rows, []]);
  try {
    const plan = await buildPlan(config),
      state = runState(config, plan),
      run = path.join(directory, "run");
    for (const task of plan.tasks) {
      const data = task.data as TaskData,
        candidate = data.candidates.A;
      if (candidate.case_id === "pending") continue;
      if (candidate.case_id === "failed") {
        state.manifest.states[task.id] = {
          status: "failed",
          attempts: 1,
          reason: "test failure",
        };
        continue;
      }
      if (task.stage === "correctness") {
        accept(state, task.id, {
          is_correct: candidate.batch_id === firstDay || candidate.version === "a_fast",
          correctness_reason: "独立核验结果。",
          evidence: [{ message_index: 1, quote: "2+2=4" }],
        });
        continue;
      }
      const result = pairResult();
      if (candidate.case_id === "unknown") result.verdict.result = "not_comparable";
      if (candidate.case_id === "bad") {
        result.verdict.result = "both_bad";
        for (const review of Object.values(result.evaluations)) {
          review.findings[0].type = "problem";
          review.findings[0].importance = "high";
        }
      }
      if (candidate.case_id === "objective" && candidate.batch_id === secondDay) {
        const winner = candidate.version === "a_fast" ? "A" : "B",
          loser = winner === "A" ? "B" : "A";
        result.verdict.result = winner === "A" ? "A_better" : "B_better";
        result.evaluations[loser].findings[0].type = "problem";
        result.evaluations[loser].findings[0].importance = "high";
      }
      accept(state, task.id, result);
    }
    await writeRunState(run, state);
    const stats = await reportRun(run),
      daily = stats.by_batch as Record<string, BatchStats>;
    assert.equal((stats.planned as JsonObject).cases, 8);
    assert.equal(stats.completed_comparisons, 4);
    assert.deepEqual(daily[firstDay].task_statuses, { succeeded: 4 });
    assert.deepEqual(daily[secondDay].task_statuses, {
      succeeded: 4,
      not_comparable: 1,
      failed: 1,
      pending: 1,
    });
    assert.equal(daily[firstDay].planned.cases, 2);
    assert.equal(daily[secondDay].planned.cases, 6);
    assert.equal(daily[firstDay].planned.skipped_pairs, 2);
    assert.equal(daily[secondDay].planned.skipped_pairs, 7);
    assert.equal(daily[firstDay].pairs.a_fast__vs__aa_fast.both_good, 2);
    assert.equal(daily[secondDay].pairs.a_fast__vs__aa_fast.both_bad, 1);
    assert.equal(daily[secondDay].pairs.a_fast__vs__aa_fast.wins.a_fast, 1);
    assert.equal(daily[firstDay].per_version!.aa_fast.correct, 1);
    assert.equal(daily[secondDay].per_version!.aa_fast.incorrect, 1);
    const markdown = await readFile(path.join(run, "task_summaries.md"), "utf8");
    for (const id of ["objective", "bad", "unknown", "failed", "pending"])
      assert(markdown.includes(`# ${secondDay} / ${id}`));
    assert(markdown.includes(`${secondDay} / missing`));
    assert.equal((await validateRun(run)).valid, true);
    assert.deepEqual((await reportRun(run)).by_batch, daily);
    const restored = await readRunState(run);
    assert.deepEqual(
      restored.manifest.tasks.map((task) => task.id),
      plan.tasks.map((task) => task.id),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
