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

  const localError = structuredClone(example.request);
  localError.input.attributions.A.is_correct = false;
  comparisonProfile.validate!(localError, example.result, audit);
});

test("Comparison requires full aligned coverage and a concise verdict", () => {
  const missingCandidate = structuredClone(example.result);
  delete (missingCandidate.decision_basis.comparisons[0].assessments as Record<string, unknown>).B;
  assert.throws(() => comparisonProfile.validate!(example.request, missingCandidate, audit), /同一行包含全部候选/);
  const missingStrength = structuredClone(example.result);
  missingStrength.decision_basis.comparisons[0].assessments.B.finding_indices = [];
  assert.throws(() => comparisonProfile.validate!(example.request, missingStrength, audit), /B\.findings\[0\].*assessments\.B\.finding_indices.*索引从0开始/);
  const badRef = structuredClone(example.result);
  badRef.decision_basis.comparisons[0].assessments.A.finding_indices = [99];
  assert.throws(() => comparisonProfile.validate!(example.request, badRef, audit), /只能引用该候选/);
  const badAdvantage = structuredClone(example.result);
  badAdvantage.decision_basis.comparisons[0].better_candidates = ["C"] as never[];
  assert.throws(() => comparisonProfile.validate!(example.request, badAdvantage, audit), /优势候选必须属于本组/);
  const long = structuredClone(example.result);
  long.decision_basis.tradeoff = "长".repeat(101);
  assert.throws(() => comparisonProfile.validate!(example.request, long, audit), /100 characters/);
  const missedProblem = structuredClone(example.request);
  missedProblem.input.attributions.A.findings.push({ ...missedProblem.input.attributions.A.findings[0], type: "problem", importance: "medium" });
  assert.throws(() => comparisonProfile.validate!(missedProblem, example.result, audit), /中高重要性问题/);
});

test("comparison repair identifies exact candidate keys for display-label mistakes", () => {
  const badLabels = JSON.parse(JSON.stringify(example.result).replaceAll('"A"', '"【候选A】"'));
  assert.throws(() => comparisonProfile.validate!(example.request, badLabels, audit), (error: unknown) => {
    assert(error instanceof Error);
    assert.match(error.message, /合法候选标识.*\["A","B"\]/);
    assert.match(error.message, /原样使用/);
    return true;
  });
});

test("core failures share the last tier, including in multi-candidate comparisons", () => {
  const request = structuredClone(example.request);
  for (const label of ["A", "B"] as const) request.input.attributions[label].findings[0]!.type = "problem";
  const result = structuredClone(example.result);
  result.assessments.A.meets_core = false;
  result.assessments.B.meets_core = false;
  result.decision_basis.tradeoff = "双方的关键结果都错了。";
  result.ranking = [["A"], ["B"]];
  assert.throws(() => comparisonProfile.validate!(request, result, audit), /未达标候选必须同层/);
  result.ranking = [["A", "B"]];
  comparisonProfile.validate!(request, result, audit);
  result.assessments.B.meets_core = true;
  request.input.attributions.B.findings[0]!.type = "strength";
  assert.throws(() => comparisonProfile.validate!(request, result, audit), /达标候选必须排在/);
  result.ranking = [["A"], ["B"]];
  assert.throws(() => comparisonProfile.validate!(request, result, audit), /达标候选必须排在/);
  result.ranking = [["B"], ["A"]];
  comparisonProfile.validate!(request, result, audit);

  Object.assign(request.input.candidates, { C: request.input.candidates.A });
  Object.assign(result.assessments, { C: { meets_core: false, summary: "未完成" } });
  Object.assign(result.decision_basis.comparisons[0].assessments, { C: { summary: "未完成", finding_indices: [] } });
  result.ranking = [["B"], ["A", "C"]];
  comparisonProfile.validate!(request, result, audit);
  result.ranking = [["B"], ["A"], ["C"]];
  assert.throws(() => comparisonProfile.validate!(request, result, audit), /未达标候选必须同层/);
});

test("both-bad tradeoff accepts relative preferences without splitting the ranking", () => {
  const request = structuredClone(example.request);
  const result = structuredClone(example.result);
  for (const label of ["A", "B"] as const) {
    request.input.attributions[label].findings[0]!.type = "problem";
    result.assessments[label].meets_core = false;
  }
  result.ranking = [["A", "B"]];
  for (const tradeoff of [
    "双方都没给回测结果。A相对更好，提供了可执行代码，B只介绍方法，但仍未完成交付。",
    "双方都没给回测结果。B相对更好，提供了可执行代码，A只介绍方法，但仍未完成交付。",
    "双方都没给回测结果，且均只有方法介绍，未见有依据的相对优势。",
  ]) {
    result.decision_basis.tradeoff = tradeoff;
    comparisonProfile.validate!(request, result, audit);
  }
  result.ranking = [["B"], ["A"]];
  assert.throws(() => comparisonProfile.validate!(request, result, audit), /未达标候选必须同层/);
});

test("core usability needs established evidence and is not copied from correctness or severity", () => {
  const request = structuredClone(example.request);
  request.input.attributions.A.is_correct = false;
  const finding = request.input.attributions.A.findings[0]!;
  finding.type = "problem";
  finding.importance = "medium";
  comparisonProfile.validate!(request, example.result, audit);
  const result = structuredClone(example.result);
  result.assessments.A.meets_core = false;
  result.ranking = [["B"], ["A"]];
  // A missing primary result remains unusable even if attribution rated its cause medium.
  comparisonProfile.validate!(request, result, audit);
  finding.importance = "high";
  finding.assessment.evidence_status = "uncertain";
  assert.throws(() => comparisonProfile.validate!(request, result, audit), /判核心不可用必须.*该候选自己的.*权限/);
  finding.assessment.evidence_status = "established";
  comparisonProfile.validate!(request, result, audit);
  // Comparison assesses the whole deliverable; severity is not a second correctness flag.
  comparisonProfile.validate!(request, example.result, audit);
});

test("both-good cannot ignore a one-sided material advantage", () => {
  const result = structuredClone(example.result);
  result.task_analysis.scoring_points = [];
  result.task_analysis.red_flags = [];
  comparisonProfile.validate!(example.request, result, audit);
  result.decision_basis.comparisons[0]!.better_candidates = ["A"] as never[];
  assert.throws(() => comparisonProfile.validate!(example.request, result, audit), /不能判都好/);
  result.ranking = [["A"], ["B"]];
  comparisonProfile.validate!(example.request, result, audit);
  result.ranking = [["A", "B"]];
  result.decision_basis.comparisons[0]!.importance = "low";
  comparisonProfile.validate!(example.request, result, audit);
});
