import test from "node:test";
import assert from "node:assert/strict";
import { ValidationError, type AgentRequest } from "@eval/contracts";
import { comparisonProfile, type ComparisonInput, type ComparisonResult } from "./index.js";
import { requestComparisonSubmission } from "../../../../tests/fixtures/comparison-submission.js";
import example from "./fixtures/example.json" with { type: "json" };

const audit = { calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [] };
const hasIssue = (code: string) => (error: unknown) => error instanceof ValidationError && error.issues!.some(issue => issue.code === code);
const resolve = (request: AgentRequest, draft: unknown) => comparisonProfile.resolve!(request, draft, audit) as ComparisonResult;

test("equivalent confirmed delivery can retain no inclination without changing either source", () => {
  const request = structuredClone(example.request), draft = requestComparisonSubmission(request, example.result as ComparisonResult);
  request.input.attributions.B.criterion_assessments[0].summary = "所求结果4正确且可直接使用。";
  draft.relative_preference = null;
  draft.tradeoff = "双方都给出4，没有已确认差异，无法区分相对优劣。";
  const before = structuredClone(request), result = resolve(request, draft);
  comparisonProfile.validate!(request, result, audit);
  assert.deepEqual(result.ranking, [["A", "B"]]);
  assert.equal(result.decision_basis.tradeoff, draft.tradeoff);
  assert.deepEqual(result.decision_basis.decisive_findings, []);
  assert.deepEqual(request, before);
});

test("the single tradeoff requires a nonblank explanation", () => {
  const request = structuredClone(example.request), draft = requestComparisonSubmission(request, example.result as ComparisonResult);
  draft.tradeoff = " \n ";
  assert.throws(() => resolve(request, draft), error => error instanceof ValidationError && error.issues!.some(issue => issue.path === "/tradeoff"));
});

test("no inclination cannot erase a declared advantage, unequal state, or unresolved common fact", () => {
  for (const variant of ["advantage", "partial", "uncertain"] as const) {
    const request = structuredClone(example.request), input = request.input as unknown as ComparisonInput;
    if (variant === "partial") input.attributions.B.criterion_assessments[0].status = "partial";
    if (variant === "uncertain") input.attributions.B.criterion_assessments[0].evidence_status = "uncertain";
    const draft = requestComparisonSubmission(request, example.result as ComparisonResult);
    draft.relative_preference = null;
    if (variant === "advantage") draft.comparisons[0] = { importance: "low", better_candidate: "A" };
    assert.throws(() => resolve(request, draft), hasIssue("relative_preference_required"));
  }
});

test("opposing resource advantages still require a relative choice instead of claiming equivalence", () => {
  const request = structuredClone(example.request), input = request.input as unknown as ComparisonInput;
  input.candidates.A.original_answer_timing.finish_seconds = 10;
  input.candidates.B.original_answer_timing.finish_seconds = 20;
  input.candidates.A.original_answer_usage.total_tokens = 100;
  input.candidates.B.original_answer_usage.total_tokens = 50;
  const draft = requestComparisonSubmission(request, example.result as ComparisonResult);
  draft.comparisons.forEach(row => { if (row) row.importance = "low"; });
  draft.relative_preference = null;
  assert.throws(() => resolve(request, draft), hasIssue("relative_preference_required"));
});

test("both-bad equivalence cannot hide an unmapped confirmed common observation, including low-impact facts", () => {
  for (const candidate of ["A", "B"] as const) for (const type of ["problem", "strength"] as const)
    for (const importance of ["low", "medium", "high"] as const) {
      const request = structuredClone(example.request), input = request.input as unknown as ComparisonInput;
      for (const source of Object.values(input.attributions)) {
        source.core_assessment.meets_core = false;
        source.criterion_assessments[0].status = "unmet";
        source.findings[0].type = "problem";
      }
      const observation = structuredClone(input.attributions[candidate].findings[0]);
      observation.type = type;
      observation.importance = importance;
      observation.text = type === "problem" ? "附加交集表的并集计算错误。" : "附加交集表的并集计算正确。";
      observation.assessment.requirement_index = null;
      input.attributions[candidate].findings.push(observation);
      const draft = requestComparisonSubmission(request, example.result as ComparisonResult), before = structuredClone(request);
      draft.relative_preference = null;
      draft.tradeoff = "双方核心结果均错误，没有已确认差异，可视为等价。";
      assert.throws(() => resolve(request, draft), hasIssue("relative_preference_required"));
      draft.relative_preference = type === "strength" ? candidate : candidate === "A" ? "B" : "A";
      draft.tradeoff = "双方核心结果均错误；附加表的已确认差异只支持相对倾向，不能补齐共同核心交付。";
      const result = resolve(request, draft);
      comparisonProfile.validate!(request, result, audit);
      assert.equal(result.status, "decided");
      assert.deepEqual(result.ranking, [["A", "B"]]);
      assert.deepEqual(result.decision_basis.decisive_findings, []);
      assert.deepEqual(request, before);
    }
});

test("a source-only unmapped observation does not block equivalent common delivery", () => {
  const request = structuredClone(example.request), input = request.input as unknown as ComparisonInput;
  const observation = structuredClone(input.attributions.A.findings[0]);
  observation.type = "problem";
  observation.dimension = "instruction_following";
  observation.assessment.requirement_index = null;
  input.attributions.A.findings.push(observation);
  const draft = requestComparisonSubmission(request, example.result as ComparisonResult);
  draft.relative_preference = null;
  draft.tradeoff = "共同交付均已确认可用且无差异；本方私规问题保留在本方总评。";
  const result = resolve(request, draft);
  comparisonProfile.validate!(request, result, audit);
  assert.deepEqual(result.ranking, [["A", "B"]]);
});

test("relative choice follows the actual winner for both core and comparative decisions", () => {
  for (const basis of ["core", "advantage"] as const) {
    const request = structuredClone(example.request), input = request.input as unknown as ComparisonInput;
    if (basis === "core") {
      input.attributions.B.core_assessment.meets_core = false;
      input.attributions.B.criterion_assessments[0].status = "unmet";
      input.attributions.B.findings[0].type = "problem";
    }
    const draft = requestComparisonSubmission(request, example.result as ComparisonResult);
    if (basis === "advantage") {
      draft.comparisons[0] = { importance: "medium", better_candidate: "A" };
      draft.preference = "A";
    }
    for (const invalid of ["B", null] as const) {
      draft.relative_preference = invalid;
      assert.throws(() => resolve(request, draft), hasIssue("relative_preference_winner_mismatch"));
    }
    draft.relative_preference = "A";
    const result = resolve(request, draft);
    comparisonProfile.validate!(request, result, audit);
    assert.deepEqual(result.ranking, [["A"], ["B"]]);
    if (basis === "core") assert.deepEqual(result.decision_basis.decisive_findings,
      [{ candidate: "A", finding_index: 0 }, { candidate: "B", finding_index: 0 }]);
  }
});

test("decisive references exclude the winner's defects and the loser's counteradvantages", () => {
  const request = structuredClone(example.request), input = request.input as unknown as ComparisonInput;
  input.task_analysis.requirements.push({ id: "explanation", text: "解释计算过程", applies_to: [], acceptance_rule: "计算过程应正确。" });
  for (const label of ["A", "B"] as const) {
    const source = input.attributions[label];
    source.task_analysis = structuredClone(input.task_analysis);
    source.criterion_assessments.push({ criterion_id: "explanation", status: label === "A" ? "partial" : "met",
      evidence_status: "established", summary: label === "A" ? "解释需修正。" : "解释正确。" });
    const finding = structuredClone(source.findings[0]);
    finding.type = label === "A" ? "problem" : "strength";
    finding.assessment.requirement_index = 1;
    source.findings.push(finding);
  }
  input.attributions.B.findings[0].type = "problem";
  input.attributions.B.criterion_assessments[0].status = "partial";
  const draft = requestComparisonSubmission(request, example.result as ComparisonResult);
  draft.comparisons = [{ importance: "high", better_candidate: "A" }, { importance: "medium", better_candidate: "B" }];
  draft.preference = "A";
  draft.tradeoff = "【候选A】的主要结果更可用；其解释仍需修正，【候选B】的解释更好，但不能补齐主要结果。";
  const before = structuredClone(request), result = resolve(request, draft);
  comparisonProfile.validate!(request, result, audit);
  assert.equal(result.decision_basis.tradeoff, draft.tradeoff);
  assert.deepEqual(result.decision_basis.decisive_findings, [{ candidate: "A", finding_index: 0 }, { candidate: "B", finding_index: 0 }]);
  assert.deepEqual(result.decision_basis.comparisons[1].better_candidates, ["B"]);
  assert.deepEqual(request, before);
  for (const candidate of ["A", "B"]) {
    const invalid = structuredClone(result);
    invalid.decision_basis.decisive_findings.push({ candidate, finding_index: 1 });
    assert.throws(() => comparisonProfile.validate!(request, invalid, audit), hasIssue("decisive_finding_not_supporting_winner"));
  }
  draft.preference = null;
  const tied = resolve(request, draft);
  comparisonProfile.validate!(request, tied, audit);
  assert.deepEqual(tied.decision_basis.decisive_findings, []);
});
