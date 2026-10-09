import { canonicalEvidence } from "../../../../tests/fixtures/evidence.js";
import test from "node:test";
import assert from "node:assert/strict";
import type { AgentRequest, CriteriaInput, JsonObject } from "@eval/contracts";
import { attributionTableChecks, attributionTableReview, type AttributionResult } from "@eval/agents/attribution";
import { parseTraceTables } from "@eval/tools";
import { attributionResult, criteriaResult } from "../../../../tests/fixtures/comparison.js";
import { comparisonSourceReview } from "./source-review.js";


const question = "按查询来源输出可直接录入的股票代码与名称。";
const source = "| 代码 | 名称 |\n|---|---|\n| 111111 | 冲突标的 |\n| 222222 | 已匹配 |";
const failedAnswer = "| 代码 | 名称 |\n|---|---|\n| 999999 | 冲突标的 |\n| 222222 | 已匹配 |\n| 333333 | 未展示标的 |";
function fixture() {
  const candidateIds = { A: "c52a0828-766a-41af-ac62-3cf9e3e680a1", B: "38ae1a74-38cd-43b9-9d32-b1100d03f5e4" };
  const analysis = criteriaResult({ question, ground_truth: { available: false, value: null },
    candidates: Object.values(candidateIds).map(candidate_id => ({ candidate_id, instructions: [], context: [] })) } satisfies CriteriaInput);
  const raw = (answer: string) => ({ messages: [{ role: "user", content: question },
    { role: "tool", name: "lookup", type: "tool_result", content: source }, { role: "assistant", content: answer }] });
  const sources = { A: { id: candidateIds.A, value: raw(source) }, B: { id: candidateIds.B, value: raw(failedAnswer) } };
  const attributions = Object.fromEntries(["A", "B"].map(label => {
    const result = attributionResult(label === "A", label === "A" ? source : failedAnswer, false, candidateIds[label as keyof typeof candidateIds]);
    result.task_analysis = structuredClone(analysis);
    result.criterion_assessments = [{ criterion_id: "r1", status: label === "A" ? "met" : "partial", evidence_status: "established",
      summary: label === "A" ? "可录入的代码与名称正确。" : "一行代码与来源冲突。", evidence: [] }];
    result.findings[0].evidence = label === "A" ? [canonicalEvidence(sources.A.id, 2, source)]
      : parseTraceTables(sources.B.value, sources.B.id).map(table => ({ ...table.rows[0].evidence }));
    return [label, result];
  })) as Record<string, AttributionResult>;
  const request: AgentRequest = { sources, input: { ground_truth: { available: false, value: null }, task_analysis: analysis, attributions,
    candidates: Object.fromEntries(Object.entries(candidateIds).map(([label, candidate_id]) => [label, {
      candidate_id, final_message_index: 2, deferred_final_material: [], original_answer_timing: { finish_seconds: null },
      original_answer_usage: { total_tokens: null, issues: [] },
    }])) } as unknown as JsonObject };
  const reviews = () => Object.fromEntries(Object.entries(sources).map(([label, value]) => [label,
    attributionTableReview({ sources: { answer: value }, input: { answer: { final_message_index: 2,
      table_check_results: attributionTableChecks(value.value, value.id, 2) } } }, attributions[label])]));
  return { request, sources, attributions, analysis, reviews };
}

test("table matching concerns remain visible without overriding any semantic core judgment", () => {
  for (const core of [true, false, null]) {
    const data = fixture();
    data.attributions.B.core_assessment.meets_core = core;
    data.sources.A.value.messages[2].content += "\n| 555555 | 别名 |";
    data.sources.B.value.messages[1].content += "\n| 444444 | 已匹配 |";
    const before = structuredClone(data.request), reviews = data.reviews(), initial = structuredClone(reviews);
    const result = comparisonSourceReview(data.request, reviews);
    assert(result.A.some(item => item.kind === "unverified"));
    assert(result.B.some(item => item.kind === "unresolved_conflict"));
    assert(Object.values(result).flat().every(item => !item.requires_review));
    assert.deepEqual(data.request, before);
    assert.deepEqual(reviews, initial);
  }
});

test("invalid recomputed material remains blocking independently of the core judgment", () => {
  const data = fixture(), reviews = data.reviews();
  reviews.B = attributionTableReview({ sources: { answer: data.sources.B }, input: { answer: {
    final_message_index: 2, table_check_results: [],
  } } }, data.attributions.B);
  const result = comparisonSourceReview(data.request, reviews);
  assert(result.B.some(item => item.kind === "invalid_material" && item.requires_review));
  assert(result.B.filter(item => item.kind !== "invalid_material").every(item => !item.requires_review));
});
