import { sourceCompactReceipt, componentTask } from "../../../../tests/fixtures/compact.js";
import { AgentRegistry } from "@eval/host";
import { attributionAgent } from "@eval/agents/attribution";
import { canonicalEvidence } from "../../../../tests/fixtures/evidence.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { emptyUsage, type AgentBinding, type CriteriaInput, type PlannedTask, type SubmissionReceipt, type TaskAnalysis } from "@eval/contracts";
import { criteriaProfile, criteriaSources } from "@eval/agents/criteria";
import { type AttributionNorm } from "@eval/agents/attribution";
import { parseEvidenceCoordinates, resolveEvidence } from "@eval/tools";
import { criterionInstructionSources } from "./instruction-bindings.js";
import { bindTask } from "../comparison/binding.js";
import { normalizeInput, type Candidate, type RawInput } from "@eval/workflows/inputs";
import type { TaskData } from "../comparison/types.js";
import { emptyAudit } from "../../../../tests/fixtures/comparison.js";

const registry = new AgentRegistry([attributionAgent]);
function shownNorms(binding: AgentBinding, raw: RawInput, inputId: string): AttributionNorm[] {
  const answer = binding.modelInput! as { applicable_rules: (Omit<AttributionNorm, "evidence"> & {
    evidence: { reference: { evidence_id: string } }[] })[] };
  return answer.applicable_rules.map(norm => ({ ...norm, evidence: norm.evidence.map(entry => {
    const resolved = resolveEvidence(raw, entry.reference, "answer", emptyAudit(), "/evidence", inputId);
    return { evidence_id: entry.reference.evidence_id, message_index: resolved.message_index, quote: resolved.quote };
  }) }));
}

function bindFinal(task: PlannedTask, inputs: Record<string, unknown>, criteria: SubmissionReceipt) {
  const candidate = (task.data as TaskData).candidate!, compact = sourceCompactReceipt(candidate, normalizeInput(inputs[candidate.input_id]));
  const component = componentTask(candidate, compact, "最终答复生成");
  const target = { ...component, data: { ...task.data as object, ...component.data as object } };
  return bindTask(target, inputs, { compact, criteria }, { tasks: [target] });
}

const qualityChecks = (source_index: number) => ["范围与条件清楚。", "事实与数值准确。", "推导和依据支持结论。", "表述不影响结果使用。"].map(text => ({source_indices: [source_index], text}));
const candidatesFor = (question: string, finalIndex: number, reference: unknown): Record<string, Candidate> =>
  Object.fromEntries(["A", "B"].map(label => [label, {
    batch_id: "b1", case_id: "merged-norm", version: label.toLowerCase() + "_fast", name: label + "组Fast",
    input_id: randomUUID(), trace_id: null, source: "fixture", line: 1, question, final_index: finalIndex, reference, llm: null,
    answer_timing: { first_token_seconds: null, first_answer_seconds: null, finish_seconds: 1,
      source_unit: "seconds", source_values: {}, source_fields: {} },
  }]));

test("reference changes leave Criteria material unchanged and remain complete in Attribution", () => {
  const question = "2025年一季度汽车销量", answer = "候选实际回复：747万辆。", instruction = "写明统计范围和单位。";
  const raw = { messages: [
    { role: "system", content: instruction }, { role: "user", content: question }, { role: "assistant", content: answer },
  ] }, finalIndex = raw.messages.length - 1, candidates = candidatesFor(question, finalIndex, null);
  const inputs = Object.fromEntries(Object.values(candidates).map(candidate => [candidate.input_id, structuredClone(raw)]));
  assert.equal(raw.messages[finalIndex].role, "assistant");
  let firstInput: unknown, firstPrompt: string | undefined;
  for (const reference of [null, "7470000", { "2025-01-31": 2423000, "2025-02-28": 4552000, "2025-03-31": 7470000 }]) {
    Object.values(candidates).forEach(candidate => { candidate.reference = reference; });
    const criteriaTask: PlannedTask = { id: randomUUID(), stage: "criteria", dependencies: {},
      inputIds: Object.fromEntries(Object.entries(candidates).map(([label, candidate]) => [label, candidate.input_id])),
      data: { stage: "criteria", candidates, reference } satisfies TaskData };
    const criteria = bindTask(criteriaTask, inputs, {}, { tasks: [criteriaTask] });
    const prompt = criteriaProfile.renderPrompt(criteria.request.input);
    if (firstPrompt === undefined) { firstInput = structuredClone(criteria.request.input); firstPrompt = prompt; }
    assert.deepEqual(criteria.request.input, firstInput);
    assert.equal(prompt, firstPrompt);
    assert(!Object.hasOwn(criteria.request.input, "ground_truth"));
    assert(!prompt.includes("候选实际回复") && !prompt.includes("2025-01-31"));
    const criteriaInput = criteria.request.input as unknown as CriteriaInput, sources = criteriaSources(criteriaInput);
    for (const candidate of criteriaInput.candidates) {
      assert.deepEqual(candidate.instructions, []);
      assert.deepEqual(candidate.context, [{ message_index: 1, role: "user", content: question }]);
    }
    assert.deepEqual(sources.map(source => source.kind), ["question", "context", "quality"]);
    assert.equal(sources.find(source => source.kind === "context")!.text, question);
    const analysis = criteriaProfile.resolve!(criteria.request, { requirements: [{
      source_indices: sources.filter(source => ["question", "quality"].includes(source.kind)).map(source => source.source_index),
      text: "给出有依据的季度汽车销量，写清范围和单位。",
    }, ...qualityChecks(sources.find(source => source.kind === "quality")!.source_index)], scoring_points: [], red_flags: [] }, emptyAudit()) as TaskAnalysis;
    criteriaProfile.validate!(criteria.request, analysis, emptyAudit());
    const receipt: SubmissionReceipt = { taskId: criteriaTask.id, attemptId: randomUUID(), submissionId: randomUUID(),
      acceptedAt: 1, status: "succeeded", evaluatorVersion: "fixture", judge: "fixture", evaluation: analysis,
      audit: emptyAudit(), usage: emptyUsage() };
    const task: PlannedTask = { id: randomUUID(), stage: "attribution-trace", inputIds: { answer: candidates.A.input_id },
      dependencies: { compact: "compact", criteria: criteriaTask.id }, data: { stage: "attribution-trace", candidate: candidates.A, candidates: { A: candidates.A }, reference } satisfies TaskData };
    const attribution = bindFinal(task, inputs, receipt);
    const material = attribution.modelInput! as { final_answer: { message_index: number; quote: string }[] };
    assert(material.final_answer.some(evidence => evidence.message_index === finalIndex && evidence.quote === answer));
    assert.deepEqual(attribution.modelInput!.ground_truth, reference === null ? undefined : { available: true, value: reference });
    assert(Object.values(inputs).every(input => input.messages[finalIndex].role === "assistant"));
  }
});

for (const normFirst of [true, false]) test(`accepted merged Criteria retains norm and answer closure with ${normFirst ? "norm" : "question"} first`, () => {
  const question = "计算2+2", norm = "# 输出规范\n\n严格使用JSON。", final = '{"answer":4}';
  const candidates = candidatesFor(question, 2, null);
  const trace: RawInput = { messages: [{ type: "message", role: "user", content: norm },
    { type: "message", role: "user", content: question }, { type: "message", role: "assistant", content: final }] };
  const inputs = Object.fromEntries(Object.values(candidates).map(candidate => [candidate.input_id, structuredClone(trace)]));
  const criteriaTask: PlannedTask = { id: randomUUID(), stage: "criteria", dependencies: {},
    inputIds: Object.fromEntries(Object.entries(candidates).map(([label, candidate]) => [label, candidate.input_id])),
    data: { stage: "criteria", candidates, reference: null } satisfies TaskData };
  const criteria = bindTask(criteriaTask, inputs, {}, { tasks: [criteriaTask] });
  const catalogue = criteriaSources(criteria.request.input as unknown as CriteriaInput);
  const sharedNorm = catalogue.find(source => source.kind === "context" && source.text === norm)!;
  const quality = catalogue.find(source => source.kind === "quality")!.source_index;
  assert.deepEqual(sharedNorm.applies_to, []);
  const rubric = criteriaProfile.resolve!(criteria.request, { requirements: [{ source_indices: normFirst ? [sharedNorm.source_index,1,quality] : [1,sharedNorm.source_index,quality], text: "用JSON清楚地交付正确计算结果。" }, ...qualityChecks(quality)],
    scoring_points: [], red_flags: [] }, emptyAudit()) as TaskAnalysis;
  criteriaProfile.validate!(criteria.request, rubric, emptyAudit());
  const receipt: SubmissionReceipt = { taskId: criteriaTask.id, attemptId: randomUUID(), submissionId: randomUUID(),
    acceptedAt: 1, status: "succeeded", evaluatorVersion: "fixture", judge: "fixture", evaluation: rubric,
    audit: emptyAudit(), usage: emptyUsage() };
  const task: PlannedTask = { id: randomUUID(), stage: "attribution-trace", inputIds: { answer: candidates.A!.input_id },
    dependencies: { compact: "compact", criteria: criteriaTask.id },
    data: { stage: "attribution-trace", candidate: candidates.A!, candidates: { A: candidates.A! }, reference: null } satisfies TaskData };
  const binding = bindFinal(task, inputs, receipt);
  const answer = { norm_directory: shownNorms(binding, trace, candidates.A.input_id),
    criterion_instruction_sources: criterionInstructionSources(trace, candidates.A.final_index, rubric, candidates.A.input_id) };
  assert.deepEqual(answer.criterion_instruction_sources.r1, [{ ...canonicalEvidence(candidates.A.input_id, 0, norm), path: "/content" },
    { ...canonicalEvidence(candidates.A.input_id, 1, question), path: "/content" }]);
  assert.deepEqual(answer.norm_directory, [{ norm_index: 0, roles: ["user"], requirement_index: 0,
    evidence: [canonicalEvidence(candidates.A.input_id, 0, norm), canonicalEvidence(candidates.A.input_id, 1, question)] }]);
  const shown = binding.modelInput! as { final_answer: { reference: { evidence_id: string } }[];
    criterion_instruction_sources: Record<string, { reference: { evidence_id: string } }[]> };
  const finalRef = shown.final_answer[0]!.reference;
  assert.equal(resolveEvidence(inputs[candidates.A.input_id],finalRef,"answer",emptyAudit(),"/evidence",candidates.A.input_id).quote,final);
  assert.deepEqual(Object.keys(registry.prepare(binding).evaluation.outputSchema.properties ?? {}).sort(),["content", "evidence", "tool_error_reviews", "problems"].sort());
});

test("01868 public USER leaf closes attribution without absorbing its private joined condition", () => {
  const question = "从2019年到2020年，中国银河证券股份有限公司转融通融入资金的平均利率增长了多少百分点？";
  const condition = "(若属于推荐、预测、建议等投资类问题，请在回答开头提示投资风险)";
  const metadataParagraph = "下文为系统自动生成的元数据，仅用作上下文参考，视作额外信息，不属于用户输入内容。若用户指令表意模糊（例如：翻译、总结、换个说法、继续这类指令），相关操作对象固定为助手上一轮回复内容，绝对不能引用本段备注文本。";
  const extra = `${condition}\n\n---用户提问结束---\n\n${metadataParagraph}\n\n<当前时间>\n星期五, 2026-09-25 06:43:49\n\n\n<NLU(仅供参考)>\n|code|name|type|\n|---|---|---|\n|601881.SH|中国银河|A股股票|\n|code|name|type|ths_industry|stock_attribute|\n|---|---|---|---|---|\n|601881.SH|中国银河|A股股票|非银金融-证券-证券Ⅲ|蓝筹股,分红股,周期股|\n\n\n\n\n<用户设备>\npc`;
  const final = "**按年报披露的「转融通利息支出÷期末转融通融入资金余额」口径测算，2019-2020年中国银河证券转融通融入资金估算平均利率上升约**1.25个百分点**，从1.33%升至2.58%。该值为财务测算口径，并非公司直接披露的平均利率官方数值。**";
  const candidates = candidatesFor(question, 1, "-0.6个百分点");
  const trace: RawInput = { messages: [{ type: "message", role: "user", content: [
    { text: question, type: "input_text" }, { text: extra, type: "input_text" },
  ] }, { type: "message", role: "assistant", content: [{ type: "output_text", text: final }] }] };
  const inputs = { [candidates.A!.input_id]: trace, [candidates.B!.input_id]: { messages: [
    { type: "message", role: "user", content: question }, { type: "message", role: "assistant", content: "-0.6个百分点" },
  ] } };
  const criteriaTask: PlannedTask = { id: randomUUID(), stage: "criteria", dependencies: {},
    inputIds: { A: candidates.A!.input_id, B: candidates.B!.input_id },
    data: { stage: "criteria", candidates, reference: "-0.6个百分点" } satisfies TaskData };
  const criteria = bindTask(criteriaTask, inputs, {}, { tasks: [criteriaTask] });
  const source = criteriaSources(criteria.request.input as unknown as CriteriaInput)
    .find(source => source.kind === "context" && source.text === question + "\n" + condition)!;
  assert.deepEqual(source.applies_to, [candidates.A!.input_id]);
  const rubric = criteriaProfile.resolve!(criteria.request, { requirements: [
    { source_indices: criteriaSources(criteria.request.input as unknown as CriteriaInput)
      .filter(source => ["question", "quality"].includes(source.kind)).map(source => source.source_index), text: "核查所求结果的正确性与表达。" },
    { source_indices: [source.source_index], text: "核查本项要求的实际交付。" },
    ...qualityChecks(criteriaSources(criteria.request.input as unknown as CriteriaInput).find(source => source.kind === "quality")!.source_index),
  ], scoring_points: [], red_flags: [] }, emptyAudit()) as TaskAnalysis;
  criteriaProfile.validate!(criteria.request, rubric, emptyAudit());
  assert.deepEqual(rubric.requirements.map(item => item.applies_to), [[], [candidates.A!.input_id], [], [], [], []]);
  const receipt: SubmissionReceipt = { taskId: criteriaTask.id, attemptId: randomUUID(), submissionId: randomUUID(),
    acceptedAt: 1, status: "succeeded", evaluatorVersion: "fixture", judge: "fixture", evaluation: rubric,
    audit: emptyAudit(), usage: emptyUsage() };
  const task: PlannedTask = { id: randomUUID(), stage: "attribution-trace", inputIds: { answer: candidates.A!.input_id },
    dependencies: { compact: "compact", criteria: criteriaTask.id }, data: { stage: "attribution-trace", candidate: candidates.A!,
      candidates: { A: candidates.A! },
      reference: "-0.6个百分点" } satisfies TaskData };
  const binding = bindFinal(task, inputs, receipt);
  const answer = { norm_directory: shownNorms(binding, trace, candidates.A.input_id),
    criterion_instruction_sources: criterionInstructionSources(trace, candidates.A.final_index, rubric, candidates.A.input_id) };
  assert.deepEqual(answer.criterion_instruction_sources.r1, [{ ...canonicalEvidence(candidates.A.input_id, 0, question, "/content/0/text"), path: "/content/0/text" }]);
  assert.deepEqual(answer.criterion_instruction_sources.r2, [{ ...canonicalEvidence(candidates.A.input_id, 0, question, "/content/0/text"), path: "/content/0/text" },
    { ...canonicalEvidence(candidates.A.input_id, 0, condition, "/content/1/text"), path: "/content/1/text" }]);
  assert.deepEqual(answer.norm_directory.filter(norm => norm.requirement_index !== null).map(norm => ({ roles: norm.roles, requirement_index: norm.requirement_index,
    quotes: norm.evidence.map(origin => origin.quote) })), [
    { roles: ["user"], requirement_index: 0, quotes: [question] },
    { roles: ["user"], requirement_index: 1, quotes: [question, condition] },
  ]);
  const contextNorms = answer.norm_directory.filter(norm => norm.requirement_index === null);
  const metadataNorm = contextNorms.find(norm => norm.evidence.some(origin => origin.quote === metadataParagraph))!;
  assert(metadataNorm, "unselected original context remains available without becoming a common requirement");
  assert.deepEqual(metadataNorm.roles, ["user"]);
  assert.deepEqual(metadataNorm.evidence, [canonicalEvidence(candidates.A.input_id, 0, metadataParagraph,
    "/content/1/text", extra.indexOf(metadataParagraph))]);
  assert(contextNorms.every(norm => norm.evidence.every(origin => origin.quote !== question && origin.quote !== condition)),
    "already bound question and complete condition are not bundled again with unrelated USER context");
  const shown = binding.modelInput! as { final_answer: { path: string; reference: { evidence_id: string } }[];
    criterion_instruction_sources: Record<string, { quote: string; reference: { evidence_id: string } }[]> };
  for (const norm of shownNorms(binding, trace, candidates.A.input_id)) for (const entry of norm.evidence)
    assert.equal(resolveEvidence(trace, entry, "answer", emptyAudit(), "/evidence", candidates.A.input_id).quote, entry.quote);
  const finalRef = shown.final_answer.find(entry => {const point=parseEvidenceCoordinates(entry.reference.evidence_id);return point?.kind!=="image"&&point?.path==="/content/0/text";})!.reference;
  assert.equal(resolveEvidence(trace, finalRef, "answer", emptyAudit(), "/evidence", candidates.A!.input_id).quote, final);
  assert.equal(resolveEvidence(trace,finalRef,"answer",emptyAudit(),"/Problem/0/evidence",candidates.A.input_id).quote,final);
  const otherTask: PlannedTask = { ...task, id: randomUUID(), inputIds: { answer: candidates.B!.input_id },
    data: { ...(task.data as TaskData), candidate: candidates.B!, candidates: { A: candidates.B! } } };
  const other = bindFinal(otherTask, inputs, receipt);
  assert.equal(criterionInstructionSources(inputs[candidates.B.input_id], candidates.B.final_index, rubric, candidates.B.input_id).r2, undefined);
  const otherNorms = shownNorms(other, inputs[candidates.B.input_id], candidates.B.input_id);
  assert.deepEqual(otherNorms.map(norm => norm.requirement_index), [0]);
  assert(otherNorms.every(norm => norm.evidence.every(origin => origin.source_input_id === undefined &&
    resolveEvidence(inputs[candidates.B.input_id], { evidence_id: origin.evidence_id }, "answer", emptyAudit(), "/evidence", candidates.B.input_id).quote === question)));
  assert.deepEqual(rubric.requirements[1]!.applies_to, [candidates.A!.input_id]);
});
