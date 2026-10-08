import test from "node:test";
import assert from "node:assert/strict";
import { AgentRegistry } from "@eval/host";
import { parseEvidenceCoordinates, projectEvidenceReferences, ValidationError, type AgentRequest, type AgentBinding, type ToolAudit } from "@eval/contracts";
import { cite, evidenceId, evidenceSources, messageContentSources, selectEvidenceSource } from "@eval/tools";
import { comparisonSourceReviews, comparisonVerificationSubmission, requestComparisonSubmission, comparisonInspectionSubmission as inspectionSubmission } from "../../../../tests/fixtures/comparison-submission.js";
import { comparisonAgent, comparisonProfile, comparisonScope } from "./index.js";
import type { ComparisonResult, ComparisonVerificationInput, ComparisonMaterialInspection } from "./types.js";
import { canonicalEvidence } from "../../../../tests/fixtures/evidence.js";
import example from "./fixtures/example.json" with { type: "json" };

const profile = comparisonAgent.profiles.verification!;
const emptyAudit = (): ToolAudit => ({ calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [] });
function pair() {
  const request = structuredClone(example.request) as AgentRequest, audit = emptyAudit();
  const input = request.input as unknown as ComparisonVerificationInput;
  for (const candidate of Object.keys(input.candidates)) request.sources[candidate]!.id = input.candidates[candidate]!.candidate_id;
  const original = structuredClone(example.result) as ComparisonResult;
  const result = comparisonProfile.resolve!(request, requestComparisonSubmission(request,original), audit) as ComparisonResult;
  comparisonProfile.validate!(request, result, audit); input.comparison_draft = result;
  return { request, input, audit, result };
}
function checks(request: AgentRequest): ComparisonMaterialInspection {
  const input = request.input as unknown as ComparisonVerificationInput;
  return { checks: Object.entries(input.candidates).flatMap(([candidate, material]) => input.task_analysis.requirements.filter(criterion =>
    !criterion.applies_to.length || criterion.applies_to.includes(material.candidate_id)).map(criterion => {
      const source = request.sources[candidate]!, raw = source.value as { messages: unknown[] };
      const leaf = messageContentSources(raw.messages[material.final_message_index])[0];
      return { candidate, criterion_id: criterion.id, result: "supported" as const, source_evidence: [], observation: "逐条核对实际最终交付及全部动作。",
        answer_evidence: [{ evidence_id: leaf ? cite(source.id, material.final_message_index, leaf, 0, leaf.text.length).evidence_id : evidenceId(source.id, material.final_message_index, "image") }] };
    })), concerns: [] };
}
function inspected(request: AgentRequest, value = checks(request), audit = emptyAudit()) {
  profile.inspection!.validate(request, value, audit);
  return { ...audit, inspection: { id: "inspection", value: value as unknown as Record<string, unknown>, proof: {
    traceReads: structuredClone(audit.traceReads), viewedImages: [...audit.viewedImages] } } };
}
function inspect(registry:AgentRegistry,binding:AgentBinding,value:unknown,audit:ToolAudit) {
  const bank=audit.evidenceBank ??= [];
  const canonical = registry.resolveInspection(binding,projectEvidenceReferences(inspectionSubmission(binding.request, value as ComparisonMaterialInspection),bank),audit);
  const revealed = registry.inspectCanonical(binding,canonical,audit);
  return registry.projectMaterial(binding,revealed,bank);
}
function finalFor(request: AgentRequest, value: Record<string, unknown> = { concern_matches: [] }) {
  return { ...comparisonVerificationSubmission(request), ...value };
}
test("fixed checks bind complete actual leaves without model answer selections", () => {
  const { request } = pair(), registry = new AgentRegistry([comparisonAgent]), audit = emptyAudit();
  const source = request.sources.A!, raw = source.value as { messages: { content: unknown }[] };
  raw.messages[1]!.content = [{ type: "output_text", text: "第一项给出4。" }, { type: "text", text: "第二项给出6。" }];
  const binding = { agent: "comparison", profile: "verification", request, projectModelInput: projectEvidenceReferences,
    modelInput: { original: "blind" }, inspectionInput: { draft: "revealed" } };
  const rawSubmission = inspectionSubmission(request, checks(request)) as { checks: Record<string, unknown>[]; concerns: unknown[] };
  for (const [index, check] of rawSubmission.checks.entries()) { delete check.answer_evidence; if (index % 2) check.result = "not_applicable"; }
  const canonical = registry.resolveInspection(binding, projectEvidenceReferences(rawSubmission, audit.evidenceBank = []), audit) as unknown as ComparisonMaterialInspection;
  const actual = evidenceSources(raw.messages[1]).filter(leaf => leaf.kind === "text" && /\/content\/\d+\/text$/u.test(leaf.path));
  assert.deepEqual(canonical.checks[0]!.answer_evidence, actual.map(leaf => ({ evidence_id: cite(source.id, 1, leaf, 0, leaf.text.length).evidence_id })));
  assert.equal(canonical.checks[0]!.result, "supported"); assert.deepEqual(canonical.concerns, []);
  const before = structuredClone(canonical);
  assert.doesNotThrow(() => registry.inspectCanonical(binding, canonical, audit));
  assert.deepEqual(canonical, before, "canonical restoration preserves already accepted source coordinates");
});

test("program check scope preserves complete confirmed generation and captured content independently", () => {
  const { request, input } = pair(), registry = new AgentRegistry([comparisonAgent]), audit = emptyAudit(), source = request.sources.A!;
  const blocks = [{ type: "text", text: "4。" }, { type: "output_text", text: '<visual>{"id":"chart"}</visual>' }];
  source.value = { messages: [{ role: "user", content: "计算2+2" }, { type: "llm_turn", input_messages: [{ role: "user", content: "计算2+2" }],
    output: [{ role: "assistant", content: blocks }], metadata: "不属于回答的旁注" }, { type: "final_answer", role: "assistant", content: "4。" }] };
  input.candidates.A!.final_message_index = 2;
  input.candidates.A!.answer_generation = { available: true, message_type: "llm_turn", matches_captured_final: false,
    message_index: 1, captured_final_message_index: 2, blocks: blocks.map((block, index) => ({ path: `/output/0/content/${index}/text`, total_chars: block.text.length, text: block.text,
      reference: { evidence_id: evidenceId(source.id, 1, "text", `/output/0/content/${index}/text`, 0, block.text.length) },
      read_request: { message_index: 1, path: `/output/0/content/${index}/text`, offset: 0, max_chars: 16000 } })) };
  const binding = { agent: "comparison", profile: "verification", request, projectModelInput: projectEvidenceReferences,
    modelInput: { actual: "blind" }, inspectionInput: { draft: "revealed" } };
  const wire = projectEvidenceReferences(inspectionSubmission(request, checks(request)), audit.evidenceBank = []);
  const canonical = registry.resolveInspection(binding, wire, audit) as unknown as ComparisonMaterialInspection;
  assert.deepEqual(canonical.checks[0]!.answer_evidence.map(reference => { const coordinate = parseEvidenceCoordinates(reference.evidence_id)!;
    assert.equal(coordinate.kind, "text"); return coordinate.path; }),
    ["/content", "/output/0/content/0/text", "/output/0/content/1/text"]);
  assert.equal(input.candidates.A!.answer_generation.matches_captured_final, false, "different generation remains different, never a collected-answer alias");
  const original = structuredClone(input.candidates.A!.answer_generation);
  for (const generation of [{ ...original, blocks: original.blocks.slice(0, 1) },
    { ...original, blocks: original.blocks.map(block => ({ ...block, total_chars: block.total_chars - 1 })) },
    { ...original, message_index: 0 }]) {
    input.candidates.A!.answer_generation = generation;
    assert.throws(() => registry.resolveInspection(binding, wire, audit), error => error instanceof ValidationError &&
      error.issues!.some(issue => issue.code === "verification_check_generation_source"));
  }
  input.candidates.A!.answer_generation = original;
});

test("unavailable generation keeps real final scope and metadata cannot impersonate proven generation", () => {
  const { request, input } = pair(), registry = new AgentRegistry([comparisonAgent]), audit = emptyAudit(), source = request.sources.A!;
  const raw = { messages: [{ role: "user", content: "计算2+2" }, { type: "llm_turn", input_messages: [{ role: "user", content: "计算2+2" }],
    output: [], metadata: { text: "2+2=4" } }, { type: "final_answer", role: "assistant", content: "2+2=4" }] };
  source.value = raw; input.candidates.A!.final_message_index = 2; input.candidates.A!.answer_generation = null;
  const binding = { agent: "comparison", profile: "verification", request, projectModelInput: projectEvidenceReferences,
    modelInput: { actual: "blind" }, inspectionInput: { draft: "revealed" } };
  const wire = projectEvidenceReferences(inspectionSubmission(request, checks(request)), audit.evidenceBank = []);
  const canonical = registry.resolveInspection(binding, wire, audit) as unknown as ComparisonMaterialInspection;
  assert.deepEqual(canonical.checks[0]!.answer_evidence, [{ evidence_id: evidenceId(source.id, 2, "text", "/content", 0, 5) }]);
  input.candidates.A!.answer_generation = { available: true, message_type: "llm_turn", matches_captured_final: true, message_index: 1,
    captured_final_message_index: 2, blocks: [{ path: "/metadata/text", total_chars: 5, ...{ text: "2+2=4",
      reference: { evidence_id: evidenceId(source.id, 1, "text", "/metadata/text", 0, 5) },
      read_request: { message_index: 1, path: "/metadata/text", offset: 0, max_chars: 16000 } } }] };
  assert.throws(() => registry.resolveInspection(binding, wire, audit), error => error instanceof ValidationError &&
    error.issues!.some(issue => issue.code === "verification_check_generation_source"));
  input.candidates.A!.answer_generation = null; raw.messages[2]!.content = "";
  assert.throws(() => registry.resolveInspection(binding, wire, audit), error => error instanceof ValidationError &&
    error.issues!.some(issue => issue.code === "verification_check_source_missing"));
  raw.messages[2]!.content = "2+2=4"; raw.messages[2]!.role = "tool";
  assert.throws(() => registry.resolveInspection(binding, wire, audit), error => error instanceof ValidationError &&
    error.issues!.some(issue => issue.code === "verification_check_source_missing"));
});

test("program check scope keeps whole reads and actual image views with model-authored observations", () => {
  const { request, input } = pair(), registry = new AgentRegistry([comparisonAgent]), audit = emptyAudit();
  const body = "完整回答".repeat(4001), source = request.sources.A!;
  (source.value as { messages: { content: unknown }[] }).messages[1]!.content = body;
  input.candidates.A!.deferred_final_material = [{ message_index: 1, path: "/content", total_chars: body.length }];
  (request.sources.B!.value as { messages: { content: unknown }[] }).messages[1]!.content = "data:image/png;base64,aA==";
  const binding = { agent: "comparison", profile: "verification", request, projectModelInput: projectEvidenceReferences,
    modelInput: { actual: "blind" }, inspectionInput: { draft: "revealed" } };
  const value = checks(request); value.checks[1]!.observation = "图中实际可见计算结果4。";
  const wire = projectEvidenceReferences(inspectionSubmission(request, value), audit.evidenceBank = []);
  assert.throws(() => registry.resolveInspection(binding, wire, audit), error => error instanceof ValidationError &&
    error.issues!.some(issue => issue.code === "final_image_not_viewed") && error.issues!.some(issue => issue.code === "deferred_final_material_not_read"));
  audit.viewedImages.push("B:1"); audit.traceReads.push({ candidate: "A", message_index: 1, kind: "text", path: "/content", start: 0, end: body.length - 1 });
  assert.throws(() => registry.resolveInspection(binding, wire, audit), /未完整读取/);
  audit.traceReads.push({ candidate: "A", message_index: 1, kind: "text", path: "/content", start: body.length - 1, end: body.length });
  const canonical = registry.resolveInspection(binding, wire, audit) as unknown as ComparisonMaterialInspection;
  const coordinate = parseEvidenceCoordinates(canonical.checks[0]!.answer_evidence[0]!.evidence_id)!;
  assert(coordinate.kind !== "image"); assert.equal(coordinate.end, body.length);
  assert.deepEqual(canonical.checks[1]!.answer_evidence, [{ evidence_id: evidenceId(request.sources.B!.id, 1, "image"), observation: value.checks[1]!.observation }]);
  const restored = structuredClone(canonical), before = structuredClone(restored);
  assert.doesNotThrow(() => registry.inspectCanonical(binding, restored, audit)); assert.deepEqual(restored, before);
});

test("constraint counterevidence survives a correct main deliverable and cannot borrow its matching proof", () => {
  const { request, input } = pair(), registry = new AgentRegistry([comparisonAgent]), audit = emptyAudit();
  const question = "计算2+2，并在交割月开始前完成移仓。";
  input.task_analysis.requirements[0]!.text = question; input.task_analysis.requirements[0]!.acceptance_rule = input.task_analysis.requirements[0]!.text;
  input.task_analysis.requirements[0]!.acceptance_rule = question;
  for (const [candidate, material] of Object.entries(input.candidates)) {
    const raw = request.sources[candidate]!.value as { messages: { content: string }[] };
    raw.messages[material.final_message_index]!.content = candidate === "A"
      ? "2+2=4。交割月份第5–7个交易日完成移仓。"
      : "2+2=4。交割月开始前完成移仓。";
  }
  const binding = { agent: "comparison", profile: "verification", request,
    projectModelInput: projectEvidenceReferences, modelInput: { original: "blind" }, inspectionInput: { draft: "revealed" } };
  const canonical = checks(request), delivery = canonical.checks[0]!;
  const raw = request.sources.A!.value as { messages: unknown[] }, source = request.sources.A!;
  const answer = evidenceSources(raw.messages[input.candidates.A!.final_message_index]).find(leaf => leaf.kind === "text" && leaf.path === "/content")!;
  const badStep = "交割月份第5–7个交易日完成移仓。", start = answer.text.indexOf(badStep);
  const counterevidence = { evidence_id: cite(source.id, input.candidates.A!.final_message_index, answer, start, start + badStep.length).evidence_id };
  const wire = projectEvidenceReferences({ checks: canonical.checks.flatMap(({ candidate, criterion_id: _id, answer_evidence: _scope, ...check }) => [
    { ...check, observation: "所需计算结果2+2=4已经正确交付。" },
    candidate === "A" ? { ...check, result: "contradicted",
      observation: "交割月份第5–7个交易日已在交割月内，违反交割月开始前完成的必要限制。" }
      : { ...check, observation: "实际步骤在交割月开始前完成，满足原问限制。" },
  ]), concerns: [{ candidate: "A", requirement_indices: [0], answer_evidence: [counterevidence], source_evidence: [],
    reason: "交割月份第5–7个交易日已在交割月内，违反交割月开始前完成的必要限制。" }] }, audit.evidenceBank = []);
  const inspection = registry.resolveInspection(binding, wire, audit) as unknown as ComparisonMaterialInspection;
  assert.equal(inspection.checks[0]!.result, "contradicted");
  assert.deepEqual(inspection.checks[0]!.answer_evidence, delivery.answer_evidence, "the complete scope is separate from localized counterevidence");
  assert(inspection.checks[0]!.observation.includes("2+2=4"));
  assert(inspection.checks[0]!.observation.includes("第5–7个交易日"));
  assert.equal(inspection.concerns.length, 1);
  assert.deepEqual(inspection.concerns[0]!.answer_evidence, [counterevidence]);
  assert.notDeepEqual(inspection.concerns[0]!.answer_evidence, delivery.answer_evidence);
  const checkpoint = inspected(request, inspection, audit);
  assert.equal((registry.resolve(binding, finalFor(request), checkpoint) as ComparisonResult).status, "needs_review");
  const proofBefore = structuredClone(checkpoint.inspection);
  assert.doesNotThrow(() => registry.inspectCanonical(binding, inspection, checkpoint));
  assert.deepEqual(checkpoint.inspection, proofBefore, "restoration uses the accepted canonical check, without rebinding model positions");
  const invalid = structuredClone(wire);
  (invalid.checks[0] as Record<string, unknown>).answer_evidence = [{ evidence_index: 1 }];
  assert.throws(() => registry.resolveInspection(binding, invalid, audit), error => error instanceof ValidationError &&
    error.issues!.some(issue => issue.code === "schema_additionalProperties" && issue.path === "/checks/0/answer_evidence"),
    "program-owned answer coverage cannot be overwritten by a model submission");
  const unresolved = structuredClone(wire);
  unresolved.checks[1]!.result = "unverified";
  const unknown = registry.resolveInspection(binding, unresolved, audit) as unknown as ComparisonMaterialInspection;
  assert.equal(unknown.checks[0]!.result, "unverified", "a correct main deliverable cannot turn unverified constraints into supported");
  assert.deepEqual(unknown.checks[0]!.answer_evidence, delivery.answer_evidence);
  assert.equal((registry.resolve(binding, finalFor(request), inspected(request, unknown, audit)) as ComparisonResult).status, "needs_review");
});
const reviews = [{ candidate: "A", criterion_ids: ["sum"], finding_indices: [0], reason: "实际来源内容与判词冲突。" }];

test("blind inspection retains complete observations and concerns without an arbitrary prose limit", () => {
  const { request } = pair(), registry = new AgentRegistry([comparisonAgent]), value = checks(request), audit = emptyAudit();
  const binding = { agent: "comparison", profile: "verification", request, projectModelInput: projectEvidenceReferences,
    modelInput: { original: "blind" }, inspectionInput: { draft: "revealed" } };
  const prose = "核对完整来源、实际交付及原句条件和例外。".repeat(50);
  value.checks[0]!.observation = prose;
  value.concerns = [{ candidate: "A", criterion_ids: ["sum"], answer_evidence: value.checks[0]!.answer_evidence,
    source_evidence: [], reason: prose }];
  const revealed = inspect(registry, binding, value, audit);
  const material = revealed.material_inspection as unknown as ComparisonMaterialInspection;
  assert.equal(material.checks[0]!.observation, prose); assert.equal(material.concerns[0]!.reason, prose);
  for (const blank of ["", " "]) {
    const invalid = structuredClone(value); invalid.checks[0]!.observation = blank;
    assert.throws(() => inspect(registry, binding, invalid, audit), ValidationError);
    invalid.checks[0]!.observation = prose; invalid.concerns[0]!.reason = blank;
    assert.throws(() => inspect(registry, binding, invalid, audit), ValidationError);
  }
});

test("revealed and restored inspection lists only mechanically eligible numeric matches and keeps unmatched concerns", () => {
  const { request, input } = pair(), registry = new AgentRegistry([comparisonAgent]), value = checks(request), audit = emptyAudit();
  const original = input.attributions.A!.findings[0]!;
  input.attributions.A!.findings = [
    { ...structuredClone(original), text: "来源问题一", type: "problem", importance: "low" },
    { ...structuredClone(original), text: "来源问题二", type: "problem", importance: "low" },
    { ...structuredClone(original), text: "同坐标的优势", type: "strength" },
  ];
  value.concerns = ["A", "B"].map((candidate, index) => ({ candidate, criterion_ids: ["sum"],
    answer_evidence: value.checks[index]!.answer_evidence, source_evidence: [], reason: "核对同一实际交付及来源责任。" }));
  const binding = { agent: "comparison", profile: "verification", request, projectModelInput: projectEvidenceReferences,
    modelInput: { original: "blind" }, inspectionInput: { draft: "revealed" } };
  const prepared = registry.prepare(binding); assert(!prepared.prompt.includes('"inspection_context":'));
  const revealed = inspect(registry, binding, value, audit), expected = { eligible_match_choices: [
    { concern_index: 0, candidate: "A", eligible_findings: [
      { finding_index: 0, covered_requirement_indices: [0] }, { finding_index: 1, covered_requirement_indices: [0] },
    ], complete_coverage_possible: true, missing_requirement_indices: [] },
    { concern_index: 1, candidate: "B", eligible_findings: [], complete_coverage_possible: false, missing_requirement_indices: [0] },
  ], verification_concerns: projectEvidenceReferences(value.concerns, audit.evidenceBank!) };
  assert.deepEqual(revealed.inspection_context, expected);
  assert(!JSON.stringify(revealed.inspection_context).includes("evidence_id"));
  const checkpointAudit = inspected(request, value, audit), before = structuredClone(checkpointAudit.inspection);
  const restored = registry.inspectCanonical(binding, value, checkpointAudit);
  assert.deepEqual(restored.inspection_context, { ...expected, verification_concerns: value.concerns });
  assert.deepEqual(checkpointAudit.inspection, before);
  const resumed = prepared.renderAttempt({ timeoutSeconds: 10, idleTimeoutSeconds: 10, maxToolCalls: 12, repairAttempts: 2,
    codeTimeoutSeconds: 5, maxOutputChars: 16000 }, { errors: [], contentSubmissions: 1, fileErrors: 0,
    repeatedErrors: 0, stopped: false, attemptId: "next", evidenceBank: [...audit.evidenceBank!], inspection: checkpointAudit.inspection });
  assert(resumed.includes("eligible_match_choices"));
  const match = { concern_index: 0, finding_indices: [2], observation: "同坐标的strength不代表已建立的问题。" };
  assert.throws(() => registry.resolve(binding, finalFor(request, { concern_matches: [match] }), checkpointAudit), error => {
    assert(error instanceof ValidationError);
    const issue = error.issues!.find(item => item.code === "inspection_match_finding")!;
    assert.deepEqual((issue.expected as { eligible_findings: unknown[] }).eligible_findings, expected.eligible_match_choices[0]!.eligible_findings);
    return true;
  });
  const pending = registry.resolve(binding, finalFor(request, { concern_matches: [{ ...match, finding_indices: [0] }] }), checkpointAudit) as ComparisonResult;
  assert.equal(pending.status, "needs_review");
  assert(pending.review_requests.some(review => review.candidate === "B" && review.reason === value.concerns[1]!.reason));
  assert.deepEqual(checkpointAudit.inspection, before);
});

test("verification requires separate blind and revealed inputs and immutable draft", () => {
  const registry = new AgentRegistry([comparisonAgent]), { request } = pair();
  assert.throws(() => registry.prepare({ agent: "comparison", profile: "verification", request }), /separate primary/);
  const binding = { agent: "comparison", profile: "verification", request, projectModelInput: projectEvidenceReferences, modelInput: { original: "actual" }, inspectionInput: { draft: "upstream" } };
  const prepared = registry.prepare(binding);
  assert(!prepared.prompt.includes("upstream")); assert(prepared.evaluation.inspectionSchema);
  assert.throws(() => registry.resolve(binding, finalFor(request, { concern_matches: [] }), emptyAudit()), /先调用 inspect_material/);
  const value = checks(request), inspectionAudit=emptyAudit(), revealed = inspect(registry,binding, value, inspectionAudit);
  assert.equal(revealed.draft, "upstream"); assert.deepEqual(revealed.material_inspection, projectEvidenceReferences(value,inspectionAudit.evidenceBank!));
  const audit = inspected(request, value), resumed = prepared.renderAttempt({ timeoutSeconds: 10, idleTimeoutSeconds: 10, maxToolCalls: 12,
    repairAttempts: 2, codeTimeoutSeconds: 5, maxOutputChars: 16000 }, { errors: [], contentSubmissions: 1, fileErrors: 0,
    repeatedErrors: 0, stopped: false, attemptId: "next", inspection: audit.inspection });
  assert(resumed.includes("upstream")); assert.deepEqual(registry.resolve(binding, finalFor(request, { concern_matches: [] }), audit), request.input.comparison_draft);
});

test("successful inspection preserves exact draft without mutating source or copying a new verdict", () => {
  const { request, result } = pair(), before = structuredClone(request), audit = inspected(request);
  const value = profile.resolve!(request, finalFor(request, { concern_matches: [] }), audit) as ComparisonResult; profile.validate!(request, value, audit);
  assert.deepEqual(value, result); value.ranking[0]!.push("invented"); assert.deepEqual(request, before);
  assert.throws(() => profile.validate!(request, { ...result, decision_basis: { ...result.decision_basis, tradeoff: "另造判词" } }, audit), /不得改写排名/);
  assert.throws(() => profile.resolve!(request, finalFor(request, { concern_matches: [], ranking: [["A"]] }), audit), ValidationError);
});

test("sparse source-review choices preserve unresolved checks without copying empty rows", () => {
  const { request, input } = pair(), value = checks(request);
  value.checks[0]!.result = "unverified";
  value.checks[0]!.observation = "同一要求的关键来源事实仍未核实。";
  const audit = inspected(request, value), draft = { concern_matches: [], source_reviews: [] };
  const before = structuredClone(draft), resolved = profile.resolve!(request, draft, audit) as ComparisonResult;
  profile.validate!(request, resolved, audit);
  assert.equal(resolved.status, "needs_review");
  assert(resolved.review_requests.some(review => review.reason === value.checks[0]!.observation));
  assert.deepEqual(draft, before);
  const choice = { slot_index: 0, candidate: "A", reason: "已有来源结论与实际原文冲突。" };
  const reviewed = profile.resolve!(request, { concern_matches: [], source_reviews: [choice] }, audit) as ComparisonResult;
  assert(reviewed.review_requests.some(review => review.candidate === "A" && review.reason === choice.reason));
  for (const source_reviews of [[{ A: null, B: null }], [{ ...choice, candidate: "X" }], [{ ...choice, reason: false }],
    [{ ...choice, reason: "" }], [{ ...choice, slot_index: 999 }], [choice, choice]])
    assert.throws(() => profile.resolve!(request, { concern_matches: [], source_reviews }, audit), ValidationError);
  assert.throws(() => profile.resolve!(request, { concern_matches: [] }, audit), ValidationError);
  assert(input.comparison_draft.status === "decided");
});

test("source review preserves complete evidence reasoning without a presentation length limit", () => {
  const { request } = pair(), audit = inspected(request);
  const reason = [
    "应区分原始文档与转述文档，并核对相同来源的不同标题及其实际支持范围。",
    "需要保留每个引用的原始发布时刻、返回字段、期间与单位，不能仅凭请求参数判定正文没有提供。",
    "复核理由还需说明本方实际交付与来源的具体冲突；相同结论不能替代来源与责任链核查。",
  ].map((item, index) => Array.from({ length: 8 }, (_, part) => `${index + 1}.${part + 1} ${item}`).join("\n")).join("\n");
  assert(reason.length > 600);
  const result = profile.resolve!(request, { concern_matches: [], source_reviews: [
    { slot_index: 0, candidate: "A", reason },
  ] }, audit) as ComparisonResult;
  profile.validate!(request, result, audit);
  assert(result.review_requests.some(review => review.candidate === "A" && review.reason === reason));
});

test("blind inspection covers common and own requirements but never peer-only or derived criteria", () => {
  const { request, input } = pair(), original = input.task_analysis.requirements[0]!;
  input.task_analysis.requirements.push({ ...original, id: "own", applies_to: [input.candidates.A!.candidate_id] });
  input.task_analysis.scoring_points.push({ ...original, id: "derived" });
  const value = checks(request); assert.equal(value.checks.length, 3);
  assert.doesNotThrow(() => inspected(request, value));
  const missing = structuredClone(value); missing.checks.pop(); assert.throws(() => inspected(request, missing), /全部适用 requirements/);
  for (const [candidate, id] of [["B", "own"], ["A", "derived"], ["A", "invented"]]) {
    const extra = structuredClone(value); extra.checks.push({ ...extra.checks[0]!, candidate: candidate!, criterion_id: id! });
    assert.throws(() => inspected(request, extra), /verification_check_slots.*本方适用要求/);
  }
  const duplicate = structuredClone(value); duplicate.checks.push(duplicate.checks[0]!); assert.throws(() => inspected(request, duplicate), /固定顺序|重复/);
});

test("standard-answer requirements have actual answer checks without fabricated message norms", () => {
  const { request, input } = pair(); input.task_analysis.requirements.push({ id: "reference", text: "标准4", applies_to: [], acceptance_rule: "结果为4" });
  const value = checks(request); assert.equal(value.checks.length, 4); assert.doesNotThrow(() => inspected(request, value));
});

test("canonical checkpoints reject peer UUID, question and role metadata rather than only requiring resolvable IDs", () => {
  const { request } = pair(), value = checks(request), source = request.sources.A!, raw = source.value as { messages: unknown[] };
  const peer = structuredClone(value); peer.checks[0]!.answer_evidence = peer.checks[1]!.answer_evidence;
  assert.throws(() => inspected(request, peer), ValidationError);
  for (const [messageIndex, path] of [[0, "/content"], [1, "/role"]] as const) {
    const leaf = evidenceSources(raw.messages[messageIndex]).find(item => item.kind === "text" && item.path === path)!;
    const wrong = structuredClone(value); wrong.checks[0]!.answer_evidence = [{ evidence_id: cite(source.id, messageIndex, leaf, 0, leaf.text.length).evidence_id }];
    assert.throws(() => inspected(request, wrong), /实际回答/);
  }
  const fake = structuredClone(value); fake.checks[0]!.answer_evidence = [{ evidence_id: "not-real" }]; assert.throws(() => inspected(request, fake), ValidationError);
});

test("canonical actual JSON answer evidence accepts complete real body containers and rejects partial cross-boundary or metadata ranges", () => {
  const { request } = pair(), source = request.sources.A!, raw = source.value as { messages: unknown[] };
  const json = evidenceSources(raw.messages[1]).find(item => item.kind === "json")!, content = selectEvidenceSource([json], "/content")!, value = checks(request);
  for (const [start, end] of [[content.start, content.end], [0, json.text.length], [content.start - 1, content.end], [content.start, content.end + 1]]) {
    value.checks[0]!.answer_evidence = [{ evidence_id: cite(source.id, 1, json, start!, end!).evidence_id }];
    assert.doesNotThrow(() => inspected(request, value));
  }
  const role = selectEvidenceSource([json], "/role")!;
  for (const [start, end] of [[role.start, role.end], [content.start - 1, content.end - 1], [content.start + 1, content.end + 1]]) {
    value.checks[0]!.answer_evidence = [{ evidence_id: cite(source.id, 1, json, start!, end!).evidence_id }];
    assert.throws(() => inspected(request, value), /实际回答/);
  }
});

test("canonical generation evidence must be proven final assistant prose, excluding later independent planner and metadata", () => {
  const { request, input } = pair(), source = request.sources.A!, generation = '4\n<visual>{"id":"chart"}</visual>';
  source.value = { messages: [{ role: "user", content: "计算2+2" }, { type: "llm_turn", input_messages: [{ role: "user", content: "计算2+2" }],
    output: [{ role: "assistant", content: generation }] }, { type: "llm_turn", input_messages: [{ role: "user", content: "独立规划" }],
    output: [{ role: "assistant", content: "planner" }] }, { type: "final_answer", role: "assistant", content: "4" }] };
  input.candidates.A!.final_message_index = 3;
  input.candidates.A!.answer_generation = { available: true, message_type: "llm_turn", matches_captured_final: false, message_index: 1, captured_final_message_index: 3, blocks: [{ path: "/output/0/content", total_chars: generation.length }] };
  const raw = source.value as { messages: unknown[] }, value = checks(request), leaf = evidenceSources(raw.messages[1]).find(item => item.path === "/output/0/content")!;
  value.checks[0]!.answer_evidence = [{ evidence_id: cite(source.id, 1, leaf, 0, leaf.text.length).evidence_id }]; assert.doesNotThrow(() => inspected(request, value));
  const role = evidenceSources(raw.messages[1]).find(item => item.path === "/output/0/role")!;
  input.candidates.A!.answer_generation!.blocks.push({ path: role.path, total_chars: role.text.length });
  value.checks[0]!.answer_evidence = [{ evidence_id: cite(source.id, 1, role, 0, role.text.length).evidence_id }]; assert.throws(() => inspected(request, value), /实际回答/);
  input.candidates.A!.answer_generation = { ...input.candidates.A!.answer_generation!, message_index: 2, blocks: [{ path: "/output/0/content", total_chars: 7 }] };
  const planner = evidenceSources(raw.messages[2]).find(item => item.path === "/output/0/content")!;
  value.checks[0]!.answer_evidence = [{ evidence_id: cite(source.id, 2, planner, 0, planner.text.length).evidence_id }]; assert.throws(() => inspected(request, value), /实际回答/);
});

test("deferred final text and real image views remain required", () => {
  const { request, input } = pair(); input.candidates.A!.deferred_final_material = [{ message_index: 1, path: "/content", total_chars: 5 }];
  assert.throws(() => inspected(request), (error: unknown) => {
    assert(error instanceof ValidationError);
    const issue = error.issues!.find(item => item.code === "deferred_final_material_not_read")!;
    assert.deepEqual(issue.expected, { read_request: { candidate: "A", message_index: 1, path: "/content", offset: 0, max_chars: 16000 } });
    return true;
  });
  const reads = emptyAudit(); reads.traceReads.push({ candidate: "A", message_index: 1, path: "/content", kind: "text", start: 0, end: 5 });
  const audit = inspected(request, checks(request), reads), result = profile.resolve!(request, finalFor(request, { concern_matches: [] }), audit); profile.validate!(request, result, audit);
  (request.sources.B!.value as { messages: { content: unknown }[] }).messages[1]!.content = "data:image/png;base64,aA==";
  const value = checks(request); value.checks[1]!.answer_evidence = [{ evidence_id: evidenceId(request.sources.B!.id, 1, "image"), observation: "实际图片给出4" }];
  assert.throws(() => inspected(request, value, audit), /必须先 view_image/); audit.viewedImages.push("B:1"); assert.doesNotThrow(() => inspected(request, value, audit));
});

test("checkpoint concerns cannot disappear; unmatched discovery creates bounded existing-source review", () => {
  const { request } = pair(), value = checks(request);
  value.concerns = [{ candidate: "A", criterion_ids: ["sum"], answer_evidence: value.checks[0]!.answer_evidence, source_evidence: [], reason: "原材料所示结果须核查。" }];
  const audit = inspected(request, value), before = structuredClone(audit.inspection);
  assert.equal((profile.resolve!(request, finalFor(request, { concern_matches: [] }), audit) as ComparisonResult).status,"needs_review");
  const result = profile.resolve!(request, finalFor(request, { concern_matches: [], source_reviews: [{ slot_index: 0, candidate: "A", reason: reviews[0].reason }] }), audit) as ComparisonResult;
  assert(result.review_requests.some(item => item.finding_indices.length === 0 && item.reason === value.concerns[0]!.reason));
  profile.validate!(request, result, audit); assert.deepEqual(audit.inspection, before);
  assert.throws(() => profile.resolve!(request, finalFor(request, { concern_matches: [{ concern_index: 0, finding_indices: [0], observation: "已有对应" }] }), audit), /established problem/);
});

test("already established same-source defects can be matched without forcing perpetual review", () => {
  const { request, input } = pair(), value = checks(request);
  input.attributions.A!.findings[0]!.type = "problem";
  value.concerns = [{ candidate: "A", criterion_ids: ["sum"], answer_evidence: value.checks[0]!.answer_evidence, source_evidence: [], reason: "实际同一行为已由来源记录。" }];
  const audit = inspected(request, value), match = { concern_index: 0, finding_indices: [0], observation: "对应同一实际错误及来源责任证据。" };
  assert.deepEqual(profile.resolve!(request, finalFor(request, { concern_matches: [match] }), audit), input.comparison_draft);
  assert.throws(() => profile.resolve!(request, finalFor(request, { concern_matches: [
    { ...match, concern_index: 999 }, match, { ...match, concern_index: 1000 },
  ] }), audit), (error: unknown) => {
    assert(error instanceof ValidationError);
    assert.deepEqual(error.issues!.map(issue => [issue.code, issue.path]), [
      ["inspection_match_index", "/concern_matches/0"], ["inspection_match_index", "/concern_matches/2"],
    ]);
    assert(error.issues!.every(issue => (issue.expected as { concern_count: number }).concern_count === 1));
    return true;
  });
  assert.deepEqual(profile.resolve!(request, finalFor(request, { concern_matches: [match] }), audit), input.comparison_draft);
  assert.throws(() => profile.resolve!(request, finalFor(request, { concern_matches: [
    { ...match, finding_indices: [999] }, { ...match, concern_index: 999 },
  ] }), audit), (error: unknown) => {
    assert(error instanceof ValidationError);
    assert.deepEqual(error.issues!.map(issue => [issue.code, issue.path]), [
      ["inspection_match_finding", "/concern_matches/0"], ["inspection_match_index", "/concern_matches/1"],
    ], "a bad finding does not manufacture a second coverage failure for the same match");
    return true;
  });
  for (const matches of [[{ ...match, concern_index: 999 }], [match, match], [{ ...match, finding_indices: [999] }]])
    assert.throws(() => profile.resolve!(request, finalFor(request, { concern_matches: matches }), audit), ValidationError);
  input.attributions.A!.findings[0]!.assessment.evidence_status = "uncertain";
  assert.throws(() => profile.resolve!(request, finalFor(request, { concern_matches: [match] }), audit), /established problem/);
});

test("matching an accurate problem preserves a separate review of its necessary-condition core impact at the public entry", () => {
  const { request, input } = pair(), registry = new AgentRegistry([comparisonAgent]);
  const source = request.sources.A!, actual = "2+2=5", proof = canonicalEvidence(source.id, 1, actual);
  (source.value as { messages: { content: string }[] }).messages[1]!.content = actual;
  const finding = input.attributions.A!.findings[0]!;
  finding.type = "problem"; finding.text = "加法结果错误"; finding.reason = "要求给出4，实际给出5。";
  finding.evidence = [proof]; finding.assessment.observation = actual;
  finding.assessment.impact = "已记录结果错误，但仍将回答判为核心可用。";
  input.attributions.A!.criterion_assessments[0]!.status = "partial";
  // Preserve the upstream partial/core=true for an explicit impact review, rather than rewriting its core here.
  input.comparison_draft = comparisonProfile.resolve!(request, requestComparisonSubmission(request, input.comparison_draft), emptyAudit()) as ComparisonResult;
  const value = checks(request);
  value.checks[0]!.result = "contradicted";
  value.checks[0]!.observation = "必要交付是正确结果4，实际最终回答给出5。";
  value.concerns = [{ candidate: "A", criterion_ids: ["sum"], answer_evidence: [{ evidence_id: proof.evidence_id }],
    source_evidence: [], reason: value.checks[0]!.observation }];
  const binding = { agent: "comparison", profile: "verification", request, projectModelInput: projectEvidenceReferences,
    modelInput: { original: "blind" }, inspectionInput: { draft: "revealed" } }, toolAudit = emptyAudit();
  const canonical = registry.resolveInspection(binding,
    projectEvidenceReferences(inspectionSubmission(request, value), toolAudit.evidenceBank = []), toolAudit) as unknown as ComparisonMaterialInspection;
  const audit = inspected(request, canonical, toolAudit), reason = "已有 problem 准确记录5而非4，但正确结果是原核心必要交付，来源虽判 partial 仍判 core=true，须纠正核心影响。";
  const submission = finalFor(request, {
    concern_matches: [{ concern_index: 0, finding_indices: [0], observation: "同一本方最终回答2+2=5、同一结果错误与回答责任，缺陷事实已准确记录。" }],
    source_reviews: [{ slot_index: 0, candidate: "A", reason }],
  });
  const before = structuredClone({ request, inspection: audit.inspection, submission });
  const pending = registry.resolve(binding, submission, audit) as ComparisonResult;
  registry.validate(binding, pending, audit);
  assert.equal(pending.status, "needs_review");
  assert.deepEqual(pending.review_requests, [{ candidate: "A", criterion_ids: ["sum"], finding_indices: [0], reason }],
    "a factual match does not discard the separately selected core-impact review or its real source associations");
  assert.equal(pending.assessments.A!.meets_core, null);
  assert.equal(pending.assessments.B!.meets_core, true);
  assert.deepEqual(canonical.concerns[0]!.answer_evidence, [{ evidence_id: proof.evidence_id }]);
  assert.equal(input.attributions.A!.criterion_assessments[0]!.status, "partial");
  assert.equal(input.attributions.A!.core_assessment.meets_core, true);
  assert.deepEqual({ request, inspection: audit.inspection, submission }, before, "review preserves the original source judgment and proof");
});

test("empty immutable concerns report every bad match index in one actionable public response", () => {
  const { request, input } = pair(), registry = new AgentRegistry([comparisonAgent]);
  const binding = { agent: "comparison", profile: "verification", request, projectModelInput: projectEvidenceReferences,
    modelInput: { actual: "blind" }, inspectionInput: { draft: "upstream" } };
  const audit = inspected(request);
  const draft = { concern_matches: [0, 1].map(concern_index => ({ concern_index, finding_indices: [0], observation: "核对原发现。" })),
    source_reviews: [] };
  assert.throws(() => registry.resolve(binding, draft, audit), (error: unknown) => {
    assert(error instanceof ValidationError);
    assert.deepEqual(error.issues!.map(issue => [issue.code, issue.path]), [
      ["inspection_match_index", "/concern_matches/0"], ["inspection_match_index", "/concern_matches/1"],
    ]);
    assert(error.issues!.every(issue => JSON.stringify(issue.expected) === JSON.stringify({
      available_concern_indices: [], concern_count: 0, concern_matches: [],
    })));
    return true;
  });
  const result = registry.resolve(binding, { ...draft, concern_matches: [] }, audit);
  registry.validate(binding, result, audit);
  assert.deepEqual(result, input.comparison_draft);
});

test("same criterion cannot match a different actual answer claim at the public Registry entry", () => {
  const { request, input } = pair(), registry = new AgentRegistry([comparisonAgent]);
  const first = "第一项给出4。", second = "第二项给出6。";
  (request.sources.A!.value as { messages: { content: string }[] }).messages[1]!.content = first + second;
  const finding = input.attributions.A!.findings[0]!;
  finding.type = "problem"; finding.text = "第一项有既有问题";
  finding.evidence = [canonicalEvidence(request.sources.A!.id, 1, first)];
  const value = checks(request);
  value.concerns = [{ candidate: "A", criterion_ids: ["sum"], reason: "第二项是独立的新问题。", source_evidence: [],
    answer_evidence: [{ evidence_id: evidenceId(request.sources.A!.id, 1, "text", "/content", first.length, (first + second).length) }] }];
  const audit = inspected(request, value), binding = { agent: "comparison", profile: "verification", request,
    projectModelInput: projectEvidenceReferences, modelInput: { original: "blind" }, inspectionInput: { draft: "revealed" } };
  const match = { concern_index: 0, finding_indices: [0], observation: "尝试只凭同一要求关联两个不同事实。" };
  assert.throws(() => registry.resolve(binding, finalFor(request, { concern_matches: [match] }), audit), (error: unknown) => {
    assert(error instanceof ValidationError); assert.equal(error.issues![0]!.code, "inspection_match_finding"); return true;
  });
  const pending = registry.resolve(binding, finalFor(request, { concern_matches: [] }), audit) as ComparisonResult;
  assert.equal(pending.status, "needs_review"); assert.equal(pending.review_requests[0]!.reason, value.concerns[0]!.reason);
  finding.evidence = [canonicalEvidence(request.sources.A!.id, 1, second, "/content", first.length)];
  assert.deepEqual(registry.resolve(binding, finalFor(request, { concern_matches: [match] }), audit), input.comparison_draft);
});

test("a real JSON message excerpt covering the actual answer leaf matches without decoding quoted strings", () => {
  const { request, input } = pair(), registry = new AgentRegistry([comparisonAgent]);
  const answer = '第一项给出4。\n"引文"与\\路径。', source = request.sources.A!;
  const message = { role: "assistant", content: [{ type: "output_text", text: answer }], metadata: { text: answer, tag: "metadata" } };
  (source.value as { messages: unknown[] }).messages[1] = message;
  const sources = evidenceSources(message), json = sources.find(item => item.kind === "json")!;
  const content = selectEvidenceSource([json], "/content")!, leaf = selectEvidenceSource([json], "/content/0/text")!;
  const finding = input.attributions.A!.findings[0]!; finding.type = "problem";
  const value = checks(request);
  const text = sources.find(item => item.kind === "text" && item.path === "/content/0/text")!;
  value.checks[0]!.answer_evidence = [{ evidence_id: cite(source.id, 1, text, 0, text.text.length).evidence_id }];
  value.concerns = [{ candidate: "A", criterion_ids: ["sum"], source_evidence: [],
    answer_evidence: value.checks[0]!.answer_evidence, reason: "同一实际交付行为已记录。" }];
  const audit = inspected(request, value), binding = { agent: "comparison", profile: "verification", request,
    projectModelInput: projectEvidenceReferences, modelInput: { original: "blind" }, inspectionInput: { draft: "revealed" } };
  const final = finalFor(request, { concern_matches: [{ concern_index: 0, finding_indices: [0], observation: "同一实际回答与责任链。" }] });
  for (const [start, end] of [[0, json.text.length], [content.start, content.end], [leaf.start, leaf.end]]) {
    const quote = json.text.slice(start, end);
    assert(!quote.includes(answer), "actual newlines and quotes are escaped in the genuine JSON excerpt");
    finding.evidence = [canonicalEvidence(source.id, 1, quote, "", start, "json")];
    assert.deepEqual(registry.resolve(binding, final, audit), input.comparison_draft);
  }
  const metadata = selectEvidenceSource([json], "/metadata")!;
  for (const [start, end] of [[metadata.start, metadata.end], [leaf.start + 1, leaf.end - 1], [0, json.text.length + 1]]) {
    const quote = json.text.slice(start, end);
    finding.evidence = [{ ...canonicalEvidence(source.id, 1, quote, "", start, "json"), evidence_id: evidenceId(source.id, 1, "json", "", start, end) }];
    assert.throws(() => registry.resolve(binding, final, audit), (error: unknown) => {
      assert(error instanceof ValidationError); assert.equal(error.issues![0]!.code, "inspection_match_finding"); return true;
    });
  }
  finding.evidence = [{ ...canonicalEvidence(request.sources.B!.id, 1, json.text, "", 0, "json"), source: "B", source_input_id: request.sources.B!.id }];
  assert.throws(() => registry.resolve(binding, final, audit), /同一实际回答证据/);
});

test("pending source review cannot be confirmed or silently removed", () => {
  const { request, input } = pair(), audit = inspected(request);
  input.comparison_draft = profile.resolve!(request, finalFor(request, { concern_matches: [], source_reviews: [{ slot_index: 0, candidate: "A", reason: reviews[0].reason }] }), audit) as ComparisonResult;
  assert.deepEqual(profile.resolve!(request, finalFor(request, { concern_matches: [] }),audit),input.comparison_draft);
  const result = profile.resolve!(request, finalFor(request, { concern_matches: [], source_reviews: [{ slot_index: 0, candidate: "B", reason: reviews[0].reason }] }), audit) as ComparisonResult;
  assert.equal(result.review_requests.length, 2); profile.validate!(request, result, audit);
  assert.throws(() => profile.validate!(request, { ...result, review_requests: result.review_requests.filter(item => item.candidate === "B"), assessments: { ...result.assessments, A: { ...result.assessments.A!, meets_core: true } } }, audit), /必须保留/);
});

test("inspection rejects invented status, foreign concerns and unknown source IDs", () => {
  const { request } = pair();
  const verdict = checks(request) as unknown as { checks: Record<string, unknown>[] }; verdict.checks[0]!.status = "met";
  assert.throws(() => inspected(request, verdict as unknown as ComparisonMaterialInspection), ValidationError);
  const value = checks(request); value.concerns = [{ candidate: "A", criterion_ids: ["new"], answer_evidence: value.checks[0]!.answer_evidence, source_evidence: [], reason: "新规则" }];
  assert.throws(() => inspected(request, value), /适用的已有要求/);
  value.concerns[0]!.criterion_ids = ["sum"]; value.concerns[0]!.source_evidence = [{ evidence_id: "bad" }];
  assert.throws(() => inspected(request, value), /真实登记|证据坐标无效/);
});


test("canonical typed block metadata cannot masquerade as answer prose", () => {
  const { request } = pair(), source = request.sources.A!;
  (source.value as { messages: { content: unknown }[] }).messages[1]!.content = [{ type: "text", text: "2+2=4" }];
  const value = checks(request), raw = source.value as { messages: unknown[] };
  const type = evidenceSources(raw.messages[1]).find(item => item.kind === "text" && item.path === "/content/0/type")!;
  value.checks[0]!.answer_evidence = [{ evidence_id: cite(source.id, 1, type, 0, type.text.length).evidence_id }];
  assert.throws(() => inspected(request, value), /实际回答/);
  const json = evidenceSources(raw.messages[1]).find(item => item.kind === "json")!, selected = selectEvidenceSource([json], type.path)!;
  value.checks[0]!.answer_evidence = [{ evidence_id: cite(source.id, 1, json, selected.start, selected.end).evidence_id }];
  assert.throws(() => inspected(request, value), /实际回答/);
});


test("malformed inspection receives both source-owned image gaps in the same first feedback", () => {
  const { request } = pair(), registry = new AgentRegistry([comparisonAgent]);
  for (const candidate of ["A", "B"]) (request.sources[candidate]!.value as { messages: { content: unknown }[] }).messages[1]!.content = "data:image/png;base64,aA==";
  const binding = { agent: "comparison", profile: "verification", request, projectModelInput: projectEvidenceReferences, modelInput: { actual: "blind" }, inspectionInput: { upper: "hidden" } };
  const audit = emptyAudit(), invalid = { checks: "wrong", concerns: [] };
  const gaps = (candidates: string[]) => (error: unknown) => {
    assert(error instanceof ValidationError); assert(error.issues!.some(issue => issue.category === "structure"));
    assert.deepEqual(error.issues!.filter(issue => issue.code === "final_image_not_viewed").map(issue => issue.candidate), candidates); return true;
  };
  assert.throws(() => inspect(registry,binding, invalid, audit), gaps(["A", "B"]));
  audit.viewedImages.push("A:1"); assert.throws(() => inspect(registry,binding, invalid, audit), gaps(["B"]));
  audit.viewedImages.push("B:1"); assert.throws(() => inspect(registry,binding, invalid, audit), gaps([]));
});

test("concern answer evidence reports its own field and preserves the submitted material", () => {
  const { request } = pair(), value = checks(request);
  value.concerns = [{ candidate: "A", criterion_ids: ["sum"], answer_evidence: [{ evidence_id: "invalid-id" }],
    source_evidence: [], reason: "原材料新发现。" }];
  const before = structuredClone({ request, value });
  assert.throws(() => inspected(request, value), (error: unknown) => {
    assert(error instanceof ValidationError);
    assert.deepEqual(error.issues!.map(issue => issue.path), ["/concerns/0/answer_evidence/0"]);
    return true;
  });
  assert.deepEqual({ request, value }, before);
});

test("valid inspection schema reports all evidence, image and deferred-read errors together", () => {
  const { request, input } = pair(), value = checks(request), registry = new AgentRegistry([comparisonAgent]);
  input.candidates.A!.deferred_final_material = [{ message_index: 1, path: "/content", total_chars: 5 }];
  (request.sources.B!.value as { messages: { content: unknown }[] }).messages[1]!.content = "data:image/png;base64,aA==";
  value.concerns = [{ candidate: "A", criterion_ids: ["sum"], answer_evidence: value.checks[0]!.answer_evidence,
    source_evidence: value.checks[0]!.answer_evidence, reason: "原材料须查。" }];
  const binding = { agent: "comparison", profile: "verification", request, projectModelInput: projectEvidenceReferences, modelInput: { actual: "blind" }, inspectionInput: { upper: "hidden" } };
  const before = structuredClone({ request, value }), audit = emptyAudit();
  const wire = projectEvidenceReferences(inspectionSubmission(request, value), audit.evidenceBank = []) as unknown as {
    checks: { source_evidence: { evidence_index: number }[] }[];
    concerns: { answer_evidence: { evidence_index: number }[]; source_evidence: { evidence_index: number }[] }[];
  };
  for (const references of [wire.concerns[0]!.answer_evidence, wire.concerns[0]!.source_evidence]) references[0]!.evidence_index = 0;
  assert.throws(() => registry.resolveInspection(binding, wire, audit), (error: unknown) => {
    assert(error instanceof ValidationError);
    for (const path of ["/concerns/0/answer_evidence/0", "/concerns/0/source_evidence/0"])
      assert(error.issues!.some(issue => issue.path === path), `missing error for ${path}`);
    assert(error.issues!.some(issue => issue.code === "final_image_not_viewed" && issue.candidate === "B"));
    assert(error.issues!.some(issue => issue.code === "deferred_final_material_not_read" && issue.candidate === "A"));
    return true;
  });
  assert.deepEqual({ request, value }, before);
});

function localInstructionPair() {
  const fixture = pair(), source = fixture.request.sources.A!;
  const rule = "## Delivery condition\nFor a text response, end with one follow-up question.\n\nA delivered file is exempt; keep this exception with the rule.";
  const raw = source.value as { messages: { role: string; content: unknown }[] };
  raw.messages.unshift({ role: "system", content: rule });
  fixture.input.candidates.A!.final_message_index = 2;
  for (const finding of fixture.input.attributions.A!.findings) for (const evidence of finding.evidence)
    if (evidence.source === undefined && evidence.source_input_id === undefined) {
      const origin = parseEvidenceCoordinates(evidence.evidence_id)!;
      evidence.message_index++;
      evidence.evidence_id = origin.kind === "image" ? evidenceId(origin.input_id, evidence.message_index, "image")
        : evidenceId(origin.input_id, evidence.message_index, origin.kind, origin.path, origin.start, origin.end);
    }
  const leaf = evidenceSources(raw.messages[0]).find(item => item.kind === "text" && item.path === "/content")!;
  const value = checks(fixture.request);
  value.concerns = [{ candidate: "A", criterion_ids: [], answer_evidence: value.checks[0]!.answer_evidence,
    source_evidence: [{ evidence_id: cite(source.id, 0, leaf, 0, rule.length).evidence_id }],
    reason: "The actual text response lacks the required closing question and is not a file delivery." }];
  const binding = { agent: "comparison", profile: "verification", request: fixture.request,
    projectModelInput: projectEvidenceReferences, modelInput: { original: "blind" }, inspectionInput: { draft: "upstream" } };
  return { ...fixture, value, binding, rule };
}

function privateProblemDraft(f: ReturnType<typeof localInstructionPair>, index: number) {
  const draft = f.input.comparison_draft;
  const updated=structuredClone(draft);
  updated.decision_basis.comparisons.push({ aspect:"Own delivery instruction",criterion_ids:[],importance:"high",better_candidates:[],
    assessments:{ A:{ summary:"A missed its private closing question requirement.",finding_indices:[index],status:"met",evidence_status:"established" },
      B:{ summary:"A's own rule does not apply to B.",finding_indices:[],status:"unknown",evidence_status:"uncertain" } } });
  f.input.comparison_draft = comparisonProfile.resolve!(f.request,requestComparisonSubmission(f.request,updated),f.audit) as ComparisonResult;
  comparisonProfile.validate!(f.request, f.input.comparison_draft, f.audit);
 }

test("a source-only norm outside fixed requirements can request one proof-bound local review through the public registry", () => {
  const registry = new AgentRegistry([comparisonAgent]), f = localInstructionPair(), before = structuredClone(f.input);
  const revealed = inspect(registry,f.binding, f.value, f.audit);
  assert.deepEqual(revealed.material_inspection, projectEvidenceReferences(f.value,f.audit.evidenceBank!));
  const audit = inspected(f.request, f.value), review = { candidate: "A", criterion_ids: [], finding_indices: [], reason: f.value.concerns[0]!.reason };
  const result = registry.resolve(f.binding, finalFor(f.request, { concern_matches: [] }), audit) as ComparisonResult;
  registry.validate(f.binding, result, audit);
  assert.deepEqual(result.review_requests, [review]);
  assert.deepEqual(result.task_analysis, before.task_analysis);
  assert.deepEqual(f.input, before, "source-only discovery cannot rewrite common judgments or ranking");
  assert.deepEqual(registry.resolve(f.binding, finalFor(f.request, { concern_matches: [] }),audit),result);
  assert.throws(() => comparisonProfile.validate!(f.request, result, emptyAudit()), /至少一个标准或既有 finding/);
});

test("an established unbound private instruction problem can match its original norm without changing the common draft", () => {
  const registry = new AgentRegistry([comparisonAgent]), f = localInstructionPair(), existing = structuredClone(f.input.attributions.A!.findings[0]!);
  existing.type = "problem"; existing.dimension = "instruction_following"; existing.assessment.requirement_index = null;
  existing.evidence = [canonicalEvidence(f.request.sources.A!.id, 0, f.rule), canonicalEvidence(f.request.sources.A!.id, 2, "2+2=4")];
  f.input.attributions.A!.findings.push(existing);
  const index = f.input.attributions.A!.findings.length - 1;
  privateProblemDraft(f, index);
  assert.equal(comparisonScope(f.request).findings.A![index]!.scope, "source_only");
  const audit = inspected(f.request, f.value);
  const match = { concern_index: 0, finding_indices: [index], observation: "Same original norm and actual response; private compliance does not change the common task result." };
  const result = registry.resolve(f.binding, finalFor(f.request, { concern_matches: [match] }), audit);
  registry.validate(f.binding, result, audit); assert.deepEqual(result, f.input.comparison_draft);
  const wrong = f.input.attributions.A!.findings[index]!;
  const unrelated = "## Unrelated\nan unrelated clause";
  (f.request.sources.A!.value as { messages: { content: string }[] }).messages[0]!.content += "\n\n" + unrelated;
  wrong.evidence = [canonicalEvidence(f.request.sources.A!.id, 0, unrelated, "/content", f.rule.length + 2), canonicalEvidence(f.request.sources.A!.id, 2, "2+2=4")];
  assert.throws(() => registry.resolve(f.binding, finalFor(f.request, { concern_matches: [match] }), audit), /真实规范/);
});

test("source-only concerns close selected own SYS or DEV anchors and require actual own answer", () => {
  const registry = new AgentRegistry([comparisonAgent]), f = localInstructionPair(), norm = f.value.concerns[0]!.source_evidence[0]!;
  const reject = (value: ComparisonMaterialInspection) => assert.throws(() => inspect(registry,f.binding, value, f.audit), ValidationError);
  for (const sources of [[], f.value.checks[0]!.answer_evidence, f.value.checks[1]!.answer_evidence]) {
    const value = structuredClone(f.value); value.concerns[0]!.source_evidence = sources; reject(value);
  }
  const raw = f.request.sources.A!.value as { messages: { role: string; content: unknown }[] };
  const user = evidenceSources(raw.messages[1]).find(item => item.kind === "text" && item.path === "/content")!;
  const fromQuestion = structuredClone(f.value); fromQuestion.concerns[0]!.source_evidence = [{ evidence_id: cite(f.request.sources.A!.id, 1, user, 0, user.text.length).evidence_id }]; reject(fromQuestion);
  const heading = evidenceSources(raw.messages[0]).find(item => item.kind === "text" && item.path === "/content")!;
  const partial = structuredClone(f.value); partial.concerns[0]!.source_evidence = [{ evidence_id: cite(f.request.sources.A!.id, 0, heading, 0, f.rule.indexOf("\n")).evidence_id }];
  const before = structuredClone(partial), closed = inspect(registry, f.binding, partial, f.audit);
  const canonical = profile.inspection!.resolve!(f.request,
    projectEvidenceReferences(inspectionSubmission(f.request, partial), f.audit.evidenceBank!), f.audit) as ComparisonMaterialInspection;
  assert.equal(canonical.concerns[0]!.source_evidence.length, 2);
  assert.deepEqual(canonical.concerns[0]!.source_evidence, [...partial.concerns[0]!.source_evidence, norm]);
  assert.deepEqual(closed.material_inspection, projectEvidenceReferences(canonical, f.audit.evidenceBank!));
  assert.deepEqual(partial, before, "program closure cannot rewrite model observations or selected anchors");
  assert.throws(() => profile.inspection!.validate(f.request, partial, f.audit), /条件和例外/,
    "an incomplete canonical checkpoint remains invalid even when the model wire can be completed");
  const unknown = structuredClone(f.value); unknown.concerns[0]!.candidate = "foreign"; reject(unknown);
  const peerAnswer = structuredClone(f.value); peerAnswer.concerns[0]!.answer_evidence = f.value.checks[1]!.answer_evidence; reject(peerAnswer);
  raw.messages[0]!.role = "developer"; assert.doesNotThrow(() => inspect(registry,f.binding, f.value, f.audit));
  raw.messages[0]!.role = "tool"; reject(f.value);
  assert.deepEqual(f.value.concerns[0]!.source_evidence, [norm], "validation leaves the selected proof unchanged");
});

test("model reviews only select existing source slots and cannot invent an empty-reference rule", () => {
 const registry=new AgentRegistry([comparisonAgent]), f=localInstructionPair(), audit=inspected(f.request,f.value);
 const source_reviews=comparisonSourceReviews(f.request); source_reviews.push({ slot_index: 999, candidate: "A", reason: "invented local rule" });
 assert.throws(() => registry.resolve(f.binding, finalFor(f.request, {concern_matches:[],source_reviews}),audit),/comparison_slots.*slot_index/);
 const result=registry.resolve(f.binding, finalFor(f.request, {concern_matches:[]}),audit) as ComparisonResult;
 assert.deepEqual(result.review_requests,[{candidate:"A",criterion_ids:[],finding_indices:[],reason:f.value.concerns[0]!.reason}]);
 const forged=structuredClone(result); forged.review_requests[0]!.reason="invented local rule";
 assert.throws(() => profile.validate!(f.request,forged,audit),/至少一个标准或既有 finding/);
});

test("local norm anchors close split conditions and only selected SYS sections", () => {
  const registry = new AgentRegistry([comparisonAgent]), f = localInstructionPair(), raw = f.request.sources.A!.value as { messages: { content: unknown }[] };
  raw.messages[0]!.content = [{ type: "text", text: "## Delivery\nText responses must end in one question." },
    { type: "text", text: "A file delivery is exempt." }];
  const leaves = evidenceSources(raw.messages[0]).filter(item => item.kind === "text" && item.path.endsWith("/text"));
  f.value.concerns[0]!.source_evidence = leaves.map(leaf => ({ evidence_id: cite(f.request.sources.A!.id, 0, leaf, 0, leaf.text.length).evidence_id }));
  assert.doesNotThrow(() => inspect(registry,f.binding, f.value, f.audit));
  const incomplete = structuredClone(f.value); incomplete.concerns[0]!.source_evidence.pop();
  const closed = profile.inspection!.resolve!(f.request,
    projectEvidenceReferences(inspectionSubmission(f.request, incomplete), f.audit.evidenceBank ??= []), f.audit) as ComparisonMaterialInspection;
  assert.deepEqual(closed.concerns[0]!.source_evidence, f.value.concerns[0]!.source_evidence,
    "the omitted exception leaf is supplied from its original governing block");
  assert.doesNotThrow(() => inspected(f.request, closed));
  const extra = "\n\n## Unrelated\nAn unrelated instruction has a different condition and exception.";
  raw.messages[0]!.content = f.rule + extra;
  const leaf = evidenceSources(raw.messages[0]).find(item => item.kind === "text" && item.path === "/content")!;
  f.value.concerns[0]!.source_evidence = [{ evidence_id: cite(f.request.sources.A!.id, 0, leaf, 0, f.rule.length).evidence_id }];
  assert.doesNotThrow(() => inspect(registry,f.binding, f.value, f.audit), "one complete relevant block suffices without cataloguing every SYS rule");
  f.value.concerns[0]!.source_evidence = [
    { evidence_id: cite(f.request.sources.A!.id, 0, leaf, 0, 20).evidence_id },
    { evidence_id: cite(f.request.sources.A!.id, 0, leaf, 20, f.rule.length).evidence_id },
  ];
  assert.doesNotThrow(() => inspect(registry,f.binding, f.value, f.audit), "real contiguous references jointly close one normative block");
  f.value.concerns[0]!.source_evidence.push({ evidence_id: cite(f.request.sources.A!.id, 0, leaf, f.rule.length + 2, f.rule.length + 12).evidence_id });
  assert.doesNotThrow(() => inspect(registry, f.binding, f.value, f.audit), "each independently selected rule receives its own complete context");
});

test("private norm proof distinguishes the actual answer chain from independent tool or planner prompts", () => {
  const registry = new AgentRegistry([comparisonAgent]), f = localInstructionPair(), raw = f.request.sources.A!.value as { messages: unknown[] };
  const quote = f.rule;
  raw.messages[0] = { type: "llm_turn", input_messages: [{ role: "system", content: quote }], output: [{ role: "assistant", content: "independent planner" }] };
  let leaf = evidenceSources(raw.messages[0]).find(item => item.kind === "text" && item.path === "/input_messages/0/content")!;
  f.value.concerns[0]!.source_evidence = [{ evidence_id: cite(f.request.sources.A!.id, 0, leaf, 0, quote.length).evidence_id }];
  assert.throws(() => inspect(registry,f.binding, f.value, f.audit), /本方完整 SYS\/DEV/);
  raw.messages[0] = { type: "llm_turn", input_messages: [{ role: "system", content: quote }], output: [{ role: "assistant", content: "2+2=4" }] };
  assert.doesNotThrow(() => inspect(registry,f.binding, f.value, f.audit), "the final-output anchor proves the actual governing answer chain");
  raw.messages[0] = { role: "tool", content: quote };
  leaf = evidenceSources(raw.messages[0]).find(item => item.kind === "text" && item.path === "/content")!;
  f.value.concerns[0]!.source_evidence = [{ evidence_id: cite(f.request.sources.A!.id, 0, leaf, 0, quote.length).evidence_id }];
  assert.throws(() => inspect(registry,f.binding, f.value, f.audit), /本方完整 SYS\/DEV/);
});

test("an unheaded cross-leaf norm closes its continuous paragraph including the later exception", () => {
  const f = localInstructionPair(), raw = f.request.sources.A!.value as { messages: { content: unknown }[] };
  raw.messages[0]!.content = [{ type: "text", text: "Text responses must end in one question." },
    { type: "text", text: "A file delivery is exempt." }];
  const leaves = evidenceSources(raw.messages[0]).filter(item => item.kind === "text" && item.path.endsWith("/text"));
  f.value.concerns[0]!.source_evidence = [{ evidence_id: cite(f.request.sources.A!.id, 0, leaves[0]!, 0, leaves[0]!.text.length).evidence_id }];
  const closed = profile.inspection!.resolve!(f.request,
    projectEvidenceReferences(inspectionSubmission(f.request, f.value), f.audit.evidenceBank ??= []), f.audit) as ComparisonMaterialInspection;
  assert.deepEqual(closed.concerns[0]!.source_evidence, leaves.map(leaf => ({ evidence_id: cite(f.request.sources.A!.id, 0, leaf, 0, leaf.text.length).evidence_id })),
    "a text leaf boundary cannot discard an exception from the same complete paragraph");
  assert.equal(closed.concerns[0]!.reason, f.value.concerns[0]!.reason);
  assert.doesNotThrow(() => inspected(f.request, closed));
});

test("peer private norms and SYS metadata cannot authorize an empty-criterion review", () => {
  const registry = new AgentRegistry([comparisonAgent]), f = localInstructionPair(), peer = f.request.sources.B!;
  const raw = peer.value as { messages: { role: string; content: unknown }[] };
  raw.messages.unshift({ role: "system", content: f.rule }); f.input.candidates.B!.final_message_index++;
  const leaf = evidenceSources(raw.messages[0]).find(item => item.kind === "text" && item.path === "/content")!;
  f.value.concerns[0]!.source_evidence = [{ evidence_id: cite(peer.id, 0, leaf, 0, leaf.text.length).evidence_id }];
  f.value.checks = checks(f.request).checks;
  assert.throws(() => inspect(registry,f.binding, f.value, f.audit), /本方完整 SYS\/DEV/);
  const ownRaw = f.request.sources.A!.value as { messages: unknown[] }, metadata = evidenceSources(ownRaw.messages[0]).find(item => item.kind === "text" && item.path === "/role")!;
  f.value.concerns[0]!.source_evidence = [{ evidence_id: cite(f.request.sources.A!.id, 0, metadata, 0, metadata.text.length).evidence_id }];
  assert.throws(() => inspect(registry,f.binding, f.value, f.audit), /本方完整 SYS\/DEV/);
});

test("verification schema accepts only nonempty indexed review choices", () => {
  const registry = new AgentRegistry([comparisonAgent]), { request } = pair();
  const binding = { agent: "comparison", profile: "verification", request, projectModelInput: projectEvidenceReferences,
    modelInput: { actual: "blind" }, inspectionInput: { draft: "upstream" } };
  const schema = registry.prepare(binding).evaluation.outputSchema;
  assert(!JSON.stringify(schema).includes('"oneOf"'));
  assert(!JSON.stringify(schema).includes('"status"'));
  const rowSchema = (schema.properties as { source_reviews: { items: { required?: string[] } } }).source_reviews.items;
  assert.deepEqual(rowSchema.required, ["slot_index", "candidate", "reason"]);
  const audit = inspected(request);
  assert.doesNotThrow(() => registry.resolve(binding, finalFor(request), audit));
  assert.throws(() => registry.resolve(binding, { concern_matches: [] }, audit), ValidationError);
  assert.throws(() => registry.resolve(binding, { concern_matches: [], source_reviews: false }, audit),
    (error: unknown) => error instanceof ValidationError && error.issues!.every(issue => issue.path === "/source_reviews" && issue.code === "schema_type"));
  const result = registry.resolve(binding, finalFor(request, { concern_matches: [],
    source_reviews: [{ slot_index: 0, candidate: "A", reason: reviews[0].reason }] }), audit) as ComparisonResult;
  assert.equal(result.status, "needs_review");
  registry.validate(binding, result, audit);
});

test("a finding explicitly covering both real private norms can match a selected criterion beyond its primary index", () => {
  const registry = new AgentRegistry([comparisonAgent]), f = localInstructionPair();
  const other = "## Layout\nPut the final follow-up question on a separated final line; delivered files are exempt.";
  const raw = f.request.sources.A!.value as { messages: { content: unknown }[] }; raw.messages[0]!.content = other + "\n\n" + f.rule;
  for (const [id, text] of [["layout", other], ["closing", f.rule]]) f.input.task_analysis.requirements.push({ id, text, acceptance_rule: text, applies_to: [f.input.candidates.A!.candidate_id] });
  for (const label of ["A", "B"]) {
    f.input.attributions[label]!.task_analysis = structuredClone(f.input.task_analysis);
    for (const id of ["layout", "closing"]) f.input.attributions[label]!.criterion_assessments.push({ criterion_id: id,
      status: label === "A" ? "unmet" : "not_applicable", evidence_status: "established", summary: "Own private requirement scope.",
      ...{ evidence: label === "A" ? [canonicalEvidence(f.request.sources.A!.id, 0, id === "layout" ? other : f.rule, "/content", id === "layout" ? 0 : other.length + 2), canonicalEvidence(f.request.sources.A!.id, 2, "2+2=4")] : [] } });
  }
  const finding = structuredClone(f.input.attributions.A!.findings[0]!);
  finding.type = "problem"; finding.dimension = "instruction_following"; finding.assessment.requirement_index = 1;
  finding.evidence = [canonicalEvidence(f.request.sources.A!.id, 0, other), canonicalEvidence(f.request.sources.A!.id, 0, f.rule, "/content", other.length + 2), canonicalEvidence(f.request.sources.A!.id, 2, "2+2=4")];
  f.input.attributions.A!.findings.push(finding); const index = f.input.attributions.A!.findings.length - 1;
  privateProblemDraft(f, index); assert.equal(comparisonScope(f.request).findings.A![index]!.scope, "source_only");
  const value = checks(f.request), leaf = evidenceSources(raw.messages[0]).find(item => item.kind === "text" && item.path === "/content")!;
  value.concerns = [{ candidate: "A", criterion_ids: ["layout", "closing"], answer_evidence: value.checks[0]!.answer_evidence,
    source_evidence: [{ evidence_id: cite(f.request.sources.A!.id, 0, leaf, 0, other.length).evidence_id },
      { evidence_id: cite(f.request.sources.A!.id, 0, leaf, other.length + 2, leaf.text.length).evidence_id }],
    reason: "The same missing final follow-up question is explicitly covered by the established finding's complete closing rule and actual answer evidence." }];
  for (const check of value.checks.filter(check => check.candidate === "A" && check.criterion_id !== "sum")) {
    check.result = "contradicted";
    check.observation = "The final arithmetic response has no follow-up question required by this own text-delivery rule.";
    check.source_evidence = [{ evidence_id: check.criterion_id === "layout"
      ? cite(f.request.sources.A!.id, 0, leaf, 0, other.length).evidence_id
      : cite(f.request.sources.A!.id, 0, leaf, other.length + 2, leaf.text.length).evidence_id }];
  }
  const toolAudit = emptyAudit(), checked = registry.resolveInspection(f.binding,
    projectEvidenceReferences(inspectionSubmission(f.request, value), toolAudit.evidenceBank = []), toolAudit) as unknown as ComparisonMaterialInspection;
  const audit = inspected(f.request, checked, toolAudit), matches = checked.concerns.map((_, concern_index) => ({ concern_index,
    finding_indices: [index], observation: "Same actual missing closing question, complete governing rule and owner responsibility; primary index names the related layout rule." }));
  const confirmed = registry.resolve(f.binding, finalFor(f.request, { concern_matches: matches }), audit);
  registry.validate(f.binding, confirmed, audit); assert.deepEqual(confirmed, f.input.comparison_draft);
  const known = f.input.attributions.A!.findings[index]!, original = structuredClone(known);
  for (const evidence of [
    [canonicalEvidence(f.request.sources.A!.id, 0, other), canonicalEvidence(f.request.sources.A!.id, 2, "2+2=4")],
    [canonicalEvidence(f.request.sources.A!.id, 0, f.rule.slice(0, 25), "/content", other.length + 2), canonicalEvidence(f.request.sources.A!.id, 2, "2+2=4")],
    [{ ...canonicalEvidence(f.request.sources.B!.id, 0, f.rule), source: "peer", source_input_id: f.request.sources.B!.id }, canonicalEvidence(f.request.sources.A!.id, 2, "2+2=4")],
    [canonicalEvidence(f.request.sources.A!.id, 0, f.rule, "/content", other.length + 2), canonicalEvidence(f.request.sources.A!.id, 1, "计算2+2")],
  ]) {
    known.evidence = evidence;
    assert.throws(() => registry.resolve(f.binding, finalFor(f.request, { concern_matches: matches }), audit), error =>
      error instanceof ValidationError && error.issues!.some(issue => ["inspection_match_finding", "inspection_match_coverage"].includes(issue.code)));
  }
  Object.assign(known, structuredClone(original));

});

test("private norm concerns retain valid trigger facts alongside the complete own norm without borrowing authorization", () => {
  const registry = new AgentRegistry([comparisonAgent]), f = localInstructionPair();
  const raw = f.request.sources.A!.value as { messages: unknown[] };
  raw.messages.push({ role: "tool", content: "The delivered material is a text response, not an exported file." });
  const leaf = evidenceSources(raw.messages[3]).find(item => item.kind === "text" && item.path === "/content")!;
  const trigger = { evidence_id: cite(f.request.sources.A!.id, 3, leaf, 0, leaf.text.length).evidence_id };
  f.value.concerns[0]!.source_evidence.push(trigger);
  assert.doesNotThrow(() => inspect(registry,f.binding, f.value, f.audit));
  const audit = inspected(f.request, f.value);
  const result = registry.resolve(f.binding, finalFor(f.request, { concern_matches: [] }), audit);
  registry.validate(f.binding, result, audit);
  const withoutNorm = structuredClone(f.value); withoutNorm.concerns[0]!.source_evidence = [trigger];
  assert.throws(() => inspect(registry,f.binding, withoutNorm, f.audit), /本方完整 SYS\/DEV/);
  const invalid = structuredClone(f.value); invalid.concerns[0]!.source_evidence.push({ evidence_id: "unregistered-trigger" });
  assert.throws(() => inspect(registry,f.binding, invalid, f.audit), /真实登记|证据坐标无效/);
});

test("a registered peer fact can supplement a private norm while peer SYS alone cannot authorize local review", () => {
  const registry = new AgentRegistry([comparisonAgent]), f = localInstructionPair(), peer = f.request.sources.B!;
  const raw = peer.value as { messages: unknown[] };
  raw.messages.push({ role: "tool", content: "The independent record confirms the same delivery format." });
  raw.messages.push({ role: "system", content: f.rule });
  const fact = evidenceSources(raw.messages[2]).find(item => item.kind === "text" && item.path === "/content")!;
  const norm = evidenceSources(raw.messages[3]).find(item => item.kind === "text" && item.path === "/content")!;
  const reference = { evidence_id: cite(peer.id, 2, fact, 0, fact.text.length).evidence_id };
  f.value.concerns[0]!.source_evidence.push(reference);
  assert.doesNotThrow(() => inspect(registry,f.binding, f.value, f.audit));
  const borrowed = structuredClone(f.value); borrowed.concerns[0]!.source_evidence = [reference, { evidence_id: cite(peer.id, 3, norm, 0, norm.text.length).evidence_id }];
  assert.throws(() => inspect(registry,f.binding, borrowed, f.audit), /本方完整 SYS\/DEV/);
  const partial = structuredClone(f.value), ownLeaf = evidenceSources((f.request.sources.A!.value as { messages: unknown[] }).messages[0])
    .find(item => item.kind === "text" && item.path === "/content")!;
  partial.concerns[0]!.source_evidence[0] = { evidence_id: cite(f.request.sources.A!.id, 0, ownLeaf, 0, 20).evidence_id };
  assert.doesNotThrow(() => inspect(registry, f.binding, partial, f.audit));
});




test("fixed inspection choices bind by program position and never accept copied association fields", () => {
  const { request, input } = pair(), original = input.task_analysis.requirements[0]!;
  input.task_analysis.requirements.push({ ...original, id: "private", applies_to: [input.candidates.A!.candidate_id] });
  const registry = new AgentRegistry([comparisonAgent]), binding = { agent: "comparison", profile: "verification", request,
    projectModelInput: projectEvidenceReferences, modelInput: { original: "blind" }, inspectionInput: { draft: "revealed" } };
  const value = checks(request), audit = emptyAudit(), raw = inspectionSubmission(request, value), before = structuredClone({ request, raw });
  const wire = projectEvidenceReferences(raw, audit.evidenceBank = []);
  const canonical = registry.resolveInspection(binding, wire, audit) as unknown as ComparisonMaterialInspection;
  assert.deepEqual(canonical.checks.map(check => [check.candidate, check.criterion_id]), [["A", "sum"], ["A", "private"], ["B", "sum"]]);
  assert.deepEqual({ request, raw }, before);
  for (const field of ["candidate", "criterion_id", "requirement_index", "slot_index"]) {
    const copied = structuredClone(wire) as { checks: Record<string, unknown>[] }; copied.checks[0][field] = "A";
    assert.throws(() => registry.resolveInspection(binding, copied, audit), ValidationError);
  }
  for (const count of [0, 5, 7]) {
    const incomplete = structuredClone(wire) as { checks: unknown[] }; incomplete.checks = Array.from({ length: count }, (_, index) => incomplete.checks[index % 6]);
    assert.throws(() => registry.resolveInspection(binding, incomplete, audit), (error: unknown) =>
      error instanceof ValidationError && error.issues!.some(issue => issue.code === "verification_check_coverage"));
  }
  const malformed = structuredClone(wire) as { checks: Record<string, unknown>[] }; delete malformed.checks[0].result;
  assert.throws(() => registry.resolveInspection(binding, malformed, audit), ValidationError);
});

test("extra concerns select global numeric requirements and reject foreign scope or copied criterion IDs", () => {
  const { request, input } = pair(), original = input.task_analysis.requirements[0]!;
  input.task_analysis.requirements.push({ ...original, id: "own", applies_to: [input.candidates.A!.candidate_id] });
  const registry = new AgentRegistry([comparisonAgent]), binding = { agent: "comparison", profile: "verification", request,
    projectModelInput: projectEvidenceReferences, modelInput: { original: "blind" }, inspectionInput: { draft: "revealed" } };
  const value = checks(request); value.concerns = [{ candidate: "A", criterion_ids: ["own"], answer_evidence: value.checks[0].answer_evidence,
    source_evidence: [], reason: "独立发现定位本方的原规范。" }];
  const audit = emptyAudit(), wire = projectEvidenceReferences(inspectionSubmission(request, value), audit.evidenceBank = []) as {
    concerns: { candidate: string; requirement_indices: number[]; criterion_ids?: string[] }[] };
  const canonical = registry.resolveInspection(binding, wire, audit) as unknown as ComparisonMaterialInspection;
  assert.deepEqual(canonical.concerns[0].criterion_ids, ["own"]);
  for (const [candidate, indices] of [["B", [1]], ["A", [999]]] as const) {
    const invalid = structuredClone(wire); invalid.concerns[0].candidate = candidate; invalid.concerns[0].requirement_indices = [...indices];
    assert.throws(() => registry.resolveInspection(binding, invalid, audit), (error: unknown) => error instanceof ValidationError &&
      error.issues!.some(issue => issue.path === "/concerns/0/requirement_indices/0" && issue.code === "inspection_concern_scope"));
  }
  const copied = structuredClone(wire); copied.concerns[0].criterion_ids = ["own"];
  assert.throws(() => registry.resolveInspection(binding, copied, audit), ValidationError);
});

test("contradicted checks require precise concerns and full inspected scope cannot clear another claim", () => {
  const { request, input } = pair(), registry = new AgentRegistry([comparisonAgent]), audit = emptyAudit();
  const source = request.sources.A!, first = "第一项给出4。", second = "第二项给出6。";
  (source.value as { messages: { content: string }[] }).messages[1]!.content = first + second;
  const leaf = evidenceSources((source.value as { messages: unknown[] }).messages[1]).find(item => item.path === "/content")!;
  const evidence = { evidence_id: cite(source.id, 1, leaf, first.length, leaf.text.length).evidence_id };
  const value = checks(request); value.checks[0]!.result = "contradicted"; value.checks[0]!.observation = "第二项给出6，是独立的新问题。";
  const binding = { agent: "comparison", profile: "verification", request, projectModelInput: projectEvidenceReferences,
    modelInput: { original: "blind" }, inspectionInput: { draft: "revealed" } };
  assert.throws(() => registry.resolveInspection(binding, projectEvidenceReferences(inspectionSubmission(request, value), audit.evidenceBank = []), audit),
    error => error instanceof ValidationError && error.issues!.some(issue => issue.code === "inspection_contradiction_removed"));
  value.concerns = [{ candidate: "A", criterion_ids: ["sum"], answer_evidence: [evidence], source_evidence: [], reason: value.checks[0]!.observation }];
  const canonical = registry.resolveInspection(binding, projectEvidenceReferences(inspectionSubmission(request, value), audit.evidenceBank!), audit) as unknown as ComparisonMaterialInspection;
  assert.deepEqual(canonical.concerns, value.concerns); assert.notDeepEqual(canonical.checks[0]!.answer_evidence, canonical.concerns[0]!.answer_evidence);
  const proof = inspected(request, canonical, audit), finding = input.attributions.A!.findings[0]!;
  finding.type = "problem"; finding.evidence = [cite(source.id, 1, leaf, 0, first.length)];
  const match = { concern_index: 0, finding_indices: [0], observation: "已有第一项问题不能替代第二项反证。" };
  assert.throws(() => registry.resolve(binding, finalFor(request, { concern_matches: [match] }), proof),
    error => error instanceof ValidationError && error.issues!.some(issue => issue.code === "inspection_match_finding"));
  assert.equal((registry.resolve(binding, finalFor(request), proof) as ComparisonResult).status, "needs_review");
  finding.evidence = [cite(source.id, 1, leaf, first.length, leaf.text.length)];
  assert.deepEqual(registry.resolve(binding, finalFor(request, { concern_matches: [match] }), proof), input.comparison_draft);
  const removed = structuredClone(canonical); removed.concerns = [];
  assert.throws(() => inspected(request, removed), /具体反证/);
});

test("unverified checks preserve ordinary unknowns but review definite upstream use of the same rule", () => {
  for (const definite of ["none", "met", "strength", "decisive"] as const) {
    const { request, input } = pair(), value = checks(request), original = structuredClone(input);
    value.checks[0].result = "unverified"; value.checks[0].observation = "原材料不足以确定该要求对应的事实。";
    input.attributions.A!.criterion_assessments[0].status = "unknown";
    input.attributions.A!.criterion_assessments[0].evidence_status = "uncertain";
    input.attributions.A!.findings[0].assessment.evidence_status = "uncertain";
    input.comparison_draft.decision_basis.decisive_findings = [];
    if (definite === "met") { input.attributions.A!.criterion_assessments[0].status = "met"; input.attributions.A!.criterion_assessments[0].evidence_status = "established"; }
    if (definite === "strength" || definite === "decisive") input.attributions.A!.findings[0].assessment.evidence_status = "established";
    if (definite === "decisive") { input.attributions.A!.findings[0].type = "problem"; input.comparison_draft.decision_basis.decisive_findings = [{ candidate: "A", finding_index: 0 }]; }
    // This resolver test isolates the gate; formal source consistency remains independently validated.
    const audit = inspected(request, value), checkpoint = structuredClone(audit.inspection);
    const result = profile.resolve!(request, finalFor(request), audit) as ComparisonResult;
    assert.equal(result.status, definite === "none" ? "decided" : "needs_review");
    assert.deepEqual(audit.inspection, checkpoint); assert.equal((audit.inspection.value as unknown as ComparisonMaterialInspection).checks[0].result, "unverified");
    assert.equal(original.task_analysis.requirements[0].id, input.task_analysis.requirements[0].id);
  }
});

test("a not-applicable check retains its actual scope explanation without manufacturing an error", () => {
  const { request } = pair(), value = checks(request); value.checks[0].result = "not_applicable";
  value.checks[0].observation = "原条件未触发，实际文本也未执行该动作。";
  const audit = inspected(request, value), result = profile.resolve!(request, finalFor(request), audit) as ComparisonResult;
  assert.equal(result.status, "decided"); assert.equal((audit.inspection.value as unknown as ComparisonMaterialInspection).checks[0].result, "not_applicable");
});

test("independent satisfaction or an inactive condition cannot silently confirm an established failure of the same requirement", () => {
  const registry = new AgentRegistry([comparisonAgent]);
  for (const result of ["supported", "not_applicable"] as const) for (const status of ["unmet", "partial"] as const) {
    const { request, input } = pair();
    // Deliberately inconsistent source judgment: the actual answer is still 2+2=4.
    input.attributions.A!.criterion_assessments[0].status = status;
    input.comparison_draft = comparisonProfile.resolve!(request, requestComparisonSubmission(request, input.comparison_draft), emptyAudit()) as ComparisonResult;
    const value = checks(request); value.checks[0].result = result;
    value.checks[0].observation = result === "supported" ? "原要求的实际交付给出2+2=4，满足该条要求。" : "真实当前任务未触发该条件，不能据此判未满足。";
    const binding = { agent: "comparison", profile: "verification", request, projectModelInput: projectEvidenceReferences,
      modelInput: { original: "blind" }, inspectionInput: { draft: "revealed" } }, toolAudit = emptyAudit();
    const canonical = registry.resolveInspection(binding, projectEvidenceReferences(inspectionSubmission(request, value), toolAudit.evidenceBank = []), toolAudit) as unknown as ComparisonMaterialInspection;
    const audit = inspected(request, canonical, toolAudit), before = structuredClone({ request, inspection: audit.inspection });
    const pending = registry.resolve(binding, finalFor(request), audit) as ComparisonResult;
    assert.equal(pending.status, "needs_review", `${result}/${status}`);
    assert.deepEqual(pending.review_requests, [{ candidate: "A", criterion_ids: ["sum"], finding_indices: [], reason: value.checks[0].observation }]);
    registry.validate(binding, pending, audit);
    assert.deepEqual({ request, inspection: audit.inspection }, before, "a source review preserves the original judgments and inspection proof");
    assert.throws(() => registry.validate(binding, input.comparison_draft, audit), (error: unknown) => error instanceof ValidationError &&
      error.issues!.some(issue => issue.code === "verification_check_conflict_removed"));
  }
});

test("an inactive requirement conflicts with its established problem, while satisfied requirements can retain local quality problems", () => {
  for (const result of ["supported", "not_applicable"] as const) {
    const { request, input } = pair(), value = checks(request);
    const problem = input.attributions.A!.findings[0]; problem.type = "problem"; problem.importance = "low";
    problem.text = "同要求的局部质量问题";
    value.checks[0].result = result; value.checks[0].observation = "原条件在当前任务没有触发，已关联的问题须核对其适用范围。";
    const audit = inspected(request, value), before = structuredClone(input), resolved = profile.resolve!(request, finalFor(request), audit) as ComparisonResult;
    assert.equal(resolved.status, result === "not_applicable" ? "needs_review" : "decided");
    if (result === "not_applicable") {
      assert.deepEqual(resolved.review_requests, [{ candidate: "A", criterion_ids: ["sum"], finding_indices: [0], reason: value.checks[0].observation }]);
      assert.doesNotThrow(() => profile.validate!(request, resolved, audit));
    } else assert.deepEqual(resolved, input.comparison_draft, "a linked local problem alone does not contradict actual satisfaction");
    assert.deepEqual(input, before);
  }
});

test("inspection conflicts preserve uncertain facts, conditional exemptions and unrelated source problems", () => {
  for (const result of ["supported", "not_applicable"] as const) for (const status of ["met", "partial", "unmet", "unknown"] as const) {
    const { request, input } = pair(), value = checks(request);
    input.attributions.A!.criterion_assessments[0].status = status;
    input.attributions.A!.criterion_assessments[0].evidence_status = "uncertain";
    input.attributions.A!.findings[0].type = "problem";
    input.attributions.A!.findings[0].assessment.evidence_status = "uncertain";
    input.attributions.B!.findings[0].type = "problem";
    value.checks[0].result = result;
    // Isolate the consistency gate; uncertain source judgments remain independently validated.
    const audit = inspected(request, value), before = structuredClone(input);
    assert.deepEqual(profile.resolve!(request, finalFor(request), audit), input.comparison_draft, `${result}/${status}`);
    assert.deepEqual(input, before);
  }
  const { request, input } = pair();
  input.task_analysis.requirements.push({ ...input.task_analysis.requirements[0], id: "other", applies_to: [] });
  for (const attribution of Object.values(input.attributions)) attribution.task_analysis = structuredClone(input.task_analysis);
  const problem = input.attributions.A!.findings[0]; problem.type = "problem"; problem.assessment.requirement_index = 1;
  const complete = checks(request); complete.checks[0].result = "not_applicable";
  const audit = inspected(request, complete);
  assert.deepEqual(profile.resolve!(request, finalFor(request), audit), input.comparison_draft, "another requirement's problem cannot conflict with this check");
});

test("derived concerns retain real raw check error paths and aggregate source evidence without hidden fields", () => {
  const { request } = pair(), registry = new AgentRegistry([comparisonAgent]), audit = emptyAudit();
  const binding = { agent: "comparison", profile: "verification", request, projectModelInput: projectEvidenceReferences,
    modelInput: { original: "blind" }, inspectionInput: { draft: "revealed" } };
  const value = checks(request); value.checks[0].result = "contradicted";
  value.checks[0].source_evidence = structuredClone(value.checks[0].answer_evidence);
  const wire = projectEvidenceReferences(inspectionSubmission(request, value), audit.evidenceBank = []) as unknown as {
    checks: { source_evidence: { evidence_index: number }[] }[] };
  wire.checks[0].source_evidence[0].evidence_index = 0;
  assert.throws(() => registry.resolveInspection(binding, wire, audit), (error: unknown) => error instanceof ValidationError &&
    error.issues!.some(issue => issue.path === "/checks/0/source_evidence/0") &&
    error.issues!.every(issue => !issue.path.startsWith("/concerns/")));
});

test("canonical validation cannot restore a decided draft after dropping derived unverified review", () => {
  const { request, input } = pair(), value = checks(request);
  value.checks[0].result = "unverified"; value.checks[0].observation = "原材料未能确证原先按既定事实使用的同一要求。";
  const audit = inspected(request, value), pending = profile.resolve!(request, finalFor(request), audit) as ComparisonResult;
  assert.equal(pending.status, "needs_review"); assert.doesNotThrow(() => profile.validate!(request, pending, audit));
  assert.throws(() => profile.validate!(request, input.comparison_draft, audit), (error: unknown) =>
    error instanceof ValidationError && error.issues!.some(issue => issue.code === "verification_unverified_removed"));
});

test("verification reports independent match and row-count failures in one repair response", () => {
  const { request, input } = pair(), material = checks(request);
  material.concerns.push({ candidate: "A", criterion_ids: [input.task_analysis.requirements[0]!.id],
    answer_evidence: material.checks[0]!.answer_evidence, source_evidence: [], reason: "同一交付存在尚需核查的来源问题。" });
  const audit = inspected(request, material);
  assert.throws(() => profile.resolve!(request, finalFor(request, {
    concern_matches: [{ concern_index: 0, finding_indices: [999], observation: "定位既有问题。" }], source_reviews: [{ slot_index: 999, candidate: "A", reason: "另一独立选择无效。" }],
  }), audit), (error: unknown) => {
    assert(error instanceof ValidationError);
    const codes = error.issues!.map(issue => issue.code);
    assert(codes.includes("inspection_match_finding"));
    assert(codes.includes("source_review_slot_index"));
    return true;
  });
  assert.throws(() => profile.resolve!(request, { concern_matches: "invalid", source_reviews: [] }, audit), (error: unknown) => {
    assert(error instanceof ValidationError);
    assert(error.issues!.every(issue => issue.code.startsWith("schema_")), "invalid shape stops unsafe downstream checks");
    return true;
  });
});
