import test from "node:test";
import { readAnalysisComparisonRecords } from "./run-data.js";
import assert from "node:assert/strict";
import type { JsonObject } from "@eval/contracts";
import type { EvalConfig } from "./types.js";
import { analysisComparisonScope, analysisComparisonStats } from "./analysis-comparison.js";

const config = { inputs: { versions: [
  { id: "a", name: "A", comparison_tier: "Fast" }, { id: "b", name: "B", comparison_tier: "Fast" }, { id: "c", name: "C", comparison_tier: "Fast" },
] } } as EvalConfig;
const name = (model: string) => model.toUpperCase() + " Expert";
const row = (first = "a", second = "b", winner: string | null = "a"): JsonObject => ({
  evaluation_type: "group_model_comparison", status: "decided", case: { batch_id: "batch", case_id: "question" },
  models: Object.fromEntries([first, second].map(model => [model, { version: name(model) }])),
  assessments: Object.fromEntries([first, second].map(model => [model, { meets_core: true, summary: model + "的正式点评。" }])),
  evaluations: Object.fromEntries([first, second].map(model => [model, { turns: [], session_problem: [] }])),
  decision_basis: { tradeoff: "C的表述更简洁，但不改变正式判决。" },
  verdicts: { [first + "__vs__" + second]: { result: winner ? "win" : "both_good", winner_version: winner,
    winner_name: winner ? name(winner) : null, reason: winner ? "这项要求有实质优势。" : "双方均好。" } },
});

test("Eris counts three models as three independent formal pairs without treating display names as tiers", () => {
  const originals = [row(), row("a", "c"), row("b", "c", null)], before = structuredClone(originals);
  const records = originals.map((original, index) => ({ reference: { runId: "run", taskId: "task" + index },
    question: "原问。", scope: analysisComparisonScope(original, config)! }));
  assert(records.every(({ scope }) => scope.comparisonTier === "Fast"), "Expert in a display name cannot override the recorded declaration");
  assert(records.every(({ scope }) => scope.comparisons.length === 1));
  assert.equal(records[2]!.scope.comparisons[0]!.result, "both_good");
  const stats = analysisComparisonStats(records);
  assert.equal(stats.formalResultCount, 3);
  assert.equal(stats.comparisonCount, 3);
  assert.equal(stats.tiers[0]!.caseCount, 1, "correlated pairs are still one business case");
  assert.deepEqual(stats.tiers[0]!.outcomes, { win: 2, both_good: 1, both_bad: 0 });
  assert.deepEqual(stats.tiers[0]!.models.map(({ model, wins, losses, both_good }) => ({ model, wins, losses, both_good })).sort((a, b) => a.model.localeCompare(b.model)), [
    { model: "a", wins: 2, losses: 0, both_good: 0 }, { model: "b", wins: 0, losses: 1, both_good: 1 }, { model: "c", wins: 0, losses: 1, both_good: 1 },
  ]);
  assert.deepEqual(stats.tiers[0]!.references, records.map(record => record.reference));
  assert.deepEqual(originals, before, "the projection preserves the formal verdict and commentary");
});

test("Eris keeps undeclared tiers unknown, preserves both-bad outcomes and rejects broken formal references", () => {
  const unknown = structuredClone(config);
  unknown.inputs.versions.forEach((version) => { delete version.comparison_tier; });
  const source = row();
  source.verdicts = Object.fromEntries(Object.keys(source.verdicts as JsonObject).map((key) => [key, { result: "both_bad", winner_version: null, winner_name: null, reason: "均未完成核心要求。" }]));
  Object.values(source.assessments as Record<string, { meets_core: boolean }>).forEach(assessment => { assessment.meets_core = false; });
  const scope = analysisComparisonScope(source, unknown)!;
  assert.equal(scope.comparisonTier, null);
  const record = { reference: { runId: "run", taskId: "task" }, question: "原问。", scope };
  const stats = analysisComparisonStats([record]);
  assert.deepEqual(stats.tiers[0]!.outcomes, { win: 0, both_good: 0, both_bad: 1 });
  assert(stats.tiers[0]!.models.every((model) => model.both_bad === 1 && model.wins === 0));
  const mixed = structuredClone(config);
  mixed.inputs.versions[0]!.comparison_tier = "Expert";
  assert.throws(() => analysisComparisonScope(row(), mixed), /不同档位/);
  const missing = row();
  delete (missing.verdicts as JsonObject).a__vs__b;
  assert.throws(() => analysisComparisonScope(missing, config), /缺失或重复/);
  const extra = row();
  (extra.verdicts as JsonObject).a__vs__c = (extra.verdicts as JsonObject).a__vs__b!;
  assert.throws(() => analysisComparisonScope(extra, config), /未登记/);
  assert.throws(() => analysisComparisonStats([record, record]), /引用重复/);
  assert.equal(analysisComparisonScope({ ...row(), status: "pending_review" }, config), null, "a review receipt remains readable without formal outcome coordinates");
  assert.equal(analysisComparisonScope({ evaluation_type: "single_model_attribution" }, config), null);
});

test("Eris rejects duplicate formal task references before reading any result", async () => {
  await assert.rejects(readAnalysisComparisonRecords("unused-run", ["same-task", "same-task"]), /引用重复/);
  assert.deepEqual(await readAnalysisComparisonRecords("unused-run", []), []);
});

test("win rates include both-good and both-bad appearances and retain two decimal places", () => {
  const bad = row("a", "b", null);
  (bad.verdicts as JsonObject).a__vs__b = { result: "both_bad", winner_version: null, winner_name: null, reason: "双方未达标" };
  (bad.assessments as JsonObject).a = { meets_core: false, summary: "未达标" };
  const stats = analysisComparisonStats([row(), row("a", "b", null), bad].map((source, index) => ({
    reference: { runId: "run", taskId: String(index) }, question: "原问", scope: analysisComparisonScope(source, config)!,
  })));
  const a = stats.tiers[0].models.find(model => model.model === "a")!;
  assert.equal(a.comparisonCount, 3);
  assert.equal(a.winRate, 33.33);
  assert.equal(a.lossRate, 0);
  assert.equal(a.bothGoodRate, 33.33);
  assert.equal(a.bothBadRate, 33.33);
  assert.equal(a.meetsCoreRate, 66.67);
  assert.equal(stats.tiers[0].models.find(model => model.model === "b")!.winRate, 0);
});

test("Eris summarizes problem incidence per model battle, deduplicating accepted problem labels", () => {
  const first = row(), second = row("a", "c"), before = structuredClone(first);
  const problem = (label: string) => ({ label });
  first.evaluations = { a: { turns: [], session_problem: [problem("correctness"), problem("correctness"), problem("completeness")] }, b: { turns: [], session_problem: [] } };
  const stats = analysisComparisonStats([first, second].map((source, index) => ({ reference: { runId: "run", taskId: String(index) },
    question: "原问。", scope: analysisComparisonScope(source, config)! })));
  const model = stats.tiers[0]!.models.find(model => model.model === "a")!;
  assert.equal(stats.tiers[0]!.caseCount, 1);
  assert.equal(model.comparisonCount, 2, "the denominator is formal model appearances, not independent answers or questions");
  assert.equal(model.meetsCoreCount, 2);
  assert.deepEqual(model.problemDimensions, [{ dimension: "correctness", established: 1, uncertain: 0, establishedRate: 50, uncertainRate: 0 }, { dimension: "completeness", established: 1, uncertain: 0, establishedRate: 50, uncertainRate: 0 }]);
  assert.deepEqual(stats.tiers[0]!.models.find(model => model.model === "b")!.problemDimensions, []);
  assert.deepEqual(first.verdicts, before.verdicts);
  delete first.evaluations;
  assert.throws(() => analysisComparisonScope(first, config), /缺少模型归因/, "missing attribution cannot become zero problems");
});
