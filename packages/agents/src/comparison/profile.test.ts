import test from "node:test";
import assert from "node:assert/strict";
import { comparisonAgent, comparisonProfile } from "./index.js";
import example from "./fixtures/example.json" with { type: "json" };

const audit = { calls: 0, viewedImages: [], calculations: [], artifacts: [] };
test("Comparison ranks a group and references attribution findings", () => {
  assert.deepEqual(Object.keys(comparisonAgent.profiles), ["default"]);
  comparisonProfile.validate!(example.request, example.result, audit);

  const duplicate = structuredClone(example.result);
  duplicate.ranking = [["A", "A"]];
  assert.throws(() => comparisonProfile.validate!(example.request, duplicate, audit), /重复|恰好/);

  const incomplete = structuredClone(example.result);
  incomplete.assessments = { A: { meets_core: true, summary: "x" } } as unknown as typeof incomplete.assessments;
  assert.throws(() => comparisonProfile.validate!(example.request, incomplete, audit), /每个候选/);

  const missingFinding = structuredClone(example.result);
  missingFinding.decision_basis.decisive_findings = [{ candidate: "A", finding_index: 9 }];
  assert.throws(
    () => comparisonProfile.validate!(example.request, missingFinding, audit),
    /归因结果中的既有 finding/,
  );

  const contradiction = structuredClone(example.request);
  contradiction.input.attributions.A.is_correct = false;
  assert.throws(
    () => comparisonProfile.validate!(contradiction, example.result, audit),
    /不能同时判定满足核心要求/,
  );
});

test("Comparison requires full aligned coverage and a concise verdict", () => {
  const missingCandidate = structuredClone(example.result);
  delete (missingCandidate.decision_basis.comparisons[0].assessments as Record<string, unknown>).B;
  assert.throws(() => comparisonProfile.validate!(example.request, missingCandidate, audit), /同一行包含全部候选/);
  const missingStrength = structuredClone(example.result);
  missingStrength.decision_basis.comparisons[0].assessments.B.finding_indices = [];
  assert.throws(() => comparisonProfile.validate!(example.request, missingStrength, audit), /覆盖全部待核对优点/);
  const badRef = structuredClone(example.result);
  badRef.decision_basis.comparisons[0].assessments.A.finding_indices = [99];
  assert.throws(() => comparisonProfile.validate!(example.request, badRef, audit), /只能引用该候选/);
  const badAdvantage = structuredClone(example.result);
  badAdvantage.decision_basis.comparisons[0].better_candidates = ["C"] as never[];
  assert.throws(() => comparisonProfile.validate!(example.request, badAdvantage, audit), /优势候选必须属于本组/);
  const long = structuredClone(example.result);
  long.decision_basis.tradeoff = "长".repeat(161);
  assert.throws(() => comparisonProfile.validate!(example.request, long, audit), /160 characters/);
  const missedProblem = structuredClone(example.request);
  missedProblem.input.attributions.A.findings.push({ ...missedProblem.input.attributions.A.findings[0], type: "problem", importance: "medium" });
  assert.throws(() => comparisonProfile.validate!(missedProblem, example.result, audit), /中高重要性问题/);
});
