import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRequest, ToolAudit } from "@eval/contracts";
import { comparisonProfile, comparisonSlots, type ComparisonInput, type ComparisonResult } from "./index.js";
import { resolveComparison } from "./resolve.js";
import example from "./fixtures/example.json" with { type: "json" };
import { requestComparisonSubmission } from "../../../../tests/fixtures/comparison-submission.js";

const audit: ToolAudit = { calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [] };

test("known final-only core delivery does not require a source review for unknown non-core process facts", () => {
  const request = structuredClone(example.request) as AgentRequest;
  const input = request.input as unknown as ComparisonInput;
  const process = { id: "process", text: "按建议检查可选工具调用", applies_to: [], acceptance_rule: "检查可选工具调用" };
  input.task_analysis.scoring_points.push(process);
  for (const attribution of Object.values(input.attributions)) {
    attribution.task_analysis = structuredClone(input.task_analysis);
    attribution.criterion_assessments.push({ criterion_id: "process", status: "unknown", evidence_status: "uncertain",
      summary: "过程没有可核查记录。" });
  }
  const draft = requestComparisonSubmission(request, example.result as ComparisonResult);
  draft.comparisons = draft.comparisons.map(row => row ?? { importance: "low" });
  const result = resolveComparison(request, draft);
  comparisonProfile.validate!(request, result, audit);
  assert.equal(result.status, "decided");
  assert.deepEqual(result.review_requests, []);
  assert.deepEqual(result.ranking, [["A", "B"]]);
  assert(result.decision_basis.comparisons.some(row => row.criterion_ids.includes("process") &&
    Object.values(row.assessments).every(cell => cell.status === "unknown")));
});

test("an unverified required execution leaves the source core pending and the comparison needs_review", () => {
  const request = structuredClone(example.request) as AgentRequest;
  const input = request.input as unknown as ComparisonInput;
  input.task_analysis.requirements[0].text = "实际调用计算工具得到2+2的结果";
  input.task_analysis.requirements[0].acceptance_rule = input.task_analysis.requirements[0].text;
  for (const attribution of Object.values(input.attributions)) {
    attribution.task_analysis = structuredClone(input.task_analysis);
    attribution.findings = [];
    attribution.criterion_assessments[0].status = "unknown";
    attribution.criterion_assessments[0].evidence_status = "uncertain";
    attribution.criterion_assessments[0].summary = "结果可见，实际工具调用尚未确认。";
    attribution.core_assessment.meets_core = null;
    attribution.core_assessment.reason = "题目要求的实际执行没有可核查记录。";
  }
  const draft = { a_summary: "结果为4，实际执行未知。", b_summary: "结果为4，实际执行未知。",
    tradeoff: "双方实际执行尚未确认。", relative_preference: "A", comparisons: comparisonSlots(request).map(() => ({ importance: "low" })) };
  const result = resolveComparison(request, draft);
  comparisonProfile.validate!(request, result, audit);
  assert.equal(result.status, "needs_review");
  assert.deepEqual(result.ranking, []);
  assert.deepEqual(result.review_requests.map(review => [review.candidate, review.criterion_ids]),
    [["A", ["sum"]], ["B", ["sum"]]]);
});
