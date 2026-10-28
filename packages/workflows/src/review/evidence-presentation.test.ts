import test from "node:test";
import assert from "node:assert/strict";
import { emptyUsage, evidenceId, type JsonObject, type PlannedTask, type SubmissionReceipt } from "@eval/contracts";
import { resolveEvidence } from "@eval/tools";
import { presentedMaterialReads, projectComparisonEvidence } from "./evidence-presentation.js";
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

test("Workflow binding preserves coordinate-shaped business fields in actual original source material", () => {
  const businessCoordinate = evidenceId(id, 99, "text", "/content", 0, 3);
  const business = { text: "真实规范。", evidence_id: "business-id", source_input_id: "business-source", nested: { evidence_id: businessCoordinate } };
  const candidate: Candidate = { batch_id: "batch", case_id: "case", input_id: id, version: "fixture-version", name: "fixture-model",
    llm: null, trace_id: null, source: "fixture", line: 1, question: "原问。", final_index: 2, reference: business,
    answer_timing: { first_token_seconds: null, first_answer_seconds: null, finish_seconds: null,
      source_unit: "seconds", source_values: {}, source_fields: {} } };
  const criteria: PlannedTask = { id: "criteria", stage: "criteria", inputIds: { A: id }, dependencies: {},
    data: { stage: "criteria", candidates: { A: candidate }, reference: business } satisfies TaskData };
  const task: PlannedTask = { id: "attribution", stage: "attribution-component", inputIds: { answer: id }, dependencies: { criteria: criteria.id },
    data: { stage: "attribution-component", candidate, candidates: { A: candidate }, component: "终稿生成轮", traceIndex: 0, reference: business } };
  const source = { messages: [{ role: "system", content: business }, { role: "user", content: business }, { role: "assistant", content: "回答。" }] };
  const receipt: SubmissionReceipt = { taskId: criteria.id, status: "succeeded", attemptId: "prior", submissionId: "accepted", acceptedAt: 1,
    evaluatorVersion: "fixture", judge: "fixture", evaluation: criteriaResult(), audit: emptyAudit(), usage: emptyUsage() };
  const original = structuredClone(source), bank: string[] = [];
  const binding = comparisonWorkflow.bind(task, { [id]: source }, { criteria: receipt }, { tasks: [criteria, task] });
  const input = binding.projectModelInput!(binding.modelInput!, bank);
  const answer = input.answer as { initial_material: { value: { role: string; content: unknown } }[];
    instruction_sources: { content: unknown }[]; final_evidence: { reference: { evidence_index: number } }[];
    norm_directory: { evidence: { reference: { evidence_index: number } }[] }[] };
  assert.deepEqual((input.ground_truth as { value: unknown }).value, business);
  assert(!Object.hasOwn(answer,"initial_material"));
  assert(!Object.hasOwn(answer,"instruction_sources"));
  assert.equal(binding.request.input.component, "终稿生成轮");
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
  return bindAttributionMaterial(candidate, source, criteriaResult());
}

test("a cited original source is directly readable and only its displayed prefix counts as read", () => {
  const body = "标题: 月度统计\n摘要: 上月变化-7%。" + "详情。".repeat(100);
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
  assert(!binding.presentedReads!.some(read => read.message_index === 0 && read.end === body.length));
  assert(prepared.evidenceBank.length > 0);
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
  const body = "确定的原文。".repeat(1000), binding = bindMaterial({ messages: [{ type: "final_answer", content: body }] });
  const answer = binding.modelInput!.answer as any;
  assert.equal(answer.final_evidence.map((entry: any) => entry.quote).join(""), body.slice(0, 1600));
  assert.deepEqual(answer.final_context.continuations, [{ end_offset: body.length,
    read_request: { candidate: "answer", message_index: 0, path: "/content", offset: 1600, max_chars: body.length - 1600 } }]);
  assert(!Object.hasOwn(binding.request.input, "answer"));
});
