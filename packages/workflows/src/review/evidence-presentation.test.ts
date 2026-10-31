import { bindComponentFixture } from "../../../../tests/fixtures/compact.js";
import test from "node:test";
import assert from "node:assert/strict";
import { emptyUsage, evidenceId, type JsonObject, type PlannedTask, type SubmissionReceipt } from "@eval/contracts";
import { resolveEvidence } from "@eval/tools";
import { presentedMaterialReads, projectComparisonEvidence, compactNavigation, compactSourceEvidence, compactPresentedReads, verifiedCompact } from "./evidence-presentation.js";
import { criteriaResult, emptyAudit } from "../../../../tests/fixtures/comparison.js";
import type { Candidate, RawInput } from "../inputs/types.js";
import type { TaskData } from "../comparison/types.js";
import { AgentRegistry } from "@eval/host";
import { attributionAgent } from "@eval/agents/attribution";
import { attributionSessionSource } from "./public-trace.js";

const id = "11111111-1111-4111-8111-111111111111", reference = { evidence_id: evidenceId(id, 0, "text", "/content", 0, 3) };
test("presented ranges use actual preview length and exclude raw business fields", () => {
  const ref = { evidence_id: evidenceId(id, 2, "text", "/output", 40, 800) };
  const excerpt = { reference: ref, quote_preview: "短预览。" };
  const raw = { reference: ref, quote: "这是不能凭字段名当成已展示证据的原始数据。" };
  assert.deepEqual(presentedMaterialReads({ trace_overview: { entries: [{ highlights: [excerpt] }] },
    initial_material: [{ value: raw, evidence: [] }], instruction_sources: [{ content: raw, evidence: [] }],
    final_answer: JSON.stringify(raw) }, "answer", id), [
    { candidate: "answer", message_index: 2, kind: "text", path: "/output", start: 40, end: 44 },
  ]);
  assert.deepEqual(presentedMaterialReads({review_sections:[{reference:ref,quote:'正文。'}],
    business_chains:[{reference:ref,quote:'目录不是已展示原文'}]},'answer',id),[
    {candidate:'answer',message_index:2,kind:'text',path:'/output',start:40,end:43},
  ]);
});
test("owned material envelopes are selected while original JSON fields and raw source content stay byte-equivalent", () => {
  const original = { evidence_id: "业务来源证据编号", source_input_id: "原始业务字段", nested: { evidence_id: reference.evidence_id } };
  const input: JsonObject = { question: original, ground_truth: { available: true, value: original },
    answer: { final_evidence: [{ quote: "原文。", reference }], initial_material: [{ value: original, evidence: [{ reference }] }],
      instruction_sources: [{ content: original, evidence: [{ reference }] }],
      norm_directory: [{ norm_index: 0, roles: ["system"], requirement_index: null, evidence: [{ quote: "原文。", reference }] }] },
    reference_materials: { peer: { initial_material: [{ value: original, evidence: [{ reference }] }] } } };
  const before = structuredClone(input), bank: string[] = [], projected = projectComparisonEvidence(input, bank);
  const answer = projected.answer as { initial_material: { value: unknown; evidence: unknown[] }[]; instruction_sources: { content: unknown }[];
    final_evidence: { reference: unknown }[]; norm_directory: { norm_index: number; roles: string[]; requirement_index: null; evidence: { quote: string; reference: unknown }[] }[] };
  assert.deepEqual(projected.question, original); assert.deepEqual((projected.ground_truth as { value: unknown }).value, original);
  assert.deepEqual(answer.initial_material[0]!.value, original); assert.deepEqual(answer.instruction_sources[0]!.content, original);
  assert.deepEqual(answer.final_evidence[0]!.reference, { evidence_index: 1 });
  assert.deepEqual(answer.norm_directory, [{ norm_index: 0, roles: ["system"], requirement_index: null,
    evidence: [{ quote: "原文。", reference: { evidence_index: 1 } }] }]);
  assert.deepEqual(bank, [reference.evidence_id]); assert.deepEqual(input, before);
});

test("flat compact displays a repeated span once while preserving equal text at different origins", () => {
  const flat = { quote: "原文。", evidence_id: reference.evidence_id };
  const same = { quote: flat.quote, reference }, different = { quote: flat.quote,
    reference: { evidence_id: evidenceId(id, 1, "text", "/content", 0, 3) } };
  const input = { compact: { turns: [{ plans: [{ content: "规划。", evidence: [flat] }], key_data: [{ key_data_content: "数据。", evidence: [flat] }] }] },
    answer: { process_evidence: [same, different] } };
  const before = structuredClone(input), bank: string[] = [], view = projectComparisonEvidence(input, bank) as any;
  assert.equal(view.compact.turns[0].plans[0].evidence[0].quote, flat.quote);
  assert.equal(view.compact.turns[0].key_data[0].evidence[0].quote, undefined);
  assert.equal(view.answer.process_evidence[0].quote, undefined);
  assert.equal(view.answer.process_evidence[1].quote, flat.quote);
  assert.deepEqual(bank, [reference.evidence_id, different.reference.evidence_id]);
  assert.deepEqual(input, before);
});

test("source-shaped session and trace metadata are opaque business data", () => {
  const meta = { evidence: [{ evidence_id: "business-id", quote: "业务字段" }] };
  const compact = { session_meta: meta, trace_meta: [meta], session_overview: [], turns: [{ turn_idx: 0 }] }, bank: string[] = [];
  assert.deepEqual(verifiedCompact(compact, { messages: [] }, { messages: [] }, id), compact);
  assert.deepEqual(compactSourceEvidence(compact), []);
  assert.deepEqual(projectComparisonEvidence({ compact }, bank).compact, compact);
  assert.deepEqual(bank, []);
});

test("attribution navigation keeps semantic evidence and avoids repeating full final answers or actors", () => {
  const proof = { evidence_id: reference.evidence_id, quote: "原文。" };
  const value = { session_meta: { network_available: false }, trace_meta: [{}], session_overview: ["用户问题。", "调用工具。", "交付结果。"], turns: [{ turn_idx: 0,
    final_answer: "很长的完整最终回复。", components: [{ components_name: "render.py" }],
    execution_chain: [{ step_idx: 1, content: "摘要。", evidence: [proof] }],
    key_data: [{ key_data_idx: 1, key_data_content: "原值001.50。", evidence: [proof] }],
  }] };
  const before = structuredClone(value), view = compactNavigation(value) as any;
  assert.equal(view.turns[0].final_answer, undefined);
  assert.equal(view.turns[0].components, undefined);
  assert.deepEqual(view.turns[0].execution_chain, before.turns[0]!.execution_chain);
  assert.deepEqual(compactPresentedReads(view, "answer", id).map(read => read.message_index), [0, 0]);
  assert.deepEqual(value, before);
});

test("compact /type evidence verifies against an unmodified answer projection", () => {
  const source: RawInput = { messages: [{ role: "assistant", type: "message", content: "最终回答。" }] };
  const raw = attributionSessionSource(source).raw;
  const proof = { evidence_id: evidenceId(id, 0, "text", "/type", 0, 7), quote: "message" };
  const compact = { turns: [{ turn_idx: 0, execution_chain: [{ step_idx: 1, content: "执行摘要。", evidence: [proof] }] }] };
  assert.deepEqual(verifiedCompact(compact, raw, source, id), compact);
  assert.equal(raw.messages[0]!.type, "message");
});

test("repeated compact references resolve each original once and reject every altered quote", () => {
  let sourceReads = 0;
  const message = { get content() { sourceReads++; return "原文。"; } };
  const raw = { messages: [message] }, proof = { evidence_id: reference.evidence_id, quote: "原文。" };
  const value = { execution_chain: Array.from({ length: 100 }, () => ({ content: "摘要。", evidence: [proof] })) };
  assert.deepEqual(verifiedCompact(value, raw, raw, id), value);
  assert(sourceReads < 10);
  assert.throws(() => verifiedCompact({ execution_chain: [value.execution_chain[0], { evidence: [{ ...proof, quote: "改写。" }] }] }, raw, raw, id));
});

test("Workflow binding preserves coordinate-shaped business fields in actual original source material", () => {
  const businessCoordinate = evidenceId(id, 99, "text", "/content", 0, 3);
  const business = { text: "真实规范。", evidence_id: "business-id", source_input_id: "business-source", nested: { evidence_id: businessCoordinate } };
  const candidate: Candidate = { batch_id: "batch", case_id: "case", input_id: id, version: "fixture-version", name: "fixture-model",
    llm: null, trace_id: null, source: "fixture", line: 1, question: "原问。", final_index: 2, reference: business,
    answer_timing: { first_token_seconds: null, first_answer_seconds: null, finish_seconds: null,
      source_unit: "seconds", source_values: {}, source_fields: {} } };
  const criteria: PlannedTask = { id: "criteria", stage: "criteria", inputIds: { A: id }, dependencies: {},
    data: { stage: "criteria", candidates: { A: candidate }, reference: business } satisfies TaskData };
  const source = { messages: [{ role: "system", content: business }, { role: "user", content: business }, { role: "assistant", content: "回答。" }] };
  const receipt: SubmissionReceipt = { taskId: criteria.id, status: "succeeded", attemptId: "prior", submissionId: "accepted", acceptedAt: 1,
    evaluatorVersion: "fixture", judge: "fixture", evaluation: criteriaResult(), audit: emptyAudit(), usage: emptyUsage() };
  const original = structuredClone(source), bank: string[] = [];
  const binding = bindComponentFixture(candidate, source, { criteria: receipt });
  const input = binding.projectModelInput!(binding.modelInput!, bank);
  const answer = input as { initial_material: { value: { role: string; content: unknown } }[];
    instruction_sources: { content: unknown }[]; final_answer: { reference: { evidence_index: number } }[];
    applicable_rules: { evidence: { reference: { evidence_index: number } }[] }[] };
  assert.deepEqual((input.ground_truth as { value: unknown }).value, business);
  assert(!Object.hasOwn(answer,"initial_material"));
  assert(!Object.hasOwn(answer,"instruction_sources"));
  assert(!Object.hasOwn(binding.request.input, "component"));
  assert.equal(binding.request.input.trace_index, 0);
  assert.deepEqual((binding.request.sources.answer!.value as typeof source).messages[1], original.messages[1]);
  assert(!JSON.stringify(binding.request.sources.answer!.value).includes('"system"'));
  assert.deepEqual(source, original);
  assert.equal(bank.includes(businessCoordinate), false, "original JSON coordinates are not program-owned references");
  assert(Number.isSafeInteger(answer.final_answer[0]!.reference.evidence_index));
  assert(answer.applicable_rules.length > 0);
  assert(answer.applicable_rules.every(norm => norm.evidence.every(origin => Number.isSafeInteger(origin.reference.evidence_index))));
  assert(bank.length > 0);
});

function bindMaterial(source: RawInput) {
  const candidate = { input_id: id, version: "fixture-version", name: "fixture-model", llm: null, question: "查询当月产量。",
    final_index: source.messages.length - 1, reference: null, answer_timing: { finish_seconds: 1 } } as Candidate;
  return bindComponentFixture(candidate, source);
}

test("component citation excerpts retain full sentence blocks and original read entrypoints", () => {
  const body = "标题: 月度统计\n摘要: 上月变化-7%。" + "详情。".repeat(10000);
  const source: RawInput = { messages: [{ role: "tool", content: [
    { text: "<referencable-result>\nID: 8\n", type: "input_text" },
    { text: body, type: "input_text" }, { text: "</referencable-result>", type: "input_text" },
  ] }, { role: "assistant", content: "变化率为7%[^8]。" }] };
  const binding = bindMaterial(source), prepared = new AgentRegistry([attributionAgent]).prepare(binding);
  const citation = (binding.modelInput!.citation_sources as { references: { sources: { reference: { evidence_id: string }; quote: string; read_request: { path: string } }[] }[] }).references[0]!;
  assert(citation.sources.length > 0);
  for (const entry of citation.sources) {
    assert.equal(entry.read_request.path, "/content/1/text"); assert(entry.quote.length <= 400);
    assert.equal(resolveEvidence(source, entry.reference, "answer", emptyAudit(), "/evidence", id).quote, entry.quote);
  }
  assert(!binding.presentedReads!.some(read => read.message_index === 0 && read.start === 0 && read.end === body.length));
  assert(prepared.evidenceBank.length > 0);
  const before = structuredClone(binding.modelInput), bank: string[] = [];
  const shown = binding.projectModelInput!(binding.modelInput!, bank) as any;
  for (const entry of shown.citation_sources.references[0].sources) assert.equal(
    resolveEvidence(source, { evidence_id: bank[entry.reference.evidence_index - 1]! }, "answer", emptyAudit(), "/evidence", id).quote, entry.quote);
  assert.deepEqual(binding.modelInput, before);
});

test("long original sections expose contiguous bounded excerpts at their original offset", () => {
  const text = "前文。".repeat(20) + "连续原文。".repeat(220), start = 60;
  const ref = { evidence_id: evidenceId(id, 0, "text", "/content", start, text.length) };
  const input = { answer: { review_sections: [{ section_index: 1, quote: text.slice(start), reference: ref }] } };
  const bank: string[] = [], before = structuredClone(input);
  const section = (projectComparisonEvidence(input, bank, 400).answer as any).review_sections[0];
  assert.equal(section.reference, undefined);
  assert.equal(section.excerpts.map((entry: any) => entry.quote).join(""), text.slice(start));
  assert.equal(section.section_index, 1);
  for (const entry of section.excerpts) {
    const original = resolveEvidence({ messages: [{ content: text }] }, { evidence_id: bank[entry.reference.evidence_index - 1]! }, "answer", emptyAudit(), "/evidence", id);
    assert.equal(original.quote, entry.quote); assert(entry.quote.length <= 400);
  }
  assert.deepEqual(input, before);
});

test("component input retains original coordinates without transferring a global responsibility graph", () => {
  const source: RawInput = { messages: [
    ...Array.from({ length: 100 }, (_, index) => ({ type: "llm_turn", name: "llm-call-" + index,
      input_messages: [{ role: "user", content: "source-" + index }], output: [{ role: "assistant", content: "answer-" + index }] })),
    { type: "final_answer", content: "最终回答。" },
  ] };
  const binding = bindMaterial(source);
  for (const value of [binding.request.input, binding.modelInput!])
    for (const key of ["business_chains", "execution_nodes", "transitions", "boundaries", "execution_graph"])
      assert(!Object.hasOwn(value as object, key), key);
  const own = new Set((binding.request.input.components as { message_indices: number[] }[]).flatMap(member => member.message_indices));
  const directory = (binding.modelInput!.source_directory as { message_index: number }[]).map(entry => entry.message_index);
  assert.equal(new Set(directory).size, directory.length);
  assert(directory.every(index => own.has(index)), "the directory lists only the delivery members' own coordinates");
  const prepared = new AgentRegistry([attributionAgent]).prepare(binding);
  assert(prepared.evaluation.toolNames.includes("read_trace"));
  assert(!prepared.evaluation.toolNames.includes("read_responsibility_chain"));
});

test("long final content keeps whole original sentences and a continuation entrypoint", () => {
  const body = "确定的原文。".repeat(2000), binding = bindMaterial({ messages: [{ type: "final_answer", content: body }] });
  const excerpts = binding.modelInput!.final_answer as { quote: string }[];
  const visible = excerpts.map(entry => entry.quote).join("");
  assert(body.startsWith(visible)); assert(visible.length <= 8000); assert(excerpts.every(entry => entry.quote.endsWith("。")));
  assert.equal(binding.modelInput!.final_partial, true);
  assert.deepEqual(binding.modelInput!.final_answer_read_request, { candidate: "answer", message_index: 0, path: "/content", offset: 0, max_chars: 16000 });
  assert.equal((binding.request.sources.answer!.value as RawInput).messages[0]!.content, body);
});
