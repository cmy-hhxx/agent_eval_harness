import { AgentRegistry } from "@eval/host";
import { attributionAgent } from "@eval/agents/attribution";
import { canonicalEvidence } from "../../../../tests/fixtures/evidence.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { selectEvidence, emptyUsage, ValidationError, type CriteriaInput, type PlannedTask, type SubmissionReceipt, type TaskAnalysis } from "@eval/contracts";
import { criteriaProfile, criteriaSources } from "@eval/agents/criteria";
import { attributionProfile, attributionFindingBasis, type AttributionNorm, type AttributionResult, type AttributionSubmission } from "@eval/agents/attribution";
import { resolveEvidence } from "@eval/tools";
import { bindTask } from "../comparison/binding.js";
import type { Candidate, RawInput } from "../inputs/types.js";
import type { TaskData } from "../comparison/types.js";
import { emptyAudit } from "../../../../tests/fixtures/comparison.js";

const registry = new AgentRegistry([attributionAgent]);
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
    const task: PlannedTask = { id: randomUUID(), stage: "attribution", inputIds: { answer: candidates.A.input_id },
      dependencies: { criteria: criteriaTask.id }, data: { stage: "attribution", candidates: { A: candidates.A }, reference } satisfies TaskData };
    const attribution = bindTask(task, inputs, { criteria: receipt }, { tasks: [criteriaTask, task] });
    const material = attribution.request.input.answer as { final_message_index: number; final_answer: string;
      final_evidence: { message_index: number; quote: string }[] };
    assert.equal(material.final_message_index, finalIndex);
    assert.equal(material.final_answer, answer);
    assert(material.final_evidence.some(evidence => evidence.message_index === finalIndex && evidence.quote === answer));
    assert.deepEqual(attribution.request.input.ground_truth, { available: reference !== null, value: reference });
    assert.deepEqual(attribution.modelInput!.ground_truth, { available: reference !== null, value: reference });
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
  const task: PlannedTask = { id: randomUUID(), stage: "attribution", inputIds: { answer: candidates.A!.input_id },
    dependencies: { criteria: criteriaTask.id },
    data: { stage: "attribution", candidates: { A: candidates.A! }, reference: null } satisfies TaskData };
  const binding = bindTask(task, inputs, { criteria: receipt }, { tasks: [criteriaTask, task] });
  const answer = binding.request.input.answer as { norm_directory: AttributionNorm[]; criterion_instruction_sources: Record<string, {
    message_index: number; path: string; quote: string }[]> };
  assert.deepEqual(answer.criterion_instruction_sources.r1, [{ ...canonicalEvidence(candidates.A.input_id, 0, norm), path: "/content" },
    { ...canonicalEvidence(candidates.A.input_id, 1, question), path: "/content" }]);
  assert.deepEqual(answer.norm_directory, [{ norm_index: 0, roles: ["user"], requirement_index: 0,
    evidence: [canonicalEvidence(candidates.A.input_id, 0, norm), canonicalEvidence(candidates.A.input_id, 1, question)] }]);
  const shown = binding.modelInput!.answer as { final_evidence: { reference: { evidence_id: string } }[];
    criterion_instruction_sources: Record<string, { reference: { evidence_id: string } }[]> };
  const finalRef = shown.final_evidence[0]!.reference;
  const reads=emptyAudit(),choose=(ref:{evidence_id:string})=>selectEvidence(reads.evidenceBank!,ref).evidence_index;
  const draft:AttributionSubmission = { is_correct:null,correctness_reason:"",correctness_evidence_indices:[],numeric_checks: [],
    criterion_assessments: rubric.requirements.map(() => ({ status: "met", evidence_status: "established", summary: "按共同要求以JSON给出4。", evidence_indices: [choose(finalRef)] })),
    meets_core: true, core_reason: "给出可用结果。", core_requirements: [1], summary: "完成计算。", strengths: [], problems: [] };
  const result = registry.resolve(binding,draft,reads) as AttributionResult;
  assert.deepEqual(result.criterion_assessments[0]!.evidence, [canonicalEvidence(candidates.A.input_id, 2, final)]);
  assert.deepEqual(result.criterion_assessments[0]!.context_evidence, [canonicalEvidence(candidates.A.input_id, 0, norm), canonicalEvidence(candidates.A.input_id, 1, question)]);
  attributionProfile.validate!(binding.request, result, emptyAudit());
  const onlyNorm = structuredClone(draft);
  onlyNorm.criterion_assessments[0]!.evidence_indices = [choose(shown.criterion_instruction_sources.r1![0]!.reference)];
  assert.throws(() => attributionProfile.validate!(binding.request,
    registry.resolve(binding,onlyNorm,reads), emptyAudit()), (error: unknown) => {
    assert(error instanceof ValidationError);
    assert(error.issues!.some(issue => issue.code === "instruction_answer_evidence_required"));
    return true;
  });
  const findingDraft = { ...draft, strengths: [{ dimension: "instruction_following",
    stage: "final_answer", importance: "medium", text: "按共同规范使用JSON。", reason: "交付格式满足真实要求。",
    basis_index: attributionFindingBasis(binding.request.input).find(item=>item.norm_index===answer.norm_directory[0]!.norm_index)!.basis_index, evidence_indices: [choose(finalRef)],
    evidence_status: "established" }] };
  const findingResult = registry.resolve(binding,findingDraft,reads) as AttributionResult;
  assert.equal(findingResult.findings[0]!.assessment.requirement_index, 0);
  assert.deepEqual(findingResult.findings[0]!.evidence, [canonicalEvidence(candidates.A.input_id, 2, final)]);
  assert.deepEqual(findingResult.findings[0]!.context_evidence, [canonicalEvidence(candidates.A.input_id, 0, norm), canonicalEvidence(candidates.A.input_id, 1, question)]);
  attributionProfile.validate!(binding.request, findingResult, emptyAudit());
  for (const missingNorm of [0, 1]) {
    const incomplete = structuredClone(findingResult);
    incomplete.findings[0]!.context_evidence = incomplete.findings[0]!.context_evidence!.filter(item => item.message_index !== missingNorm);
    assert.throws(() => attributionProfile.validate!(binding.request, incomplete, emptyAudit()), (error: unknown) => {
      assert(error instanceof ValidationError);
      assert(error.issues!.some(issue => issue.code === "instruction_evidence_required" && issue.path === "/findings/0/evidence"));
      return true;
    });
  }
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
  const task: PlannedTask = { id: randomUUID(), stage: "attribution", inputIds: { answer: candidates.A!.input_id },
    dependencies: { criteria: criteriaTask.id }, data: { stage: "attribution", candidates: { A: candidates.A! },
      reference: "-0.6个百分点" } satisfies TaskData };
  const binding = bindTask(task, inputs, { criteria: receipt }, { tasks: [criteriaTask, task] });
  const answer = binding.request.input.answer as { norm_directory: AttributionNorm[]; criterion_instruction_sources: Record<string, {
    message_index: number; path: string; quote: string }[]> };
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
  const shown = binding.modelInput!.answer as { final_evidence: { path: string; reference: { evidence_id: string } }[];
    criterion_instruction_sources: Record<string, { quote: string; reference: { evidence_id: string } }[]> };
  for (const id of ["r1", "r2"]) for (const entry of shown.criterion_instruction_sources[id]!)
    assert.equal(resolveEvidence(trace, entry.reference, "answer", emptyAudit(), "/evidence", candidates.A!.input_id).quote, entry.quote);
  const finalRef = shown.final_evidence.find(entry => entry.path === "/content/0/text")!.reference;
  assert.equal(resolveEvidence(trace, finalRef, "answer", emptyAudit(), "/evidence", candidates.A!.input_id).quote, final);
  const reads=emptyAudit(),choose=(ref:{evidence_id:string})=>selectEvidence(reads.evidenceBank!,ref).evidence_index;
  const finalNumber=choose(finalRef);
  const draft:AttributionSubmission = { is_correct:false,correctness_reason:"回答1.25个百分点与标准-0.6不同。",correctness_evidence_indices:[finalNumber],
    numeric_checks:[{label:"利率变化百分点",reference_index:1,actual:"1.25",scale:"1",mode:"rounded",evidence_index:finalNumber}],
    criterion_assessments:rubric.requirements.map(item=>({status:item.id==="r2"?"met":"unmet",evidence_status:"established",summary:"核对真实问题、结果及条件。",evidence_indices:[finalNumber]})),
    meets_core:false,core_reason:"所求数值与标准不一致。",core_requirements:[1],summary:"所求数值未对齐标准。",strengths:[],problems:[] };
  {
    const request = binding.request;
    const resolved = registry.resolve(binding,draft,reads) as AttributionResult;
    assert.deepEqual(resolved.criterion_assessments[0]!.evidence, [canonicalEvidence(candidates.A.input_id, 1, final, "/content/0/text")]);
    assert.deepEqual(resolved.criterion_assessments[0]!.context_evidence, [canonicalEvidence(candidates.A.input_id, 0, question, "/content/0/text")]);
    assert.deepEqual(resolved.criterion_assessments[1]!.evidence, [canonicalEvidence(candidates.A.input_id, 1, final, "/content/0/text")]);
    assert.deepEqual(resolved.criterion_assessments[1]!.context_evidence, [canonicalEvidence(candidates.A.input_id, 0, question, "/content/0/text"), canonicalEvidence(candidates.A.input_id, 0, condition, "/content/1/text")]);
    attributionProfile.validate!(request, resolved, emptyAudit());
    const normOnly = structuredClone(draft);
    normOnly.criterion_assessments[0]!.evidence_indices = [choose(shown.criterion_instruction_sources.r1![0]!.reference)];
    assert.throws(() => attributionProfile.validate!(request,
      registry.resolve(binding,normOnly,reads), emptyAudit()), (error: unknown) => {
      assert(error instanceof ValidationError);
      assert(error.issues!.some(issue => issue.code === "instruction_answer_evidence_required" && issue.path === "/criterion_assessments/0/evidence_indices"));
      return true;
    });
  }
  const otherTask: PlannedTask = { ...task, id: randomUUID(), inputIds: { answer: candidates.B!.input_id },
    data: { ...(task.data as TaskData), candidates: { A: candidates.B! } } };
  const other = bindTask(otherTask, inputs, { criteria: receipt }, { tasks: [criteriaTask, otherTask] });
  assert.equal((other.request.input.answer as { criterion_instruction_sources: Record<string, unknown> }).criterion_instruction_sources.r2, undefined);
  const otherNorms = (other.request.input.answer as { norm_directory: AttributionNorm[] }).norm_directory;
  assert.deepEqual(otherNorms.map(norm => norm.requirement_index), [0]);
  assert(otherNorms.every(norm => norm.evidence.every(origin => origin.source_input_id === undefined &&
    resolveEvidence(inputs[candidates.B.input_id], { evidence_id: origin.evidence_id }, "answer", emptyAudit(), "/evidence", candidates.B.input_id).quote === question)));
  assert.deepEqual(rubric.requirements[1]!.applies_to, [candidates.A!.input_id]);
});
