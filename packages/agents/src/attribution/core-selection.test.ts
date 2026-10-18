import { validateJudgment } from "./validate.js";
import { resolveJudgment } from "./resolve.js";
import test from "node:test";
import assert from "node:assert/strict";
import { AgentRegistry } from "@eval/host";
import { ValidationError, type AgentRequest, type TaskAnalysis } from "@eval/contracts";
import { attributionAgent, attributionProfile, type AttributionResult } from "./index.js";
import example from "./fixtures/example.json" with { type: "json" };
import { prepareFixtureEvidence } from "../../../../tests/fixtures/evidence.js";
import { attributionJudgment } from "../../../../tests/fixtures/attribution-judgment.js";

const audit = { calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [] };
function fixture() {
  const request = structuredClone(example.request) as AgentRequest;
  const draft = attributionJudgment(request, structuredClone(example.result) as AttributionResult);
  const reference = draft.correctness_evidence[0]!;
  return { request, draft, reference };
}

test("model core selectors bind original numeric requirements to formal IDs without changing a judgment", () => {
  const { request, draft } = fixture();
  const registry = new AgentRegistry([attributionAgent]), binding = { agent: "attribution", profile: "default", request };
  const prepared = prepareFixtureEvidence(registry, binding);
  const properties = prepared.evaluation.outputSchema.properties as Record<string,any>;
  assert.equal(properties.core_requirements.items.minimum,1);
  assert(!Object.hasOwn(properties,"core_assessment"));
  const before = structuredClone({ request, draft, audit });
  const result = resolveJudgment(binding.request, draft, audit) as AttributionResult;
  registry.validate(binding, result, audit);
  assert.deepEqual(result.core_assessment, { meets_core: draft.core_assessment.meets_core,
    reason: draft.core_assessment.reason, criterion_ids: ["r1"] });
  assert.equal(Object.hasOwn(result.core_assessment, "requirement_indices"), false);
  assert.deepEqual({ request, draft, audit }, before);
  assert.deepEqual(resolveJudgment(binding.request, draft, audit), result, "retries retain exact program associations");
});

test("core selection retains global indices across an unowned requirement", () => {
  const { request, draft, reference } = fixture();
  const analysis = request.input.task_analysis as unknown as TaskAnalysis;
  analysis.requirements.push({ ...analysis.requirements[0], id: "r2", applies_to: ["22222222-2222-4222-8222-222222222222"] },
    { ...analysis.requirements[0], id: "r3" });
  draft.criterion_assessments.push({ ...draft.criterion_assessments[0], criterion_id: "r3", evidence: [reference] });
  draft.core_assessment.requirement_indices = [2, 0];
  const result = resolveJudgment(request, draft, audit) as AttributionResult;
  attributionProfile.validate!(request, result, audit);
  assert.deepEqual(result.core_assessment.criterion_ids, ["r3", "r1"]);
  assert.equal(result.criterion_assessments.find(item => item.criterion_id === "r2")!.status, "not_applicable");
});

test("bad core selections report every real raw path and only applicable numeric choices", () => {
  const { request, draft } = fixture();
  const analysis = request.input.task_analysis as unknown as TaskAnalysis;
  analysis.requirements.push({ ...analysis.requirements[0], id: "r2", applies_to: ["22222222-2222-4222-8222-222222222222"] });
  draft.core_assessment.requirement_indices = [9, 1];
  const before = structuredClone({ request, draft });
  const issues = validateJudgment(request, draft, audit).filter(issue => issue.code.startsWith("core_requirement_"));
  assert.deepEqual(issues.map(issue => [issue.code, issue.path, issue.actual, issue.expected]), [
    ["core_requirement_index_invalid", "/core_assessment/requirement_indices/0", 9, [0]],
    ["core_requirement_not_applicable", "/core_assessment/requirement_indices/1", 1, [0]],
  ]);
  assert.throws(() => resolveJudgment(request, draft, audit), (error: unknown) =>
    error instanceof ValidationError && issues.every(expected => error.issues!.some(issue =>
      issue.code === expected.code && issue.path === expected.path)));
  assert.deepEqual({ request, draft }, before);
});

test("core failure still needs confirmed gaps while uncertainty is preserved with its reason", () => {
  const { request, draft } = fixture();
  const failed = { ...draft, core_assessment: { ...draft.core_assessment, meets_core: false } };
  assert(validateJudgment(request, failed, audit).some(issue => issue.code === "core_failure_unsupported"));
  const pending = { ...draft, core_assessment: { ...draft.core_assessment, meets_core: null,
    reason: "局部要求已确认，整体完成情况仍缺核实。" } };
  assert.equal((resolveJudgment(request, pending, audit) as AttributionResult).core_assessment.meets_core, null);
});

test("candidate-only requirements remain assessable but cannot determine common core usability", () => {
  const { request, draft } = fixture();
  const analysis = request.input.task_analysis as unknown as TaskAnalysis;
  analysis.requirements.push({ ...analysis.requirements[0], id: "private", applies_to: [request.input.candidate_id as string] });
  draft.criterion_assessments.push({ ...draft.criterion_assessments[0], criterion_id: "private", status: "unmet" });
  draft.core_assessment = { meets_core: false, reason: "仅本方格式未满足。", requirement_indices: [1] };
  const issues = validateJudgment(request, draft, audit);
  assert(issues.some(issue => issue.code === "core_requirement_private" && issue.path === "/core_assessment/requirement_indices/0"));
  const schema = attributionProfile.modelSubmissionSchema!(request) as any;
  assert.deepEqual(schema.properties.core_requirements.items.enum, [1]);
  assert.equal(schema.properties.criterion_assessments.minItems, draft.criterion_assessments.length,
    "private compliance still needs its own assessment");
  draft.core_assessment = { meets_core: true, reason: "共同任务结果已完成，私有格式问题单列。", requirement_indices: [0] };
  assert(!validateJudgment(request, draft, audit).some(issue => issue.code.startsWith("core_")));
});

test("a selected unmet core requirement cannot be hidden by another met requirement", () => {
  const { request, draft } = fixture();
  const analysis = request.input.task_analysis as unknown as TaskAnalysis;
  analysis.requirements.push({ ...analysis.requirements[0], id: "limit", text: "交付必须满足规定的时间限制。" });
  draft.criterion_assessments.push({ ...draft.criterion_assessments[0], criterion_id: "limit", status: "unmet" });
  draft.core_assessment.requirement_indices = [0, 1];
  assert(validateJudgment(request, draft, audit).some(issue => issue.code === "core_success_unmet"));
  draft.core_assessment.meets_core = false;
  assert(!validateJudgment(request, draft, audit).some(issue => issue.code.startsWith("core_")));
});
