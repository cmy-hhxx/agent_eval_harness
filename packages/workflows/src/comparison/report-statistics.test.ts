import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { JsonObject, PlannedTask, TaskState } from "@eval/contracts";
import type { Candidate } from "../inputs/types.js";
import type { TaskData } from "./types.js";
import { summarizeResults, taskFailureSummary, writeOverview } from "./report.js";

const answer = (id: string, version: string, correct: boolean | null, batch = "day", caseId = "case", inputId = `${batch}:${caseId}:${version}`): JsonObject => ({
  task_id: id, version, input_id: inputId, batch_id: batch, case_id: caseId, is_correct: correct,
});
function source(row: JsonObject): PlannedTask {
  const candidate: Candidate = { batch_id: String(row.batch_id), case_id: String(row.case_id), version: String(row.version),
    name: String(row.version), input_id: String(row.input_id), trace_id: null, source: "/fixture/input.jsonl", line: 1,
    question: "问题", final_index: 1, reference: "答案", llm: null,
    answer_timing: { first_token_seconds: null, first_answer_seconds: null, finish_seconds: null, source_unit: "ms", source_values: {}, source_fields: {} },
  };
  return { id: String(row.task_id), stage: "attribution", inputIds: { answer: candidate.input_id }, dependencies: {},
    data: { stage: "attribution", candidates: { A: candidate }, reference: "答案" } satisfies TaskData };
}
function pair(first: string, second: string, core: [boolean, boolean], refs: [string, string],
  batch = "day", caseId = "case", winner: string | null = null): JsonObject {
  return { comparison_id: `${batch}:${caseId}:${first}:${second}`, case: { batch_id: batch, case_id: caseId },
    models: { [first]: {}, [second]: {} }, ranking: winner ? [[winner], [[first, second].find((id) => id !== winner)!]] : [[first, second]],
    assessments: { [first]: { meets_core: core[0] }, [second]: { meets_core: core[1] } },
    attribution_task_ids: { [first]: refs[0], [second]: refs[1] },
    verdicts: { [`${first}__vs__${second}`]: { result: winner ? "win" : core[0] ? "both_good" : "both_bad", winner_version: winner } },
  };
}
const summarize = (answers: JsonObject[], pairs: JsonObject[]) =>
  summarizeResults(answers.map(source), [], answers, pairs, [], []);

test("report separates failed attempts, blocked dependencies and cancelled tasks", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "report-statuses-"));
  const statuses = { succeeded: 4, failed: 6, timed_out: 5, blocked: 97, cancelled: 2, pending: 3, running: 1 };
  const totals = { ...summarize([], []), task_statuses: statuses,
    planned: { cases: 10, tasks: 118, skipped_groups: 0, input_issues: 0 } };
  try {
    await writeOverview(directory, { ...totals, run_id: "status-counts", status: "finished",
      evaluator_versions: ["test"], by_batch: { day: totals }, tokens: { totalTokens: 0 }, attempts_without_final_metrics: 0 });
    const report = await readFile(path.join(directory, "report.md"), "utf8");
    assert.match(report, /执行失败：11；依赖阻塞：97；已取消：2/);
    assert.match(report, /\| 失败 \| 依赖阻塞 \| 已取消 \| 待完成 \|/);
    assert.match(report, /\| day \| 10 \| 118 \| 0 \| 11 \| 97 \| 2 \| 4 \| 0 \| 0 \|/);
    assert.equal(statuses.blocked, 97);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("report surfaces comparison coverage and standard conflicts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "report-coverage-"));
  const totals = { ...summarize([], []), coverage: { planned: 43, decided: 40, pending: 1, incomplete: 2 },
    standard_conflicts: [{ batch_id: "day", case_id: "case", version: "a", task_id: "a" }] };
  try {
    await writeOverview(directory, { ...totals, run_id: "coverage", status: "finished", evaluator_versions: ["test"],
      by_batch: {}, tokens: { totalTokens: 0 }, attempts_without_final_metrics: 0 });
    const report = await readFile(path.join(directory, "report.md"), "utf8");
    assert.match(report, /比较覆盖：已决 40；待核 1；未完成 2（计划 43）。标准冲突待核：1 例（见 stats.json）。/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("two-model statistics preserve battle counts while separating answer identity across batches", () => {
  const answers = [answer("a1", "a", true, "first"), answer("b1", "b", true, "first"),
    answer("a2", "a", false, "second"), answer("b2", "b", false, "second")];
  const result = summarize(answers, [pair("a", "b", [true, true], ["a1", "b1"], "first"),
    pair("a", "b", [false, false], ["a2", "b2"], "second")]);
  assert.equal(result.planned.cases, 2);
  assert.deepEqual(result.head_to_head.a__vs__b, { evaluated: 2, wins: { a: 0, b: 0 }, both_good: 1, both_bad: 1 });
  for (const version of ["a", "b"]) {
    assert.deepEqual(result.per_version![version], { correct: 1, incorrect: 1, undetermined: 0, conflicted_count: 0,
      evaluated: 2, decidable_coverage: 1, accuracy_among_decidable: .5 });
    assert.equal(result.standings[version]!.entered, 2);
    assert.equal(result.standings[version]!.meets_core, 1);
    assert.equal(result.standings[version]!.meets_core_rate, .5);
  }
});

test("three independent pairs count two battles but one absolute core assessment for each answer", () => {
  const answers = [answer("a", "a", true), answer("b", "b", true), answer("c", "c", false)];
  const result = summarize(answers, [pair("a", "b", [true, true], ["a", "b"]),
    pair("a", "c", [true, false], ["a", "c"], "day", "case", "a"),
    pair("b", "c", [true, false], ["b", "c"], "day", "case", "b")]);
  assert.equal(result.completed_comparisons, 3);
  assert.deepEqual(Object.values(result.head_to_head).map((pair) => pair.evaluated), [1, 1, 1]);
  for (const version of ["a", "b", "c"]) {
    const standing = result.standings[version]!;
    assert.equal(standing.entered, 2);
    assert.equal(standing.core_case_count, 1);
    assert.equal(standing.core_decidable_count, 1);
    assert.equal(standing.meets_core, version === "c" ? 0 : 1);
    assert.equal(standing.meets_core_rate, version === "c" ? 0 : 1);
    assert.equal(result.per_version![version]!.evaluated, 1);
  }
});

test("formal attribution references select the accepted independent review without double-counting its source", () => {
  const answers = [answer("original", "a", false), answer("review", "a", true), answer("b", "b", true)];
  const result = summarize(answers, [pair("a", "b", [true, true], ["review", "b"])]);
  assert.deepEqual(result.per_version!.a, { correct: 1, incorrect: 0, undetermined: 0, conflicted_count: 0,
    evaluated: 1, decidable_coverage: 1, accuracy_among_decidable: 1 });
  assert.equal(result.statistical_diagnostics, undefined);
});

test("without a formal verdict, conflicting reviews stay undetermined instead of choosing one source", () => {
  const answers = [answer("original", "a", false), answer("review", "a", true)];
  const result = summarize(answers, []);
  assert.equal(result.per_version!.a!.evaluated, 1);
  assert.equal(result.per_version!.a!.undetermined, 1);
  assert.equal(result.per_version!.a!.conflicted_count, 1);
  assert.equal(result.per_version!.a!.accuracy_among_decidable, null);
  assert.deepEqual(result.statistical_diagnostics![0]!.task_ids, ["original", "review"]);
  const consistent = summarize([answer("original", "a", true), answer("review", "a", true)], []);
  assert.equal(consistent.per_version!.a!.correct, 1);
  assert.equal(consistent.per_version!.a!.conflicted_count, 0);
});

test("conflicting official pairs produce explicit correctness and core diagnostics for one case", () => {
  const answers = [answer("original", "a", false), answer("review", "a", true), answer("b", "b", true), answer("c", "c", true)];
  const result = summarize(answers, [pair("a", "b", [true, true], ["original", "b"]),
    pair("a", "c", [false, true], ["review", "c"], "day", "case", "c")]);
  assert.equal(result.per_version!.a!.conflicted_count, 1);
  assert.equal(result.per_version!.a!.undetermined, 1);
  const standing = result.standings.a!;
  assert.equal(standing.entered, 2);
  assert.equal(standing.core_case_count, 1);
  assert.equal(standing.core_undetermined, 1);
  assert.equal(standing.core_conflicted_count, 1);
  assert.equal(standing.meets_core, 0);
  assert.equal(standing.meets_core_rate, null);
  assert.equal(standing.core_decidable_coverage, 0);
  assert.deepEqual(new Set(result.statistical_diagnostics!.map((row) => row.metric)), new Set(["core", "correctness"]));
});

test("missing formal references and multiple input identities do not borrow an unrelated accepted answer", () => {
  const missing = summarize([answer("old", "a", true), answer("b", "b", true)],
    [pair("a", "b", [true, true], ["missing", "b"])]);
  assert.equal(missing.per_version!.a!.undetermined, 1);
  assert.equal(missing.per_version!.a!.correct, 0);
  assert.equal(missing.statistical_diagnostics![0]!.code, "missing_attribution_source");
  const differentInputs = summarize([answer("old", "a", true, "day", "case", "old-input"),
    answer("new", "a", true, "day", "case", "new-input")], []);
  assert.equal(differentInputs.per_version!.a!.evaluated, 1);
  assert.equal(differentInputs.per_version!.a!.undetermined, 1);
  assert.equal(differentInputs.per_version!.a!.conflicted_count, 0);
  assert.equal(differentInputs.statistical_diagnostics![0]!.code, "ambiguous_input_source");
});

test("standard conflicts are surfaced separately from model errors", () => {
  const first = answer("a", "a", false);
  first.standard_conflict = true;
  const result = summarize([first, answer("b", "b", true)], []);
  assert.deepEqual(result.standard_conflicts, [{ batch_id: "day", case_id: "case", version: "a", task_id: "a" }]);
  assert(result.statistical_diagnostics!.some((row) => row.metric === "standard" && row.code === "standard_conflict"));
  assert.equal(result.per_version!.a!.incorrect, 1);
});

test("only the independent standard review can publish a proposed conflict, including without a pair verdict", () => {
  const original = { ...answer("proposal", "a", false), standard_conflict: true };
  const reviewed = { ...answer("review", "a", false), standard_conflict: false };
  const tasks = [source(original), source(reviewed)];
  tasks[1]!.data = { ...(tasks[1]!.data as TaskData), standardConflictReview: true,
    reviewOf: { taskId: "proposal", round: 1, reasons: [] } } satisfies TaskData;
  const pending = summarizeResults(tasks, [], [original], [], [], []);
  assert.equal(pending.standard_conflicts, undefined);
  assert.equal(pending.per_version!.a!.undetermined, 1);
  const withdrawn = summarizeResults(tasks, [], [original, reviewed], [], [], []);
  assert.equal(withdrawn.standard_conflicts, undefined);
  assert.equal(withdrawn.per_version!.a!.incorrect, 1);
  reviewed.standard_conflict = true;
  const confirmed = summarizeResults(tasks, [], [original, reviewed], [], [], []);
  assert.deepEqual(confirmed.standard_conflicts, [{ batch_id: "day", case_id: "case", version: "a", task_id: "review" }]);
});

test("coverage distinguishes decided, pending and incomplete comparison tasks", () => {
  const answers = [answer("a", "a", true), answer("b", "b", true)];
  const tasks = answers.map(source);
  const comparisonTask = (id: string): PlannedTask => ({ id, stage: "comparison", inputIds: {}, dependencies: {},
    data: { ...(tasks[0]!.data as JsonObject), stage: "comparison" } } as unknown as PlannedTask);
  const result = summarizeResults([...tasks, comparisonTask("decided"), comparisonTask("pending"), comparisonTask("blocked")],
    [], answers, [pair("a", "b", [true, true], ["a", "b"])], [], [], [{ case: { batch_id: "day", case_id: "case" } }]);
  assert.deepEqual(result.coverage, { planned: 3, decided: 1, pending: 1, incomplete: 1 });
});

test("failed task summaries expose bounded diagnostics from the persisted state", () => {
  const long = "x".repeat(300);
  const state: TaskState = { status: "failed", attempts: 1, failure: {
    errors: Array.from({ length: 5 }, (_, index) => ({ category: "decision", code: `code_${index}`,
      path: `/field/${index}`, message: index === 0 ? long : "原因" })),
    contentSubmissions: 4, fileErrors: 0, repeatedErrors: 0, stopped: false, attemptId: "attempt",
  } };
  const summary = taskFailureSummary(state)!;
  assert.match(summary, /code_0（\/field\/0）：x{220}…/u);
  assert.match(summary, /其余 2 项见 state\.json/u);
  assert.equal(taskFailureSummary(undefined), null);
  assert.equal(taskFailureSummary({ status: "failed", attempts: 1 }), null);
});
