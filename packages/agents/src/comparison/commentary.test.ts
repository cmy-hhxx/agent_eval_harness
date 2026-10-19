import test from "node:test";
import assert from "node:assert/strict";
import { AgentRegistry } from "@eval/host";
import { comparisonAgent, comparisonSlotChoices, type ComparisonInput, type ComparisonResult } from "./index.js";
import { requestComparisonSubmission } from "../../../../tests/fixtures/comparison-submission.js";
import { canonicalEvidence } from "../../../../tests/fixtures/evidence.js";
import example from "./fixtures/example.json" with { type: "json" };

const audit = { calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [] };

for (const usable of [true, false]) for (const relative of ["A", "B"] as const) {
  test(`${usable ? "both-good" : "both-bad"} explicitly states ${relative} relative preference without changing its verdict`, () => {
    const request = structuredClone(example.request), input = request.input as unknown as ComparisonInput;
    input.candidates.A.original_answer_timing.finish_seconds = 10;
    input.candidates.B.original_answer_timing.finish_seconds = 20;
    input.candidates.A.original_answer_usage.total_tokens = 100;
    input.candidates.B.original_answer_usage.total_tokens = 50;
    if (!usable) for (const label of ["A", "B"] as const) {
      const attribution = input.attributions[label];
      const final = label === "A" ? "2+2=3" : "2+2=5";
      request.sources[label].value.messages[1].content = final;
      request.input.candidates[label].final_answer = final;
      Object.assign(request.input.attributions[label], { is_correct: false, correctness_reason: "2+2应为4。",
        correctness_evidence: [canonicalEvidence(request.sources[label].id, 1, final)] });
      Object.assign(attribution.core_assessment, { meets_core: false, reason: "所求加法结果错误。" });
      Object.assign(attribution.criterion_assessments[0], { status: "unmet", summary: "所求结果不是4。",
        evidence: [canonicalEvidence(request.sources[label].id, 1, final)] });
      Object.assign(attribution.findings[0], { type: "problem", text: "所求加法结果错误。", reason: "2+2应为4。",
        evidence: [canonicalEvidence(request.sources[label].id, 1, final)],
        problem: { component: [], label: "计算错误", definition: "加法结果错误。" } });
      Object.assign(attribution.findings[0].assessment, { observation: final, impact: "所求结果不可用，须重新计算。" });
    }
    const draft = requestComparisonSubmission(request, example.result as ComparisonResult);
    draft.comparisons.forEach(row => {
      if (!row) return;
      row.importance = "low";
    });
    if (!usable) { draft.a_summary = "给出3，所求结果错误。"; draft.b_summary = "给出5，所求结果错误。"; }
    draft.tradeoff = "所求结果及修正成本相当，【候选A】本次等待较短，【候选B】本次记录用量较少。";
    Object.assign(draft, { relative_preference: relative });
    const before = structuredClone(request), registry = new AgentRegistry([comparisonAgent]);
    const binding = { agent: "comparison", profile: "default", request };
    const result = registry.resolve(binding, draft, audit) as ComparisonResult;
    registry.validate(binding, result, audit);
    assert.equal(result.status, "decided");
    assert.deepEqual(result.ranking, [["A", "B"]]);
    assert.deepEqual(Object.values(result.assessments).map(item => item.meets_core), [usable, usable]);
    assert.deepEqual(result.decision_basis.decisive_findings, []);
    assert.equal(result.decision_basis.tradeoff, `相对更倾向【候选${relative}】。` +
      "所求结果及修正成本相当，【候选A】本次等待较短，【候选B】本次记录用量较少。 " +
      "【候选A】：完成耗时：10 秒；总 token：100。 【候选B】：完成耗时：20 秒；总 token：50。");
    assert.deepEqual(request, before, "source facts and receipts are never rewritten to justify a relative preference");
  });
}

test("comparison cells put accepted facts beside standards without creating a defect from supplementary reference text", () => {
  const request = structuredClone(example.request), input = request.input as unknown as ComparisonInput;
  request.input.ground_truth.value = "4；补充背景：这一数字用于国际通行教材。";
  input.attributions.A.findings[0].reason = "最终结果为4，与原题一致。";
  input.attributions.A.findings[0].assessment.impact = "用户可直接采用结果，无需补算。";
  const before = structuredClone(request);
  const cell = comparisonSlotChoices(request)[0] as unknown as {
    accepted_assessments: Record<string, { status: string; evidence_status: string; summary: string }[]>;
    observations: Record<string, { type: string; text: string; reason: string; impact: string; evidence_status: string }[]>;
  };
  assert.deepEqual(cell.accepted_assessments.A, [{ status: "met", evidence_status: "established", summary: "正确给出4。" }]);
  assert.deepEqual(cell.accepted_assessments.B, [{ status: "met", evidence_status: "established", summary: "正确给出4。" }]);
  assert.deepEqual(cell.observations.A, [{ type: "strength", text: "加法结果正确", evidence_status: "established",
    reason: "最终结果为4，与原题一致。", impact: "用户可直接采用结果，无需补算。" }]);
  assert(!JSON.stringify(cell.accepted_assessments).includes("国际通行教材"));
  assert(!JSON.stringify(cell.observations).includes("国际通行教材"));
  assert.deepEqual(request, before);
});
