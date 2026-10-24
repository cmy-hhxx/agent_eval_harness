import { responsibilityFixture } from "../../../../tests/fixtures/responsibility.js";
import { attributionJudgment } from "../../../../tests/fixtures/attribution-judgment.js";
import { validateJudgment } from "./validate.js";
import { resolveJudgment } from "./resolve.js";
const INPUT_ID = "11111111-1111-4111-8111-111111111111";
import test from "node:test";
import assert from "node:assert/strict";
import { attributionAgent, attributionProfile } from "./index.js";
import type { AttributionResult } from "./types.js";
import example from "./fixtures/example.json" with { type: "json" };
import { cite, evidenceSources } from "@eval/tools";
import { ValidationError, type AgentRequest, type TaskAnalysis, type ToolAudit } from "@eval/contracts";
import { Ajv2020 } from "ajv/dist/2020.js";
import { AgentRegistry } from "@eval/host";
import { canonicalEvidence, prepareFixtureEvidence } from "../../../../tests/fixtures/evidence.js";
import { setFixtureNormDirectory, attributionSubmission } from "../../../../tests/fixtures/attribution-submission.js";

const audit = { calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [] };
const judgmentFixture = (result: AttributionResult = structuredClone(example.result) as AttributionResult,
  request: AgentRequest = example.request) => {
    setFixtureNormDirectory(request);
    return attributionJudgment(request, result);
  };

test("a confirmed wrong answer retains its established defect and an explicitly inferred cause", () => {
  const request = structuredClone(example.request);
  request.input.ground_truth.value = "5";
  const result = structuredClone(example.result) as AttributionResult;
  result.is_correct = false;
  result.correctness_reason = "回答4与标准5不符，取数结果校验存在偏差。";
  result.core_assessment.meets_core = false;
  result.criterion_assessments[0].status = "unmet";
  const finding = result.findings[0];
  finding.type = "problem";
  finding.problem = { component: [responsibilityFixture("最终作答节点（原始名称未提供）",{evidence_ids:finding.evidence.map(item=>item.evidence_id)})], label: "取数结果偏差", definition: result.correctness_reason };
  attributionProfile.validate!(request, result, audit);
  const accepted = resolveJudgment(request, judgmentFixture(result, request), audit) as AttributionResult;
  assert.equal(accepted.is_correct, false);
  assert.equal(accepted.core_assessment.meets_core, false);
  assert.equal(accepted.findings[0].problem!.component[0].certainty,"inferred");
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
  const draft = judgmentFixture(result, request), before = structuredClone(draft);
  const accepted = resolveJudgment(request, draft, audit) as AttributionResult;
  registry.validate(binding, accepted, audit);
  assert.deepEqual(accepted.correctness_evidence, result.correctness_evidence);
  assert.deepEqual(draft, before);
  const invalid = structuredClone(draft);
  invalid.numeric_checks[0]!.evidence_index = 1;
  assert.throws(() => resolveJudgment(request, invalid, audit), (error: unknown) =>
    error instanceof ValidationError && error.issues!.some(issue =>
      issue.code === "evidence_final_required" && issue.path === "/numeric_checks/0/evidence_index"));
  const malformed = { ...invalid, summary: 7 };
  assert.throws(() => resolveJudgment(request, malformed, audit), (error: unknown) =>
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
    const draft = judgmentFixture(result, request);
    (draft.numeric_checks[0] as unknown as { actual: string | number }).actual = actual;
    const before = structuredClone(draft), binding = { agent: "attribution", profile: "default", request };
    const resolved = resolveJudgment(request, draft, audit) as AttributionResult;
    registry.validate(binding, resolved, audit);
    assert.equal(resolved.numeric_checks[0]!.actual, text);
    assert.equal(resolved.numeric_checks[0]!.expected, text);
    assert.deepEqual(draft, before);
  }
});
test("unsafe numeric values remain errors in bound judgments", () => {
  const request=example.request;

  const result = structuredClone(example.result) as AttributionResult;
  result.numeric_checks = [{ label: "加法结果", expected: "4", actual: "4", scale: "1", mode: "exact", matches: true, evidence_index: 0 }];
  for (const actual of [NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const draft = { ...judgmentFixture(structuredClone(result)), summary: 7 };
    (draft.numeric_checks[0] as unknown as { actual: number }).actual = actual;
    assert.throws(() => resolveJudgment(request, draft, audit), (error: unknown) =>
      error instanceof ValidationError && error.issues!.some(issue => issue.code === "schema_type" && issue.path === "/summary") &&
      error.issues!.some(issue => issue.code === "numeric_actual_unsafe" && issue.path === "/numeric_checks/0/actual"));
  }
  for (const field of ["expected", "matches"]) {
    const redundant = judgmentFixture(structuredClone(result));
    (redundant.numeric_checks[0] as unknown as Record<string, unknown>)[field] = field === "expected" ? "4" : true;
    assert.throws(() => resolveJudgment(request, redundant, audit), ValidationError);
  }
  const invented = judgmentFixture(structuredClone(result));
  (invented.numeric_checks[0] as unknown as { actual: number }).actual = 5;
  assert.throws(() => resolveJudgment(request, invented, audit), (error: unknown) =>
    error instanceof ValidationError && error.issues!.some(issue => issue.code === "numeric_answer_missing"));
});
test("absent standard answers leave deterministic correctness fields to the program", () => {
  const request = structuredClone(example.request);
  Object.assign(request.input.ground_truth, { available: false, value: null });
  const expected = { ...structuredClone(example.result), has_standard_answer: false,
    is_correct: null, correctness_reason: "", correctness_evidence: [] } as AttributionResult;
  const draft = judgmentFixture(expected, request);
  assert.deepEqual(judgmentFixture({ ...expected, has_standard_answer: true }, request), draft,
    "the submission follows trusted request availability rather than a result flag");
  const original = structuredClone(draft);
  const resolved = resolveJudgment(request, draft, audit);
  assert.deepEqual(resolved, expected);
  attributionProfile.validate!(request, resolved, audit);
  assert.deepEqual(draft, original, "resolution does not insert program fields into the submitted draft");
});
test("model correctness fields stay required and use fixed empty values without a trusted standard answer", () => {
  const request = structuredClone(example.request);
  const registered = structuredClone(attributionProfile.submissionSchema);
  const fields = ["is_correct", "correctness_reason", "correctness_evidence_indices"] as const;
  const available = attributionProfile.modelSubmissionSchema!(request);
  const properties = available.properties as Record<string, unknown>;
  assert(fields.every(field => Object.hasOwn(properties, field) && (available.required as string[]).includes(field)));
  Object.assign(request.input.ground_truth, { available: false, value: null });
  const registry = new AgentRegistry([attributionAgent]);
  const prepared = prepareFixtureEvidence(registry, { agent: "attribution", profile: "default", request,
    modelInput: { ...request.input, ground_truth: { available: true, value: "spoofed" } } });
  const unavailable = prepared.evaluation.outputSchema;
  assert(fields.every(field => Object.hasOwn(unavailable.properties as object, field) && (unavailable.required as string[]).includes(field)));
  assert.equal((unavailable.properties as any).is_correct.const,null);
  assert.equal((unavailable.properties as any).correctness_reason.const,"");
  assert.equal((unavailable.properties as any).correctness_evidence_indices.maxItems,0);
  assert.deepEqual(attributionProfile.submissionSchema, registered);
  assert.deepEqual(new Ajv2020({ strict: false }).compile(unavailable)(attributionSubmission(request,example.result as AttributionResult,{...audit,evidenceBank:[]})), true);
});

test("the bound internal judgment keeps correctness ownership separate from empty model markers", () => {
  const request = structuredClone(example.request);
  Object.assign(request.input.ground_truth, { available: false, value: null });
  const draft = judgmentFixture(undefined, request);
  for (const [field, value] of [["is_correct", null], ["correctness_reason", ""], ["correctness_evidence", []]] as const) {
    const submitted = { ...draft, [field]: value };
    const before = structuredClone(submitted);
    const issue = validateJudgment(request, submitted, audit).find(issue => issue.path === `/${field}`);
    assert(issue?.code.endsWith("_forbidden"));
    assert.throws(() => resolveJudgment(request, submitted, audit), (error: unknown) =>
      error instanceof ValidationError && error.issues!.some(issue => issue.path === `/${field}` && issue.code.endsWith("_forbidden")));
    assert.deepEqual(submitted, before);
  }
  const availableDraft = judgmentFixture();
  for (const field of ["is_correct", "correctness_reason", "correctness_evidence"] as const) {
    const incomplete = { ...availableDraft } as Partial<typeof availableDraft>;
    delete incomplete[field];
    assert.throws(() => resolveJudgment(example.request, incomplete, audit), (error: unknown) =>
      error instanceof ValidationError && error.issues!.some(issue => issue.path === `/${field}` && issue.code.endsWith("_required")));
  }
  assert(validateJudgment(example.request, { ...availableDraft, is_correct: null }, audit)
    .some(issue => issue.code === "correctness_required"));
  assert.throws(() => resolveJudgment(example.request, { ...availableDraft, is_correct: "true" }, audit), /输出结构无效/);
});

test("malformed bound judgments report evidence coordinates with schema and missing-criterion feedback", () => {

  const draft = { ...judgmentFixture(), summary: null, criterion_assessments: [],
    findings: [{ type: "strength", evidence: [{ evidence_id: "ev_11111111-1111-4111-8111-111111111111_0_text_0_14407_" }] }] };
  const before = structuredClone({ request: example.request, draft, audit });
  assert.throws(() => resolveJudgment(example.request, draft, audit),
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
  const draft = judgmentFixture();
  assert.deepEqual(resolveJudgment(example.request, draft, audit), example.result);
  assert.throws(() => resolveJudgment(example.request, { ...draft, task_analysis: example.result.task_analysis }, audit), /输出结构无效/);

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
  incomplete.findings[0]!.problem = { component: [responsibilityFixture("最终作答节点（原始名称未提供）", {evidence_ids: []})], label: "问题" };
  assert.throws(
    () => attributionProfile.validate!(example.request, incomplete, audit),
    /required|输出结构无效/,
  );

  const blankLabel = structuredClone(example.result) as unknown as AttributionResult;
  blankLabel.findings[0]!.type = "problem";
  blankLabel.findings[0]!.problem = { component: [responsibilityFixture("最终作答节点（原始名称未提供）", {evidence_ids: blankLabel.findings[0]!.evidence.map(item=>item.evidence_id)})], label: "  ", definition: "说明" };
  assert.throws(() => attributionProfile.validate!(example.request, blankLabel, audit), /非空中文字符串/);
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
  const submission = judgmentFixture(result, request);
  const scopeDraft = {
    ...submission,
    criterion_assessments: result.criterion_assessments.map((assessment) => ({
      ...assessment, evidence: structuredClone(submission.correctness_evidence),
    })),
    core_assessment: { meets_core: result.core_assessment.meets_core, reason: result.core_assessment.reason, requirement_indices: [0, 1] },
    findings: [{ ...submission.findings[0]!, assessment: { ...result.findings[0]!.assessment, requirement_index: 1 } }],
  };
  assert.deepEqual(validateJudgment(request, scopeDraft, audit).map((issue) => issue.code),
    ["criterion_out_of_scope", "core_requirement_not_applicable", "finding_requirement_not_applicable"]);
  assert.throws(() => attributionProfile.validate!(request, result, audit), /才能且必须填 not_applicable/);
  result.criterion_assessments[3]!.status = "not_applicable";
  result.findings[0]!.assessment.requirement_index = 1;
  assert.throws(() => attributionProfile.validate!(request, result, audit), /不能关联不适用/);
  result.findings[0]!.assessment.requirement_index = 0;
  result.criterion_assessments[0]!.status = "not_applicable";
  assert.throws(() => attributionProfile.validate!(request, result, audit), /才能且必须填 not_applicable/);
});

test("bound judgments cover applicable criteria while the program derives every out-of-scope result", () => {
  const request = structuredClone(example.request);
  const task: TaskAnalysis = request.input.task_analysis;
  const other = "22222222-2222-4222-8222-222222222222";
  task.requirements.push({ id: "r_other", text: "另一候选必须JSON交付", applies_to: [other], acceptance_rule: "另一候选使用JSON。" });
  task.scoring_points.push({ id: "s_other", text: "另一候选的结构要求", applies_to: [other], acceptance_rule: "另一候选符合自身结构。" });
  task.red_flags.push({ id: "f_other", text: "另一候选禁止买卖点", applies_to: [other], acceptance_rule: "另一候选不提供买卖点。" });
  const draft = judgmentFixture();
  draft.criterion_assessments.reverse();
  const before = structuredClone(draft);
  assert.deepEqual(validateJudgment(request, draft, audit), [], "scope alone needs no model evidence");
  const result = resolveJudgment(request, draft, audit) as AttributionResult;
  attributionProfile.validate!(request, result, audit);
  const registry = new AgentRegistry([attributionAgent]);
  const binding = { agent: "attribution", profile: "default", request };
  const accepted = resolveJudgment(request, draft, audit) as AttributionResult;
  registry.validate(binding, accepted, audit);
  assert.deepEqual(accepted,result,"bound judgment validation preserves declared facts and derives scope only");
  assert.deepEqual(result.criterion_assessments.map(item => item.criterion_id),
    [...task.requirements, ...task.scoring_points, ...task.red_flags].map(item => item.id));
  for (const id of ["r_other", "s_other", "f_other"]) {
    const item = result.criterion_assessments.find(item => item.criterion_id === id)!;
    assert.equal(item.status, "not_applicable");
    assert.equal(item.evidence_status, "established");
    assert.deepEqual(item.evidence, []);
    assert.equal(item.summary, "这项要求不适用于本回答。");
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
    assert(validateJudgment(request, invalid, audit).some(issue => issue.code === "criterion_out_of_scope"));
    assert.throws(() => resolveJudgment(request, invalid, audit), ValidationError);
  }
  const submittedForeign = { ...draft, criterion_assessments: [...draft.criterion_assessments,
    { ...draft.criterion_assessments[0]!, criterion_id: "r_other" }] };
  assert.throws(() => resolveJudgment(request, submittedForeign, audit), (error: unknown) => {
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
    assert.throws(() => resolveJudgment(request, invalid, audit), (error: unknown) => {
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
    assert.deepEqual((issue?.expected as { read_request?: unknown })?.read_request,
      { candidate: "answer", message_index: 1, path: "/content", offset: 2, max_chars: 16000 });
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
  task.requirements.push({ id: "r2", text: norm, applies_to: [], acceptance_rule: norm });
  const result = structuredClone(example.result) as AttributionResult;
  result.task_analysis = structuredClone(task);
  const final = cite(INPUT_ID, 2, evidenceSources(messages[2]).find(source => source.path === "/content")!, 0, messages[2]!.content.length);
  const evidence = [canonicalEvidence(INPUT_ID, 2, final.quote)];
  result.correctness_evidence = evidence;
  result.criterion_assessments.forEach(assessment => { assessment.evidence = evidence; });
  result.criterion_assessments.push({ ...result.criterion_assessments[0]!, criterion_id: "r2", evidence });
  Object.assign(result.findings[0]!, { dimension: "instruction_following", evidence });
  result.findings[0]!.assessment.requirement_index = 1;
  const draft = judgmentFixture(result, request);
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
    problem: { component: [responsibilityFixture("最终作答节点（原始名称未提供）", {evidence_ids: ([...draft.findings[0]!.evidence, normRef]).map(item=>item.evidence_id)})], label: "指令执行偏差", definition: "回答未按所关联的规范顺序组织内容。" },
    evidence: [...draft.findings[0]!.evidence, normRef] };
  const submitted = { ...draft, findings: [problem] };
  const before = structuredClone({ request, submitted, audit });
  const conflict = validateJudgment(request, submitted, audit)
    .find(issue => issue.code === "finding_requirement_conflict")!;
  assert.equal(conflict.path, "/findings/0/assessment/requirement_index");
  assert.equal(conflict.actual, 1);
  assert.deepEqual(conflict.expected, { criterion_id: "r2", status: "met", evidence_status: "established",
    finding_index: 0, criterion_status_path: "/criterion_assessments/3/status" });
  assert.match(conflict.message, /partial 或 unmet/);
  assert.match(conflict.message, /正确的 requirement_index/);
  assert.match(conflict.message, /requirements 中时填 null/);
  const registry = new AgentRegistry([attributionAgent]);
  assert.throws(() => resolveJudgment(({ agent: "attribution", profile: "default", request }).request, { ...submitted, summary: null }, audit),
    (error: unknown) => {
      assert(error instanceof ValidationError);
      assert(error.issues!.some(issue => issue.code === "schema_type" && issue.path === "/summary"), JSON.stringify(error.issues));
      assert(error.issues!.some(issue => issue.code === "finding_requirement_conflict"));
      return true;
    });
  assert.throws(()=>resolveJudgment(request,submitted,audit),error=>error instanceof ValidationError&&error.issues!.some(issue=>issue.code==="finding_requirement_conflict"));
  assert.deepEqual({ request, submitted, audit }, before, "the guard preserves declarations and source evidence");

  for (const dimension of ["format", "correctness", "reasoning", "completeness", "evidence_quality", "relevance", "efficiency"] as const) {
    const labeled = structuredClone(submitted);
    labeled.findings[0]!.dimension = dimension;
    delete labeled.findings[0]!.norm_index;
    labeled.findings[0]!.assessment.requirement_index = 1;
    const issue = validateJudgment(request, labeled, audit)
      .find(issue => issue.code === "finding_requirement_conflict");
    assert(issue, `${dimension} cannot bypass the same declaration conflict`);
    assert.deepEqual(issue.expected, conflict.expected);
    assert.throws(()=>resolveJudgment(request,labeled,audit),error=>error instanceof ValidationError&&error.issues!.some(issue=>issue.code==="finding_requirement_conflict"));
  }

  const partial = structuredClone(submitted);
  partial.criterion_assessments.find(item => item.criterion_id === "r2")!.status = "partial";
  assert.deepEqual(validateJudgment(request, partial, audit), []);
  const partialResult = resolveJudgment(request, partial, audit) as AttributionResult;
  attributionProfile.validate!(request, partialResult, audit);
  assert.equal(partialResult.core_assessment.meets_core, true, "a partial requirement does not mechanically overturn an independently usable core");

  const uncertainProblem = structuredClone(submitted);
  uncertainProblem.findings[0]!.assessment.evidence_status = "uncertain";
  const uncertainConflict = validateJudgment(request, uncertainProblem, audit)
    .find(issue => issue.code === "finding_requirement_conflict");
  assert(uncertainConflict, "an uncertain linked problem cannot coexist with established satisfaction of the same requirement");
  assert.deepEqual(uncertainConflict.expected, conflict.expected);
  assert.match(uncertainConflict.message, /证据确实不足时保留 uncertain/);
  assert.throws(() => resolveJudgment(({ agent: "attribution", profile: "default", request }).request, uncertainProblem, audit),
    (error: unknown) => error instanceof ValidationError && error.issues!.some(issue => issue.code === "finding_requirement_conflict"));
  const acceptedCanonical = structuredClone(partialResult);
  acceptedCanonical.criterion_assessments.find(item=>item.criterion_id==="r2")!.status="met";
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
    assert(!validateJudgment(request, changed, audit).some(issue => issue.code === "finding_requirement_conflict"));
    const changedResult = resolveJudgment(request, changed, audit) as AttributionResult;
    attributionProfile.validate!(request, changedResult, audit);
    assert.equal(changedResult.core_assessment.meets_core, true);
  }
  const noProblem = { ...structuredClone(submitted), findings: [draft.findings[0]!] };
  assert(!validateJudgment(request, noProblem, audit).some(issue => issue.code === "finding_requirement_conflict"));
  attributionProfile.validate!(request, resolveJudgment(request, noProblem, audit), audit);


});
