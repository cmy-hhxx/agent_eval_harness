import { responsibilityFixture } from "../../../../tests/fixtures/responsibility.js";
import { attributionSubmission } from "../../../../tests/fixtures/attribution-submission.js";
import { resolveJudgment } from "./resolve.js";
const INPUT_ID = "11111111-1111-4111-8111-111111111111";
import test from "node:test";
import assert from "node:assert/strict";
import { AgentRegistry } from "@eval/host";
import { prepareFixtureEvidence } from "../../../../tests/fixtures/evidence.js";
import { parseEvidenceCoordinates, ValidationError, type AgentBinding, type AgentRequest, type EvidenceReference, type ToolAudit } from "@eval/contracts";
import { cite, evidenceSources, selectEvidenceSource } from "@eval/tools";
import { attributionAgent, attributionTableChecks, attributionTableReview } from "./index.js";
import type { AttributionResult } from "./types.js";
import example from "./fixtures/example.json" with { type: "json" };
import { setFixtureNormDirectory } from "../../../../tests/fixtures/attribution-submission.js";

const peerId = "22222222-2222-4222-8222-222222222222";
const timestamp = "2025-03-12T16:35:00.000Z";
const audit = (): ToolAudit => ({ calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [] });
const registry = new AgentRegistry([attributionAgent]);
function fixture() {
  const request = structuredClone(example.request) as AgentRequest;
  const own = request.sources.answer.value as { messages: Record<string, unknown>[] };
  own.messages[0]!.content = "按原请求时间说明今天日期";
  own.messages[0]!.timestamp = timestamp;
  own.messages[1]!.content = "今天是2025年3月13日。";
  request.input.ground_truth = { available: false, value: null };
  const answer = request.input.answer as Record<string, unknown>;
  answer.question = "按原请求时间说明今天日期";
  answer.final_answer = own.messages[1]!.content as string;
  request.input.task_analysis = { task_type: "日期判断", goal: answer.question, requirements: [
    { id: "r1", text: "给出原请求的UTC日期", applies_to: [], acceptance_rule: "依据原请求UTC时间说明日期。" },
  ], scoring_points: [], red_flags: [] };
  request.input.review_context = { reasons: ["核查日期依据"] };
  const peer = structuredClone(own);
  peer.messages[1]!.content = "原请求UTC日期为2025年3月12日。";
  request.sources.B = { id: peerId, value: { batch_id: "b1", case_id: "q", ...peer } };
  request.input.reference_materials = { B: { ...structuredClone(answer),
    identity: { version_id: "B", display_name: "对方回答", answer_model: null },
    final_answer: peer.messages[1]!.content as string, source_input_id: peerId, original_user_timestamp: timestamp, grader_only: true } };
  delete (request.input.reference_materials as any).B.norm_directory;
  delete (request.input.reference_materials as any).B.component_catalog;
  const ref = (source: string, index: number, path: string): EvidenceReference => {
    const raw = request.sources[source]!.value as { messages: unknown[] };
    const selected = selectEvidenceSource(evidenceSources(raw.messages[index]), path)!;
    return { evidence_id: cite(request.sources[source]!.id, index, selected.source, selected.start, selected.end).evidence_id };
  };
  (request.input.reference_materials as any).B.final_evidence = [{ ...ref("B", 1, "/content"),
    message_index: 1, quote: peer.messages[1]!.content }];
  const ownRef = ref("answer", 1, "/content"), peerRef = ref("B", 0, "/timestamp");
  const draft = { summary: "原UTC日期与回答相差一天。", numeric_checks: [],  findings: [{
    type: "problem", dimension: "correctness", stage: "final_answer", importance: "high",
    text: "UTC日期错误", reason: "原请求UTC日期为12日，实际回答为13日。", evidence: [ownRef, peerRef],
    assessment: { requirement_index: 0, observation: "UTC日期相差一天", evidence_status: "established", impact: "核心日期不可用" },
    problem: { component: [responsibilityFixture("最终作答节点（原始名称未提供）",{evidence_ids:[ownRef.evidence_id]})], label: "日期错误", definition: "最终日期与原请求UTC日期不一致。" },
  }], criterion_assessments: [{ criterion_id: "r1", status: "unmet", evidence_status: "established",
    summary: "回答日期与原请求UTC日期不一致。", evidence: [ownRef, peerRef] }],
    core_assessment: { meets_core: false, reason: "日期错误。", requirement_indices: [0] } };
  setFixtureNormDirectory(request);
  return { request, binding: { agent: "attribution", profile: "default", request } as AgentBinding, draft, ref };
}
function hasIssue(action: () => unknown, code: string, path?: string) {
  assert.throws(action, (error: unknown) => error instanceof ValidationError && error.issues!.some(issue =>
    issue.code === code && (path === undefined || issue.path === path)), code);
}
test("public Attribution review resolves a peer UTC counterfact against its registered raw source and persists its UUID", () => {
  const { request, binding, draft } = fixture();
  const before = structuredClone({ request, draft });
  prepareFixtureEvidence(registry, binding);
  const result = resolveJudgment(binding.request, draft, audit()) as AttributionResult;
  registry.validate(binding, result, audit());
  assert.deepEqual(result.findings[0]!.evidence, [
    { evidence_id: draft.findings[0]!.evidence[0]!.evidence_id, message_index: 1, quote: "今天是2025年3月13日。" },
    { evidence_id: draft.findings[0]!.evidence[1]!.evidence_id, message_index: 0, quote: timestamp, source: "B", source_input_id: peerId },
  ]);
  assert.deepEqual(result.correctness_evidence, []);
  assert.equal(result.is_correct, null);
  assert(!Object.hasOwn(draft, "is_correct"));
  const restored = JSON.parse(JSON.stringify(result));
  registry.validate(binding, restored, audit());
  assert.deepEqual(restored.findings[0].evidence, result.findings[0]!.evidence);
  assert.deepEqual({ request, draft }, before);
  restored.findings[0].evidence[1].source_input_id = request.sources.answer.id;
  hasIssue(() => registry.validate(binding, restored, audit()), "evidence_source_invalid");
});
test("model schema uses numeric selections for both peer and self evidence", () => {
  const { binding } = fixture();
  const prepared = prepareFixtureEvidence(registry, binding);
  const own = structuredClone(example.request);
  const plain = prepareFixtureEvidence(registry, { ...binding, request: own });
  for (const preparedSchema of [prepared,plain]) {
    const refs=(preparedSchema.evaluation.outputSchema.properties as any).strengths.items.properties.evidence_indices;
    assert.deepEqual(refs.items,{type:"integer",minimum:1});
    assert(!(preparedSchema.evaluation.outputSchema.properties as any).strengths.items.properties.evidence);
  }
  assert.equal((prepared.evaluation.outputSchema.properties as any).correctness_evidence_indices.maxItems,0);
});
test("registered same-question evidence allows formatting whitespace without allowing another question", () => {
  const { request, binding, draft } = fixture();
  const peer = (request.input.reference_materials as any).B;
  peer.question = "按原请求时间\n说明 今天日期";
  (request.sources.B.value as any).messages[0].content = peer.question;
  prepareFixtureEvidence(registry, binding);
  registry.validate(binding, resolveJudgment(request, draft, audit()), audit());
  peer.question = "按原请求时间说明今天气温";
  hasIssue(() => resolveJudgment(request, draft, audit()), "evidence_source_invalid");
});
test("unknown sources, explicit answer aliases, missing registrations and different business scope fail the public entry without rewriting a draft", () => {
  for (const source of ["B", "other", "answer", "../B"]) {
    const { binding, draft } = fixture();
    Object.assign(draft.findings[0]!, { source });
    const before = structuredClone(draft);
    hasIssue(() => resolveJudgment(binding.request, draft, audit()), "schema_additionalProperties");
    assert.deepEqual(draft, before);
  }
  for (const change of [
    (request: AgentRequest) => { (request.input.reference_materials as any).B.source_input_id = request.sources.answer.id; },
    (request: AgentRequest) => { (request.input.reference_materials as any).B.question = "另一个问题"; },
    (request: AgentRequest) => { (request.sources.B!.value as any).case_id = "else"; },
    (request: AgentRequest) => { (request.sources.B!.value as any).batch_id = "else"; },
    (request: AgentRequest) => { (request.sources.B!.value as any).messages[0].timestamp = "2025-03-13T16:35:00.000Z"; },
    (request: AgentRequest) => { delete request.input.reference_materials; },
    (request: AgentRequest) => { delete request.input.review_context; },
  ]) {
    const { request, binding, draft } = fixture(); change(request);
    hasIssue(() => resolveJudgment(binding.request, draft, audit()), "evidence_source_invalid");
  }
});
test("registered same-case facts preserve missing and different native timestamps without borrowing a peer clock", () => {
  for (const ownTimestamp of [undefined, "2025-03-12T18:35:00+08:00"]) {
    const { request, binding, draft } = fixture();
    const own = request.sources.answer.value as any;
    if (ownTimestamp === undefined) delete own.messages[0].timestamp;
    else own.messages[0].timestamp = ownTimestamp;
    draft.findings[0]!.assessment.evidence_status = "uncertain";
    draft.findings[0]!.assessment.observation = "peer原时间可定位，但未核实本方相对日期依据。";
    draft.findings[0]!.reason = "不能将peer时钟补成本方当前时间。";
    draft.criterion_assessments[0]!.status = "unknown";
    draft.criterion_assessments[0]!.evidence_status = "uncertain";
    draft.core_assessment.meets_core = null as any;
    const before = structuredClone({ request, draft });
    prepareFixtureEvidence(registry, binding);
    const result = resolveJudgment(binding.request, draft, audit()) as AttributionResult;
    registry.validate(binding, result, audit());
    assert.deepEqual({ request, draft }, before);
    assert.equal(own.messages[0].timestamp, ownTimestamp);
    assert.equal((request.sources.B!.value as any).messages[0].timestamp, timestamp);
    assert.equal((request.input.reference_materials as any).B.original_user_timestamp, timestamp);
    assert.equal(result.findings[0]!.evidence[1]!.quote, timestamp);
    assert.equal(result.findings[0]!.assessment.evidence_status, "uncertain");
  }
});
test("foreign facts cannot replace this candidate's actual delivery or numeric correctness evidence", () => {
  const { binding, draft, ref } = fixture();
  draft.findings[0]!.evidence = [ref("B", 0, "/timestamp")];
  hasIssue(() => resolveJudgment(binding.request, draft, audit()), "finding_final_evidence_required", "/findings/0/evidence");
  draft.findings[0]!.evidence.push(ref("answer", 1, "/content"));
  const result = resolveJudgment(binding.request, draft, audit());
  registry.validate(binding, result, audit());
  const accepted = result as AttributionResult;
  assert.equal(accepted.findings[0]!.evidence.at(-1)!.message_index, 1, "own final excerpt is explicitly selected alongside the peer fact");
  accepted.findings[0]!.evidence.pop();
  hasIssue(() => registry.validate(binding, accepted, audit()), "peer_actual_evidence_required", "/findings/0/evidence");
  const numeric = fixture();
  numeric.request.input.ground_truth = { available: true, value: "4" };
  const numericDraft = { ...numeric.draft, is_correct: false, correctness_reason: "结果不同", correctness_evidence: [numeric.ref("B", 1, "/content")] };
  hasIssue(() => resolveJudgment((numeric.binding).request, numericDraft, audit()), "evidence_final_required", "/correctness_evidence");
});

test("correctness may cite registered peer original facts alongside own delivery, but numeric actual and peer final stay separate", () => {
  const { request, binding, draft, ref } = fixture();
  request.input.ground_truth = { available: true, value: "12" };
  const original = ref("B", 0, "/timestamp"), own = ref("answer", 1, "/content");
  const judgment = { ...draft, is_correct: false, correctness_reason: "实际回答13日，原始请求时间及标准答案为12日。",
    correctness_evidence: [own, original] };
  prepareFixtureEvidence(registry, binding);
  const result = resolveJudgment(request, judgment, audit()) as AttributionResult;
  registry.validate(binding, result, audit());
  assert.equal(result.correctness_evidence[1]!.source_input_id, peerId);
  const numeric = { ...judgment, numeric_checks: [{ label: "日期", reference_index: 0, actual: "12", scale: "1", mode: "exact", evidence_index: 1 }] };
  hasIssue(() => resolveJudgment(request, numeric, audit()), "evidence_final_required", "/numeric_checks/0/evidence_index");
  hasIssue(() => resolveJudgment(request, { ...judgment, correctness_evidence: [original] }, audit()),
    "evidence_final_required", "/correctness_evidence");
  hasIssue(() => resolveJudgment(request, { ...judgment, correctness_evidence: [own, ref("B", 1, "/content")] }, audit()),
    "peer_final_not_independent", "/correctness_evidence/1");
});

test("a peer final answer cannot establish own correctness even alongside own actual delivery", () => {
  const { binding, draft, ref } = fixture();
  const refs = [ref("answer", 1, "/content"), ref("B", 1, "/content")];
  draft.findings[0]!.evidence = refs;
  draft.criterion_assessments[0]!.evidence = refs;
  prepareFixtureEvidence(registry, binding);
  const before = structuredClone({ binding, draft });
  assert.throws(() => resolveJudgment(binding.request, draft, audit()), (error: unknown) => {
    assert(error instanceof ValidationError);
    assert.deepEqual(error.issues!.filter(issue => issue.code === "peer_final_not_independent").map(issue => issue.path),
      ["/criterion_assessments/0/evidence/1", "/findings/0/evidence/1"]);
    return true;
  });
  assert.deepEqual({ binding, draft }, before);
});

test("peer deferred final leaves and JSON excerpts cannot bypass the source boundary", () => {
  for (const json of [false, true]) {
    const { request, binding, draft, ref } = fixture();
    const peer = request.sources.B!.value as { messages: Record<string, unknown>[] };
    const text = "原请求日期为12日。".repeat(2000);
    peer.messages[1]!.content = text;
    const material = (request.input.reference_materials as any).B;
    material.final_answer = "";
    material.final_evidence = [];
    material.deferred_final_material = [{ message_index: 1, path: "/content", total_chars: text.length }];
    const leaf = evidenceSources(peer.messages[1]).find(source => source.kind === (json ? "json" : "text") && source.path === (json ? "" : "/content"))!;
    draft.findings[0]!.evidence = [ref("answer", 1, "/content"), {
      evidence_id: cite(peerId, 1, leaf, 0, json ? leaf.text.length : 80).evidence_id,
    }];
    prepareFixtureEvidence(registry, binding);
    hasIssue(() => resolveJudgment(binding.request, draft, audit()), "peer_final_not_independent", "/findings/0/evidence/1");
  }
});

test("same-message original tool, reference, timestamp and image evidence remains available beside peer final prose", () => {
  const { request, binding, draft, ref } = fixture();
  const peer = request.sources.B!.value as { messages: Record<string, unknown>[] };
  peer.messages[1] = { ...peer.messages[1], type: "llm_turn", timestamp,
    output: [{ type: "tool_result", name: "web_search", output: { text: "原始资料：UTC日期为12日。", value: 12 } }],
    reference: { text: "原始参考材料。" }, image: { type: "image", mimeType: "image/png", data: "AA==" } };
  const reads = { ...audit(), viewedImages: ["B:1"] };
  draft.findings[0]!.evidence = [ref("answer", 1, "/content"), ref("B", 1, "/output/0/output/text"),
    ref("B", 1, "/output/0/output/value"), ref("B", 1, "/reference/text"), ref("B", 1, "/timestamp"),
    { evidence_id: `ev_${peerId}_1_image`, observation: "原始图片显示日期。" }];
  prepareFixtureEvidence(registry, binding);
  const result = resolveJudgment(binding.request, draft, reads) as AttributionResult;
  registry.validate(binding, result, reads);
  assert.equal(result.findings[0]!.evidence.filter(item => item.source === "B").length, 5);
  draft.findings[0]!.evidence.push(ref("B", 1, "/content"));
  hasIssue(() => resolveJudgment(binding.request, draft, reads), "peer_final_not_independent", "/findings/0/evidence/6");
});

test("registered original answer generation is final prose while its sibling tool return remains independent", () => {
  const { request, binding, draft, ref } = fixture();
  const peer = request.sources.B!.value as { messages: Record<string, unknown>[] };
  const text = peer.messages[1]!.content;
  peer.messages = [peer.messages[0]!, { type: "llm_turn", input_messages: [peer.messages[0]],
    output: [{ role: "assistant", content: [{ type: "text", text }] }],
    tool_return: { type: "tool_result", name: "web_search", content: "原始资料：UTC日期为12日。" } },
    { type: "final_answer", role: "assistant", content: text }];
  const material = (request.input.reference_materials as any).B;
  material.final_message_index = 2;
  material.final_evidence = [{ ...ref("B", 2, "/content"), message_index: 2, quote: text }];
  const generation = ref("B", 1, "/output/0/content/0/text");
  material.answer_generation = { available: true, message_type: "llm_turn", message_index: 1,
    input_contexts: [{ message_index: 1, path: "/input_messages",
      total_chars: (() => { const range = selectEvidenceSource(evidenceSources(peer.messages[1]), "/input_messages")!; return range.end - range.start; })(),
      read_request: { message_index: 1, path: "/input_messages", offset: 0, max_chars: 16000 } }],
    captured_final_message_index: 2, matches_captured_final: true, blocks: [{ path: "/output/0/content/0/text", text,
      total_chars: String(text).length, reference: generation,
      read_request: { message_index: 1, path: "/output/0/content/0/text", offset: 0, max_chars: 16000 } }] };
  draft.findings[0]!.evidence = [ref("answer", 1, "/content"), ref("B", 1, "/tool_return/content")];
  prepareFixtureEvidence(registry, binding);
  registry.validate(binding, resolveJudgment(binding.request, draft, audit()), audit());
  draft.findings[0]!.evidence[1] = generation;
  hasIssue(() => resolveJudgment(binding.request, draft, audit()), "peer_final_not_independent", "/findings/0/evidence/1");
});

test("accepted formal origins restore without replaying current submission rules", () => {
  const {request,binding,draft,ref}=fixture();
  const accepted=resolveJudgment(request,draft,audit()) as AttributionResult;
  const quote=String((request.sources.B!.value as {messages:{content:string}[]}).messages[1].content);
  accepted.findings[0].evidence[1]={...ref("B",1,"/content"),message_index:1,quote,source:"B",source_input_id:peerId};
  const restored=JSON.parse(JSON.stringify(accepted));
  registry.validate(binding,restored,audit());
  assert.deepEqual(restored,accepted);
  draft.findings[0].evidence=[ref("answer",1,"/content"),ref("B",1,"/content")];
  hasIssue(()=>resolveJudgment(request,draft,audit()),"peer_final_not_independent","/findings/0/evidence/1");
});

test("peer private instructions cannot close this candidate's instruction evidence even at matching indices", () => {
  const { request, binding, draft, ref } = fixture();
  const own = request.sources.answer.value as any, peer = request.sources.B!.value as any;
  own.messages[0] = { type: "message", role: "system", content: "风险提示必须前置。" };
  peer.messages[0] = structuredClone(own.messages[0]);
  (request.input.reference_materials as any).B.original_user_timestamp = null;
  draft.criterion_assessments[0]!.evidence = [ref("answer", 1, "/content")];
  draft.findings[0]!.dimension = "instruction_following";
  draft.findings[0]!.assessment.requirement_index = null as any;
  draft.findings[0]!.evidence = [ref("answer", 1, "/content"), ref("B", 0, "/content")];
  setFixtureNormDirectory(request);
  const originalEvidence = structuredClone(draft.findings[0]!.evidence);
  const { requirement_index: _association, ...assessment } = draft.findings[0]!.assessment;
  Object.assign(draft.findings[0]!, { norm_index: 0, assessment });
  const before = structuredClone({ request, draft });
  const result = resolveJudgment(binding.request, draft, audit()) as AttributionResult;
  registry.validate(binding, result, audit());
  const ownNorm = ref("answer", 0, "/content");
  assert.deepEqual(result.findings[0]!.evidence.map(item => item.evidence_id), [
    originalEvidence[0]!.evidence_id, originalEvidence[1]!.evidence_id,
  ]);
  assert.equal(result.findings[0]!.evidence[1]!.source, "B", "an explicit peer fact retains its foreign owner");
  const completedNorm = result.findings[0]!.context_evidence![0]!;
  assert.equal(completedNorm.evidence_id, ownNorm.evidence_id);
  assert.equal(completedNorm.source, undefined);
  assert.equal(completedNorm.source_input_id, undefined);
  assert.equal(parseEvidenceCoordinates(completedNorm.evidence_id)!.input_id, INPUT_ID);
  assert.equal(completedNorm.quote, own.messages[0].content, "only the actual complete own SYS is attached");
  const peerOnly = structuredClone(result);
  delete peerOnly.findings[0]!.context_evidence;
  registry.validate(binding, peerOnly, audit());
  assert.equal(peerOnly.findings[0]!.context_evidence, undefined, "an unlinked finding never promotes a peer fact into an own norm");
  assert.deepEqual({ request, draft }, before, "program closure does not rewrite the submitted selection or raw source");
});
test("peer image observation requires the peer's actual view audit and keeps source-qualified repair suggestions", () => {
  const { request, binding, draft } = fixture();
  (request.sources.B!.value as any).messages[1].content = [{ type: "image", mimeType: "image/png", data: "AA==" }];
  draft.findings[0]!.evidence[1] = { evidence_id: `ev_${peerId}_1_image`, observation: "图中日期为12日" } as EvidenceReference;
  hasIssue(() => resolveJudgment(binding.request, draft, { ...audit(), viewedImages: ["answer:1"] }), "image_not_viewed");
  const inspected = { ...audit(), viewedImages: ["B:1"] };
  const result = resolveJudgment(binding.request, draft, inspected) as AttributionResult;
  registry.validate(binding, result, inspected);
  assert.deepEqual(result.findings[0]!.evidence[1], { evidence_id: draft.findings[0]!.evidence[1]!.evidence_id,
    source: "B", source_input_id: peerId, message_index: 1, quote: "[图像观察]图中日期为12日" });
  const invalid = fixture();
  const reads = { ...audit(), evidenceBank: [] as string[] };
  const selected = attributionSubmission(invalid.request,resolveJudgment(invalid.request,invalid.draft,reads) as AttributionResult,reads);
  reads.evidenceBank[selected.problems[0].evidence_indices[1]-1]=`ev_${peerId}_0_text_0_999_/timestamp`;
  const providedBank = [...reads.evidenceBank];
  assert.throws(() => registry.resolve(invalid.binding, selected, reads), (error: unknown) => {
    assert(error instanceof ValidationError);
    const issue = error.issues!.find(issue => issue.code === "evidence_range_invalid")!;
    assert(issue);
    const suggestions = (issue.expected as any).suggested_evidence;
    assert(suggestions.length);
    assert(suggestions.every((item: any) => item.reference
      ? Object.keys(item.reference).length === 1 && Number.isSafeInteger(item.reference.evidence_index) &&
        item.reference.evidence_index > 0 && parseEvidenceCoordinates(reads.evidenceBank[item.reference.evidence_index - 1]!)?.input_id === peerId
      : item.read_request.tool === "read_trace" && item.read_request.arguments.candidate === "B" &&
        item.read_request.arguments.message_index === 0));
    assert.deepEqual(reads.evidenceBank, providedBank, "new source suggestions require a real read before numbering");
    return true;
  });
});

test("review peer independent tool facts resolve missing table rows without posing as own lineage or erasing conflicts", () => {
  const { request, binding, ref } = fixture();
  const table = (rows: string[]) => "| 代码 | 名称 |\n|---|---|\n" + rows.map(row => `| ${row} |`).join("\n");
  const own = request.sources.answer.value as any, peer = request.sources.B!.value as any;
  own.messages = [own.messages[0], { role: "tool", content: table(["000001 | Alpha"]) },
    { role: "assistant", content: table(["000001 | Alpha", "000002 | Beta"]) }];
  peer.messages = [peer.messages[0], { role: "tool", content: "Beta的股票代码为000002。" }, { role: "assistant", content: "已查询代码。" }];
  const answer = request.input.answer as any, material = (request.input.reference_materials as any).B;
  answer.final_message_index = 2; answer.final_answer = own.messages[2].content;
  answer.table_check_results = attributionTableChecks(own, INPUT_ID, 2);
  material.final_message_index = 2; material.final_answer = peer.messages[2].content;
  material.final_evidence = [{ ...ref("B", 2, "/content"), message_index: 2, quote: peer.messages[2].content }];
  material.input_file = "inputs/peer_B.json";
  delete material.identity;
  setFixtureNormDirectory(request);
  prepareFixtureEvidence(registry, binding);
  const row = answer.table_check_results[0].rows[0];
  const draft = { summary: "缺失来源行由同题独立返回核实。", findings: [], numeric_checks: [],
    criterion_assessments: [{ criterion_id: "r1", status: "met", evidence_status: "established", summary: "对应已核对。", evidence: [ref("answer", 2, "/content")] }],
    core_assessment: { meets_core: true, reason: "对应可用。", requirement_indices: [0] },
    table_resolutions: [{ table_index: 2, row_index: row.row_index,
      outcome: "supported", reason: "同题peer独立查询明确返回Beta代码。", evidence: [
        { evidence_id: row.answer.evidence.evidence_id }, ref("B", 1, "/content"),
      ] }] };
  const result = resolveJudgment(binding.request, draft, audit()) as AttributionResult;
  registry.validate(binding, result, audit());
  assert.deepEqual(attributionTableReview(request, result).concerns, []);
  assert.equal(result.table_resolutions![0]!.table_id, answer.table_check_results[0].answer_table_id);
  assert.equal(Object.hasOwn(result.table_resolutions![0]!, "table_index"), false);
  for (const table_index of [1, 3]) {
    const invalid = structuredClone(draft); invalid.table_resolutions[0]!.table_index = table_index;
    const before = structuredClone({ request, invalid });
    hasIssue(() => resolveJudgment(binding.request, invalid, audit()), "table_resolution_table_index", "/table_resolutions/0/table_index");
    assert.deepEqual({ request, invalid }, before);
  }
  assert.equal(result.table_resolutions![0]!.evidence[1]!.source_input_id, peerId);
  const forged = structuredClone(result);
  delete forged.table_resolutions![0]!.evidence[1]!.source;
  delete forged.table_resolutions![0]!.evidence[1]!.source_input_id;
  hasIssue(() => registry.validate(binding, forged, audit()), "table_resolution_unsupported");
  own.messages[1].content = table(["000001 | Alpha", "000003 | Beta"]);
  answer.table_check_results = attributionTableChecks(own, INPUT_ID, 2);
  const conflicting = resolveJudgment(binding.request, draft, audit());
  hasIssue(() => registry.validate(binding, conflicting, audit()), "table_resolution_unsupported");
  draft.table_resolutions[0]!.evidence.push({ evidence_id: answer.table_check_results[0].rows[0].sources[0].evidence.evidence_id });
  registry.validate(binding, resolveJudgment(binding.request, draft, audit()), audit());
});

test("an input UUID from another task is rejected before raw-coordinate resolution without altering the draft", () => {
  const { binding, draft } = fixture();
  draft.findings[0]!.evidence[1]!.evidence_id = draft.findings[0]!.evidence[1]!.evidence_id
    .replace(peerId, "33333333-3333-4333-8333-333333333333");
  const before = structuredClone(draft);
  hasIssue(() => resolveJudgment(binding.request, draft, audit()), "evidence_source_invalid", "/findings/0/evidence/1");
  assert.deepEqual(draft, before);
});


test("malformed review feedback requires this candidate's final image even after a registered peer was viewed", () => {
  const { request, binding, draft } = fixture();
  for (const source of ["answer", "B"]) {
    const raw = request.sources[source]!.value as { messages: Record<string, unknown>[] };
    raw.messages[1]!.attachments = [{ type: "image", mimeType: "image/png", data: "AA==" }];
  }
  prepareFixtureEvidence(registry, binding);
  const malformed = { ...draft, summary: 7 };
  const before = structuredClone({ request, draft, malformed });
  const issues = (reads: ToolAudit) => {
    try { resolveJudgment(binding.request, malformed, reads); assert.fail("malformed summary must fail"); }
    catch (error) { assert(error instanceof ValidationError); return error.issues!; }
  };
  const peerViewed = { ...audit(), viewedImages: ["B:1"] };
  assert.deepEqual(issues(peerViewed).map(issue => issue.code), ["schema_type", "final_image_not_viewed"]);
  const ownViewed = { ...audit(), viewedImages: ["answer:1"] };
  assert.deepEqual(issues(ownViewed).map(issue => issue.code), ["schema_type"]);
  const result = resolveJudgment(binding.request, draft, ownViewed) as AttributionResult;
  hasIssue(() => registry.validate(binding, result, peerViewed), "final_image_not_viewed");
  registry.validate(binding, result, ownViewed);
  assert.deepEqual({ request, draft, malformed }, before);
});
