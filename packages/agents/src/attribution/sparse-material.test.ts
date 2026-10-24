import { responsibilityFixture, responsibilitySubmissionFixture } from "../../../../tests/fixtures/responsibility.js";
import assert from "node:assert/strict";
import test from "node:test";
import { AgentRegistry } from "@eval/host";
import { ValidationError, type AgentRequest, type ToolAudit } from "@eval/contracts";
import { attributionAgent, attributionProfile, type AttributionResult } from "./index.js";
import example from "./fixtures/example.json" with { type: "json" };
import { canonicalEvidence } from "../../../../tests/fixtures/evidence.js";
import { attributionSubmission, setFixtureNormDirectory } from "../../../../tests/fixtures/attribution-submission.js";

function fixture(question = "计算2+2", final = "4") {
  const request = structuredClone(example.request) as AgentRequest;
  const messages = [{ type: "message", role: "user", content: question },
    { type: "message", role: "assistant", content: final }];
  (request.sources.answer.value as { messages: unknown[] }).messages = messages;
  const evidence = canonicalEvidence(request.sources.answer.id, 1, final);
  Object.assign(request.input.answer as object, { question, final_answer: final, final_evidence: [evidence],
    catalog: messages.map((message, message_index) => ({ message_index, type: message.type, role: message.role,
      chars: JSON.stringify(message).length })) });
  const analysis = { task_type: "整数加法", goal: question,
    requirements: [{ id: "r1", text: question, applies_to: [], acceptance_rule: question }],
    scoring_points: [], red_flags: [] };
  request.input.task_analysis = analysis;
  const norms = setFixtureNormDirectory(request);
  const result = structuredClone(example.result) as AttributionResult;
  result.task_analysis = analysis;
  result.correctness_evidence = [evidence];
  result.findings = [];
  result.criterion_assessments = [{ criterion_id: "r1", status: "met", evidence_status: "established",
    summary: "最终结果为4，符合题目要求。", evidence: [evidence] }];
  const audit: ToolAudit = { calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [],
    calculations: [], artifacts: [], evidenceBank: [] };
  const registry = new AgentRegistry([attributionAgent]);
  const binding = { agent: "attribution", profile: "default", request };
  const resolve = () => {
    const draft = attributionSubmission(request, result, audit);
    const accepted = registry.resolve(binding, draft, audit) as AttributionResult;
    registry.validate(binding, accepted, audit);
    return accepted;
  };
  return { request, result, evidence, norms, audit, registry, binding, resolve };
}

test("final-only answers can confirm correctness and core delivery without private rules or process evidence", () => {
  const f = fixture();
  assert(f.norms.every(norm => norm.roles.every(role => role === "user")));
  const schema = attributionProfile.modelSubmissionSchema!(f.request) as {
    properties: { problems: { items: { properties: { component: { items: { enum: string[] } } } } } } };
  assert((schema.properties.problems.items.properties.component.items as any).properties.component.enum.includes("回答模型"));
  const accepted = f.resolve();
  assert.equal(accepted.is_correct, true);
  assert.equal(accepted.core_assessment.meets_core, true);
  assert.equal(accepted.criterion_assessments[0].evidence_status, "established");
  assert.deepEqual(accepted.findings, []);
  assert.equal(f.audit.calls, 0);
  assert.deepEqual(f.audit.traceReads, []);
});

test("a confirmed final-answer error stays established when its component cannot be located", () => {
  const f = fixture("计算2+2", "5");
  f.result.is_correct = false;
  f.result.correctness_reason = "回答为5，标准答案为4。";
  f.result.core_assessment = { meets_core: false, reason: "唯一所求结果错误。", criterion_ids: ["r1"] };
  f.result.criterion_assessments[0].status = "unmet";
  f.result.criterion_assessments[0].summary = "回答为5，无法完成所求计算。";
  f.result.findings = [{ finding_id: "f0", type: "problem", dimension: "correctness", stage: "final_answer",
    importance: "high", text: "加法结果错误。", reason: "回答为5，标准答案为4，未提供过程记录。",
    evidence: [f.evidence], assessment: { requirement_index: 0, observation: "最终结果为5。",
      evidence_status: "established", impact: "唯一所求结果不能使用。" },
    problem: { component: [responsibilityFixture("回答模型",{evidence_ids:[f.evidence.evidence_id]})], label: "结果错误", definition: "最终结果错误，现有材料无法定位出错环节。" } }];
  const accepted = f.resolve();
  assert.equal(accepted.is_correct, false);
  assert.equal(accepted.core_assessment.meets_core, false);
  assert.equal(accepted.findings[0].assessment.evidence_status, "established");
  assert.equal(accepted.findings[0].problem!.component[0].certainty,"inferred");
  assert.equal(accepted.findings[0].stage, "final_answer");
  const invented = attributionSubmission(f.request, accepted, f.audit);
  invented.problems[0].component = [responsibilitySubmissionFixture("InvisibleCalculator")];
  assert.throws(() => f.registry.resolve(f.binding, invented, f.audit), error =>
    error instanceof ValidationError && error.issues!.some(issue => issue.code === "schema_enum" ||
      issue.code === "responsibility_actor"));
});

test("an explicit execution requirement can remain unknown while the visible result is correct", () => {
  const f = fixture("实际调用计算工具得到2+2的结果", "已调用计算工具，结果为4。");
  f.result.criterion_assessments[0] = { criterion_id: "r1", status: "unknown", evidence_status: "uncertain",
    summary: "最终结果正确，实际工具调用没有可核查记录。", evidence: [f.evidence] };
  f.result.core_assessment = { meets_core: null, reason: "题目要求实际调用工具，该动作尚未确认。",
    criterion_ids: ["r1"] };
  const accepted = f.resolve();
  assert.equal(accepted.is_correct, true);
  assert.equal(accepted.core_assessment.meets_core, null);
  assert.equal(accepted.criterion_assessments[0].status, "unknown");
  assert.deepEqual(accepted.findings, []);
});
