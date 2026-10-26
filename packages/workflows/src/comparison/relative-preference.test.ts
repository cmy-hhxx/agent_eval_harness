import test from "node:test";
import assert from "node:assert/strict";
import { comparisonProfile, type ComparisonInput, type ComparisonResult } from "@eval/agents/comparison";
import example from "../../../agents/src/comparison/fixtures/example.json" with { type: "json" };
import { requestComparisonSubmission } from "../../../../tests/fixtures/comparison-submission.js";
import { display } from "./results.js";
import { decideVerdict } from "./verdicts.js";

test("swapping candidates restores the same relative preference without changing a both-good verdict", () => {
  const original = structuredClone(example.request);
  (original.input as unknown as ComparisonInput).candidates.A.original_answer_timing.finish_seconds = 10;
  (original.input as unknown as ComparisonInput).candidates.B.original_answer_timing.finish_seconds = 20;
  for (const swapped of [false, true]) {
    const request = structuredClone(original);
    if (swapped) {
      const { candidates, attributions } = request.input;
      [candidates.A, candidates.B] = [candidates.B, candidates.A];
      [attributions.A, attributions.B] = [attributions.B, attributions.A];
      [request.sources.A, request.sources.B] = [request.sources.B, request.sources.A];
    }
    const before = structuredClone(request.input.attributions);
    const draft = requestComparisonSubmission(request, example.result as ComparisonResult);
    draft.comparisons.forEach(row => { if (row) row.importance = "low"; });
    draft.relative_preference = swapped ? "B" : "A";
    draft.tradeoff = `质量相当，【候选${swapped ? "B" : "A"}】本次等待较短，【候选${swapped ? "A" : "B"}】等待较久。`;
    const result = comparisonProfile.resolve!(request, draft, {
      calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [],
    }) as ComparisonResult;
    const names = swapped ? { A: "乙组", B: "甲组" } : { A: "甲组", B: "乙组" };
    const shown = display(result.decision_basis.tradeoff, names);
    assert(shown.startsWith("相对更倾向甲组。"));
    assert(shown.includes("质量相当，甲组本次等待较短，乙组等待较久。"));
    assert(shown.includes("甲组：完成耗时：10 秒；总 token：无有效记录。"));
    assert(shown.includes("乙组：完成耗时：20 秒；总 token：无有效记录。"));
    assert.deepEqual(result.ranking, [["A", "B"]]);
    assert.equal(decideVerdict(true, true, 0, 0).outcome, "both_good");
    assert.deepEqual((request.input as unknown as ComparisonInput).attributions, before);
  }
});

test("swapped tradeoff binds each defect and measured resources to the same actual candidate", () => {
  const request = structuredClone(example.request), input = request.input as unknown as ComparisonInput;
  input.candidates.A.original_answer_timing.finish_seconds = 233.442;
  input.candidates.A.original_answer_usage.total_tokens = 215260;
  input.candidates.B.original_answer_timing.finish_seconds = 58.071;
  input.candidates.B.original_answer_usage.total_tokens = 58647;
  const draft = requestComparisonSubmission(request, example.result as ComparisonResult);
  draft.comparisons.forEach(row => { if (row) row.importance = "low"; });
  draft.relative_preference = "B";
  draft.tradeoff = "【候选A】没有席位数据却推断具体买方。【候选B】的小单净流入分类可用，机构出货仍须限定为资金类别。A/B类业务标记保持原义。";
  const result = comparisonProfile.resolve!(request, draft, {
    calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [],
  }) as ComparisonResult;
  const shown = display(result.decision_basis.tradeoff, { A: "B组Expert", B: "A组Expert" });
  assert.equal(shown, "相对更倾向A组Expert。" +
    "B组Expert没有席位数据却推断具体买方。A组Expert的小单净流入分类可用，机构出货仍须限定为资金类别。A/B类业务标记保持原义。 " +
    "B组Expert：完成耗时：233.442 秒；总 token：215260。 A组Expert：完成耗时：58.071 秒；总 token：58647。");
});

test("candidate display names replace bracketed and bare blind labels while preserving evidence quotes", () => {
  assert.deepEqual(
    display({ summary: "候选A有缺陷，【候选B】更完整，候选C保留原文。", quote: "候选A原文不能替换。" },
      { A: "B组Fast", B: "A组Fast" }),
    { summary: "B组Fast有缺陷，A组Fast更完整，候选C保留原文。", quote: "候选A原文不能替换。" },
  );
});
