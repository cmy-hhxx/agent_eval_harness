import test from "node:test";
import assert from "node:assert/strict";
import { AgentRegistry } from "@eval/host";
import { projectEvidenceReferences, ValidationError, type AgentRequest, type ToolAudit } from "@eval/contracts";
import { evidenceId, evidenceSources, selectEvidenceSource } from "@eval/tools";
import { actualAnswerEvidenceShares } from "./proof-matching.js";
import { findingAppliesToPair } from "./pair-scope.js";
import { comparisonAgent, comparisonProfile } from "./index.js";
import { comparisonVerificationSubmission, requestComparisonSubmission } from "../../../../tests/fixtures/comparison-submission.js";
import type { ComparisonInput, ComparisonMaterialInspection, ComparisonResult, ComparisonVerificationInput, Finding } from "./types.js";
import example from "./fixtures/example.json" with { type: "json" };

const ID = "11111111-1111-4111-8111-111111111111", PEER = "22222222-2222-4222-8222-222222222222";
const BODY = '先减一半。\n条件："短线超买"。';
function pair() {
  const raw = { messages: [{ role: "user", content: "判断风险" },
    { type: "llm_turn", input_messages: [{ role: "user", content: "判断风险" }],
      output: [{ role: "assistant", content: BODY }], metadata: BODY },
    { type: "final_answer", role: "assistant", content: BODY, metadata: BODY }] };
  const material: ComparisonInput["candidates"][string] = { candidate_id: ID, final_message_index: 2,
    answer_generation: { available: true, message_type: "llm_turn", matches_captured_final: true, message_index: 1, captured_final_message_index: 2,
      blocks: [{ path: "/output/0/content", total_chars: BODY.length }] },
    deferred_final_material: [], original_answer_timing: { finish_seconds: null }, original_answer_usage: { total_tokens: null, issues: [] } };
  const generation = evidenceId(ID, 1, "text", "/output/0/content", 0, BODY.length),
    captured = evidenceId(ID, 2, "text", "/content", 0, BODY.length);
  return { raw, material, generation, captured };
}

function publicPair() {
  const request = structuredClone(example.request) as AgentRequest, input = request.input as unknown as ComparisonVerificationInput;
  const audit: ToolAudit = { calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [], evidenceBank: [] };
  for (const candidate of Object.keys(input.candidates)) {
    request.sources[candidate]!.id = input.candidates[candidate]!.candidate_id;
    input.attributions[candidate]!.findings[0]!.evidence = [{ evidence_id: evidenceId(input.candidates[candidate]!.candidate_id, 1, "text", "/content", 0, 5),
      message_index: 1, quote: "2+2=4" }];
    const assessment = input.attributions[candidate]!.criterion_assessments[0] as unknown as { evidence: Finding["evidence"] };
    assessment.evidence = structuredClone(input.attributions[candidate]!.findings[0]!.evidence);
  }
  input.comparison_draft = comparisonProfile.resolve!(request, requestComparisonSubmission(request, structuredClone(example.result) as ComparisonResult), audit) as ComparisonResult;
  const binding = { agent: "comparison", profile: "verification", request, projectModelInput: projectEvidenceReferences,
    modelInput: { source: "actual blind inputs" }, inspectionInput: { draft: "revealed findings" } }, registry = new AgentRegistry([comparisonAgent]);
  const inspection = (candidate: string, answerId: string, criterionIds = ["sum"], sourceEvidence: { evidence_id: string }[] = []) => {
    const value: ComparisonMaterialInspection = { checks: Object.entries(input.candidates).flatMap(([label, material]) =>
      input.task_analysis.requirements.filter(criterion => !criterion.applies_to.length || criterion.applies_to.includes(material.candidate_id)).map(criterion => {
        const source = request.sources[label]!, raw = source.value as { messages: unknown[] },
          leaf = evidenceSources(raw.messages[material.final_message_index]).find(source => source.kind === "text" && source.path.startsWith("/content"))!;
        return { candidate: label, criterion_id: criterion.id, result: "supported" as const, source_evidence: [], observation: "核对实际最终回答。",
          answer_evidence: [{ evidence_id: evidenceId(source.id, material.final_message_index, "text", leaf.path, 0, leaf.text.length) }] };
      })), concerns: [{ candidate, criterion_ids: criterionIds, answer_evidence: [{ evidence_id: answerId }],
        source_evidence: sourceEvidence.map(({ evidence_id }) => ({ evidence_id })), reason: "实际来源中同一待核查行为。" }] };
    comparisonAgent.profiles.verification!.inspection!.validate(request, value, audit);
    audit.inspection = { id: "real-inspection-checkpoint", value: value as unknown as Record<string, unknown>, proof: { traceReads: [], viewedImages: [] } };
    return value;
  };
  const final = (indices: number[]) => comparisonVerificationSubmission(request, { concern_matches: indices.length ?
    [{ concern_index: 0, finding_indices: indices, observation: "既有问题与实际行为相同。" }] : [] });
  return { request, input, audit, binding, registry, inspection, final };
}
function publicGeneration() {
  const p = pair();
  return { ...p.material.answer_generation!, message_type: "llm_turn" as const, matches_captured_final: true,
    blocks: p.material.answer_generation!.blocks.map(block => ({ ...block, text: BODY, reference: { evidence_id: p.generation },
      read_request: { message_index: 1, path: block.path, offset: 0, max_chars: 16000 } })) };
}

test("actual captured answer and confirmed complete generation share mapped ranges without rewriting either physical ID", () => {
  const { raw, material, generation, captured } = pair(), before = structuredClone(raw);
  assert(actualAnswerEvidenceShares(raw, ID, material, generation, captured));
  assert(actualAnswerEvidenceShares(raw, ID, material, captured, generation));
  const end = BODY.indexOf("。") + 1;
  assert(actualAnswerEvidenceShares(raw, ID, material, generation, evidenceId(ID, 2, "text", "/content", 0, end)));
  assert(!actualAnswerEvidenceShares(raw, ID, material, evidenceId(ID, 1, "text", "/output/0/content", 0, end),
    evidenceId(ID, 2, "text", "/content", end, BODY.length)));
  assert.deepEqual(raw, before);
});

test("metadata, peer, arbitrary earlier assistant and unconfirmed generation never alias the actual answer", () => {
  const { raw, material, generation, captured } = pair();
  for (const wrong of [evidenceId(ID, 1, "text", "/metadata", 0, BODY.length),
    evidenceId(ID, 2, "text", "/metadata", 0, BODY.length), evidenceId(PEER, 2, "text", "/content", 0, BODY.length),
    evidenceId(ID, 2, "image")]) assert(!actualAnswerEvidenceShares(raw, ID, material, wrong, captured));
  assert(!actualAnswerEvidenceShares(raw, ID, { ...material, answer_generation: null }, generation, captured));
  for (const matches_captured_final of [false, null]) assert(!actualAnswerEvidenceShares(raw, ID,
    { ...material, answer_generation: { ...material.answer_generation!, matches_captured_final } }, generation, captured));
  const unconfirmed = structuredClone(raw); unconfirmed.messages[2]!.type = "message";
  assert(!actualAnswerEvidenceShares(unconfirmed, ID, material, generation, captured));
  const newUser = structuredClone(raw); newUser.messages.splice(2, 0, { role: "user", content: "另一个任务" });
  assert(!actualAnswerEvidenceShares(newUser, ID, { ...material, final_message_index: 3,
    answer_generation: { ...material.answer_generation!, captured_final_message_index: 3 } }, generation,
    evidenceId(ID, 3, "text", "/content", 0, BODY.length)));
  assert(!actualAnswerEvidenceShares(raw, ID, { ...material, answer_generation: { ...material.answer_generation!, captured_final_message_index: 0 } }, generation, captured));
  raw.messages.splice(1, 0, { role: "assistant", content: BODY });
  material.final_message_index = 3; material.answer_generation = { ...material.answer_generation!, message_index: 2, captured_final_message_index: 3 };
  assert(!actualAnswerEvidenceShares(raw, ID, material, evidenceId(ID, 1, "text", "/content", 0, BODY.length),
    evidenceId(ID, 3, "text", "/content", 0, BODY.length)));
});

test("normalized equality, independent later planner and incomplete ordered generation do not establish identity", () => {
  for (const changed of [BODY.replace("\n", " "), BODY + '\n<visual>{"id":"chart"}</visual>', BODY + " "]) {
    const { raw, material, generation, captured } = pair();
    raw.messages[1]!.output![0]!.content = changed;
    material.answer_generation!.blocks[0]!.total_chars = changed.length;
    assert(!actualAnswerEvidenceShares(raw, ID, material, generation, captured));
  }
  const { raw, material, generation } = pair();
  raw.messages.splice(2, 0, { type: "llm_turn", input_messages: [{ role: "user", content: "独立规划" }], output: [{ role: "assistant", content: BODY }], metadata: "独立规划" });
  material.final_message_index = 3; material.answer_generation!.captured_final_message_index = 3;
  assert(!actualAnswerEvidenceShares(raw, ID, material, generation, evidenceId(ID, 3, "text", "/content", 0, BODY.length)));
});

test("JSON physical container maps only a complete actual answer leaf, excluding unrelated and partial JSON", () => {
  const { raw, material, captured } = pair(), json = evidenceSources(raw.messages[1]).find(source => source.kind === "json")!,
    leaf = selectEvidenceSource([json], "/output/0/content")!;
  assert(actualAnswerEvidenceShares(raw, ID, material, evidenceId(ID, 1, "json", "", 0, json.text.length), captured));
  assert(!actualAnswerEvidenceShares(raw, ID, material, evidenceId(ID, 1, "json", "", leaf.start + 1, leaf.end), captured));
  const meta = selectEvidenceSource([json], "/metadata")!;
  assert(!actualAnswerEvidenceShares(raw, ID, material, evidenceId(ID, 1, "json", "", meta.start, meta.end), captured));
});

test("ordered complete typed leaves map independently; missing leaves, tool calls and images cannot establish aliases", () => {
  const blocks = [{ type: "text", text: "先减一半。" }, { type: "output_text", text: "短线超买时。" }], raw = { messages: [
    { role: "user", content: "判断风险" }, { type: "llm_turn", input_messages: [{ role: "user", content: "判断风险" }],
      output: [{ role: "assistant", content: structuredClone(blocks) }] }, { type: "final_answer", role: "assistant", content: structuredClone(blocks) }] };
  const material = pair().material;
  material.answer_generation!.blocks = blocks.map((block, index) => ({ path: `/output/0/content/${index}/text`, total_chars: block.text.length }));
  const generation = evidenceId(ID, 1, "text", "/output/0/content/0/text", 0, blocks[0]!.text.length),
    captured = evidenceId(ID, 2, "text", "/content/0/text", 0, blocks[0]!.text.length);
  assert(actualAnswerEvidenceShares(raw, ID, material, generation, captured));
  assert(!actualAnswerEvidenceShares(raw, ID, material, generation, evidenceId(ID, 2, "text", "/content/1/text", 0, blocks[1]!.text.length)));
  const incomplete = { ...material, answer_generation: { ...material.answer_generation!, blocks: material.answer_generation!.blocks.slice(0, 1) } };
  assert(!actualAnswerEvidenceShares(raw, ID, incomplete, generation, captured));
  const withCall = structuredClone(raw);
  Object.assign(withCall.messages[1]!.output![0]!, { tool_calls: [{ name: "plan" }] });
  assert(!actualAnswerEvidenceShares(withCall, ID, material, generation, captured));
  const withImage = structuredClone(raw);
  (withImage.messages[2]!.content as unknown[]).push({ type: "image", mimeType: "image/png", data: "AA==" });
  assert(!actualAnswerEvidenceShares(withImage, ID, material, generation, captured));
  assert(actualAnswerEvidenceShares(withImage, ID, material, captured, captured), "physical text remains usable alongside a separately audited image");
  const reordered = structuredClone(raw); (reordered.messages[2]!.content as typeof blocks).reverse();
  assert(!actualAnswerEvidenceShares(reordered, ID, material, generation, evidenceId(ID, 2, "text", "/content/1/text", 0, blocks[0]!.text.length)));
});

test("instruction pair scope requires all actual norm origins, never coincident metadata or a truncated condition", () => {
  const norm = "# 规则\n风险要前置。\n例外：用户明确禁止时不要前置。", raw = { messages: [
    { role: "system", content: norm, metadata: norm }, { role: "assistant", content: BODY }] };
  const material = { ...pair().material, final_message_index: 1, answer_generation: null };
  const finding: Finding = { type: "problem", dimension: "instruction_following", stage: "final_answer", importance: "high",
    text: "风险位于末尾。", reason: "完整规则要求前置。", evidence: [],
    assessment: { requirement_index: 0, observation: "风险位于末尾。", evidence_status: "established", impact: "未遵循完整共同要求。" } };
  const analysis: ComparisonInput["task_analysis"] = { task_type: "subjective", goal: "根据完整规范判断交付。", requirements: [
    { id: "norm", text: norm, applies_to: [], acceptance_rule: "按完整条件执行。" }], scoring_points: [], red_flags: [] };
  const attribution = { task_analysis: analysis, findings: [finding], criterion_assessments: [],
    core_assessment: { meets_core: true, reason: "核心任务已完成。", criterion_ids: ["norm"] } };
  const input: ComparisonInput = { task_analysis: analysis, candidates: { A: material, B: { ...material, candidate_id: PEER } },
    attributions: { A: attribution, B: { ...attribution, findings: [] } } };
  const full = { evidence_id: evidenceId(ID, 0, "text", "/content", 0, norm.length), message_index: 0, quote: norm };
  finding.evidence = [full]; assert(findingAppliesToPair(input, "A", 0, raw));
  finding.evidence = [{ ...full, evidence_id: evidenceId(ID, 0, "text", "/metadata", 0, norm.length) }];
  assert(!findingAppliesToPair(input, "A", 0, raw));
  const end = norm.indexOf("例外");
  finding.evidence = [{ ...full, evidence_id: evidenceId(ID, 0, "text", "/content", 0, end), quote: norm.slice(0, end) }];
  assert(!findingAppliesToPair(input, "A", 0, raw));
});

test("public Registry matches canonical JSON containers and proven generation without reconstructing display text", () => {
  for (const generation of [false, true]) {
    const f = publicPair(), own = f.input.candidates.A!, source = f.request.sources.A!, p = pair();
    source.value = p.raw; own.final_message_index = p.material.final_message_index; own.answer_generation = publicGeneration();
    const finding = f.input.attributions.A!.findings[0]!; finding.type = "problem";
    const json = evidenceSources(p.raw.messages[2]).find(source => source.kind === "json")!;
    finding.evidence = generation ? [{ evidence_id: p.captured, message_index: 2, quote: BODY }]
      : [{ evidence_id: evidenceId(ID, 2, "json", "", 0, json.text.length), message_index: 2, quote: json.text }];
    f.inspection("A", generation ? p.generation : p.captured);
    assert.deepEqual(f.registry.resolve(f.binding, f.final([0]), f.audit), f.input.comparison_draft);
  }
});

test("public Registry rejects same quote at metadata and offers omission as a finite pending branch", () => {
  const f = publicPair(), p = pair(), own = f.input.candidates.A!, source = f.request.sources.A!;
  source.value = p.raw; own.final_message_index = p.material.final_message_index; own.answer_generation = publicGeneration();
  const finding = f.input.attributions.A!.findings[0]!; finding.type = "problem";
  finding.evidence = [{ evidence_id: evidenceId(ID, 2, "text", "/metadata", 0, BODY.length), message_index: 2, quote: BODY }];
  const value = f.inspection("A", p.captured);
  assert.throws(() => f.registry.resolve(f.binding, f.final([0]), f.audit), (error: unknown) => {
    assert(error instanceof ValidationError);
    const issue = error.issues!.find(issue => issue.code === "inspection_match_finding")!;
    const choices = issue.expected as { eligible_findings: unknown[]; complete_coverage_possible: boolean; unmatched_action: string };
    assert.deepEqual(choices.eligible_findings, []); assert.equal(choices.complete_coverage_possible, false);
    assert.match(choices.unmatched_action, /省略.*保留原发现/); return true;
  });
  const pending = f.registry.resolve(f.binding, f.final([]), f.audit) as ComparisonResult;
  assert.equal(pending.status, "needs_review"); assert(pending.review_requests.some(review => review.reason === value.concerns[0]!.reason));
});

test("public repair choices expose partial criterion coverage without claiming a complete legal match", () => {
  const f = publicPair(), own = f.input.candidates.A!, rule = "# 完整规范\n最后询问用户；只输出数字时除外。";
  (f.request.sources.A!.value as { messages: unknown[] }).messages[0] = { role: "system", content: rule };
  f.input.task_analysis.requirements.push({ id: "other", text: rule, applies_to: [own.candidate_id], acceptance_rule: "保留完整条件。" });
  const finding = f.input.attributions.A!.findings[0]!; finding.type = "problem";
  f.inspection("A", finding.evidence[0]!.evidence_id, ["sum", "other"]);
  assert.throws(() => f.registry.resolve(f.binding, f.final([0]), f.audit), (error: unknown) => {
    assert(error instanceof ValidationError);
    const issue = error.issues!.find(issue => issue.code === "inspection_match_coverage")!;
    const choices = issue.expected as { eligible_findings: { finding_index: number; covered_requirement_indices: number[] }[];
      missing_requirement_indices: number[]; complete_coverage_possible: boolean; required_proof: unknown[] };
    assert.deepEqual(choices.eligible_findings, [{ finding_index: 0, covered_requirement_indices: [0] }]);
    assert.deepEqual(choices.missing_requirement_indices, [1]); assert.equal(choices.complete_coverage_possible, false);
    assert.equal(choices.required_proof.length, 2); return true;
  });
  const pending = f.registry.resolve(f.binding, f.final([]), f.audit) as ComparisonResult;
  assert.equal(pending.status, "needs_review"); assert.deepEqual(pending.review_requests[0]!.criterion_ids, ["sum", "other"]);
});

function sharedUserPair() {
  const f = publicPair(), source = f.request.sources.A!, question = "按股票代码和名称输出表格。",
    condition = "如果提出投资建议，须在开头提示风险。", row = "甲公司 | 000002", answer = row + "\n其他说明。";
  const raw: { messages: Record<string, unknown>[] } = { messages: [
    { role: "user", content: [{ type: "text", text: question }, { type: "text", text: condition }], metadata: question },
    { role: "assistant", content: answer }] };
  source.value = raw; f.input.candidates.A!.answer_generation = null;
  f.input.task_analysis.requirements[0]!.text = question;
  f.input.task_analysis.requirements.push({ id: "compound", text: question + "\n" + condition,
    applies_to: [source.id], acceptance_rule: "保留原问与附加条件。" });
  const reference = (messageIndex: number, path: string, start = 0, end?: number) => {
    const selected = selectEvidenceSource(evidenceSources(raw.messages[messageIndex]), path)!;
    return { evidence_id: evidenceId(source.id, messageIndex, selected.source.kind, selected.source.path,
      selected.start + start, end === undefined ? selected.end : selected.start + end), message_index: messageIndex,
      quote: selected.source.text.slice(selected.start + start, end === undefined ? selected.end : selected.start + end) };
  };
  const finding = f.input.attributions.A!.findings[0]!;
  finding.type = "problem"; finding.text = "甲公司股票代码错误。";
  finding.evidence = [reference(1, "/content", 0, row.length), reference(0, "/content/0/text")];
  const inspect = (sourceEvidence: { evidence_id: string }[] = [], answerId = finding.evidence[0]!.evidence_id) => {
    const value = f.inspection("A", answerId, ["sum", "compound"], sourceEvidence);
    const context = f.registry.inspectCanonical(f.binding, value, f.audit).inspection_context as {
      eligible_match_choices: { eligible_findings: { finding_index: number; covered_requirement_indices: number[] }[];
        missing_requirement_indices: number[]; complete_coverage_possible: boolean }[] };
    return context.eligible_match_choices[0]!;
  };
  return { ...f, source, raw, question, condition, row, answer, finding, reference, inspect };
}

test("public Registry offers a shared complete USER origin across compound criteria without automatically closing the concern", () => {
  const f = sharedUserPair(), choice = f.inspect();
  assert.deepEqual(choice.eligible_findings, [{ finding_index: 0, covered_requirement_indices: [0, 1] }]);
  assert.deepEqual(choice.missing_requirement_indices, []); assert.equal(choice.complete_coverage_possible, true);
  const pending = f.registry.resolve(f.binding, f.final([]), f.audit) as ComparisonResult;
  assert.equal(pending.status, "needs_review"); assert.deepEqual(pending.review_requests[0]!.criterion_ids, ["sum", "compound"]);
  assert.deepEqual(f.registry.resolve(f.binding, f.final([0]), f.audit), f.input.comparison_draft);
});

test("a concern selecting only the compound rule's added USER leaf cannot borrow the common question", () => {
  for (const mode of ["text", "partial-text", "json", "partial-json"]) {
    const f = sharedUserPair();
    const selected = selectEvidenceSource(evidenceSources(f.raw.messages[0]).filter(source => source.kind === "json"), "/content/1/text")!;
    const valueStart = selected.source.text.indexOf(f.condition, selected.start);
    const reference = mode === "text" ? f.reference(0, "/content/1/text") : mode === "partial-text" ? f.reference(0, "/content/1/text", 0, 5)
      : { evidence_id: evidenceId(f.source.id, 0, "json", "", mode === "json" ? selected.start : valueStart,
        mode === "json" ? selected.end : valueStart + 5) };
    const choice = f.inspect([reference]);
    assert.deepEqual(choice.eligible_findings, [{ finding_index: 0, covered_requirement_indices: [0] }], mode);
    assert.deepEqual(choice.missing_requirement_indices, [1], mode);
    assert.throws(() => f.registry.resolve(f.binding, f.final([0]), f.audit), /匹配须覆盖原发现/);
  }
});

test("a separated additional USER paragraph cannot bypass the explicit added-clause guard", () => {
  const f = sharedUserPair();
  (f.raw.messages[0]!.content as { text: string }[])[0]!.text += "\n";
  f.input.task_analysis.requirements[1]!.text = f.question + "\n\n" + f.condition;
  const choice = f.inspect([f.reference(0, "/content/1/text")]);
  assert.deepEqual(choice.missing_requirement_indices, [1]);
});

test("shared USER eligibility requires complete own original provenance and the same actual problem", () => {
  for (const mode of ["truncated", "metadata", "peer", "other-input", "other-message", "indivisible-condition", "heading",
    "different-actual", "strength", "uncertain", "unbound", "private-primary", "only-added-target", "system", "developer"]) {
    const f = sharedUserPair();
    if (mode === "truncated") f.finding.evidence[1] = f.reference(0, "/content/0/text", 0, f.question.length - 1);
    if (mode === "metadata") f.finding.evidence[1] = f.reference(0, "/metadata");
    if (mode === "peer") Object.assign(f.finding.evidence[1]!, { source: "B", source_input_id: PEER });
    if (mode === "other-input") f.finding.evidence[1]!.evidence_id = evidenceId(PEER, 0, "text", "/content/0/text", 0, f.question.length);
    if (mode === "other-message" || mode === "system" || mode === "developer") {
      f.raw.messages.splice(1, 0, { role: mode === "other-message" ? "user" : mode,
        content: mode === "other-message" ? f.question : f.input.task_analysis.requirements[1]!.text });
      f.input.candidates.A!.final_message_index = 2; f.finding.evidence[0] = f.reference(2, "/content", 0, f.row.length);
      if (mode === "other-message") f.finding.evidence[1] = f.reference(1, "/content");
    }
    if (mode === "indivisible-condition" || mode === "heading") {
      const content = (mode === "heading" ? "# 要求\n" : "") + f.question + "\n" + f.condition;
      f.raw.messages[0]!.content = content;
      f.input.task_analysis.requirements[0]!.text = (mode === "heading" ? "# 要求\n" : "") + f.question;
      f.input.task_analysis.requirements[1]!.text = content;
      f.finding.evidence[1] = f.reference(0, "/content", 0, f.input.task_analysis.requirements[0]!.text.length);
    }
    if (mode === "strength") f.finding.type = "strength";
    if (mode === "uncertain") f.finding.assessment.evidence_status = "uncertain";
    if (mode === "unbound") f.finding.assessment.requirement_index = null;
    if (mode === "private-primary") f.input.task_analysis.requirements[0]!.applies_to = [f.source.id];
    if (mode === "only-added-target") f.input.task_analysis.requirements[1]!.text = f.condition;
    const answerId = mode === "different-actual" ? f.reference(1, "/content", f.row.length + 1).evidence_id : f.finding.evidence[0]!.evidence_id;
    const choice = f.inspect([], answerId);
    assert(choice.missing_requirement_indices.includes(1), mode);
    assert.throws(() => f.registry.resolve(f.binding, f.final([0]), f.audit), /原材料发现只能对应|匹配须覆盖原发现/, mode);
  }
});

test("multi-leaf common USER blocks require every real origin, while complete JSON containers retain eligibility", () => {
  const f = sharedUserPair(), first = "按股票代码和名称", second = "输出完整表格。", common = first + "\n" + second;
  f.raw.messages[0]!.content = [{ type: "text", text: first }, { type: "text", text: second + "\n" }, { type: "text", text: f.condition }];
  f.input.task_analysis.requirements[0]!.text = common;
  f.input.task_analysis.requirements[1]!.text = common + "\n\n" + f.condition;
  f.finding.evidence = [f.finding.evidence[0]!, f.reference(0, "/content/0/text"), f.reference(0, "/content/1/text", 0, second.length)];
  assert.deepEqual(f.inspect().eligible_findings, [{ finding_index: 0, covered_requirement_indices: [0, 1] }]);
  f.finding.evidence.pop(); assert.deepEqual(f.inspect().missing_requirement_indices, [1]);
  const json = evidenceSources(f.raw.messages[0]).find(source => source.kind === "json")!,
    full = { evidence_id: evidenceId(f.source.id, 0, "json", "", 0, json.text.length), message_index: 0, quote: json.text };
  f.finding.evidence = [f.finding.evidence[0]!, full];
  assert.deepEqual(f.inspect([full]).eligible_findings, [{ finding_index: 0, covered_requirement_indices: [0, 1] }]);
});

test("escaped USER JSON values preserve added-clause scope without treating keys, delimiters or metadata as norms", () => {
  const f = sharedUserPair(), condition = '如果提出 "投资建议"，须提示风险。\\路径\n保留条件。';
  (f.raw.messages[0]!.content as { text: string }[])[1]!.text = condition;
  f.input.task_analysis.requirements[1]!.text = f.question + "\n" + condition;
  const json = evidenceSources(f.raw.messages[0]).find(source => source.kind === "json")!,
    selected = selectEvidenceSource([json], "/content/1/text")!, valueStart = selected.end - JSON.stringify(condition).length + 1,
    ref = (start: number, end: number) => ({ evidence_id: evidenceId(f.source.id, 0, "json", "", start, end) });
  for (const [start, end] of [[selected.start, selected.end], [valueStart + 4, valueStart + 10]])
    assert.deepEqual(f.inspect([ref(start!, end!)]).missing_requirement_indices, [1]);
  const metadata = selectEvidenceSource([json], "/metadata")!;
  for (const [start, end] of [[selected.start, valueStart], [selected.end - 1, selected.end], [metadata.start, metadata.end]])
    assert.deepEqual(f.inspect([ref(start!, end!)]).eligible_findings, [{ finding_index: 0, covered_requirement_indices: [0, 1] }]);
});

function returnedNewsPair() {
  const f = publicPair(), source = f.request.sources.A!, question = "结合过去12小时内的财经新闻筛选3条信息。",
    answer = "过去12小时：央行扩大隔夜逆回购，利好银行板块。",
    raw = { messages: Array.from({ length: 17 }, (): unknown => ({ type: "tool_call", input: { query: "财经新闻" } })) };
  raw.messages[0] = { role: "user", content: question };
  raw.messages[6] = { type: "tool_result", metadata: { publish_time: "2026-09-24 07:30:09" }, input: { arguments: "隔夜逆回购" }, output: { items: [
    { serial_number: "xjzdja7", summary: "财联社9月23日讯，央行扩大隔夜逆回购。", publish_time: "2026-09-24 07:30:09",
      metadata: { publish_time: "2026-09-24 07:30:09" }, query: "隔夜逆回购" },
    { summary: "央行开展8000亿元MLF操作。", publish_time: "2026-09-24 20:22:00" }], count: 2,
    context: [{ role: "system", content: "只看12小时新闻。" }, { role: "user", content: question }] } };
  raw.messages[16] = { type: "final_answer", role: "assistant", content: answer };
  source.value = raw; f.input.candidates.A!.final_message_index = 16; f.input.candidates.A!.answer_generation = null;
  f.input.task_analysis.requirements[0]!.text = question;
  const reference = (path: string, candidate = "A") => {
    const origin = f.request.sources[candidate]!, selected = selectEvidenceSource(evidenceSources(raw.messages[6]), path)!;
    return { evidence_id: evidenceId(origin.id, 6, selected.source.kind, selected.source.path, selected.start, selected.end),
      message_index: 6, quote: selected.source.text.slice(selected.start, selected.end) };
  };
  const fact = reference("/output/items/0"), answerId = evidenceId(source.id, 16, "text", "/content", 0, answer.length);
  const finding = f.input.attributions.A!.findings[0]!;
  finding.type = "problem"; finding.stage = "reasoning";
  finding.text = "所选新闻来源发布于07:30，早于提问前12小时窗口起点18:07。";
  finding.evidence = [fact];
  return { ...f, raw, source, finding, reference, fact, answerId };
}

test("public Registry closes an already established window problem through the same own returned news fact", () => {
  const f = returnedNewsPair();
  f.inspection("A", f.answerId, ["sum"], [f.fact]);
  assert.deepEqual(f.registry.resolve(f.binding, f.final([0]), f.audit), f.input.comparison_draft);
});

test("returned fact matching retains physical text/JSON identity and confirmed execution values", () => {
  for (const paths of [["/output/items/0", "/output/items/0/publish_time"],
    ["/output/items/0/publish_time", "/output/items/0"], ["", "/output/items/0"], ["/output/count", "/output/count"],
    ["/output/items/0/metadata/publish_time", "/output/items/0/metadata/publish_time"]]) {
    const f = returnedNewsPair(); f.finding.evidence = [f.reference(paths[0]!)];
    f.inspection("A", f.answerId, ["sum"], [f.reference(paths[1]!)]);
    assert.deepEqual(f.registry.resolve(f.binding, f.final([0]), f.audit), f.input.comparison_draft);
  }
  for (const message of [{ role: "tool", content: "2026-09-24 07:30:09" },
    { type: "function_call_output", output: { count: 2 } }]) {
    const f = returnedNewsPair(); f.raw.messages[6] = message;
    const fact = f.reference("content" in message ? "/content" : "/output/count"); f.finding.evidence = [fact];
    f.inspection("A", f.answerId, ["sum"], [fact]);
    assert.deepEqual(f.registry.resolve(f.binding, f.final([0]), f.audit), f.input.comparison_draft);
  }
});

test("returned JSON counterfacts require a value rather than its field label, colon, quote or whitespace", () => {
  const probe = returnedNewsPair(), json = evidenceSources(probe.raw.messages[6]).find(item => item.kind === "json")!,
    selected = selectEvidenceSource([json], "/output/items/0/publish_time")!,
    valueStart = json.text.indexOf("2026-09-24 07:30:09", selected.start), blank = valueStart + "2026-09-24".length;
  for (const [start, end] of [[selected.start, selected.start + '"publish_time"'.length],
    [selected.start + '"publish_time"'.length, valueStart], [valueStart - 1, valueStart],
    [selected.end - 1, selected.end], [blank, blank + 1]]) {
    const f = returnedNewsPair(), fact = { evidence_id: evidenceId(f.source.id, 6, "json", "", start!, end!),
      message_index: 6, quote: json.text.slice(start, end) };
    f.finding.evidence = [fact]; f.inspection("A", f.answerId, ["sum"], [fact]);
    assert.throws(() => f.registry.resolve(f.binding, f.final([0]), f.audit), /原材料发现只能对应/);
  }
  const f = returnedNewsPair(), fact = { evidence_id: evidenceId(f.source.id, 6, "json", "", valueStart, valueStart + 10),
    message_index: 6, quote: "2026-09-24" };
  f.finding.evidence = [fact]; f.inspection("A", f.answerId, ["sum"], [fact]);
  assert.deepEqual(f.registry.resolve(f.binding, f.final([0]), f.audit), f.input.comparison_draft);
  for (const path of ["/output/rows/0", "/output/a~1b~0c"]) {
    const escaped = returnedNewsPair();
    escaped.raw.messages[6] = { type: "tool_result", output: { rows: ['报导 "FX"\\路径\n下一行'], "a/b~c": '报导 "FX"\\路径\n下一行' } };
    const origin = evidenceSources(escaped.raw.messages[6]).filter(item => item.kind === "json"),
      selectedValue = selectEvidenceSource(origin, path)!,
      value = { evidence_id: evidenceId(escaped.source.id, 6, "json", "", selectedValue.start, selectedValue.end),
        message_index: 6, quote: selectedValue.source.text.slice(selectedValue.start, selectedValue.end) };
    escaped.finding.evidence = [value]; escaped.inspection("A", escaped.answerId, ["sum"], [value]);
    assert.deepEqual(escaped.registry.resolve(escaped.binding, escaped.final([0]), escaped.audit), escaped.input.comparison_draft);
  }
});

test("same criterion cannot replace a returned counterfact with another row, query, request or copied norm", () => {
  for (const paths of [["/output/items/0", "/output/items/1"], ["/output/items/0/query", "/output/items/0/query"],
    ["/input/arguments", "/input/arguments"], ["/output/context/0/content", "/output/context/0/content"],
    ["/output/context/1/content", "/output/context/1/content"], ["/metadata/publish_time", "/metadata/publish_time"]]) {
    const f = returnedNewsPair(); f.finding.evidence = [f.reference(paths[0]!)];
    f.inspection("A", f.answerId, ["sum"], [f.reference(paths[1]!)]);
    assert.throws(() => f.registry.resolve(f.binding, f.final([0]), f.audit), /原材料发现只能对应/);
  }
  const f = returnedNewsPair(), raw = f.raw as { messages: Record<string, unknown>[] };
  raw.messages[6]!.type = "tool_call"; f.inspection("A", f.answerId, ["sum"], [f.fact]);
  assert.throws(() => f.registry.resolve(f.binding, f.final([0]), f.audit), /原材料发现只能对应/);
});

test("returned counterfacts do not bypass own source, established problem or private norm/actual guards", () => {
  for (const mode of ["peer", "strength", "uncertain", "private", "system"]) {
    const f = returnedNewsPair();
    if (mode === "peer") {
      f.request.sources.B!.value = structuredClone(f.raw); f.input.candidates.B!.final_message_index = 16;
    }
    if (mode === "strength") f.finding.type = "strength";
    if (mode === "uncertain") f.finding.assessment.evidence_status = "uncertain";
    if (mode === "private") f.input.task_analysis.requirements[0]!.applies_to = [f.source.id];
    if (mode === "system") f.raw.messages[0] = { role: "system", content: f.input.task_analysis.requirements[0]!.text };
    f.inspection("A", f.answerId, ["sum"], [mode === "peer" ? f.reference("/output/items/0", "B") : f.fact]);
    assert.throws(() => f.registry.resolve(f.binding, f.final([0]), f.audit), /原材料发现只能对应/);
  }
});
