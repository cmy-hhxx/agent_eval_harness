import test from "node:test";
import assert from "node:assert/strict";
import { canonical, emptyUsage, evidenceId, type JsonObject, type PlannedTask, type SubmissionReceipt } from "@eval/contracts";
import { resolveEvidence } from "@eval/tools";
import { presentedMaterialReads, projectComparisonEvidence } from "./evidence-presentation.js";
import { comparisonWorkflow } from "../comparison/workflow.js";
import { criteriaResult, emptyAudit } from "../../../../tests/fixtures/comparison.js";
import type { Candidate, RawInput } from "../inputs/types.js";
import type { TaskData } from "../comparison/types.js";
import { AgentRegistry } from "@eval/host";
import { attributionAgent } from "@eval/agents/attribution";

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
  assert.deepEqual(answer.initial_material, []);
  assert.deepEqual(answer.instruction_sources, []);
  assert.deepEqual((binding.request.input.answer as typeof answer).instruction_sources, []);
  assert.deepEqual((binding.request.sources.answer!.value as typeof source).messages[1], original.messages[1]);
  assert(!JSON.stringify(binding.request.sources.answer!.value).includes('"system"'));
  assert.deepEqual(source, original);
  assert.equal(bank.includes(businessCoordinate), false, "original JSON coordinates are not program-owned references");
  assert(Number.isSafeInteger(answer.final_evidence[0]!.reference.evidence_index));
  assert(answer.norm_directory.length > 0);
  assert(answer.norm_directory.every(norm => norm.evidence.every(origin => Number.isSafeInteger(origin.reference.evidence_index))));
  assert(bank.length > 0);
});

function bindMaterial(source: RawInput, initialContextChars: number) {
  const candidate = { input_id: id, version: "fixture-version", name: "fixture-model", llm: null, question: "查询当月产量。",
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

test("bound citation previews use original content leaves and preserve usable read offsets", () => {
  const body = '标题: 月度统计\n溯源地址: https://example.test/report\n发布时间: 2024-03-04\n摘要: 上月变化-7%。' + "详情。".repeat(100);
  const source: RawInput = { messages: [{ role: "tool", content: [
    { text: "<referencable-result>\nID: 8\n", type: "input_text" },
    { text: body, type: "input_text" }, { text: "</referencable-result>", type: "input_text" },
  ] }, { role: "assistant", content: "变化率为7%[^8]。" }] };
  const binding = bindMaterial(source, 8000), bank: string[] = [];
  const projected = binding.projectModelInput!(binding.modelInput!, bank).answer as any;
  const shown = projected.citation_inventory.references[0].sources;
  assert.equal(shown.length, 1);
  assert.equal(shown[0].quote_preview, body.slice(0, 200));
  assert.equal(shown[0].read_request.path, "/content/1/text");
  assert.equal(shown[0].read_request.offset, 0);
  assert.equal(resolveEvidence(source, { evidence_id: bank[shown[0].reference.evidence_index - 1] },
    "answer", emptyAudit(), "/evidence", id).quote, body);
  assert(binding.presentedReads!.some(read => read.path === "/content/1/text" && read.start === 0 && read.end >= 200));
});

test("compact citation navigation does not repeat paragraphs already displayed in the answer", () => {
  const final = '产量变化需要核查。<trace ref="ABC1234"/><trace ref="DEF5678"/>';
  const source: RawInput = { messages: [
    { role: "tool", content: [{ serial_number: "ABC1234", title: "第一期", content: "产量28" },
      { serial_number: "DEF5678", title: "第二期", content: "产量31" }] },
    { role: "assistant", content: final },
  ] };
  const binding = bindMaterial(source, 8000), bank: string[] = [];
  const projected = binding.projectModelInput!(binding.modelInput!, bank).answer as any;
  assert.equal(projected.final_answer, final);
  for (const reference of projected.citation_inventory.references) for (const occurrence of reference.occurrences) {
    assert(!Object.hasOwn(occurrence.context, "quote"));
    assert(!Object.hasOwn(occurrence.context, "quote_preview"));
    assert(!Object.hasOwn(occurrence.context, "read_request"));
    assert.equal(occurrence.context.already_shown, true);
    assert(occurrence.context.reference.evidence_index > 0);
  }
  assert(projected.citation_inventory.references.every((item: any) => item.sources.length > 0));
});

test("Attribution presents each complete answer section beside its sources and keeps rule sections independently addressable", () => {
  const rule = "# 原则\n普通原则。\n## 署名范围\n报告作者可以列出；转载平台不得署名。\n## 文件交付\n仅在请求下载时交付文件。";
  const body = "标题: 上期产量\n发布时间: 2024-03-04\n摘要: 2024年2月产量变动为-7%。";
  const final = "## 数据解释\n\n本期产量增长7%，因此需求改善[^8]。\n\n## 交付\n\n来源：转载平台。";
  const source: RawInput = { messages: [{ role: "system", content: rule }, { role: "tool", content:
    `<referencable-result>\nID: 8\n${body}\n</referencable-result>` }, { role: "assistant", content: final }] };
  const binding = bindMaterial(source, 8000), before = structuredClone(binding.request);
  const prepared = new AgentRegistry([attributionAgent]).prepare(binding);
  const prompt = prepared.prompt;
  const focus = JSON.parse(prompt.slice(prompt.indexOf('{'), prompt.indexOf('\n\n任务材料')));
  const review = focus.answers.answer.review;
  const section = review.find((row: any) => row.kind === "answer" && row.quote.includes("需求改善"));
  assert(section, "the literal conclusion is an addressable investigation item");
  assert.equal(section.quote, "## 数据解释\n\n本期产量增长7%，因此需求改善[^8]。");
  assert(review[review.indexOf(section) + 1].quote.includes("变动为-7%"), "original source and inference are adjacent");
  assert.equal(prompt.split("本期产量增长7%").length - 1, 1, "the full answer is not repeated elsewhere");
  assert(!focus.rule_sections.some((row: any) => row.title === "## 署名范围"),
    "a nested rule remains a distinct investigation scope even when a broader block is in the basis directory");
  const sourceRow = review[review.indexOf(section) + 1];
  assert.equal(resolveEvidence(source, { evidence_id: prepared.evidenceBank![section.reference.evidence_index - 1] },
    "answer", emptyAudit(), "/evidence", id).quote, section.quote);
  assert(sourceRow.reference.evidence_index > 0);
  assert.deepEqual(binding.request, before, "presentation cannot alter rule bindings, evidence or final judgments");
  assert(!Object.hasOwn(prepared.evaluation.outputSchema.properties!, "review"), "review is navigation, not a new submission gate");
});

test("long instructions do not consume the source-material budget or hide a short tool return", () => {
  const norm = "完整保留规范与条件。".repeat(3000), fact = "当月产量为25，全年累计为300。";
  const source: RawInput = { messages: [{ role: "system", content: norm }, { role: "tool", content: fact },
    { role: "assistant", content: "当月产量为25。" }] };
  const binding = bindMaterial(source, 1000);
  const answer = binding.request.input.answer as { initial_material: InitialMaterial; instruction_sources: { content: unknown }[] };
  assert(answer.initial_material.some(item => canonical(item.value).includes(fact)), "the real return must be visible despite the long norm");
  assert.deepEqual(answer.instruction_sources, []);
  assert(!JSON.stringify(binding.request.sources.answer!.value).includes(norm));
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
