const INPUT_ID = "11111111-1111-4111-8111-111111111111";
import test from "node:test";
import assert from "node:assert/strict";
import { attributionAgent, attributionProfile } from "./index.js";
import type { AttributionResult } from "./types.js";
import example from "./fixtures/example.json" with { type: "json" };
import { cite, evidenceSources } from "@eval/tools";
import { projectEvidenceReferences, ValidationError, type AgentRequest, type TaskAnalysis, type ToolAudit } from "@eval/contracts";
import { Ajv2020 } from "ajv/dist/2020.js";
import { AgentRegistry } from "@eval/host";
import { canonicalEvidence, resolveFixtureEvidence, prepareFixtureEvidence } from "../../../../tests/fixtures/evidence.js";
import { attributionSubmission, setFixtureNormDirectory } from "../../../../tests/fixtures/attribution-submission.js";

const audit = { calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [] };
const fixtureSubmission = (result: AttributionResult = structuredClone(example.result) as AttributionResult,
  request: AgentRequest = example.request) => {
    setFixtureNormDirectory(request);
    return attributionSubmission(request, result);
  };
function responsibilityCase() {
  const request = structuredClone(example.request) as AgentRequest;
  request.input.ground_truth = { available: false, value: null };
  const raw = request.sources.answer.value as { messages: Record<string, unknown>[] };
  raw.messages = [
    { role: "user", content: "计算2+2" },
    { type: "function_call_output", name: "Search", output: "其他检索结果。" },
    { type: "function_call_output", name: "CodeInterpreter", output: "301689.SZ 电科思仪" },
    { role: "assistant", content: "2+2=4；688255.SH 电科思仪" },
  ];
  Object.assign(request.input.answer as object, { final_message_index: 3,
    catalog: raw.messages.map((message, message_index) => ({
      message_index, type: message.type ?? "message", role: message.role, name: message.name, chars: JSON.stringify(message).length,
    })) });
  const result = structuredClone(example.result) as AttributionResult;
  const final = canonicalEvidence(INPUT_ID, 3, "2+2=4；688255.SH 电科思仪");
  result.findings[0]!.evidence = [final];
  result.criterion_assessments.forEach(item => { item.evidence = [final]; });
  const draft = fixtureSubmission(result, request);
  const finding = Object.assign(draft.findings[0]!, { type: "problem", dimension: "correctness",
    text: "电科思仪代码来源冲突", reason: "原输出与实际交付代码不同，核查返回的责任。",
    evidence: [{ evidence_id: final.evidence_id },
      { evidence_id: canonicalEvidence(INPUT_ID, 2, "301689.SZ 电科思仪", "/output").evidence_id }],
    assessment: { ...draft.findings[0]!.assessment, requirement_index: null },
    problem: { model_responsible: false, tool_evidence_indices: [1], label: "代码来源冲突",
      definition: "责任指向本条已选择的工具返回，不能猜测未引用的 Search。" } });
  return { request, draft: { ...draft, findings: [finding] }, binding: { agent: "attribution", profile: "default", request } };
}
test("responsibility selections bind the responsible tool to this finding rather than the call-chain name menu", () => {
  const { draft, binding } = responsibilityCase(), registry = new AgentRegistry([attributionAgent]);
  const before = structuredClone(draft);
  const accepted = resolveFixtureEvidence(registry, binding, draft, audit) as AttributionResult;
  registry.validate(binding, accepted, audit);
  assert.deepEqual(accepted.findings[0]!.problem!.component, ["CodeInterpreter"]);
  assert.deepEqual(Object.keys(accepted.findings[0]!.problem!).sort(), ["component", "definition", "label"]);
  assert.deepEqual(draft, before);
});
test("responsibility selections preserve model-only and unknown responsibility despite cited tool outputs", () => {
  for (const model_responsible of [true, false]) {
    const { draft, binding } = responsibilityCase(), registry = new AgentRegistry([attributionAgent]);
    Object.assign(draft.findings[0]!.problem!, { model_responsible, tool_evidence_indices: [] });
    const result = resolveFixtureEvidence(registry, binding, draft, audit) as AttributionResult;
    registry.validate(binding, result, audit);
    assert.deepEqual(result.findings[0]!.problem!.component, model_responsible ? ["模型自身推理"] : []);
    assert.equal(result.findings[0]!.assessment.evidence_status, "established", "unknown responsibility does not erase an established observation");
  }
});
test("responsibility selections keep proven local responsibility when an upstream cause remains unknown", () => {
  const { draft, binding } = responsibilityCase(), registry = new AgentRegistry([attributionAgent]);
  draft.findings[0]!.problem!.definition = "该工具本次独立失误已证实；上游根因仍未知。";
  const result = resolveFixtureEvidence(registry, binding, draft, audit) as AttributionResult;
  registry.validate(binding, result, audit);
  assert.deepEqual(result.findings[0]!.problem!.component, ["CodeInterpreter"]);
});
test("responsibility selections give repairs only the cited own-tool positions and reject free component names", () => {
  const { request, draft, binding } = responsibilityCase(), registry = new AgentRegistry([attributionAgent]);
  for (const index of [0, 2]) {
    draft.findings[0]!.problem!.tool_evidence_indices = [index];
    assert.throws(() => resolveFixtureEvidence(registry, binding, draft, audit), (error: unknown) => {
      assert(error instanceof ValidationError);
      const issue = error.issues!.find(item => item.code === "problem_tool_evidence_invalid")!;
      assert.equal(issue.path, "/findings/0/problem/tool_evidence_indices/0");
      assert.deepEqual((issue.expected as { tool_evidence_choices: unknown }).tool_evidence_choices,
        [{ finding_evidence_index: 1, tool_name: "CodeInterpreter" }]);
      assert(!JSON.stringify(issue.expected).includes("Search"), "an unrelated called tool must not become a repair suggestion");
      return true;
    });
  }
  const model = prepareFixtureEvidence(registry, { ...binding, modelInput: request.input });
  const problem = (model.evaluation.outputSchema.properties as any).findings.items.properties.problem;
  assert(!Object.hasOwn(problem.properties, "component"));
  const legacy = structuredClone(draft);
  legacy.findings[0]!.problem = { component: ["FinScreener"], label: "代码冲突", definition: "猜测工具责任。" } as any;
  assert.throws(() => resolveFixtureEvidence(registry, binding, legacy, audit), (error: unknown) =>
    error instanceof ValidationError && error.issues!.some(issue => issue.code === "schema_additionalProperties" &&
      issue.path === "/findings/0/problem/component"));
});
test("responsibility selections retain original slots when one reference is invalid and deduplicate repeated responsible tool evidence", () => {
  const { request, draft, binding } = responsibilityCase(), registry = new AgentRegistry([attributionAgent]);
  const invalid = structuredClone(draft);
  invalid.findings[0]!.evidence[0] = { evidence_id: "invented" };
  const issues = attributionProfile.validateSubmission!(request, invalid, audit);
  assert(issues.some(issue => issue.code === "evidence_id_invalid" && issue.path === "/findings/0/evidence/0"));
  assert(!issues.some(issue => issue.code === "problem_tool_evidence_invalid"), "the valid tool at original slot 1 must not move to slot 0");
  assert.throws(() => attributionProfile.resolve!(request, invalid, audit), (error: unknown) =>
    error instanceof ValidationError && error.issues!.some(issue => issue.code === "evidence_id_invalid"));
  draft.findings[0]!.evidence.push(structuredClone(draft.findings[0]!.evidence[1]!));
  Object.assign(draft.findings[0]!.problem!, { model_responsible: true, tool_evidence_indices: [1, 2] });
  const result = resolveFixtureEvidence(registry, binding, draft, audit) as AttributionResult;
  registry.validate(binding, result, audit);
  assert.deepEqual(result.findings[0]!.problem!.component, ["模型自身推理", "CodeInterpreter"]);
});
test("responsibility selections bind before own norms and foreign evidence are expanded or reordered", () => {
  const { request, draft, binding } = responsibilityCase(), registry = new AgentRegistry([attributionAgent]);
  const raw = request.sources.answer.value as { messages: Record<string, unknown>[] };
  raw.messages[0]!.role = "developer";
  const peerId = "22222222-2222-4222-8222-222222222222";
  request.input.review_context = { reasons: ["核查来源"] };
  request.sources.B = { id: peerId, value: { ...structuredClone(request.sources.answer.value as object), messages: [
    { role: "user", content: "计算2+2" },
    { role: "tool", name: "OtherTool", content: "独立参考资料。" },
    { role: "assistant", content: "对方最终回答。" },
  ] } };
  request.input.reference_materials = { B: { ...structuredClone(request.input.answer as object),
    identity: { version_id: "B", display_name: "对方回答", answer_model: null },
    question: "计算2+2", source_input_id: peerId, final_answer: "对方最终回答。",
    original_user_timestamp: null, grader_only: true, final_message_index: 2 } };
  delete (request.input.reference_materials as any).B.norm_directory;
  setFixtureNormDirectory(request);
  draft.findings[0]!.evidence.unshift({ evidence_id: canonicalEvidence(peerId, 1, "独立参考资料。").evidence_id });
  draft.findings[0]!.evidence.splice(1, 0, { evidence_id: canonicalEvidence(INPUT_ID, 0, "计算").evidence_id });
  draft.findings[0]!.dimension = "instruction_following";
  draft.findings[0]!.assessment.evidence_status = "uncertain";
  draft.findings[0]!.problem!.tool_evidence_indices = [3];
  const { requirement_index: _requirement, ...assessment } = draft.findings[0]!.assessment;
  Object.assign(draft.findings[0]!, { norm_index: 0, assessment });
  const result = resolveFixtureEvidence(registry, binding, draft, audit) as AttributionResult;
  registry.validate(binding, result, audit);
  assert.deepEqual(result.findings[0]!.problem!.component, ["CodeInterpreter"]);
  assert(result.findings[0]!.evidence.some(item => item.quote === "计算2+2"), "the program expands the selected partial norm to its complete source");
  assert.equal(result.findings[0]!.evidence[0]!.source, "B", "private parent binding preserves original selected evidence order");
  draft.findings[0]!.problem!.tool_evidence_indices = [0];
  assert.throws(() => resolveFixtureEvidence(registry, binding, draft, audit), (error: unknown) =>
    error instanceof ValidationError && error.issues!.some(issue => issue.code === "problem_tool_evidence_invalid"));
});
test("an omitted finding requirement selection becomes canonical null without defaulting judgments or evidence", () => {
  const request = structuredClone(example.request) as AgentRequest;
  const binding = { agent: "attribution", profile: "default", request };
  const registry = new AgentRegistry([attributionAgent]);
  const draft = fixtureSubmission(undefined, request);
  delete (draft.findings[0]!.assessment as Partial<typeof draft.findings[0]["assessment"]>).requirement_index;
  const before = structuredClone(draft);
  const resolved = resolveFixtureEvidence(registry, binding, draft, audit) as AttributionResult;
  registry.validate(binding, resolved, audit);
  assert.equal(resolved.findings[0]!.assessment.requirement_index, null);
  assert.deepEqual(draft, before);
  const explicit = structuredClone(draft);
  explicit.findings[0]!.assessment.requirement_index = null;
  assert.deepEqual(resolveFixtureEvidence(registry, binding, explicit, audit), resolved);
  const invalidIndex = structuredClone(draft);
  invalidIndex.findings[0]!.assessment.requirement_index = -1;
  assert.throws(() => resolveFixtureEvidence(registry, binding, invalidIndex, audit), ValidationError);
  for (const field of ["observation", "evidence_status", "impact"]) {
    const incomplete = structuredClone(draft);
    delete (incomplete.findings[0]!.assessment as unknown as Record<string, unknown>)[field];
    assert.throws(() => resolveFixtureEvidence(registry, binding, incomplete, audit), ValidationError);
  }
  const noEvidence = structuredClone(draft);
  delete (noEvidence.findings[0] as unknown as Record<string, unknown>).evidence;
  assert.throws(() => resolveFixtureEvidence(registry, binding, noEvidence, audit), ValidationError);
  const unknownField = structuredClone(draft);
  (unknownField.findings[0]!.assessment as unknown as Record<string, unknown>).requirement_id = "invented";
  assert.throws(() => resolveFixtureEvidence(registry, binding, unknownField, audit), ValidationError);
});
test("public attribution preserves a final-and-tool correctness bundle while numeric actuals stay on the final slot", () => {
  const request = structuredClone(example.request) as AgentRequest;
  const raw = request.sources.answer.value as { messages: Record<string, unknown>[] };
  raw.messages[0] = { role: "tool", name: "calculate", content: "计算来源：2+2=4" };
  const result = structuredClone(example.result) as AttributionResult;
  result.correctness_evidence.push(canonicalEvidence(INPUT_ID, 0, "计算来源：2+2=4"));
  result.numeric_checks = [{ label: "加法结果", expected: "4", actual: "4", scale: "1", mode: "exact", matches: true, evidence_index: 0 }];
  const binding = { agent: "attribution", profile: "default", request };
  const registry = new AgentRegistry([attributionAgent]);
  const draft = fixtureSubmission(result, request), before = structuredClone(draft);
  const accepted = resolveFixtureEvidence(registry, binding, draft, audit) as AttributionResult;
  registry.validate(binding, accepted, audit);
  assert.deepEqual(accepted.correctness_evidence, result.correctness_evidence);
  assert.deepEqual(draft, before);
  const invalid = structuredClone(draft);
  invalid.numeric_checks[0]!.evidence_index = 1;
  assert.throws(() => resolveFixtureEvidence(registry, binding, invalid, audit), (error: unknown) =>
    error instanceof ValidationError && error.issues!.some(issue =>
      issue.code === "evidence_final_required" && issue.path === "/numeric_checks/0/evidence_index"));
  const malformed = { ...invalid, summary: 7 };
  assert.throws(() => resolveFixtureEvidence(registry, binding, malformed, audit), (error: unknown) =>
    error instanceof ValidationError && error.issues!.some(issue => issue.code === "schema_type" && issue.path === "/summary") &&
    error.issues!.some(issue => issue.code === "evidence_final_required" && issue.path === "/numeric_checks/0/evidence_index"));
  const forgedResult = structuredClone(accepted);
  forgedResult.numeric_checks[0]!.evidence_index = 1;
  assert.throws(() => registry.validate(binding, forgedResult, audit), (error: unknown) =>
    error instanceof ValidationError && error.issues!.some(issue =>
      issue.code === "evidence_final_required" && issue.path === "/numeric_checks/0/evidence_index"));
});
test("native numeric actuals preserve zero and negative signs while formal values and standard precision remain strings", () => {
  const registry = new AgentRegistry([attributionAgent]);
  for (const actual of [0, -0, -4, 1087.4, "9007199254740993"]) {
    const text = typeof actual === "string" ? actual : Object.is(actual, -0) ? "-0" : String(actual);
    const request = structuredClone(example.request) as AgentRequest;
    const raw = request.sources.answer.value as { messages: Record<string, unknown>[] };
    raw.messages[0]!.content = "给出指定数值。";
    raw.messages[1]!.content = `实际值${text}元`;
    Object.assign(request.input.answer as object, { question: "给出指定数值。", final_answer: raw.messages[1]!.content });
    request.input.ground_truth = { available: true, value: `${text}元` };
    const task = request.input.task_analysis as unknown as TaskAnalysis;
    task.goal = "给出指定数值。";
    Object.assign(task.requirements[0]!, { text: "给出指定数值", acceptance_rule: "实际回答与标准数值一致。" });
    task.scoring_points = []; task.red_flags = [];
    const result = structuredClone(example.result) as AttributionResult;
    result.task_analysis = structuredClone(task);
    result.correctness_evidence = [canonicalEvidence(INPUT_ID, 1, raw.messages[1]!.content as string)];
    result.findings[0]!.evidence = result.correctness_evidence;
    result.criterion_assessments = [result.criterion_assessments[0]!];
    result.criterion_assessments[0]!.evidence = result.correctness_evidence;
    result.numeric_checks = [{ label: "实际数值", expected: text, actual: text, scale: "1", mode: "exact", matches: true, evidence_index: 0 }];
    const draft = fixtureSubmission(result, request);
    (draft.numeric_checks[0] as unknown as { actual: string | number }).actual = actual;
    const before = structuredClone(draft), binding = { agent: "attribution", profile: "default", request };
    const resolved = resolveFixtureEvidence(registry, binding, draft, audit) as AttributionResult;
    registry.validate(binding, resolved, audit);
    assert.equal(resolved.numeric_checks[0]!.actual, text);
    assert.equal(resolved.numeric_checks[0]!.expected, text);
    assert.deepEqual(draft, before);
  }
});
test("unsafe native actuals and invented delivery values remain errors without accepting numeric standards", () => {
  const registry = new AgentRegistry([attributionAgent]), binding = { agent: "attribution", profile: "default", request: example.request };
  const result = structuredClone(example.result) as AttributionResult;
  result.numeric_checks = [{ label: "加法结果", expected: "4", actual: "4", scale: "1", mode: "exact", matches: true, evidence_index: 0 }];
  for (const actual of [NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const draft = { ...fixtureSubmission(structuredClone(result)), summary: 7 };
    (draft.numeric_checks[0] as unknown as { actual: number }).actual = actual;
    assert.throws(() => resolveFixtureEvidence(registry, binding, draft, audit), (error: unknown) =>
      error instanceof ValidationError && error.issues!.some(issue => issue.code === "schema_type" && issue.path === "/summary") &&
      error.issues!.some(issue => issue.code === "numeric_actual_unsafe" && issue.path === "/numeric_checks/0/actual"));
  }
  for (const field of ["expected", "matches"]) {
    const redundant = fixtureSubmission(structuredClone(result));
    (redundant.numeric_checks[0] as unknown as Record<string, unknown>)[field] = field === "expected" ? "4" : true;
    assert.throws(() => resolveFixtureEvidence(registry, binding, redundant, audit), ValidationError);
  }
  const invented = fixtureSubmission(structuredClone(result));
  (invented.numeric_checks[0] as unknown as { actual: number }).actual = 5;
  assert.throws(() => resolveFixtureEvidence(registry, binding, invented, audit), (error: unknown) =>
    error instanceof ValidationError && error.issues!.some(issue => issue.code === "numeric_answer_missing"));
});
test("absent standard answers leave deterministic correctness fields to the program", () => {
  const request = structuredClone(example.request);
  Object.assign(request.input.ground_truth, { available: false, value: null });
  const expected = { ...structuredClone(example.result), has_standard_answer: false,
    is_correct: null, correctness_reason: "", correctness_evidence: [] } as AttributionResult;
  const draft = fixtureSubmission(expected, request);
  assert.deepEqual(fixtureSubmission({ ...expected, has_standard_answer: true }, request), draft,
    "the submission follows trusted request availability rather than a result flag");
  const original = structuredClone(draft);
  const resolved = attributionProfile.resolve!(request, draft, audit);
  assert.deepEqual(resolved, expected);
  attributionProfile.validate!(request, resolved, audit);
  assert.deepEqual(draft, original, "resolution does not insert program fields into the submitted draft");
});
test("model parameters require correctness judgments only for a trusted available standard answer", () => {
  const request = structuredClone(example.request);
  const registered = structuredClone(attributionProfile.submissionSchema);
  const fields = ["is_correct", "correctness_reason", "correctness_evidence"] as const;
  const available = attributionProfile.modelSubmissionSchema!(request);
  const properties = available.properties as Record<string, unknown>;
  assert(fields.every(field => Object.hasOwn(properties, field) && (available.required as string[]).includes(field)));
  Object.assign(request.input.ground_truth, { available: false, value: null });
  const registry = new AgentRegistry([attributionAgent]);
  const prepared = prepareFixtureEvidence(registry, { agent: "attribution", profile: "default", request,
    modelInput: { ...request.input, ground_truth: { available: true, value: "spoofed" } } });
  const unavailable = prepared.evaluation.outputSchema;
  assert(fields.every(field => !Object.hasOwn(unavailable.properties as object, field) && !(unavailable.required as string[]).includes(field)));
  assert.deepEqual(attributionProfile.submissionSchema, registered);
  assert.deepEqual(new Ajv2020({ strict: false }).compile(unavailable)(projectEvidenceReferences(fixtureSubmission(undefined, request), [])), true);
});

test("missing standards forbid model-owned empty correctness fields and preserve strict available-standard submissions", () => {
  const request = structuredClone(example.request);
  Object.assign(request.input.ground_truth, { available: false, value: null });
  const draft = fixtureSubmission(undefined, request);
  for (const [field, value] of [["is_correct", null], ["correctness_reason", ""], ["correctness_evidence", []]] as const) {
    const submitted = { ...draft, [field]: value };
    const before = structuredClone(submitted);
    const issue = attributionProfile.validateSubmission!(request, submitted, audit).find(issue => issue.path === `/${field}`);
    assert(issue?.code.endsWith("_forbidden"));
    assert.throws(() => attributionProfile.resolve!(request, submitted, audit), (error: unknown) =>
      error instanceof ValidationError && error.issues!.some(issue => issue.path === `/${field}` && issue.code.endsWith("_forbidden")));
    assert.deepEqual(submitted, before);
  }
  const availableDraft = fixtureSubmission();
  for (const field of ["is_correct", "correctness_reason", "correctness_evidence"] as const) {
    const incomplete = { ...availableDraft } as Partial<typeof availableDraft>;
    delete incomplete[field];
    assert.throws(() => attributionProfile.resolve!(example.request, incomplete, audit), (error: unknown) =>
      error instanceof ValidationError && error.issues!.some(issue => issue.path === `/${field}` && issue.code.endsWith("_required")));
  }
  assert(attributionProfile.validateSubmission!(example.request, { ...availableDraft, is_correct: null }, audit)
    .some(issue => issue.code === "correctness_required"));
  assert.throws(() => attributionProfile.resolve!(example.request, { ...availableDraft, is_correct: "true" }, audit), /输出结构无效/);
});

test("malformed attribution drafts report evidence coordinates with schema and missing-criterion feedback", () => {
  const registry = new AgentRegistry([attributionAgent]);
  const draft = { ...fixtureSubmission(), summary: null, criterion_assessments: [],
    findings: [{ type: "strength", evidence: [{ evidence_id: "ev_11111111-1111-4111-8111-111111111111_0_text_0_14407_" }] }] };
  const before = structuredClone({ request: example.request, draft, audit });
  assert.throws(() => resolveFixtureEvidence(registry, { agent: "attribution", profile: "default", request: example.request }, draft, audit),
    (error: unknown) => {
      assert(error instanceof ValidationError);
      assert(error.issues!.some(issue => issue.code === "schema_type" && issue.path === "/summary"), JSON.stringify(error.issues));
      assert(error.issues!.some(issue => issue.code === "criterion_assessment_missing"));
      assert(error.issues!.some(issue => issue.code === "evidence_range_invalid" && issue.path === "/findings/0/evidence/0"));
      return true;
    });
  assert.deepEqual({ request: example.request, draft, audit }, before);
});
test("numeric ledger verifies rounded values against final-answer evidence", () => {
  const request = structuredClone(example.request);
  request.input.ground_truth.value = "2023年9.4";
  request.sources.answer.value.messages[1]!.content = "2023年9.36";
  const result = structuredClone(example.result) as AttributionResult;
  result.correctness_evidence = [canonicalEvidence(INPUT_ID, 1, "2023年9.36")];
  result.criterion_assessments.forEach((assessment) => { assessment.evidence = result.correctness_evidence; });
  result.findings = [];
  result.numeric_checks = [{ label: "2023", expected: "9.4", actual: "9.36", scale: "1", mode: "rounded", matches: false,
    evidence_index: 0 }];
  assert.throws(() => attributionProfile.validate!(request, result, audit), /matches 应为 true/);
  result.numeric_checks[0]!.matches = true;
  attributionProfile.validate!(request, result, audit);
  result.numeric_checks[0]!.actual = "19.36";
  assert.throws(() => attributionProfile.validate!(request, result, audit), (error: unknown) => {
    assert(error instanceof ValidationError);
    assert.deepEqual(error.issues?.find((issue) => issue.code === "numeric_answer_missing")?.actual,
      { number: "19.36", quote: "2023年9.36" });
    return true;
  });
  result.numeric_checks[0]!.actual = "9.36";
  result.numeric_checks[0]!.expected = "9.5";
  assert.throws(() => attributionProfile.validate!(request, result, audit), /来自标准答案/);
  result.numeric_checks[0]!.expected = "9.4";
  result.numeric_checks[0]!.scale = "0";
  assert.throws(() => attributionProfile.validate!(request, result, audit), /比例必须大于零/);
  result.numeric_checks[0] = { label: "2023", expected: "9.4", actual: null, scale: "1", mode: "rounded", matches: false, evidence_index: 0 };
  result.is_correct = false;
  attributionProfile.validate!(request, result, audit);

  request.input.ground_truth.value = "1.13018E+12元";
  request.sources.answer.value.messages[1]!.content = "非流动资产1130181000000元";
  result.correctness_evidence = [canonicalEvidence(INPUT_ID, 1, "非流动资产1130181000000元")];
  result.criterion_assessments.forEach((assessment) => { assessment.evidence = result.correctness_evidence; });
  result.is_correct = true;
  result.numeric_checks[0] = { label: "非流动资产", expected: "1.13018E+12", actual: "1130181000000", scale: "1", mode: "rounded", matches: true, evidence_index: 0 };
  attributionProfile.validate!(request, result, audit);
  result.numeric_checks[0].expected = "1130180000000";
  assert.throws(() => attributionProfile.validate!(request, result, audit), /保留原有小数位和科学计数法指数/);
});

test("final-answer images must be inspected before claiming a missing deliverable", () => {
  const request = structuredClone(example.request);
  Object.assign(request.sources.answer.value.messages[1]!, { content: [
    { type: "text", text: "2+2=4" }, { type: "image", mimeType: "image/png", data: "AA==" },
  ] });
  assert.throws(() => attributionProfile.validate!(request, example.result, audit), /最终回答含图片/);
  const result = structuredClone(example.result) as AttributionResult;
  result.correctness_evidence = [canonicalEvidence(INPUT_ID, 1, "2+2=4", "/content/0/text")];
  result.criterion_assessments.forEach(item => { item.evidence = result.correctness_evidence; });
  result.findings.forEach(item => { item.evidence = result.correctness_evidence; });
  attributionProfile.validate!(request, result, { ...audit, viewedImages: ["answer:1"] });
});
test("Attribution judges one answer, conditionally on the standard answer", () => {
  assert.deepEqual(Object.keys(attributionAgent.profiles), ["default"]);
  attributionProfile.validate!(example.request, example.result, audit);
  const draft = fixtureSubmission();
  assert.deepEqual(attributionProfile.resolve!(example.request, draft, audit), example.result);
  assert.throws(() => attributionProfile.resolve!(example.request, { ...draft, task_analysis: example.result.task_analysis }, audit), /输出结构无效/);

  const duplicateFindingId = structuredClone(example.result);
  duplicateFindingId.findings = [duplicateFindingId.findings[0]!, duplicateFindingId.findings[0]!];
  assert.throws(() => attributionProfile.validate!(example.request, duplicateFindingId, audit), /finding_id.*唯一/);

  const subjective = structuredClone(example.request);
  subjective.input.ground_truth.available = false;
  const nulled = {
    ...example.result,
    has_standard_answer: false,
    is_correct: null,
    correctness_reason: "",
    correctness_evidence: [],
  };
  attributionProfile.validate!(subjective, nulled, audit);
  assert.throws(() => attributionProfile.validate!(subjective, example.result, audit), /无标准答案/);

  const wrongScope = structuredClone(example.result);
  wrongScope.correctness_evidence = [canonicalEvidence(INPUT_ID, 0, "计算2+2")];
  assert.throws(() => attributionProfile.validate!(example.request, wrongScope, audit), /须至少引用本方最终消息/);

  const incomplete = structuredClone(example.result) as unknown as {
    findings: { type: string; problem: Record<string, unknown> | null }[];
  };
  incomplete.findings[0]!.type = "problem";
  incomplete.findings[0]!.problem = { component: ["模型自身推理"], label: "问题" };
  assert.throws(
    () => attributionProfile.validate!(example.request, incomplete, audit),
    /required|输出结构无效/,
  );

  const blankLabel = structuredClone(example.result) as unknown as AttributionResult;
  blankLabel.findings[0]!.type = "problem";
  blankLabel.findings[0]!.problem = { component: ["模型自身推理"], label: "  ", definition: "说明" };
  assert.throws(() => attributionProfile.validate!(example.request, blankLabel, audit), /问题名称不能为空/);
});

test("problem components must name a tool from the answer call chain", () => {
  const request = structuredClone(example.request);
  (request.input.answer as { catalog: { message_index: number; name: string; type: string; role?: string }[] }).catalog = [
    { message_index: 1, name: "Search", type: "function_call_output" },
    { message_index: 2, name: "FinQuery", type: "function_call_output" },
    { message_index: 3, name: "NotATool", type: "message", role: "assistant" },
  ];
  request.sources.answer.value.messages.splice(1, 0,
    { type: "function_call_output", role: "tool", content: "检索超时" },
    { type: "function_call_output", role: "tool", content: "查询失败" },
  );
  request.input.answer.final_message_index = 3;
  const finding = (component: string) => ({
    ...example.result,
    correctness_evidence: [canonicalEvidence(INPUT_ID, 3, "2+2=4")],
    criterion_assessments: example.result.criterion_assessments.map((assessment) => ({
      ...assessment, evidence: [canonicalEvidence(INPUT_ID, 3, "2+2=4")],
    })),
    findings: [
      {
        ...structuredClone(example.result.findings[0]),
        type: "problem",
        assessment: { ...example.result.findings[0]!.assessment, requirement_index: null },
        problem: { component: [component], label: "取数失败", definition: "多次查询失败" },
        evidence: component === "FinQuery"
          ? [canonicalEvidence(INPUT_ID, 2, "查询失败")]
          : [canonicalEvidence(INPUT_ID, 1, "检索超时")],
      },
    ],
  });
  attributionProfile.validate!(request, finding("Search"), audit);
  const multiple = finding("Search");
  multiple.findings[0]!.problem.component = ["Search", "FinQuery", "模型自身推理"];
  assert.throws(() => attributionProfile.validate!(request, multiple, audit), /必须引用该工具/);
  multiple.findings[0]!.evidence.push(canonicalEvidence(INPUT_ID, 2, "查询失败"));
  attributionProfile.validate!(request, multiple, audit);
  multiple.findings[0]!.problem.component = [];
  attributionProfile.validate!(request, multiple, audit);
  for (const components of [["Search", "Search"]]) {
    multiple.findings[0]!.problem.component = components;
    assert.throws(() => attributionProfile.validate!(request, multiple, audit), /输出结构无效/);
  }
  const unsupported = finding("FinQuery");
  unsupported.findings[0]!.evidence = [canonicalEvidence(INPUT_ID, 3, "2+2=4")];
  assert.throws(() => attributionProfile.validate!(request, unsupported, audit), /必须引用该工具/);
  unsupported.findings[0]!.evidence = [canonicalEvidence(INPUT_ID, 1, "检索超时")];
  assert.throws(() => attributionProfile.validate!(request, unsupported, audit), /必须引用该工具/);
  const suspected = finding("FinQuery") as AttributionResult;
  suspected.findings[0]!.assessment.evidence_status = "uncertain";
  suspected.findings[0]!.assessment.requirement_index = null;
  attributionProfile.validate!(request, suspected, audit);
  attributionProfile.validate!(request, { ...suspected, findings: [] }, audit);
  assert.throws(() => attributionProfile.validate!(request, finding("search"), audit), /调用链中的工具名/);
  attributionProfile.validate!(request, finding("模型自身推理"), audit);
  for (const component of ["Context Recall", "上下文召回", "检索阶段", "WebSearch", "NotATool"])
    assert.throws(
      () => attributionProfile.validate!(request, finding(component), audit),
      /调用链中的工具名/,
      component,
    );
});

test("shared criteria are immutable and assessed exactly once", () => {
  const result = structuredClone(example.result) as AttributionResult;
  result.task_analysis.requirements[0]!.text = "按回答另设标准";
  assert.throws(() => attributionProfile.validate!(example.request, result, audit), /镜像请求中的共享判据/);
  result.task_analysis = structuredClone(example.request.input.task_analysis);
  result.criterion_assessments.pop();
  assert.throws(() => attributionProfile.validate!(example.request, result, audit), /覆盖全部判据/);
  result.criterion_assessments = structuredClone(example.result.criterion_assessments) as AttributionResult["criterion_assessments"];
  result.criterion_assessments.push(result.criterion_assessments[0]!);
  assert.throws(() => attributionProfile.validate!(example.request, result, audit), /只能评审一次/);
  result.criterion_assessments.pop();
  result.criterion_assessments[0]!.criterion_id = "r99";
  assert.throws(() => attributionProfile.validate!(example.request, result, audit), /必须引用共享判据/);
});

test("partial submissions report criterion coverage and absent reference before date or evidence repairs", () => {
  // r76 case021 first submitted only r1 and a numeric ledger containing two dates.
  // Schema errors hid missing r2/r3 and the no-reference rule until later submissions.
  const request = structuredClone(example.request);
  const groundTruth = request.input.ground_truth as { available: boolean; value: unknown };
  groundTruth.available = false;
  groundTruth.value = null;
  const taskAnalysis: TaskAnalysis = request.input.task_analysis;
  taskAnalysis.scoring_points = [];
  taskAnalysis.red_flags = [];
  taskAnalysis.requirements.push(...["r2", "r3"].map((id) => ({
    id, text: "另一条共同验收要求", applies_to: [], acceptance_rule: "回答须完成该用户要求。",
  })));
  const { has_standard_answer: _derived, task_analysis: _shared, is_correct: _correct,
    correctness_reason: _reason, correctness_evidence: _evidence, ...submission } = structuredClone(example.result);
  const draft = {
    ...submission,
    core_assessment: { meets_core: submission.core_assessment.meets_core, reason: submission.core_assessment.reason,
      requirement_indices: [0] },
    findings: [],
    criterion_assessments: [{ ...submission.criterion_assessments[0]!, evidence: [{ evidence_id: "ev_11111111-1111-4111-8111-111111111111_16_text_0_1746_/content" }] }],
    numeric_checks: [
      { label: "收盘价", expected: "3513", actual: "3513", scale: "1", matches: true, mode: "exact", evidence_index: 0 },
      { label: "最后交易日", expected: "2026-10-21", actual: "2026-10-21", scale: "1", matches: true, mode: "exact", evidence_index: 0 },
      { label: "最后交易日", expected: "2026-11-13", actual: "2026-11-13", scale: "1", matches: true, mode: "exact", evidence_index: 0 },
    ],
  };
  const original = structuredClone(draft);
  assert.throws(() => attributionProfile.resolve!(request, draft, audit), /pattern/);
  const issues = attributionProfile.validateSubmission!(request, draft, audit);
  assert.deepEqual(issues.filter((issue) => issue.code === "criterion_assessment_missing").map((issue) => issue.actual), ["r2", "r3"]);
  assert(issues.some((issue) => issue.code === "numeric_checks_without_reference" && issue.path === "/numeric_checks"));
  assert(attributionProfile.validateSubmission!(request, {
    ...draft, core_assessment: { ...draft.core_assessment, meets_core: null },
  }, audit).some((issue) => issue.code === "core_unknown_unsupported"));
  assert(!attributionProfile.validateSubmission!(request, {
    ...draft, core_assessment: { ...draft.core_assessment, meets_core: null, requirement_indices: [1] },
  }, audit).some((issue) => issue.code === "core_unknown_unsupported"), "a missing assessment cannot supply a core state");
  assert.deepEqual(draft, original, "submission checks must preserve the draft for recovery");

  const result = {
    ...structuredClone(example.result), has_standard_answer: false, task_analysis: request.input.task_analysis,
    is_correct: null, correctness_reason: "", correctness_evidence: [], numeric_checks: [],
    criterion_assessments: [submission.criterion_assessments[0]!, ...["r2", "r3"].map((criterion_id) => ({
      criterion_id, status: "met", evidence_status: "established", summary: "已完成该共同要求。",
      evidence: structuredClone(example.result.correctness_evidence),
    }))],
  } as unknown as AttributionResult;
  result.findings[0]!.problem = { component: ["模型自身推理"], label: "待查", definition: "根因仍未知。" };
  const submitted = fixtureSubmission(result, request);
  const findingIssues = attributionProfile.validateSubmission!(request, {
    ...submitted, findings: [{ ...submitted.findings[0]!, problem: { model_responsible: true,
      tool_evidence_indices: [], label: "不适用于优点", definition: "优点不能提交问题对象。" } }],
  }, audit);
  assert(findingIssues.some((issue) => issue.code === "strength_problem_forbidden"));
  result.findings[0]!.problem = null;
  assert.deepEqual(attributionProfile.validateSubmission!(request, fixtureSubmission(result, request), audit), []);
  attributionProfile.validate!(request, result, audit);

  for (const partial of [null, undefined, [], 4, "invalid", { criterion_assessments: null }, {
    criterion_assessments: [null, 4, { criterion_id: null }], core_assessment: 4,
    findings: [null, 4, { assessment: 4, problem: { model_responsible: 4, tool_evidence_indices: 4, label: 4, definition: 4 } }],
    numeric_checks: 4, correctness_evidence: null, correctness_reason: 4, is_correct: "invalid",
  }, {
    criterion_assessments: [{ criterion_id: "r1", status: "unknown", evidence_status: { toString: null } }],
    core_assessment: { requirement_indices: [0], meets_core: null },
  }]) assert.doesNotThrow(() => attributionProfile.validateSubmission!(request, partial, audit));
});

test("00981 missing criterion repair locates a misplaced exact ID without moving or guessing", () => {
  const request = structuredClone(example.request);
  const r4 = { id: "r4", text: "共同用户要求的固定格式", applies_to: [], acceptance_rule: "回答须使用指定格式。" };
  const taskAnalysis: TaskAnalysis = request.input.task_analysis;
  taskAnalysis.requirements.push({ ...taskAnalysis.requirements[0]!, id: "r2" });
  taskAnalysis.scoring_points = [{ ...taskAnalysis.scoring_points[0]!, id: "r3" }];
  taskAnalysis.red_flags = [r4];
  const base = fixtureSubmission();
  const draft = { ...base,
    criterion_assessments: base.criterion_assessments.map((assessment, index) => ({ ...assessment, criterion_id: `r${index + 1}` })),
    item: { criterion_id: "r4", status: "met", evidence_status: "established", summary: "已按共同要求交付。", evidence: "" },
  };
  const before = structuredClone(draft);
  const missing = (value: unknown) => attributionProfile.validateSubmission!(request, value, audit)
    .find(issue => issue.code === "criterion_assessment_missing" && issue.actual === "r4");
  const issue = missing(draft)!;
  assert.deepEqual(issue.expected, {
    criterion_id: "r4", criterion: r4, candidate_id: request.input.candidate_id, applicable: true,
    target_path: "/criterion_assessments/-", source_path: "/item",
    required_fields: ["criterion_id", "status", "evidence_status", "summary", "evidence"],
  });
  assert.match(issue.message, /移动完整条目/);
  assert.match(issue.message, /删除错误的顶层字段/);
  assert.match(issue.message, /补齐必填字段/);
  assert.throws(() => attributionProfile.resolve!(request, draft, audit), /additional properties/);
  assert.deepEqual(draft, before, "the feedback rejects the wrong shape without changing it");
  const { item, ...withoutItem } = draft;
  const corrected = { ...withoutItem, criterion_assessments: [...draft.criterion_assessments, { ...item, evidence: base.criterion_assessments[0]!.evidence }] };
  assert.deepEqual(attributionProfile.validateSubmission!(request, corrected, audit), []);
  const accepted = attributionProfile.resolve!(request, corrected, audit) as AttributionResult;
  attributionProfile.validate!(request, accepted, audit);

  for (const value of [withoutItem, { ...withoutItem, item: { ...item, criterion_id: "r99" } },
    { ...withoutItem, task_analysis: { ...item } },
    { ...withoutItem, item: { ...item }, another: { ...item } }]) {
    const expected = missing(value)!.expected as Record<string, unknown>;
    assert.equal(Object.hasOwn(expected, "source_path"), false, "absent, unknown and ambiguous IDs never suggest a move");
    assert.equal(expected.target_path, "/criterion_assessments/-");
    assert.deepEqual(expected.criterion, r4);
    assert.match(missing(value)!.message, /追加完整条目/);
  }
  const escaped = missing({ ...withoutItem, ["a/b~c"]: item })!;
  assert.equal((escaped.expected as Record<string, unknown>).source_path, "/a~1b~0c");
  assert.deepEqual(item.evidence, "", "a suggested correction never coerces evidence to an array");
});

test("04748 strength submissions omit problem and reject empty, null and XML representations", () => {
  const draft = fixtureSubmission(), before = structuredClone(draft);
  const validateModel = new Ajv2020({ allErrors: true, strict: false }).compile(attributionProfile.submissionSchema);
  assert.equal(validateModel(draft), true, "strength submits no problem field");
  const resolved = attributionProfile.resolve!(example.request, draft, audit) as AttributionResult;
  assert.equal(resolved.findings[0]!.problem, null, "the program derives the formal result field");
  attributionProfile.validate!(example.request, resolved, audit);
  assert.deepEqual(draft, before, "resolution never mutates the submitted draft");
  for (const problem of [null, "", "null", { null: "" }, {}, [], 0, false]) {
    const invalid = { ...draft, findings: [{ ...draft.findings[0]!, problem }] };
    assert.equal(validateModel(invalid), false, "strength rejects every submitted problem value");
    assert.throws(() => attributionProfile.resolve!(example.request, invalid, audit), ValidationError);
    const issue = attributionProfile.validateSubmission!(example.request, invalid, audit)
      .find(issue => issue.code === "strength_problem_forbidden");
    assert.equal(issue?.path, "/findings/0/problem");
    assert.deepEqual(issue?.actual, problem);
    assert.match(issue?.message ?? "", /删除 problem 字段/);
    assert.deepEqual(invalid.findings[0]!.problem, problem, "wrong values are rejected without coercion");
  }
  const xml = { ...draft, findings: [{ ...draft.findings[0]!, $text: "]<]minimax[>[<problem />" }] };
  assert.equal(validateModel(xml), false, "the actual 080 XML residue is an unknown field");
  assert.throws(() => attributionProfile.resolve!(example.request, xml, audit), /additional properties/);
});

test("candidate-specific requirements retain scope in assessments and findings", () => {
  const request = structuredClone(example.request);
  const result = structuredClone(example.result) as AttributionResult;
  (request.input.task_analysis.requirements as TaskAnalysis["requirements"]).push({
    id: "r2", text: "另一候选的指定格式", applies_to: ["22222222-2222-4222-8222-222222222222"], acceptance_rule: "另一候选须用JSON交付。",
  });
  result.task_analysis = structuredClone(request.input.task_analysis);
  result.criterion_assessments.push({ criterion_id: "r2", status: "not_applicable", evidence_status: "established", summary: "本候选不在该条scope中。", evidence: [] });
  attributionProfile.validate!(request, result, audit);
  result.criterion_assessments[3]!.status = "met";
  const submission = fixtureSubmission(result, request);
  const scopeDraft = {
    ...submission,
    criterion_assessments: result.criterion_assessments.map((assessment) => ({
      ...assessment, evidence: structuredClone(submission.correctness_evidence),
    })),
    core_assessment: { meets_core: result.core_assessment.meets_core, reason: result.core_assessment.reason, requirement_indices: [0, 1] },
    findings: [{ ...submission.findings[0]!, assessment: { ...result.findings[0]!.assessment, requirement_index: 1 } }],
  };
  assert.deepEqual(attributionProfile.validateSubmission!(request, scopeDraft, audit).map((issue) => issue.code),
    ["criterion_out_of_scope", "core_requirement_not_applicable", "finding_requirement_not_applicable"]);
  assert.throws(() => attributionProfile.validate!(request, result, audit), /才能且必须填 not_applicable/);
  result.criterion_assessments[3]!.status = "not_applicable";
  result.findings[0]!.assessment.requirement_index = 1;
  assert.throws(() => attributionProfile.validate!(request, result, audit), /不能关联不适用/);
  result.findings[0]!.assessment.requirement_index = 0;
  result.criterion_assessments[0]!.status = "not_applicable";
  assert.throws(() => attributionProfile.validate!(request, result, audit), /才能且必须填 not_applicable/);
});

test("model submissions assess applicable criteria while the program derives every out-of-scope result", () => {
  const request = structuredClone(example.request);
  const task: TaskAnalysis = request.input.task_analysis;
  const other = "22222222-2222-4222-8222-222222222222";
  task.requirements.push({ id: "r_other", text: "另一候选必须JSON交付", applies_to: [other], acceptance_rule: "另一候选使用JSON。" });
  task.scoring_points.push({ id: "s_other", text: "另一候选的结构要求", applies_to: [other], acceptance_rule: "另一候选符合自身结构。" });
  task.red_flags.push({ id: "f_other", text: "另一候选禁止买卖点", applies_to: [other], acceptance_rule: "另一候选不提供买卖点。" });
  const draft = fixtureSubmission();
  draft.criterion_assessments.reverse();
  const before = structuredClone(draft);
  assert.deepEqual(attributionProfile.validateSubmission!(request, draft, audit), [], "scope alone needs no model evidence");
  const result = attributionProfile.resolve!(request, draft, audit) as AttributionResult;
  attributionProfile.validate!(request, result, audit);
  const registry = new AgentRegistry([attributionAgent]);
  const binding = { agent: "attribution", profile: "default", request };
  const accepted = resolveFixtureEvidence(registry, binding, draft, audit) as AttributionResult;
  registry.validate(binding, accepted, audit);
  assert.deepEqual(accepted, result, "the actual Host route accepts one applicable-only submission");
  assert.deepEqual(result.criterion_assessments.map(item => item.criterion_id),
    [...task.requirements, ...task.scoring_points, ...task.red_flags].map(item => item.id));
  for (const id of ["r_other", "s_other", "f_other"]) {
    const item = result.criterion_assessments.find(item => item.criterion_id === id)!;
    assert.equal(item.status, "not_applicable");
    assert.equal(item.evidence_status, "established");
    assert.deepEqual(item.evidence, []);
    assert.equal(item.summary, "该判据的 applies_to 不包含当前候选，本候选不适用。");
  }
  assert.deepEqual(draft, before, "derived results do not modify the model submission");
  const formal = structuredClone(result);
  formal.criterion_assessments.find(item => item.criterion_id === "r_other")!.status = "met";
  assert.throws(() => attributionProfile.validate!(request, formal, audit), /not_applicable/);
  const uncertainScope = structuredClone(result);
  uncertainScope.criterion_assessments.find(item => item.criterion_id === "r_other")!.evidence_status = "uncertain";
  assert.throws(() => attributionProfile.validate!(request, uncertainScope, audit), /可信 applies_to/);
  const suppliedScopeEvidence = structuredClone(result);
  suppliedScopeEvidence.criterion_assessments.find(item => item.criterion_id === "r_other")!.evidence = structuredClone(result.correctness_evidence);
  assert.throws(() => attributionProfile.validate!(request, suppliedScopeEvidence, audit), /不填写回答证据/);
  const missingFormalScope = structuredClone(result);
  missingFormalScope.criterion_assessments = missingFormalScope.criterion_assessments.filter(item => item.criterion_id !== "r_other");
  assert.throws(() => attributionProfile.validate!(request, missingFormalScope, audit), /覆盖全部判据/);
  const validateModel = new Ajv2020({ allErrors: true, strict: false }).compile(attributionProfile.submissionSchema);
  for (const evidence_id of ["placeholder", "ev_r_other_applies_to"]) {
    const foreign = { criterion_id: "r_other", status: "not_applicable", evidence_status: "established", summary: "scope不同。", evidence: [{ evidence_id }] };
    const invalid = { ...draft, criterion_assessments: [...draft.criterion_assessments, foreign] };
    assert.equal(validateModel(invalid), false, "model submissions cannot supply not_applicable");
    assert(attributionProfile.validateSubmission!(request, invalid, audit).some(issue => issue.code === "criterion_out_of_scope"));
    assert.throws(() => attributionProfile.resolve!(request, invalid, audit), ValidationError);
  }
  const submittedForeign = { ...draft, criterion_assessments: [...draft.criterion_assessments,
    { ...draft.criterion_assessments[0]!, criterion_id: "r_other" }] };
  assert.throws(() => attributionProfile.resolve!(request, submittedForeign, audit), (error: unknown) => {
    assert(error instanceof ValidationError);
    assert(error.issues!.some(issue => issue.code === "criterion_out_of_scope"));
    return true;
  });
  for (const [code, criterion_assessments] of [
    ["criterion_assessment_unknown", [...draft.criterion_assessments, { ...draft.criterion_assessments[0]!, criterion_id: "missing_id" }]],
    ["criterion_assessment_duplicate", [...draft.criterion_assessments, draft.criterion_assessments[0]!]],
    ["criterion_assessment_missing", draft.criterion_assessments.slice(1)],
  ] as const) {
    const invalid = { ...draft, criterion_assessments };
    const snapshot = structuredClone(invalid);
    assert.throws(() => resolveFixtureEvidence(registry, binding, invalid, audit), (error: unknown) => {
      assert(error instanceof ValidationError);
      assert(error.issues!.some(issue => issue.code === code));
      return true;
    }, "scope derivation never discards invalid applicable coverage");
    assert.deepEqual(invalid, snapshot);
  }
});

test("core failure requires an established applicable requirement and partial can remain usable", () => {
  const result = structuredClone(example.result) as AttributionResult;
  result.criterion_assessments[0]!.status = "partial";
  attributionProfile.validate!(example.request, result, audit);
  result.core_assessment.meets_core = false;
  result.core_assessment.reason = "缺失部分使唯一所求结果不能使用。";
  attributionProfile.validate!(example.request, result, audit);
  result.criterion_assessments[0]!.evidence_status = "uncertain";
  assert.throws(() => attributionProfile.validate!(example.request, result, audit), /核心不可用必须引用/);
  result.core_assessment.meets_core = null;
  attributionProfile.validate!(example.request, result, audit);
  result.criterion_assessments[0]!.status = "unknown";
  result.criterion_assessments[0]!.evidence_status = "established";
  assert.throws(() => attributionProfile.validate!(example.request, result, audit), /unknown 表示证据不足/);
  result.criterion_assessments[0]!.evidence_status = "uncertain";
  attributionProfile.validate!(example.request, result, audit);
  result.core_assessment.meets_core = true;
  assert.throws(() => attributionProfile.validate!(example.request, result, audit), /核心可用必须引用/);
  result.core_assessment.meets_core = false;
  result.core_assessment.criterion_ids = ["s1"];
  assert.throws(() => attributionProfile.validate!(example.request, result, audit), /只能引用.*requirements/);
  result.core_assessment.criterion_ids = ["r1"];
  result.criterion_assessments[0]!.status = "unmet";
  result.criterion_assessments[0]!.evidence_status = "established";
  result.criterion_assessments[0]!.evidence = [];
  assert.throws(() => attributionProfile.validate!(example.request, result, audit), /必须引用支持判断的原文/);
});

test("all deferred final text must be read with exact candidate, path and character coverage", () => {
  const request = structuredClone(example.request);
  (request.input.answer.deferred_final_material as { message_index: number; path: string; total_chars: number }[])
    .push({ message_index: 1, path: "/content", total_chars: 5 });
  const read = (start: number, end: number) => ({ candidate: "answer", message_index: 1, kind: "text" as const, path: "/content", start, end });
  const partial: ToolAudit = { ...audit, traceReads: [read(0, 2), read(3, 5)] };
  assert.throws(() => attributionProfile.validate!(request, example.result, partial), (error: unknown) => {
    assert(error instanceof ValidationError);
    const issue = error.issues?.find((item) => item.code === "deferred_final_material_not_read");
    assert.deepEqual(issue?.actual, [{ start: 2, end: 3 }]);
    assert.match(issue?.message ?? "", /展示缺失不能推定没有交付/);
    return true;
  });
  attributionProfile.validate!(request, example.result, { ...audit, traceReads: [read(3, 5), read(0, 3)] });
  for (const wrong of [
    { ...read(0, 5), candidate: "other" },
    { ...read(0, 5), path: "/content/text" },
    { ...read(0, 5), message_index: 0 },
    { ...read(0, 5), kind: "json" as const, path: "" },
  ]) assert.throws(() => attributionProfile.validate!(request, example.result, { ...audit, traceReads: [wrong] }), /未完整读取/);
});

const instructionCase = () => {
  const request: AgentRequest = structuredClone(example.request);
  const norm = "本轮投资建议先说明风险；纯事实查询不要求风险提示。";
  const messages = [
    { role: "system", type: "message", content: norm },
    { role: "user", type: "message", content: "计算2+2" },
    { role: "assistant", type: "message", content: "风险提示：示例存在波动。2+2=4" },
  ];
  request.sources.answer!.value = { messages };
  Object.assign(request.input.answer as object, { final_message_index: 2,
    catalog: messages.map((message, message_index) => ({ message_index, role: message.role, type: message.type,
      chars: JSON.stringify(message).length })) });
  const task = request.input.task_analysis as unknown as TaskAnalysis;
  task.requirements.push({ id: "r2", text: norm, applies_to: [], acceptance_rule: "保留原文条件核验。" });
  const result = structuredClone(example.result) as AttributionResult;
  result.task_analysis = structuredClone(task);
  const final = cite(INPUT_ID, 2, evidenceSources(messages[2]).find(source => source.path === "/content")!, 0, messages[2]!.content.length);
  const evidence = [canonicalEvidence(INPUT_ID, 2, final.quote)];
  result.correctness_evidence = evidence;
  result.criterion_assessments.forEach(assessment => { assessment.evidence = evidence; });
  result.criterion_assessments.push({ ...result.criterion_assessments[0]!, criterion_id: "r2", evidence });
  Object.assign(result.findings[0]!, { dimension: "instruction_following", evidence });
  result.findings[0]!.assessment.requirement_index = 1;
  const draft = fixtureSubmission(result, request);
  draft.correctness_evidence = [{ evidence_id: final.evidence_id }];
  draft.criterion_assessments.forEach(assessment => { assessment.evidence = [{ evidence_id: final.evidence_id }]; });
  draft.findings.forEach(finding => { finding.evidence = [{ evidence_id: final.evidence_id }]; });
  return { request, result, draft, norm, final };
};

test("incoming problem associations cannot coexist with established satisfaction of the same requirement", () => {
  const { request, draft } = instructionCase();
  const source = evidenceSources((request.sources.answer!.value as { messages: unknown[] }).messages[0])
    .find(source => source.path === "/content")!;
  const normRef = { evidence_id: cite(INPUT_ID, 0, source, 0, source.text.length).evidence_id };
  const problem = { ...draft.findings[0]!, type: "problem" as const,
    problem: { model_responsible: true, tool_evidence_indices: [], label: "指令执行偏差", definition: "回答未按所关联的规范顺序组织内容。" },
    evidence: [...draft.findings[0]!.evidence, normRef] };
  const submitted = { ...draft, findings: [problem] };
  const before = structuredClone({ request, submitted, audit });
  const conflict = attributionProfile.validateSubmission!(request, submitted, audit)
    .find(issue => issue.code === "finding_requirement_conflict")!;
  assert.equal(conflict.path, "/findings/0/assessment/requirement_index");
  assert.equal(conflict.actual, 1);
  assert.deepEqual(conflict.expected, { criterion_id: "r2", status: "met", evidence_status: "established",
    finding_index: 0, criterion_status_path: "/criterion_assessments/3/status" });
  assert.match(conflict.message, /partial 或 unmet/);
  assert.match(conflict.message, /正确的 requirement_index/);
  assert.match(conflict.message, /requirements 中时填 null/);
  const registry = new AgentRegistry([attributionAgent]);
  assert.throws(() => resolveFixtureEvidence(registry, { agent: "attribution", profile: "default", request }, { ...submitted, summary: null }, audit),
    (error: unknown) => {
      assert(error instanceof ValidationError);
      assert(error.issues!.some(issue => issue.code === "schema_type" && issue.path === "/summary"), JSON.stringify(error.issues));
      assert(error.issues!.some(issue => issue.code === "finding_requirement_conflict"));
      return true;
    });
  const formal = attributionProfile.resolve!(request, submitted, audit) as AttributionResult;
  assert.throws(() => attributionProfile.validate!(request, formal, audit), (error: unknown) =>
    error instanceof ValidationError && error.issues!.some(issue => issue.code === "finding_requirement_conflict"));
  assert.deepEqual({ request, submitted, audit }, before, "the guard preserves declarations and source evidence");

  for (const dimension of ["format", "correctness", "reasoning", "completeness", "evidence_quality", "relevance", "efficiency"] as const) {
    const labeled = structuredClone(submitted);
    labeled.findings[0]!.dimension = dimension;
    delete labeled.findings[0]!.norm_index;
    labeled.findings[0]!.assessment.requirement_index = 1;
    const issue = attributionProfile.validateSubmission!(request, labeled, audit)
      .find(issue => issue.code === "finding_requirement_conflict");
    assert(issue, `${dimension} cannot bypass the same declaration conflict`);
    assert.deepEqual(issue.expected, conflict.expected);
    const resolved = attributionProfile.resolve!(request, labeled, audit) as AttributionResult;
    assert.throws(() => attributionProfile.validate!(request, resolved, audit), (error: unknown) =>
      error instanceof ValidationError && error.issues!.some(issue => issue.code === "finding_requirement_conflict"));
  }

  const partial = structuredClone(submitted);
  partial.criterion_assessments.find(item => item.criterion_id === "r2")!.status = "partial";
  assert.deepEqual(attributionProfile.validateSubmission!(request, partial, audit), []);
  const partialResult = attributionProfile.resolve!(request, partial, audit) as AttributionResult;
  attributionProfile.validate!(request, partialResult, audit);
  assert.equal(partialResult.core_assessment.meets_core, true, "a partial requirement does not mechanically overturn an independently usable core");

  const uncertainProblem = structuredClone(submitted);
  uncertainProblem.findings[0]!.assessment.evidence_status = "uncertain";
  const uncertainConflict = attributionProfile.validateSubmission!(request, uncertainProblem, audit)
    .find(issue => issue.code === "finding_requirement_conflict");
  assert(uncertainConflict, "an uncertain linked problem cannot coexist with established satisfaction of the same requirement");
  assert.deepEqual(uncertainConflict.expected, conflict.expected);
  assert.match(uncertainConflict.message, /证据确实不足时保留 uncertain/);
  assert.throws(() => resolveFixtureEvidence(registry, { agent: "attribution", profile: "default", request }, uncertainProblem, audit),
    (error: unknown) => error instanceof ValidationError && error.issues!.some(issue => issue.code === "finding_requirement_conflict"));
  const acceptedCanonical = structuredClone(formal);
  acceptedCanonical.findings[0]!.assessment.evidence_status = "uncertain";
  const canonicalBefore = structuredClone(acceptedCanonical);
  registry.validate({ agent: "attribution", profile: "default", request }, acceptedCanonical, audit);
  assert.deepEqual(acceptedCanonical, canonicalBefore, "accepted canonical source reuse preserves the recorded judgment; it never replays new model choices");

  for (const change of [
    (value: typeof submitted) => {
      value.criterion_assessments.find(item => item.criterion_id === "r2")!.evidence_status = "uncertain";
      value.findings[0]!.assessment.evidence_status = "uncertain";
    },
  ]) {
    const changed = structuredClone(submitted);
    change(changed);
    assert(!attributionProfile.validateSubmission!(request, changed, audit).some(issue => issue.code === "finding_requirement_conflict"));
    const changedResult = attributionProfile.resolve!(request, changed, audit) as AttributionResult;
    attributionProfile.validate!(request, changedResult, audit);
    assert.equal(changedResult.core_assessment.meets_core, true);
  }
  const noProblem = { ...structuredClone(submitted), findings: [draft.findings[0]!] };
  assert(!attributionProfile.validateSubmission!(request, noProblem, audit).some(issue => issue.code === "finding_requirement_conflict"));
  attributionProfile.validate!(request, attributionProfile.resolve!(request, noProblem, audit), audit);


});

test("first feedback combines malformed Attribution with the own final-image read gap", () => {
  const request = structuredClone(example.request);
  Object.assign(request.sources.answer.value.messages[1]!, { attachments: [
    { type: "image", mimeType: "image/png", data: "AA==" },
  ] });
  const draft = { ...fixtureSubmission(), summary: 7 };
  const registry = new AgentRegistry([attributionAgent]);
  const binding = { agent: "attribution", profile: "default", request };
  const before = structuredClone({ request, draft });
  const issues = (reads: ToolAudit) => {
    try { resolveFixtureEvidence(registry, binding, draft, reads); assert.fail("malformed summary must fail"); }
    catch (error) { assert(error instanceof ValidationError); return error.issues!; }
  };
  for (const reads of [audit, { ...audit, viewedImages: ["peer:1"] }]) {
    const errors = issues(reads);
    assert.deepEqual(errors.map(issue => issue.code), ["schema_type", "final_image_not_viewed"]);
    assert.equal(errors.filter(issue => issue.code === "final_image_not_viewed").length, 1);
  }
  assert.deepEqual(issues({ ...audit, viewedImages: ["answer:1"] }).map(issue => issue.code), ["schema_type"]);
  assert.throws(() => attributionProfile.validate!(request, example.result, audit), (error: unknown) =>
    error instanceof ValidationError && error.issues!.filter(issue => issue.code === "final_image_not_viewed").length === 1);
  const result = structuredClone(example.result) as AttributionResult;
  result.correctness_evidence = [canonicalEvidence(INPUT_ID, 1, "2+2=4")];
  result.criterion_assessments.forEach(item => { item.evidence = result.correctness_evidence; });
  result.findings.forEach(item => { item.evidence = result.correctness_evidence; });
  attributionProfile.validate!(request, result, { ...audit, viewedImages: ["answer:1"] });
  assert.deepEqual({ request, draft }, before);
});
