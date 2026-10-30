import { compactReceipt } from "../../../../tests/fixtures/compact.js";
import test from "node:test";
import assert from "node:assert/strict";
import { emptyUsage, evidenceId, type JsonObject, type PlannedTask, type SubmissionReceipt } from "@eval/contracts";
import { resolveEvidence } from "@eval/tools";
import { presentedMaterialReads, projectComparisonEvidence, compactNavigation, compactSourceEvidence, compactPresentedReads, verifiedCompact } from "./evidence-presentation.js";
import { comparisonWorkflow } from "../comparison/workflow.js";
import { criteriaResult, emptyAudit } from "../../../../tests/fixtures/comparison.js";
import type { Candidate, RawInput } from "../inputs/types.js";
import type { TaskData } from "../comparison/types.js";
import { AgentRegistry } from "@eval/host";
import { attributionAgent } from "@eval/agents/attribution";
import { bindAttributionMaterial } from "./attribution.js";

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

test("compact shows one original span once, preserving its references and keeping equal text at other origins separate", () => {
  const same = { quote: "原文。", reference }, different = { quote: same.quote,
    reference: { evidence_id: evidenceId(id, 1, "text", "/content", 0, 3) } };
  const business = { quote: same.quote, reference };
  const input = { compact: { turns: [{ plan: { source_evidence: [same] }, key_data: { value: { source_evidence: [same] } } }] },
    answer: { process_evidence: [same, different], initial_material: [{ value: business, evidence: [] }] } };
  const before = structuredClone(input), bank: string[] = [], view = projectComparisonEvidence(input, bank) as typeof input;
  const turn = view.compact.turns[0]!;
  assert.equal(turn.plan.source_evidence[0]!.quote, same.quote);
  assert.equal(turn.key_data.value.source_evidence[0]!.quote, undefined);
  assert.equal(view.answer.process_evidence[0]!.quote, undefined);
  assert.equal(view.answer.process_evidence[1]!.quote, same.quote, "equal text at another message retains its own original quote");
  assert.deepEqual(bank, [reference.evidence_id, different.reference.evidence_id]);
  assert.deepEqual(view.answer.initial_material[0]!.value, business);
  assert.deepEqual(input, before, "display reuse must not modify the formal compact or original source");
});

test("source-shaped business metadata remains data when compact references are projected and checked", () => {
  const meta = { session_meta: { source_evidence: [{ reference: { evidence_id: "business-id" }, quote: "业务字段" }] } };
  const compact = { meta, session_overview: {}, turns: [{ turn_index: 0 }] }, bank: string[] = [];
  assert.deepEqual(verifiedCompact(compact, { messages: [] }, { messages: [] }, id), compact);
  assert.deepEqual(compactSourceEvidence(compact), []);
  assert.deepEqual((projectComparisonEvidence({ compact }, bank).compact as typeof compact).meta, meta);
  assert.deepEqual(bank, []);
});

test("compact navigation preserves source values and creates a precise read entry without repeating private coordinates", () => {
  const entry = { quote: "原文。", reference, message_index: 0,
    location: { trace_index: 0, message_index: 0, source_message_index: 0, path: "/content", start: 0, end: 3 } };
  const value = { meta: {}, session_overview: {}, turns: [{ turn_index: 0, key_data: {
    source_values: [{ value: 12.34, location: { trace_index: 0, message_index: 0, source_message_index: 0,
      path: "/output", field_path: "/metric" }, source_evidence: [entry] }],
    summary_origin: { agent: "compact", field: "key_data" }, repeated: { source_evidence: [entry] },
  } }] };
  const before = structuredClone(value), bank: string[] = [];
  const projected = projectComparisonEvidence({ compact: value }, bank).compact as any;
  const key = projected.turns[0].key_data, proof = key.source_values[0].source_evidence[0];
  assert.equal(key.source_values[0].value, 12.34);
  assert.deepEqual(key.source_values[0].location, { path: "/output", field_path: "/metric" });
  assert.deepEqual(proof.read_request, { candidate: "answer", message_index: 0, path: "/content", offset: 0, max_chars: 1600 });
  assert.equal(proof.location, undefined);
  assert.equal(key.summary_origin, undefined);
  assert.deepEqual(key.repeated.source_evidence, [{ reference: { evidence_index: 1 }, already_shown: true }]);
  assert.deepEqual(value, before); assert.deepEqual(bank, [reference.evidence_id]);
});

test("attribution navigation retains environment facts and only omits a final summary after original delivery is complete", () => {
  const value = { meta: { case_id: "case", source_input_id: id, session_meta: { network_available: false }, environment: { shell: true } },
    session_overview: {}, turns: [{ turn_index: 0, final_answer: { conclusion: "有条件结论。" }, stop_reason: { reason: "网络不可用。" } }] };
  const original = structuredClone(value), partial = compactNavigation(value, false), complete = compactNavigation(value, true);
  assert.deepEqual(partial.meta, { session_meta: { network_available: false }, environment: { shell: true } });
  assert.deepEqual((partial.turns as JsonObject[])[0]!.final_answer, value.turns[0]!.final_answer);
  assert.equal((complete.turns as JsonObject[])[0]!.final_answer, undefined);
  assert.deepEqual((complete.turns as JsonObject[])[0]!.stop_reason, value.turns[0]!.stop_reason);
  assert.deepEqual(value, original);
});

test("navigation omits repeated code proofs while preserving semantic evidence and source values", () => {
  const bookkeeping = { quote: "工具。", reference: { evidence_id: evidenceId(id, 1, "text", "/name", 0, 3) } };
  const semantic = { quote: "原文。", reference };
  const value = { meta: {}, session_overview: {}, components: [{ kind: "tool", name: "shell" }], turns: [{ turn_index: 0,
    components: [{ kind: "script", name: "render.py" }],
    execution_facts: { tool_calls: [{ name: "shell", count: 1, message_indices: [1], source_evidence: [bookkeeping] }],
      model_outputs: [{ message_index: 3, output_form: "nonempty_text", source_evidence: [bookkeeping] }],
      execution_links: [{ request_message_index: 1, return_message_indices: [2], model_inputs: [
        { message_index: 3, path: "/input_messages/0/content", additional_input_locations: [{ message_index: 4, path: "/input_messages/0/content" }] },
        { message_index: 5, path: "/input_messages/0/content" },
      ] }] },
    execution_chain: [{ observation: "摘要。", source_evidence: [semantic] }],
    key_data: { source_values: [{ value: "001.50", source_evidence: [semantic] }] },
  }] };
  const before = structuredClone(value), view = compactNavigation(value, true) as any;
  assert.equal(view.components, undefined);
  assert.equal(view.turns[0].components, undefined, "actor catalog is supplied once beside compact navigation");
  assert.equal(view.turns[0].execution_facts.tool_calls[0].source_evidence, undefined);
  assert.equal(view.turns[0].execution_facts.model_outputs[0].source_evidence, undefined);
  assert.deepEqual(view.turns[0].execution_facts.execution_links[0].model_inputs, [
    { message_index: 3, path: "/input_messages/0/content" }, { message_index: 5, path: "/input_messages/0/content" },
  ]);
  assert.deepEqual(view.turns[0].execution_chain, before.turns[0]!.execution_chain);
  assert.equal(view.turns[0].key_data.source_values[0].value, "001.50");
  assert.deepEqual(compactPresentedReads(view, "answer", id).map(read => read.message_index), [0, 0]);
  assert.deepEqual(presentedMaterialReads({ actor_catalog: [{ actor_index: 1, kind: "tool", name: "shell", source_evidence: [bookkeeping] }] },
    "answer", id).map(read => read.message_index), [1], "identity proofs count as read only when actually displayed");
  assert.deepEqual(value, before, "formal compact keeps every proof and original input location");
});

test("repeated compact references resolve each original once and still reject every altered quote", () => {
  let sourceReads = 0;
  const message = { get content() { sourceReads++; return "原文。"; } };
  const raw = { messages: [message] }, proof = { reference, quote: "原文。" };
  const value = { observations: Array.from({ length: 100 }, () => ({ source_evidence: [proof] })) };
  assert.deepEqual(verifiedCompact(value, raw, raw, id), value);
  assert(sourceReads < 10, "repeated links must not rescan the same source hundreds of times");
  assert.throws(() => verifiedCompact({ observations: [value.observations[0], { source_evidence: [{ ...proof, quote: "改写。" }] }] }, raw, raw, id));
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
  const task: PlannedTask = { id: "attribution", stage: "attribution-trace", inputIds: { answer: id }, dependencies: { criteria: criteria.id },
    data: { stage: "attribution-trace", candidate, candidates: { A: candidate }, traceIndex: 0, reference: business } };
  const source = { messages: [{ role: "system", content: business }, { role: "user", content: business }, { role: "assistant", content: "回答。" }] };
  const receipt: SubmissionReceipt = { taskId: criteria.id, status: "succeeded", attemptId: "prior", submissionId: "accepted", acceptedAt: 1,
    evaluatorVersion: "fixture", judge: "fixture", evaluation: criteriaResult(), audit: emptyAudit(), usage: emptyUsage() };
  const original = structuredClone(source), bank: string[] = [];
  const binding = comparisonWorkflow.bind(task, { [id]: source }, { compact: compactReceipt(), criteria: receipt }, { tasks: [criteria, task] });
  const input = binding.projectModelInput!(binding.modelInput!, bank);
  const answer = input.answer as { initial_material: { value: { role: string; content: unknown } }[];
    instruction_sources: { content: unknown }[]; final_evidence: { reference: { evidence_index: number } }[];
    norm_directory: { evidence: { reference: { evidence_index: number } }[] }[] };
  assert.deepEqual((input.ground_truth as { value: unknown }).value, business);
  assert(!Object.hasOwn(answer,"initial_material"));
  assert(!Object.hasOwn(answer,"instruction_sources"));
  assert(!Object.hasOwn(binding.request.input, "component"));
  assert.equal(binding.request.input.trace_index, 0);
  assert.deepEqual((binding.request.sources.answer!.value as typeof source).messages[1], original.messages[1]);
  assert(!JSON.stringify(binding.request.sources.answer!.value).includes('"system"'));
  assert.deepEqual(source, original);
  assert.equal(bank.includes(businessCoordinate), false, "original JSON coordinates are not program-owned references");
  assert(Number.isSafeInteger(answer.final_evidence[0]!.reference.evidence_index));
  assert(answer.norm_directory.length > 0);
  assert(answer.norm_directory.every(norm => norm.evidence.every(origin => Number.isSafeInteger(origin.reference.evidence_index))));
  assert(bank.length > 0);
});

function bindMaterial(source: RawInput) {
  const candidate = { input_id: id, version: "fixture-version", name: "fixture-model", llm: null, question: "查询当月产量。",
    final_index: source.messages.length - 1, reference: null, answer_timing: { finish_seconds: 1 } } as Candidate;
  return bindAttributionMaterial(candidate, source, criteriaResult(), { compact: compactReceipt().evaluation as never });
}

test("a cited original source is directly readable and only its displayed prefix counts as read", () => {
  const body = "标题: 月度统计\n摘要: 上月变化-7%。" + "详情。".repeat(10000);
  const source: RawInput = { messages: [{ role: "tool", content: [
    { text: "<referencable-result>\nID: 8\n", type: "input_text" },
    { text: body, type: "input_text" }, { text: "</referencable-result>", type: "input_text" },
  ] }, { role: "assistant", content: "变化率为7%[^8]。" }] };
  const binding = bindMaterial(source), prepared = new AgentRegistry([attributionAgent]).prepare(binding);
  const answer = binding.modelInput!.answer as any, entry = answer.citation_inventory.references[0].sources[0];
  assert.equal(entry.read_request.path, "/content/1/text");
  assert.equal(entry.read_request.offset, 0);
  assert.equal(resolveEvidence(source, { evidence_id: entry.reference.evidence_id }, "answer", emptyAudit(), "/evidence", id).quote, body);
  assert.equal(entry.quote_preview, body.slice(0, 200));
  assert(binding.presentedReads!.some(read => read.message_index === 0 && read.start === 0 && read.end === 200));
  assert(!binding.presentedReads!.some(read => read.message_index === 0 && read.start === 0 && read.end === body.length));
  assert(prepared.evidenceBank.length > 0);
});

test("Attribution citation previews select the displayed original range rather than an unseen long source", () => {
  const body = "标题: 月度统计\n摘要: 上月变化-7%。" + "详情。".repeat(1000);
  const source: RawInput = { messages: [{ role: "tool", content: [
    { text: "<referencable-result>\nID: 8\n", type: "input_text" },
    { text: body, type: "input_text" }, { text: "</referencable-result>", type: "input_text" },
  ] }, { role: "assistant", content: "变化率为7%[^8]。" }] };
  const binding = bindMaterial(source), before = structuredClone(binding.modelInput), bank: string[] = [];
  const shown = binding.projectModelInput!(binding.modelInput!, bank) as any;
  const entry = shown.answer.citation_inventory.references[0].sources.find((entry: any) => entry.quote_preview);
  assert(entry?.reference?.evidence_index, "the displayed preview must be directly selectable");
  assert.equal(resolveEvidence(source, { evidence_id: bank[entry.reference.evidence_index - 1]! }, "answer", emptyAudit(), "/evidence", id).quote, entry.quote_preview);
  for (const evidence_id of bank)
    assert(resolveEvidence(source, { evidence_id }, "answer", emptyAudit(), "/evidence", id).quote.length <= 400);
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

test("an atomic review retains coordinates without constructing or transferring a global responsibility graph", () => {
  const source: RawInput = { messages: [
    ...Array.from({ length: 100 }, (_, index) => ({ type: "llm_turn", name: "llm-call-" + index,
      input_messages: [{ role: "user", content: "source-" + index }], output: [{ role: "assistant", content: "answer-" + index }] })),
    { type: "final_answer", content: "最终回答。" },
  ] };
  const binding = bindMaterial(source);
  for (const value of [binding.request.input, binding.materialNavigation!.answer, binding.modelInput!.answer])
    for (const key of ["business_chains", "execution_nodes", "transitions", "boundaries", "execution_graph"])
      assert(!Object.hasOwn(value as object, key), key);
  assert(JSON.stringify(binding.materialNavigation).length < 300);
  const prepared = new AgentRegistry([attributionAgent]).prepare(binding);
  assert(!prepared.evaluation.toolNames.includes("read_responsibility_chain"));
  assert(!prepared.evaluation.toolNames.includes("read_execution"));
  assert(prepared.evaluation.toolNames.includes("read_trace"));
});

test("long final sources retain complete ownership and precise continuation without duplicating their body", () => {
  const body = "确定的原文。".repeat(2000), binding = bindMaterial({ messages: [{ type: "final_answer", content: body }] });
  const answer = binding.modelInput!.answer as any;
  assert.equal(answer.final_evidence.map((entry: any) => entry.quote).join(""), body.slice(0, 6400));
  assert.deepEqual(answer.final_context.continuations, [{ end_offset: body.length,
    read_request: { candidate: "answer", message_index: 0, path: "/content", offset: 6400, max_chars: body.length - 6400 } }]);
  assert.equal(binding.request.input.answer, body);
});
