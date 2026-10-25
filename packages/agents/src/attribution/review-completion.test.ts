import test from "node:test";
import assert from "node:assert/strict";
import { ValidationError, type AgentRequest, type ToolAudit } from "@eval/contracts";
import { canonicalEvidence } from "../../../../tests/fixtures/evidence.js";
import { attributionJudgment } from "../../../../tests/fixtures/attribution-judgment.js";
import { setFixtureNormDirectory } from "../../../../tests/fixtures/attribution-submission.js";
import { resolveJudgment } from "./resolve.js";
import { validateEvaluation, validateJudgment } from "./validate.js";
import type { AttributionResult } from "./types.js";
import example from "./fixtures/example.json" with { type: "json" };

const claim = "I found no leveraged ETF with a verified POWL holding in the available data.";
const audit: ToolAudit = { calls: 0, requiredReadCalls: 0,
  traceReads: [{candidate:"answer",message_index:1,kind:"text",path:"/content",start:0,end:claim.length}],
  viewedImages: [], calculations: [], artifacts: [] };
function fixture() {
  const request = structuredClone(example.request) as AgentRequest;
  const raw = request.sources.answer.value as { messages: Record<string, unknown>[] };
  raw.messages[0]!.content = "Leveraged ETF that has holding of POWL";
  raw.messages[1]!.content = claim;
  Object.assign(request.input.answer as object, { question: raw.messages[0]!.content, final_answer: claim });
  request.input.ground_truth = { available: false, value: null };
  const result = structuredClone(example.result) as AttributionResult;
  result.task_analysis.requirements[0]!.text = "核查持有 POWL 的杠杆 ETF";
  result.task_analysis.requirements[0]!.acceptance_rule = "回答按实际检索范围说明持仓结果及限制。";
  result.task_analysis.scoring_points = []; result.task_analysis.red_flags = [];
  request.input.task_analysis = structuredClone(result.task_analysis) as unknown as AgentRequest["input"][string];
  result.has_standard_answer = false; result.is_correct = null; result.correctness_reason = "";
  result.correctness_evidence = []; result.numeric_checks = []; result.findings = [];
  result.criterion_assessments = [result.criterion_assessments[0]!];
  result.criterion_assessments[0]!.evidence = [canonicalEvidence(request.sources.answer.id, 1, claim)];
  result.summary = "回答限定为现有数据中的可核验持仓，未扩大为全市场不存在。";
  result.core_assessment.reason = "回答明确交付现有数据查询结论及范围。";
  result.criterion_assessments[0]!.summary = result.summary;
  setFixtureNormDirectory(request);
  return { request, result };
}
function unknown(result: AttributionResult) {
  result.core_assessment.meets_core = null;
  Object.assign(result.criterion_assessments[0]!, { status: "unknown", evidence_status: "uncertain",
    uncertainty: { claim, missing_evidence: "未采集覆盖该检索时点的完整杠杆基金持仓目录，不能据此核实集合穷尽性。",
      impact: "可确认回答限制了检索范围，尚不能独立确认是否遗漏符合条件的基金。" } });
}
test("POWL-style empty review cannot pass using only user context, regardless of placeholder wording", () => {
  for (const text of ["占位", "稍后核实", "尚待开展本项评审"]) {
    const { request, result } = fixture(); unknown(result);
    delete result.criterion_assessments[0]!.uncertainty;
    result.summary = result.core_assessment.reason = result.criterion_assessments[0]!.summary = text;
    result.criterion_assessments[0]!.evidence = [canonicalEvidence(request.sources.answer.id, 0, "Leveraged ETF that has holding of POWL")];
    const issues = validateJudgment(request, attributionJudgment(request, result), audit);
    assert(issues.some(issue => issue.code === "criterion_uncertainty_required"));
    assert(issues.some(issue => issue.code === "criterion_delivery_evidence_required"));
  }
});
test("a specific unknown claim remains reviewable without inventing a problem", () => {
  const { request, result } = fixture(); unknown(result);
  const resolved = resolveJudgment(request, attributionJudgment(request, result), audit) as AttributionResult;
  validateEvaluation(request, resolved, audit);
  assert.equal(resolved.findings.length, 0);
  assert.deepEqual(resolved.criterion_assessments[0]!.uncertainty, result.criterion_assessments[0]!.uncertainty);
});
test("an evidence-backed no-problem assessment remains acceptable", () => {
  const { request, result } = fixture();
  const resolved = resolveJudgment(request, attributionJudgment(request, result), audit) as AttributionResult;
  validateEvaluation(request, resolved, audit);
  assert.equal(resolved.findings.length, 0);
});
test("repairing structure does not bypass the business review gate", () => {
  const { request, result } = fixture(); unknown(result);
  result.criterion_assessments[0]!.uncertainty!.claim = "需要核实";
  const draft = attributionJudgment(request, result);
  for (const submitted of [{ ...draft, summary: 5 }, draft]) {
    assert.throws(() => resolveJudgment(request, submitted, audit), (error: unknown) =>
      error instanceof ValidationError && error.issues!.some(issue => issue.code === "criterion_uncertainty_claim_unbound"));
  }
  assert.throws(() => validateEvaluation(request, result, audit), (error: unknown) =>
    error instanceof ValidationError && error.issues!.some(issue => issue.code === "criterion_uncertainty_claim_unbound"));
});

test("unknown review requests protected reads for selected unread upstream evidence only", () => {
  const { request, result } = fixture(); unknown(result);
  const source = canonicalEvidence(request.sources.answer.id, 0, "Leveraged ETF that has holding of POWL");
  result.criterion_assessments[0]!.evidence.push(source);
  const draft = attributionJudgment(request, result);
  const issues = validateJudgment(request, draft, audit);
  const required = issues.find(issue => issue.code === "investigation_read_required");
  assert.deepEqual(required?.expected, {read_requests:[{candidate:"answer",message_index:0,kind:"text",path:"/content",start:0,end:source.quote.length}]});
  const supplied = {...audit, traceReads:[...audit.traceReads,{candidate:"answer",message_index:0,kind:"text" as const,path:"/content",start:0,end:source.quote.length}]};
  assert.equal(validateJudgment(request, draft, supplied).length, 0);
  assert.equal(validateJudgment(request, draft, supplied).filter(issue=>issue.code==="investigation_read_required").length, 0);
});
