import test from "node:test";
import assert from "node:assert/strict";
import { canonical, emptyUsage, evidenceId, type JsonObject, type PlannedTask, type SubmissionReceipt } from "@eval/contracts";
import { resolveEvidence } from "@eval/tools";
import { projectComparisonEvidence } from "./evidence-presentation.js";
import { comparisonWorkflow } from "./workflow.js";
import { criteriaResult, emptyAudit } from "../../../../tests/fixtures/comparison.js";
import type { Candidate, RawInput, TaskData } from "./types.js";
const id = "11111111-1111-4111-8111-111111111111", reference = { evidence_id: evidenceId(id, 0, "text", "/content", 0, 3) };
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
  const task: PlannedTask = { id: "attribution", stage: "attribution", inputIds: { answer: id }, dependencies: { criteria: criteria.id },
    data: { stage: "attribution", candidates: { A: candidate }, reference: business } satisfies TaskData };
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
  assert.deepEqual(answer.initial_material.find(item => item.value.role === "user")!.value.content, business);
  assert.deepEqual(answer.instruction_sources[0]!.content, business);
  assert.deepEqual((binding.request.sources.answer!.value as typeof source), original);
  assert.deepEqual(source, original);
  assert.equal(bank.includes(businessCoordinate), false, "original JSON coordinates are not program-owned references");
  assert(Number.isSafeInteger(answer.final_evidence[0]!.reference.evidence_index));
  assert(answer.norm_directory.length > 0);
  assert(answer.norm_directory.every(norm => norm.evidence.every(origin => Number.isSafeInteger(origin.reference.evidence_index))));
  assert(bank.length > 0);
});

function bindMaterial(source: RawInput, initialContextChars: number) {
  const candidate = { input_id: id, version: "fixture-version", name: "fixture-model", question: "查询当月产量。",
    final_index: source.messages.length - 1, answer_timing: { finish_seconds: 1 } } as Candidate;
  const criteria: PlannedTask = { id: "criteria", stage: "criteria", inputIds: { A: id }, dependencies: {},
    data: { stage: "criteria", candidates: { A: candidate }, reference: null } satisfies TaskData };
  const task: PlannedTask = { id: "attribution", stage: "attribution", inputIds: { answer: id }, dependencies: { criteria: criteria.id },
    data: { stage: "attribution", candidates: { A: candidate }, reference: null, initialContextChars } satisfies TaskData };
  const receipt: SubmissionReceipt = { taskId: criteria.id, status: "succeeded", attemptId: "prior", submissionId: "accepted", acceptedAt: 1,
    evaluatorVersion: "fixture", judge: "fixture", evaluation: criteriaResult(), audit: emptyAudit(), usage: emptyUsage() };
  return comparisonWorkflow.bind(task, { [id]: source }, { criteria: receipt }, { tasks: [criteria, task] });
}

type InitialMaterial = { message_index: number; value: unknown; evidence: { evidence_id: string; quote: string; message_index: number }[] }[];

test("long instructions do not consume the source-material budget or hide a short tool return", () => {
  const norm = "完整保留规范与条件。".repeat(3000), fact = "当月产量为25，全年累计为300。";
  const source: RawInput = { messages: [{ role: "system", content: norm }, { role: "tool", content: fact },
    { role: "assistant", content: "当月产量为25。" }] };
  const binding = bindMaterial(source, 1000);
  const answer = binding.request.input.answer as { initial_material: InitialMaterial; instruction_sources: { content: unknown }[] };
  assert(answer.initial_material.some(item => canonical(item.value).includes(fact)), "the real return must be visible despite the long norm");
  assert.equal(answer.instruction_sources[0]!.content, norm);
  assert.deepEqual(binding.request.sources.answer!.value, source);
});

test("cited tool returns precede recent unrelated material within the same source budget", () => {
  const result = { serial_number: "ABC1234", title: "产量", content: "当月产量25，全年累计300。" };
  const source: RawInput = { messages: [{ role: "user", content: "查询当月产量。" },
    { role: "tool", content: result }, { role: "tool", content: "无关数据。".repeat(80) },
    { role: "assistant", content: '产量25。<trace ref="ABC1234"/>' }] };
  const binding = bindMaterial(source, 1000);
  const initial = (binding.request.input.answer as { initial_material: InitialMaterial }).initial_material;
  assert(initial.some(item => item.message_index === 1), "a later unrelated result cannot crowd out the cited result");
  assert(initial.reduce((n, item) => n + canonical(item.value).length + item.evidence.reduce((sum, e) => sum + e.quote.length, 0), 0) <= 1000);
});

test("uncited tool returns precede newer planning records within the source budget", () => {
  const fact = "成交量[20260930 14:30-20260930 15:00]：11228580股。";
  for (const returned of [
    { type: "tool_result", output: fact },
    { type: "function_call_output", output: fact },
    { role: "tool", content: fact },
  ]) {
    const source: RawInput = { messages: [{ role: "user", content: "查询尾盘成交量。" }, returned,
      { type: "llm_turn", output: "准备汇总成交量。".repeat(10) },
      { type: "tool_call", input: { command: "补充查询。".repeat(10) } },
      { role: "assistant", content: "尾盘成交量1122.86万股。" }] };
    const before = structuredClone(source), binding = bindMaterial(source, 500);
    const initial = (binding.request.input.answer as { initial_material: InitialMaterial }).initial_material;
    assert(initial.some(item => item.message_index === 1 && canonical(item.value).includes(fact)));
    assert.deepEqual(source, before);
  }
});

test("a cited source inside an oversized return is shown intact with original evidence coordinates", () => {
  const result = { serial_number: "ABC1234", title: "产量", content: "当月产量25，全年累计300。" };
  const source: RawInput = { messages: [{ role: "tool", content: [result, { unrelated: "其他原始内容。".repeat(4000) }] },
    { role: "assistant", content: '产量25。<trace ref="ABC1234"/>' }] };
  const before = structuredClone(source), binding = bindMaterial(source, 1000);
  const initial = (binding.request.input.answer as { initial_material: InitialMaterial }).initial_material;
  const selected = initial.find(item => typeof item.value === "string" && item.value.includes(result.content));
  assert(selected, "the complete cited block fits even when its enclosing message does not");
  assert.equal(selected.value, selected.evidence[0]!.quote);
  assert.equal(resolveEvidence(source, { evidence_id: selected.evidence[0]!.evidence_id }, "answer", emptyAudit(), "/evidence", id).quote, selected.value);
  const bank: string[] = [];
  binding.projectModelInput!(binding.modelInput!, bank);
  assert(bank.includes(selected.evidence[0]!.evidence_id));
  assert.deepEqual(source, before);
});
