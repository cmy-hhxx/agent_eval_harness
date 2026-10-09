import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { emptyUsage, type JsonObject, type RunState, type PublicationInput, type PublicationResult } from "@eval/contracts";
import { PublicationStatistics, publishableComparisons, comparisonCodec, buildPlan, assertStatisticsLog, assertCompleteComparisonRewrite } from "@eval/workflows/comparison";
import type { AutomationJob, AutomationState } from "@eval/automations";
import { publishSnapshot, syncMongoDay, statisticsSnapshot } from "../../../apps/host/src/automation-publication.js";
import { loadAutomationConfig } from "../../../apps/host/src/automation-config.js";
import { fixtureConfig, fakeIdentity, fakeEvaluatorVersion } from "../../fixtures/comparison.js";
import { ROOT } from "../../fixtures/services.js";

test("comparison delivery waits for shared criteria and evaluation rewrites, never clustering", async () => {
  const { directory, config } = await fixtureConfig(undefined, true, true);
  try {
    config.rewrite = { attribution: true, comparison: true, comparisonItems: true, clustering: true };
    config.comparisons = [["a_fast", "b_fast"], ["a_expert", "b_expert"]];
    const plan = await buildPlan(config);
    const state: RunState = { usage: emptyUsage(), receipts: {}, recordedAttempts: 0, manifest: {
      format: "evaluation-run", debug: false, runId: "daily", status: "running", evaluatorVersion: fakeEvaluatorVersion,
      engine: fakeIdentity, config, tasks: plan.tasks, inputCatalog: plan.catalog, inputs: {},
      states: Object.fromEntries(plan.tasks.map((task) => [task.id, { status: "pending", attempts: 0 }])),
      preflight: plan.summary, startedAt: Date.now(),
    } };
    const saved = comparisonCodec.encode(state);
    let time = 100;
    for (const task of Object.values(saved.tasks)) {
      task.status = "succeeded";
      task.receipt = { acceptedAt: time++, exported: {} } as NonNullable<typeof task.receipt>;
    }
    assert.equal(publishableComparisons(saved).size, 2);
    const criteria = Object.values(saved.tasks).find((task) => task.stage === "criteria")!;
    criteria.status = "pending";
    assert.equal(publishableComparisons(saved).size, 0, "both pairs depend on the accepted shared rubric");
    criteria.status = "succeeded";
    for (const task of Object.values(saved.tasks)) {
      if (task.stage === "clustering") task.status = "failed";
      if (task.data.rewriteOf?.stage === "clustering") task.status = "pending";
    }
    assert.equal(publishableComparisons(saved).size, 2, "clustering and its rewrite never gate comparison delivery");
    const comparisonRewrite = Object.values(saved.tasks).find((task) => task.data.rewriteOf?.stage === "comparison")!;
    comparisonRewrite.status = "failed";
    assert.equal(publishableComparisons(saved).size, 1);
    comparisonRewrite.status = "succeeded";
    comparisonRewrite.data.comparisonRewriteScope = "verdicts";
    assert.equal(publishableComparisons(saved).size, 1, "verdict-only polish is not a complete comparison rewrite");
    (saved.config as typeof config).rewrite.comparisonItems = false;
    assert.equal(publishableComparisons(saved, true).size, 1, "current automation requirements apply before the run is reconciled");
    (saved.config as typeof config).rewrite.comparisonItems = true;
    comparisonRewrite.data.comparisonRewriteScope = "all";
    assert.equal(publishableComparisons(saved).size, 2);
    const comparison = Object.values(saved.tasks).find((task) => task.stage === "comparison" && !(task.data as { verificationAudit?: boolean }).verificationAudit)!;
    comparison.receipt!.exported!.file = "comparison-review.jsonl";
    assert.equal(publishableComparisons(saved).size, 1, "review requests are not official comparison rows");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("publication requires nonempty verdict and content rewrites while recorded resource cells keep their original text", () => {
  const findings = { a_fast: { finding_indices: [0] }, b_fast: { finding_indices: [0] } };
  const row: JsonObject = { comparison_id: "comparison", decision_basis: { comparisons: [
    { criterion_ids: ["r1"], assessments: findings },
    { criterion_ids: [], assessments: { a_fast: { finding_indices: [] }, b_fast: { finding_indices: [] } } },
    { criterion_ids: [], assessments: findings },
  ] }, rewritten: { rewrites: [
    { id: "verdict.A__vs__B.reason", text: "双方都好：给出相同结果。" },
    { id: "comparison.0.A.summary", text: "给出了结果。" },
    { id: "comparison.0.B.summary", text: "给出了结果。" },
    { id: "comparison.2.A.summary", text: "来源明确。" },
    { id: "comparison.2.B.summary", text: "  " },
  ] } };
  assert.throws(() => assertCompleteComparisonRewrite(row, ["B", "A"]), /comparison\.2\.B\.summary/);
  const items = (row.rewritten as { rewrites: { id: string; text: string }[] }).rewrites;
  items[4].text = "来源明确。";
  assertCompleteComparisonRewrite(row, ["B", "A"]);
  items.shift();
  assert.throws(() => assertCompleteComparisonRewrite(row, ["B", "A"]), /verdict\.A__vs__B\.reason/);
});

const date = "2026-09-30";
const configuredGroups = [["a_fast", "b_fast"], ["a_expert", "b_expert"]];
const inputs: PublicationInput[] = ["a_fast", "b_fast"].map((versionId) => ({ versionId, trace: {
  batch_id: date, case_id: "one", version: versionId, versions: "release", messages: [{}],
  meta: { task: "客观题", difficulty: "简单", first_token_time_cost: 0, finish_answer_time_cost: 100,
    usage: { input_tokens: 200, output_tokens: 20 } },
} }));
const result: PublicationResult = { evaluatedAt: 10, row: { case: { batch_id: date, case_id: "one" },
  status: "decided", assessments: { a_fast: { meets_core: false }, b_fast: { meets_core: true } },
  models: { a_fast: {}, b_fast: {} }, verdicts: { a_fast__vs__b_fast: { result: "win", winner_version: "b_fast" } },
  has_standard_answer: true, evaluations: { a_fast: { is_correct: false }, b_fast: { is_correct: true } },
} };
async function* rows<T>(data: T[]) { yield* data; }

test("three-model statistics use configured battles and count each answer's correctness once", () => {
  const ids = ["a_fast", "b_fast", "baseline"];
  const stats = new PublicationStatistics([ids]);
  for (const versionId of ids) stats.addInput({ ...inputs[0], versionId, trace: { ...inputs[0].trace, version: versionId } });
  const outcomes = ["both_good", "win", "win"];
  let index = 0;
  for (let first = 0; first < ids.length; first++) for (let second = first + 1; second < ids.length; second++) {
    const pair = [ids[first], ids[second]], outcome = outcomes[index++];
    stats.addResult({ evaluatedAt: 10, row: { ...result.row,
      models: Object.fromEntries(pair.map((id) => [id, {}])),
      evaluations: Object.fromEntries(pair.map((id) => [id, { is_correct: id !== "b_fast" }])),
      assessments: Object.fromEntries(pair.map((id) => [id, { meets_core: id !== "baseline" }])),
      verdicts: { [pair.join("__vs__")]: { result: outcome, winner_version: outcome === "win" ? pair[0] : null } },
    } });
  }
  const record = stats.record("three", Date.now()); assertStatisticsLog(record);
  const data = record.data as Record<string, any>;
  assert.deepEqual(data.progress, { expectedBattleCount: 3, completedBattleCount: 3, completedCaseCount: 1 });
  assert.equal(data.caseCount, 1);
  for (const model of data.stats) {
    assert.equal(model.evaluated, 2);
    assert.equal(model.accuracy.count, 1);
    assert.equal(model.accuracy.correct, model.id === "b_fast" ? 0 : 1);
    assert.equal(model.total.count, 1);
    assert.equal(model.winRate, model.wins / 2 * 100);
  }
  assert.throws(() => new PublicationStatistics([ids]).addResult({ ...result, row: { ...result.row,
    models: Object.fromEntries(ids.map((id) => [id, {}])) } }), /two-candidate/);
  assert.throws(() => new PublicationStatistics([["a_fast", "baseline"]]).addResult(result), /configured/);
});

test("statistics reject review requests and contradictory absolute core assessments across pairs", () => {
  const groups = [["a_fast", "b_fast", "baseline"]];
  for (const row of [{ ...result.row, status: "needs_review" },
    { ...result.row, evaluation_type: "comparison_review" }])
    assert.throws(() => new PublicationStatistics(groups).addResult({ ...result, row }), /decided/);
  const stats = new PublicationStatistics(groups);
  stats.addResult({ ...result, row: { ...result.row, status: "decided", assessments: {
    a_fast: { meets_core: false }, b_fast: { meets_core: true },
  } } });
  const reassessed = { ...result, row: { ...result.row, status: "decided", models: { a_fast: {}, baseline: {} },
    evaluations: { a_fast: { is_correct: false }, baseline: { is_correct: true } },
    assessments: { a_fast: { meets_core: true }, baseline: { meets_core: true } },
    verdicts: { a_fast__vs__baseline: { result: "win", winner_version: "baseline" } },
  } };
  assert.throws(() => stats.addResult(reassessed), /Conflicting answer core/);
  reassessed.row.assessments.a_fast.meets_core = false;
  stats.addResult(reassessed);
  assert.throws(() => new PublicationStatistics(groups).addResult({ ...result, row: { ...result.row, assessments: {} } }), /missing a core/);
});

test("configured pairs retain their date scope when a later date adds a baseline", () => {
  const stats = new PublicationStatistics([]), earlier = "2026-09-29", ids = ["a_fast", "b_fast", "baseline"];
  stats.addGroups([["a_fast", "b_fast"]], earlier);
  stats.addGroups([ids], date);
  for (const batchId of [earlier, date]) for (const versionId of ids)
    stats.addInput({ ...inputs[0], versionId, trace: { ...inputs[0].trace, batch_id: batchId, version: versionId } });
  for (const batch_id of [earlier, date]) stats.addResult({ ...result, row: { ...result.row, case: { batch_id, case_id: "one" } } });
  const data = stats.record("scoped", Date.now()).data as Record<string, any>;
  assert.equal(data.progress.expectedBattleCount, 4);
  assert.deepEqual(data.requestDates.map((day: any) => [day.date, day.progress.expectedBattleCount]), [[date, 3], [earlier, 1]]);
  assert.throws(() => stats.addResult({ ...result, row: { ...result.row, case: { batch_id: earlier, case_id: "one" },
    models: { a_fast: {}, baseline: {} },
  } }), /configured/);
});

test("both outcome counts sit beside wins across totals, days, scenarios, difficulties and trends", () => {
  const stats = new PublicationStatistics(configuredGroups);
  const battles = [
    { date: "2026-09-29", caseId: "same", mode: "fast", task: "数据查询类", difficulty: "简单", result: "both_good", winner: null },
    { date: "2026-09-29", caseId: "same", mode: "expert", task: "数据查询类", difficulty: "简单", result: "both_bad", winner: null },
    { date, caseId: "same", mode: "fast", task: "客观题", difficulty: "中等", result: "win", winner: "b_fast" },
    { date, caseId: "good", mode: "expert", task: "问答", difficulty: "复杂", result: "both_good", winner: null },
    { date, caseId: "bad", mode: "fast", task: "未分类", difficulty: "未分层", result: "both_bad", winner: null },
    { date, caseId: "win", mode: "expert", task: "客观题", difficulty: "长程任务", result: "win", winner: "a_expert" },
  ];
  for (const battle of battles) {
    const ids = [`a_${battle.mode}`, `b_${battle.mode}`];
    for (const id of ids) stats.addInput({ versionId: id, trace: { ...inputs[0].trace,
      batch_id: battle.date, case_id: battle.caseId, version: id,
      meta: { task: battle.task, difficulty: battle.difficulty } } });
    stats.addResult({ evaluatedAt: 10, row: {
      status: "decided", assessments: Object.fromEntries(ids.map((id) => [id, { meets_core: battle.result !== "both_bad" }])),
      case: { batch_id: battle.date, case_id: battle.caseId }, models: Object.fromEntries(ids.map((id) => [id, {}])),
      has_standard_answer: false, evaluations: Object.fromEntries(ids.map((id) => [id, { is_correct: null }])),
      verdicts: { [ids.join("__vs__")]: { result: battle.result, winner_version: battle.winner } },
    } });
  }
  for (const input of inputs) stats.addInput({ ...input, trace: { ...input.trace, case_id: "pending" } });
  stats.addInput({ ...inputs[0], trace: { ...inputs[0].trace, case_id: "unpaired" } });
  stats.addResult({ ...result, row: { ...result.row, case: { batch_id: date, case_id: "unpaired" },
    verdicts: { a_fast__vs__b_fast: { result: "both_bad", winner_version: null } } } });
  const record = stats.record("outcomes", Date.now());
  assertStatisticsLog(record);
  const data = record.data as Record<string, any>;
  assert.equal(data.progress.expectedBattleCount, 7);
  assert.equal(data.progress.completedBattleCount, 6, "pending and unpaired inputs cannot inflate outcome counts");
  const counts = (value: Record<string, any>) => ({ id: value.id, wins: value.wins,
    both_good: value.both_good, both_bad: value.both_bad, evaluated: value.evaluated });
  const check = (scope: Record<string, any>, selected: typeof battles) => {
    assert.equal(scope.progress.completedBattleCount, selected.length);
    const ids = [...new Set(selected.flatMap((battle) => [`a_${battle.mode}`, `b_${battle.mode}`]))].sort();
    assert.deepEqual(scope.stats.map(counts), ids.map((id) => {
      const entered = selected.filter((battle) => id.endsWith(`_${battle.mode}`));
      return { id, wins: entered.filter((battle) => battle.winner === id).length,
        both_good: entered.filter((battle) => battle.result === "both_good").length,
        both_bad: entered.filter((battle) => battle.result === "both_bad").length, evaluated: entered.length };
    }));
    for (const model of scope.stats) {
      const keys = Object.keys(model), position = keys.indexOf("wins");
      assert.deepEqual(keys.slice(position, position + 4), ["wins", "both_good", "both_bad", "evaluated"]);
      const peer = scope.stats.find((row: any) => row.id === model.id.replace(/^[ab]_/, model.id.startsWith("a_") ? "b_" : "a_"));
      assert.equal(model.wins + peer.wins + model.both_good + model.both_bad, model.evaluated);
      assert.equal(model.winRate, model.wins / model.evaluated * 100, "win-rate denominator is unchanged");
    }
    for (const task of scope.tasks ?? []) check(task, selected.filter((battle) => battle.task === task.name));
    for (const difficulty of scope.difficultyLevels ?? []) check(difficulty, selected.filter((battle) => battle.difficulty === difficulty.name));
  };
  check(data, battles);
  for (const day of data.requestDates) {
    check(day, battles.filter((battle) => battle.date === day.date));
    assert.deepEqual(data.winRateTrend.filter((point: any) => point.date === day.date).map(counts), day.stats.map(counts));
  }
  for (const point of data.winRateTrend) assert.deepEqual(Object.keys(point), ["date", "id", "wins", "both_good", "both_bad", "evaluated"]);
  for (const model of data.stats) for (const key of ["wins", "both_good", "both_bad", "evaluated"]) {
    assert.equal(model[key], data.requestDates.reduce((sum: number, day: any) => sum + (day.stats.find((row: any) => row.id === model.id)?.[key] ?? 0), 0));
  }
  const historical = stats.record("history", Date.now(), "2026-09-29").data as Record<string, any>;
  check(historical, battles.filter((battle) => battle.date === "2026-09-29"));
});

test("statistics read explicit verdict outcomes and reject unknown or inconsistent outcomes", () => {
  for (const verdict of [
    {}, { result: "tie", winner_version: null }, { result: "win", winner_version: null },
    { result: "win", winner_version: "a_expert" }, { result: "both_bad", winner_version: "b_fast" },
    { result: "both_good" },
  ]) {
    assert.throws(() => new PublicationStatistics(configuredGroups).addResult({ ...result, row: { ...result.row,
      verdicts: { a_fast__vs__b_fast: verdict } } }), /statistics verdict|Statistics verdict/);
  }
  const stats = new PublicationStatistics(configuredGroups);
  stats.addResult(result);
  assert.throws(() => stats.addResult(result), /Duplicate statistics comparison/);
});

test("frozen statistics contract rejects added, missing and mistyped fields at every nested object", () => {
  const stats = new PublicationStatistics(configuredGroups);
  inputs.forEach((row) => stats.addInput(row));
  stats.addResult(result);
  const record = stats.record("frozen", Date.now());
  assertStatisticsLog(record);
  const paths: string[][] = [];
  const visit = (value: unknown, path: string[]) => {
    if (!value || typeof value !== "object") return;
    if (!Array.isArray(value)) paths.push(path);
    for (const [key, child] of Object.entries(value)) visit(child, [...path, key]);
  };
  visit(record, []);
  for (const path of paths) {
    const target = (value: Record<string, any>): Record<string, any> => path.reduce((row, key) => row[key], value);
    const extra = structuredClone(record);
    target(extra).unexpected = 1;
    assert.throws(() => assertStatisticsLog(extra), /frozen contract/, path.join("/"));
    assert.equal(target(extra).unexpected, 1, "validation must not silently strip extra fields");
    for (const [key, value] of Object.entries(target(record))) {
      const missing = structuredClone(record);
      delete target(missing)[key];
      assert.throws(() => assertStatisticsLog(missing), /frozen contract/, [...path, key].join("/"));
      assert.equal(Object.hasOwn(target(missing), key), false, "validation must not fill missing fields");
      const mistyped = structuredClone(record), wrong = typeof value === "string" ? 123 : "123";
      target(mistyped)[key] = wrong;
      assert.throws(() => assertStatisticsLog(mistyped), /frozen contract/, [...path, key].join("/"));
      assert.equal(target(mistyped)[key], wrong, "validation must not coerce numeric strings");
    }
  }
});

test("frozen statistics contract allows evolving values, new dates, empty arrays and nullable metrics", () => {
  const stats = new PublicationStatistics(configuredGroups);
  assertStatisticsLog(stats.record("empty", Date.now()));
  for (const day of ["2026-09-29", "2026-09-30"]) {
    inputs.forEach((row) => stats.addInput({ ...row, trace: { ...row.trace, batch_id: day, meta: {} } }));
    stats.addResult({ ...result, row: { ...result.row, has_standard_answer: false, case: { batch_id: day, case_id: "one" } } });
    const record = stats.record(day, Date.now());
    assertStatisticsLog(record);
    const data = record.data as Record<string, any>;
    assert.deepEqual(data.stats[0].first, { p50: null, p90: null, count: 0 });
    assert.deepEqual(data.stats[0].accuracy, { correct: 0, count: 0, rate: null });
    assert.equal(data.requestDates.length, day.endsWith("29") ? 1 : 2);
  }
});

test("four-hour statistics use paired denominators and preserve the existing log structure", () => {
  const stats = new PublicationStatistics(configuredGroups);
  inputs.forEach((row) => stats.addInput(row));
  stats.addInput({ versionId: "a_fast", trace: { ...inputs[0].trace, case_id: "unpaired" } });
  stats.addInput({ versionId: "a_fast", trace: { ...inputs[0].trace, case_id: "pending" } });
  stats.addInput({ versionId: "b_fast", trace: { ...inputs[1].trace, case_id: "pending" } });
  stats.addResult(result);
  const record = stats.record("trace", Date.parse("2026-09-30T04:00:00Z"));
  const data = record.data as Record<string, any>;
  assert.equal(record.logtime, "2026-09-30 12:00:00.000");
  assert.equal(data.totalCaseCount, 3); assert.equal(data.caseCount, 1);
  assert.deepEqual(data.progress, { expectedBattleCount: 2, completedBattleCount: 1, completedCaseCount: 1 });
  assert.deepEqual(data.stats[1].accuracy, { correct: 1, count: 1, rate: 100 });
  assert.equal(data.stats[1].winRate, 100);
  assert.deepEqual(data.stats[1].first, { p50: 0, p90: 0, count: 1 });
  assert.deepEqual(Object.keys(data).sort(), ["caseCount", "difficultyLevels", "models", "progress", "requestDates", "scope", "source", "stats", "tasks", "totalCaseCount", "winRateTrend"]);
  assert.equal(data.tasks[0].count, 3); assert.equal(data.difficultyLevels[0].evaluatedCount, 1);
});

test("dashboard snapshot retains history, separates identical case IDs across dates and uses request dates", () => {
  const stats = new PublicationStatistics(configuredGroups);
  for (const day of ["2026-09-24", "2026-09-29"]) {
    inputs.forEach((input) => stats.addInput({ ...input, trace: { ...input.trace, batch_id: day, request_time: `${day} 12:00:00` } }));
    stats.addResult({ ...result, row: { ...result.row, case: { batch_id: day, case_id: "one" } } });
  }
  const record = stats.record("global", Date.now());
  const data = record.data as Record<string, any>;
  assert.equal(data.totalCaseCount, 2);
  assert.equal(data.caseCount, 2);
  assert.deepEqual(data.requestDates.map(({ date, count }: any) => ({ date, count })), [{ date: "2026-09-29", count: 1 }, { date: "2026-09-24", count: 1 }]);
  for (const day of data.requestDates) {
    assert.equal(day.caseCount, 1);
    assert.equal(day.totalCaseCount, day.count);
    assert.equal(day.progress.completedBattleCount, 1);
    assert.equal(day.tasks[0].count, 1);
    assert.equal(day.difficultyLevels[0].evaluatedCount, 1);
    assert.equal(day.stats[1].winRate, 100);
  }
  assert.deepEqual(new Set(data.winRateTrend.map((point: any) => point.date)), new Set(["2026-09-24", "2026-09-29"]));
  assert.deepEqual(data.scope, { matchup: "same-mode" });
  assert.equal(data.source, "/api/version-comparisons?matchup=same-mode");
});

test("latest snapshot refreshes existing dates and includes new dates without double counting", () => {
  const stats = new PublicationStatistics(configuredGroups);
  const add = (day: string, caseId: string, finish: number) => {
    for (const input of inputs) stats.addInput({ ...input, trace: { ...input.trace, batch_id: day, case_id: caseId,
      request_time: `${day} 12:00:00`, meta: { ...input.trace.meta as object, finish_answer_time_cost: finish } } });
  };
  add("2026-09-29", "old", 100);
  add("2026-09-29", "late", 200);
  stats.addResult({ ...result, row: { ...result.row, case: { batch_id: "2026-09-29", case_id: "old" } } });
  const before = stats.record("29", Date.now()).data as Record<string, any>;
  assert.equal(before.requestDates[0].progress.completedBattleCount, 1);
  add("2026-09-29", "old", 100);
  add("2026-09-30", "new", 1000);
  for (const [day, caseId] of [["2026-09-29", "late"], ["2026-09-30", "new"]])
    stats.addResult({ ...result, row: { ...result.row, case: { batch_id: day, case_id: caseId } } });
  const after = stats.record("30", Date.now()).data as Record<string, any>;
  assert.equal(after.totalCaseCount, 3);
  assert.equal(after.progress.completedBattleCount, 3);
  assert.equal(after.stats[0].total.p50, 200, "global percentiles come from answers, not averages of daily percentiles");
  assert.deepEqual(after.requestDates.map((day: any) => [day.date, day.count, day.progress.completedBattleCount]),
    [["2026-09-30", 1, 1], ["2026-09-29", 2, 2]]);
  const historical = stats.record("29", Date.now(), "2026-09-29").data as Record<string, any>;
  assert.equal(historical.totalCaseCount, 2);
  assert.equal(historical.requestDates.length, 1);
  assert.equal(historical.stats[0].total.p50, 150);
});

test("case annotations fill unlabelled models without conflating dates or silently accepting conflicting labels", () => {
  const stats = new PublicationStatistics(configuredGroups);
  stats.addInput(inputs[0]);
  stats.addInput({ ...inputs[1], trace: { ...inputs[1].trace, meta: {} } });
  stats.addResult(result);
  stats.addLabels({ batchId: "2026-09-29", caseId: "one", task: "其他分类", difficulty: "复杂" });
  const data = stats.record("labels", Date.now()).data as Record<string, any>;
  assert.equal(data.tasks.length, 1);
  assert.equal(data.tasks[0].progress.completedBattleCount, 1);
  assert.equal(data.difficultyLevels[0].progress.completedBattleCount, 1);
  assert.throws(() => stats.addLabels({ batchId: date, caseId: "one", task: "其他分类" }), /Conflicting statistics task labels/);
});

test("daily statistics use a paired request date or the batch date when all request timestamps are absent", () => {
  const stats = new PublicationStatistics(configuredGroups);
  for (const input of inputs) stats.addInput(input);
  stats.addResult(result);
  for (const [i, input] of inputs.entries()) stats.addInput({ ...input, trace: { ...input.trace, case_id: "dated",
    ...(i === 1 ? { request_time: "2026-09-28T18:00:00Z" } : {}) } });
  stats.addResult({ ...result, row: { ...result.row, case: { batch_id: date, case_id: "dated" } } });
  const data = stats.record("dates", Date.now()).data as Record<string, any>;
  assert.deepEqual(data.requestDates.map((row: any) => [row.date, row.count, row.progress.completedBattleCount]),
    [["2026-09-30", 1, 1], ["2026-09-29", 1, 1]]);
  assert.equal(data.requestDates.reduce((sum: number, row: any) => sum + row.count, 0), data.totalCaseCount);
});

test("statistics load case labels from Mongo and retain them across models and daily history", async () => {
  const config = await loadAutomationConfig(path.join(ROOT, "configs/automations.json"));
  config.publication = { ...config.publication, mongoUriEnv: "PATH" };
  const days = ["2026-09-24", "2026-09-30"];
  const state = { jobs: Object.fromEntries(days.map((date) => [date, { date, download: "ready" }])) } as AutomationState;
  const dependencies: Parameters<typeof statisticsSnapshot>[3] = {
    labels: async (_settings, dates) => {
      assert.deepEqual(dates, days);
      return [{ batchId: days[0], caseId: "one", task: "数据查询类", difficulty: "简单" }];
    },
    snapshot: async (_config, job) => ({
      comparisons: configuredGroups,
      inputs: () => rows(inputs.map((input) => ({ ...input, trace: { ...input.trace, batch_id: job.date,
        request_time: `${job.date} 12:00:00`, meta: job.date === days[0] ? {} : input.trace.meta } }))),
      results: () => rows([{ ...result, row: { ...result.row, case: { batch_id: job.date, case_id: "one" } } }]),
    }),
  };
  const data = (await statisticsSnapshot(config, state, AbortSignal.timeout(5000), dependencies)).record("all", Date.now()).data as Record<string, any>;
  assert.equal(data.totalCaseCount, 2);
  const historical = data.requestDates.find((day: any) => day.date === days[0]);
  assert.equal(historical.tasks[0].id, "数据查询类");
  assert.equal(historical.tasks[0].progress.completedBattleCount, 1);
  assert.equal(historical.difficultyLevels[0].count, 1);
  assert.deepEqual(new Set(data.tasks.map((task: any) => task.id)), new Set(["数据查询类", "客观题"]));
  await assert.rejects(statisticsSnapshot(config, state, AbortSignal.timeout(5000), {
    ...dependencies, labels: async () => { throw new Error("label source unavailable"); },
  }), /label source unavailable/, "never publish a deceptively unclassified snapshot after a read failure");
});

test("dashboard log snapshots use the complete inventory and resume without a duplicate line", async () => {
  const { directory } = await fixtureConfig();
  try {
    const config = await loadAutomationConfig(path.join(ROOT, "configs/automations.json"));
    config.publication = { ...config.publication, logFile: path.join(directory, "statistics.jsonl"), mongoUriEnv: "PATH" };
    const state = { publication: { traceId: "trace-window", status: "running", attempts: 1, nextAt: 0 } } as AutomationState;
    let uploads = 0, persisted = "";
    const dependencies: Parameters<typeof publishSnapshot>[4] = {
      snapshot: async () => { const stats = new PublicationStatistics(configuredGroups); inputs.forEach(input => stats.addInput(input)); stats.addResult(result); return stats; },
      upload: async (_url, record) => {
        uploads++;
        assert.equal(persisted, "sending");
        assertStatisticsLog(record);
        assert.equal((record.data as Record<string, any>).stats[0].both_good, 0);
        assert.equal((record.data as Record<string, any>).stats[0].both_bad, 0);
        assert.deepEqual(JSON.parse((await readFile(config.publication.logFile, "utf8")).trim()), record);
        if (uploads === 1) throw new Error("response lost");
        return "req-verified";
      },
    };
    const save = async () => { persisted = state.publication!.log?.status ?? ""; };
    await assert.rejects(publishSnapshot(config, state, save, AbortSignal.timeout(5000), dependencies), /response lost/);
    assert.equal(state.publication!.log!.status, "sending");
    await assert.rejects(publishSnapshot(config, state, save, AbortSignal.timeout(5000), dependencies), /manual receipt/);
    assert.equal(uploads, 1);
    // Operator has verified that the first POST was not written.
    state.publication!.log = { ...state.publication!.log, status: "pending" };
    await publishSnapshot(config, state, save, AbortSignal.timeout(5000), dependencies);
    await publishSnapshot(config, state, save, AbortSignal.timeout(5000), dependencies);
    assert.equal(uploads, 2);
    const delivery = state.publication!;
    assert.equal(delivery.log!.status, "uploaded");
    assert.equal(delivery.log!.requestId, "req-verified");
    assert.deepEqual(delivery.counts, { cases: 1, comparisons: 1 });
    assert(delivery.log!.writtenAt! <= delivery.log!.startedAt!);
    assert(delivery.log!.uploadedAt! >= delivery.log!.startedAt!);
    assert.equal((await readFile(config.publication.logFile, "utf8")).trim().split("\n").length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("publication blocks structural drift before appending or uploading a recovered log", async () => {
  const { directory } = await fixtureConfig();
  try {
    const config = await loadAutomationConfig(path.join(ROOT, "configs/automations.json"));
    const stats = new PublicationStatistics(configuredGroups);
    inputs.forEach((row) => stats.addInput(row));
    stats.addResult(result);
    const record = stats.record("invalid", Date.now());
    delete (record.data as Record<string, any>).requestDates[0].difficultyLevels;
    stats.record = () => record;
    for (const recovered of [false, true]) {
      config.publication.logFile = path.join(directory, `${recovered}.jsonl`);
      const line = JSON.stringify(record) + "\n";
      if (recovered) await writeFile(config.publication.logFile, line);
      const state = { publication: { traceId: "invalid", status: "running", attempts: 1, nextAt: 0 } } as AutomationState;
      let saves = 0, snapshots = 0, uploads = 0;
      await assert.rejects(publishSnapshot(config, state, async () => { saves++; }, AbortSignal.timeout(5000), {
        snapshot: async () => { snapshots++; return stats; },
        upload: async () => { uploads++; return "must-not-upload"; },
      }), /frozen contract/);
      assert.equal(uploads, 0);
      assert.equal(saves, 0);
      assert.equal(snapshots, recovered ? 0 : 1);
      assert.equal(state.publication!.log, undefined);
      if (recovered) assert.equal(await readFile(config.publication.logFile, "utf8"), line);
      else await assert.rejects(readFile(config.publication.logFile), { code: "ENOENT" });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Mongo delivery streams ready inputs and results independently of the log schedule", async () => {
  const { directory } = await fixtureConfig();
  const key = "TEST_AUTOMATIONS_MONGO_URI", previous = process.env[key];
  process.env[key] = "mongodb://mock";
  try {
    const config = await loadAutomationConfig(path.join(ROOT, "configs/automations.json"));
    config.publication = { ...config.publication, mongoUriEnv: key, logFile: path.join(directory, "statistics.jsonl") };
    let ready: PublicationResult[] = [];
    const delivered: { inputs: PublicationInput[]; results: PublicationResult[] }[] = [];
    const dependencies: Parameters<typeof syncMongoDay>[3] = {
      snapshot: async () => ({ comparisons: configuredGroups, inputs: () => rows(inputs), results: () => rows(ready) }),
      mongo: async (settings, batch, inputRows, resultRows) => {
        assert.equal(batch, date);
        assert.equal(settings.inputsUnchanged, delivered.length === 1);
        const input: PublicationInput[] = [], output: PublicationResult[] = [];
        for await (const row of inputRows) input.push(row);
        for await (const row of resultRows) output.push(row);
        delivered.push({ inputs: input, results: output });
        return { inputs: input.length, comparisons: output.length, inserted: output.length, updated: 0 };
      },
    };
    const job = { date } as AutomationJob;
    await syncMongoDay(config, job, AbortSignal.timeout(3000), dependencies);
    ready = [result];
    job.mongo = { status: "running", attempts: 1, nextAt: 0, synced: { inputsUpdatedAt: 0, comparisons: 0 } };
    await syncMongoDay(config, job, AbortSignal.timeout(3000), dependencies);
    job.inputsUpdatedAt = 10;
    await syncMongoDay(config, job, AbortSignal.timeout(3000), dependencies);
    assert.deepEqual(delivered, [{ inputs, results: [] }, { inputs, results: [result] }, { inputs, results: [result] }]);
    ready = [{ ...result, row: { ...result.row, status: "needs_review" } }];
    await assert.rejects(syncMongoDay(config, job, AbortSignal.timeout(3000), dependencies), /decided/);
    assert.equal(delivered.length, 3, "invalid results are rejected before the Mongo writer is invoked");
    await assert.rejects(readFile(config.publication.logFile), { code: "ENOENT" });
  } finally {
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
