import { AgentRegistry } from "@eval/host";
import { attributionAgent } from "@eval/agents/attribution";
import { canonicalEvidence } from "../../../../tests/fixtures/evidence.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { selectEvidence, emptyUsage, ValidationError, type CriteriaInput, type PlannedTask, type SubmissionReceipt, type TaskAnalysis } from "@eval/contracts";
import { criteriaProfile, criteriaSources } from "@eval/agents/criteria";
import { comparisonScope } from "@eval/agents/comparison";
import { attributionProfile, attributionFindingBasis, type AttributionNorm, type AttributionResult, type AttributionSubmission } from "@eval/agents/attribution";
import { resolveEvidence } from "@eval/tools";
import { bindTask } from "./binding.js";
import { criterionInstructionSources } from "./instruction-bindings.js";
import type { Candidate, RawInput, TaskData } from "./types.js";
import { emptyAudit } from "../../../../tests/fixtures/comparison.js";


const registry = new AgentRegistry([attributionAgent]);
const candidatesFor = (question: string, finalIndex: number, reference: unknown): Record<string, Candidate> =>
  Object.fromEntries(["A", "B"].map(label => [label, {
    batch_id: "b1", case_id: "merged-norm", version: label.toLowerCase() + "_fast", name: label + "组Fast",
    input_id: randomUUID(), trace_id: null, source: "fixture", line: 1, question, final_index: finalIndex, reference, llm: null,
    answer_timing: { first_token_seconds: null, first_answer_seconds: null, finish_seconds: 1,
      source_unit: "seconds", source_values: {}, source_fields: {} },
  }]));

test("attribution defers repeated long instruction blocks and reuses overview evidence without changing trusted material", () => {
  const question = "计算结果", rule = "## 规范\n\n" + "条件与例外原文。".repeat(500) + "\n\n**调用收敛：**\n最多四次查询。\n\n### 出处标注\n隐藏内部品牌。";
  const candidates = candidatesFor(question, 4, null), raw: RawInput = { messages: [
    { role: "system", content: rule }, { role: "user", content: question },
    { type: "tool_call", name: "Calc", input: { expression: "2+2" } },
    { type: "tool_result", name: "Calc", output: [{ text: "4" }, { text: "AttributeError: shift" }] },
    { role: "assistant", content: "最终结果是4。" },
  ] };
  const analysis: TaskAnalysis = { task_type: "calculation", goal: question, requirements: [
    { id: "r1", text: question, acceptance_rule: question, applies_to: [] },
    { id: "r2", text: "遵守本方规则", acceptance_rule: rule, applies_to: [candidates.A.input_id] },
  ], scoring_points: [], red_flags: [] };
  const criteriaTask: PlannedTask = { id: randomUUID(), stage: "criteria", dependencies: {},
    inputIds: { A: candidates.A.input_id, B: candidates.B.input_id }, data: { stage: "criteria", candidates, reference: null } };
  const task: PlannedTask = { id: randomUUID(), stage: "attribution", dependencies: { criteria: criteriaTask.id },
    inputIds: { answer: candidates.A.input_id }, data: { stage: "attribution", candidates: { A: candidates.A }, reference: null } };
  const receipt: SubmissionReceipt = { taskId: criteriaTask.id, attemptId: randomUUID(), submissionId: randomUUID(),
    acceptedAt: 1, status: "succeeded", evaluatorVersion: "fixture", judge: "fixture", evaluation: analysis,
    audit: emptyAudit(), usage: emptyUsage() };
  const before = structuredClone({ raw, analysis });
  const binding = bindTask(task, { [candidates.A.input_id]: raw }, { criteria: receipt }, { tasks: [criteriaTask, task] });
  const bank: string[] = [], shown = binding.projectModelInput!(binding.modelInput!, bank);
  const prompt = attributionProfile.renderPrompt(shown);
  assert(!prompt.includes(rule), "full instructions are neither embedded again nor copied into acceptance rules");
  assert(prompt.includes("answer.criterion_instruction_sources.r2[0]"));
  const answer = shown.answer as any;
  assert.deepEqual(answer.initial_material, []);
  assert(!Object.hasOwn(answer.instruction_sources[0], "content"));
  const navigation = answer.norm_directory.flatMap((entry: any) => entry.evidence).find((entry: any) => entry.outline)?.outline;
  assert(navigation.some((item: any) => item.title === "**调用收敛：**" && rule.slice(item.offset).startsWith(item.title)));
  assert(navigation.some((item: any) => item.title === "### 出处标注"));
  assert(JSON.stringify(navigation).length < 2400);
  assert(!Object.hasOwn(answer.instruction_sources[0].evidence[0], "outline"), "the rule navigation appears beside its basis, without a second copy");
  assert(!Object.hasOwn(answer.final_evidence[0], "quote"), "final text is not copied again with its evidence number");
  const error = answer.trace_overview.entries.flatMap((entry: any) => entry.highlights).find((item: any) => item.quote.includes("AttributeError"));
  assert.equal(resolveEvidence(raw, { evidence_id: bank[error.reference.evidence_index - 1] }, "answer", emptyAudit(), "/evidence", candidates.A.input_id).quote, error.quote);
  assert.equal((binding.request.input.task_analysis as unknown as TaskAnalysis).requirements[1].acceptance_rule, rule);
  assert.deepEqual({ raw, analysis }, before);
});

test("common quality and correctness survive the workflow while each system rule stays with its owner", () => {
  const question = "计算二加二。", reference = "四", candidates = candidatesFor(question, 2, reference);
  const rules = { A: "只写结果。", B: "用完整句子说明结果。" }, replies = { A: "四", B: "结果是四。" };
  const inputs = Object.fromEntries(Object.entries(candidates).map(([label, candidate]) => [candidate.input_id, {
    messages: [{ role: "system", content: rules[label as "A" | "B"] }, { role: "user", content: question },
      { role: "assistant", content: replies[label as "A" | "B"] }],
  }]));
  const criteriaTask: PlannedTask = { id: randomUUID(), stage: "criteria", dependencies: {},
    inputIds: Object.fromEntries(Object.entries(candidates).map(([label, candidate]) => [label, candidate.input_id])),
    data: { stage: "criteria", candidates, reference } satisfies TaskData };
  const criteria = bindTask(criteriaTask, inputs, {}, { tasks: [criteriaTask] });
  const catalogue = criteriaSources(criteria.request.input as unknown as CriteriaInput);
  const rubric = criteriaProfile.resolve!(criteria.request, { requirements: [
    { source_indices: [1], text: "给出二加二的计算结果。" },
    { source_indices: [catalogue.find(source => source.kind === "quality")!.source_index], text: "结果可靠，推理成立，表达清楚。" },
    { source_indices: [1, 2], text: "所求结果与参考答案四一致，接受等价表达。" },
    ...catalogue.filter(source => source.kind === "instruction").map(source => ({ source_indices: [source.source_index], text: source.text })),
  ], scoring_points: [], red_flags: [] }, emptyAudit()) as TaskAnalysis;
  criteriaProfile.validate!(criteria.request, rubric, emptyAudit());
  assert.deepEqual(rubric.requirements.map(item => item.applies_to), [[], [], [], [candidates.A.input_id], [candidates.B.input_id]]);
  assert(!criteriaProfile.renderPrompt(criteria.request.input).includes(replies.B));
  const receipt = (task: PlannedTask, evaluation: unknown): SubmissionReceipt => ({ taskId: task.id, attemptId: randomUUID(),
    submissionId: randomUUID(), acceptedAt: 1, status: "succeeded", evaluatorVersion: "fixture", judge: "fixture",
    evaluation, audit: emptyAudit(), usage: emptyUsage() });
  const dependencies: Record<string, SubmissionReceipt> = { criteria: receipt(criteriaTask, rubric) };
  const tasks = [criteriaTask];
  for (const label of ["A", "B"] as const) {
    const task: PlannedTask = { id: randomUUID(), stage: "attribution", inputIds: { answer: candidates[label].input_id },
      dependencies: { criteria: criteriaTask.id }, data: { stage: "attribution", candidates: { A: candidates[label] }, reference } satisfies TaskData };
    tasks.push(task);
    const binding = bindTask(task, inputs, { criteria: dependencies.criteria }, { tasks });
    const answer = binding.request.input.answer as { norm_directory: AttributionNorm[] };
    const ownIndex = label === "A" ? 3 : 4, peerIndex = label === "A" ? 4 : 3;
    assert(answer.norm_directory.some(norm => norm.requirement_index === ownIndex && norm.roles.includes("system")));
    assert(!answer.norm_directory.some(norm => norm.requirement_index === peerIndex));
    const finalRef = (binding.modelInput!.answer as { final_evidence: { reference: { evidence_id: string } }[] }).final_evidence[0].reference;
    const reads = emptyAudit(), finalNumber = selectEvidence(reads.evidenceBank!, finalRef).evidence_index;
    const draft: AttributionSubmission = { is_correct: true, correctness_reason: "结果与参考答案四一致。",
      correctness_evidence_indices: [finalNumber], numeric_checks: [],
      criterion_assessments: Array.from({ length: 4 }, () => ({ status: "met", evidence_status: "established", summary: "满足本项要求。", evidence_indices: [finalNumber] })),
      meets_core: true, core_reason: "正确给出所求结果。", core_requirements: [1, 3], summary: "正确完成计算。", strengths: [], problems: [] };
    const result = registry.resolve(binding, draft, reads) as AttributionResult;
    registry.validate(binding, result, reads);
    assert.equal(result.is_correct, true);
    assert.equal(result.criterion_assessments[2].status, "met");
    assert.equal(result.criterion_assessments[ownIndex].status, "met");
    assert.equal(result.criterion_assessments[peerIndex].status, "not_applicable");
    dependencies[label] = receipt(task, result);
  }
  const comparisonTask: PlannedTask = { id: randomUUID(), stage: "comparison", inputIds: criteriaTask.inputIds,
    dependencies: Object.fromEntries(Object.entries(dependencies).map(([label, item]) => [label, item.taskId])),
    data: { stage: "comparison", candidates, reference, group: ["a_fast", "b_fast"] } satisfies TaskData };
  tasks.push(comparisonTask);
  const comparison = bindTask(comparisonTask, inputs, dependencies, { tasks });
  assert.deepEqual(comparisonScope(comparison.request).common_criterion_ids, ["r1", "r2", "r3"]);
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
  const rubric = criteriaProfile.resolve!(criteria.request, { requirements: [{ source_indices: normFirst ? [sharedNorm.source_index,1,quality] : [1,sharedNorm.source_index,quality], text: "用JSON清楚地交付正确计算结果。" }],
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
    criterion_assessments: [{ status: "met", evidence_status: "established", summary: "按共同要求以JSON给出4。", evidence_indices: [choose(finalRef)] }],
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
      .filter(source => ["question", "reference", "quality"].includes(source.kind)).map(source => source.source_index), text: "核查所求结果的正确性与表达。" },
    { source_indices: [source.source_index], text: "核查本项要求的实际交付。" },
  ], scoring_points: [], red_flags: [] }, emptyAudit()) as TaskAnalysis;
  criteriaProfile.validate!(criteria.request, rubric, emptyAudit());
  assert.deepEqual(rubric.requirements.map(item => item.applies_to), [[], [candidates.A!.input_id]]);
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

test("a headed private norm keeps all leaf origins without being promoted by a short task description", () => {
  const question="解释平均利率。",parts=["## 风险边界","只有投资建议须提示风险。","概念解释无需风险提示；不得扩大触发范围。"];
  const final="平均利率是按统一口径计算的平均融资成本。",candidates=candidatesFor(question,2,null);
  const trace:RawInput={messages:[{role:"system",content:parts.map(text=>({type:"input_text",text}))},{role:"user",content:question},{role:"assistant",content:final}]};
  const inputs=Object.fromEntries(Object.values(candidates).map(candidate=>[candidate.input_id,structuredClone(trace)]));
  const criteriaTask:PlannedTask={id:randomUUID(),stage:"criteria",inputIds:{A:candidates.A.input_id,B:candidates.B.input_id},dependencies:{},data:{stage:"criteria",candidates,reference:null} satisfies TaskData};
  const criteria=bindTask(criteriaTask,inputs,{}, {tasks:[criteriaTask]});
  const rubric=criteriaProfile.resolve!(criteria.request,{requirements:[{source_indices:criteriaSources(criteria.request.input as unknown as CriteriaInput)
    .filter(source=>["question","quality"].includes(source.kind)).map(source=>source.source_index),text:"准确清楚地解释平均利率的含义。"}],scoring_points:[],red_flags:[]},emptyAudit()) as TaskAnalysis;
  const receipt:SubmissionReceipt={taskId:criteriaTask.id,attemptId:randomUUID(),submissionId:randomUUID(),acceptedAt:1,status:"succeeded",evaluatorVersion:"fixture",judge:"fixture",evaluation:rubric,audit:emptyAudit(),usage:emptyUsage()};
  const task:PlannedTask={id:randomUUID(),stage:"attribution",inputIds:{answer:candidates.A.input_id},dependencies:{criteria:criteriaTask.id},data:{stage:"attribution",candidates:{A:candidates.A},reference:null} satisfies TaskData};
  const binding=bindTask(task,inputs,{criteria:receipt},{tasks:[criteriaTask,task]});
  const answer=binding.request.input.answer as {norm_directory:AttributionNorm[]};
  const own=answer.norm_directory.find(item=>item.roles.includes("system"))!;
  assert.equal(own.requirement_index,null);assert.deepEqual(own.evidence.map(item=>item.quote),parts);
  const finalRef=(binding.modelInput!.answer as any).final_evidence[0].reference;
  const reads=emptyAudit(),finalNumber=selectEvidence(reads.evidenceBank!,finalRef).evidence_index;
  const draft:AttributionSubmission={is_correct:null,correctness_reason:"",correctness_evidence_indices:[],numeric_checks:[],summary:"已解释含义。",meets_core:true,core_reason:"给出了所求含义。",core_requirements:[1],
    criterion_assessments:[{status:"met",evidence_status:"established",summary:"给出了融资成本含义。",evidence_indices:[finalNumber]}],
    problems:[],strengths:[{dimension:"instruction_following",stage:"final_answer",importance:"low",text:"纯概念解释没有加入投资风险提示。",reason:"该条件在本轮未触发。",basis_index:attributionFindingBasis(binding.request.input).find(item=>item.norm_index===own.norm_index)!.basis_index,evidence_indices:[finalNumber],evidence_status:"established"}]};
  const result=registry.resolve(binding,draft,reads) as AttributionResult;
  registry.validate(binding,result,reads);
  assert.equal(result.findings[0].assessment.requirement_index,null);
  assert(parts.every(part=>result.findings[0].context_evidence!.some(item=>item.quote===part)));
  draft.strengths[0].dimension="format";
  const classified=registry.resolve(binding,draft,reads) as AttributionResult;
  registry.validate(binding,classified,reads);
  assert.equal(classified.findings[0].dimension,"format","topic labels do not change the selected rule's ownership");
  assert.equal(classified.findings[0].assessment.requirement_index,null);
  assert(parts.every(part=>classified.findings[0].context_evidence!.some(item=>item.quote===part)));
  const copied=structuredClone(rubric);copied.requirements[0].text=parts.join("\n");
  assert.deepEqual(criterionInstructionSources(trace,2,copied,candidates.A.input_id),criterionInstructionSources(trace,2,rubric,candidates.A.input_id));
});

test("norm directories preserve own original conditions, global requirement positions and long full-read coordinates", () => {
  const question = "解释平均利率。", privateNorm = "## 本方输出规则\n\n" + "保留真实来源、触发条件与例外。".repeat(1200);
  const developerNorm = "## 概念解释\n\n概念解释应给出计算口径，除非用户明确要求只给名称。";
  const condition = "(若属于推荐、预测、建议等投资类问题，请在回答开头提示投资风险)";
  const metadataParagraph = "下文为系统自动生成的元数据，仅用作上下文参考，视作额外信息，不属于用户输入内容。";
  const metadata = `\n\n---用户提问结束---\n\n${metadataParagraph}\n\n<当前时间>\n2026-09-25`;
  const peerNorm = "## 对方专用规则\n\n仅对方应使用专门表格。";
  const final = "平均利率是按统一口径计算的平均融资成本。", candidates = candidatesFor(question, 3, null);
  candidates.B.final_index = 2;
  const trace: RawInput = { messages: [
    { role: "system", content: privateNorm }, { role: "developer", content: developerNorm },
    { role: "user", content: [{ type: "input_text", text: question }, { type: "input_text", text: condition + metadata }] },
    { role: "assistant", content: final },
  ] };
  const inputs: Record<string, RawInput> = { [candidates.A.input_id]: trace,
    [candidates.B.input_id]: { messages: [{ role: "system", content: peerNorm }, { role: "user", content: question },
      { role: "assistant", content: final }] } };
  const analysis: TaskAnalysis = { task_type: "explanation", goal: question, requirements: [
    { id: "r1", text: peerNorm, acceptance_rule: peerNorm, applies_to: [candidates.B.input_id] },
    { id: "r2", text: question, acceptance_rule: question, applies_to: [] },
    { id: "r3", text: developerNorm, acceptance_rule: developerNorm, applies_to: [candidates.A.input_id] },
  ], scoring_points: [{ id: "s1", text: privateNorm, acceptance_rule: privateNorm, applies_to: [candidates.A.input_id] }],
    red_flags: [{ id: "f1", text: condition, acceptance_rule: condition, applies_to: [candidates.A.input_id] }] };
  const criteriaTask: PlannedTask = { id: randomUUID(), stage: "criteria", dependencies: {},
    inputIds: { A: candidates.A.input_id, B: candidates.B.input_id },
    data: { stage: "criteria", candidates, reference: null } satisfies TaskData };
  const receipt: SubmissionReceipt = { taskId: criteriaTask.id, attemptId: randomUUID(), submissionId: randomUUID(),
    acceptedAt: 1, status: "succeeded", evaluatorVersion: "fixture", judge: "fixture", evaluation: analysis,
    audit: emptyAudit(), usage: emptyUsage() };
  const task: PlannedTask = { id: randomUUID(), stage: "attribution", inputIds: { answer: candidates.A.input_id },
    dependencies: { criteria: criteriaTask.id }, data: { stage: "attribution", candidates: { A: candidates.A }, reference: null } satisfies TaskData };
  const binding = bindTask(task, inputs, { criteria: receipt }, { tasks: [criteriaTask, task] });
  const answer = binding.request.input.answer as { norm_directory: AttributionNorm[] };
  assert.deepEqual(answer.norm_directory.filter(norm => norm.requirement_index !== null).map(norm => norm.requirement_index), [1, 2]);
  const physical = answer.norm_directory.filter(norm => norm.requirement_index === null);
  assert(physical.some(norm => norm.roles.includes("system") && norm.evidence.some(origin => origin.quote === privateNorm)));
  const conditionNorm = physical.find(norm => norm.roles.includes("user") && norm.evidence.some(origin => origin.quote === condition))!;
  assert(conditionNorm, "a genuine unselected USER condition remains available in its complete physical block");
  assert(conditionNorm.evidence.every(origin => origin.quote !== metadataParagraph), "independent context is not merged into the condition block");
  const metadataNorm = answer.norm_directory.find(norm => norm.evidence.some(origin => origin.quote === metadataParagraph))!;
  assert(metadataNorm, "original USER context is retained without semantic keyword filtering");
  assert.equal(metadataNorm.requirement_index, null, "context does not acquire a common requirements index");
  assert.deepEqual(metadataNorm.evidence, [canonicalEvidence(candidates.A.input_id, 2, metadataParagraph, "/content/1/text",
    (condition + metadata).indexOf(metadataParagraph))]);
  assert(answer.norm_directory.every(norm => norm.evidence.every(origin => !origin.quote.includes(peerNorm))));
  const bank: string[] = [], shown = binding.projectModelInput!(binding.modelInput!, bank).answer as {
    norm_directory: { norm_index: number; roles: string[]; requirement_index: number | null; evidence: {
      quote?: string; quote_preview?: string; has_more?: boolean; reference: { evidence_index: number };
      search_scope?: { candidate: string; message_index: number; path: string }; start_offset?: number; end_offset: number;
    }[] }[] };
  const original = physical.find(norm => norm.roles.includes("system"))!, norm = shown.norm_directory[original.norm_index]!;
  assert.equal(norm.requirement_index, null);
  assert.equal(norm.evidence[0]!.quote, undefined);
  assert.equal(norm.evidence[0]!.quote_preview, privateNorm.slice(0, 200));
  assert.equal(norm.evidence[0]!.has_more, true);
  assert(!Object.hasOwn(norm.evidence[0]!, "read_request"));
  assert.deepEqual(norm.evidence[0]!.search_scope, { candidate: "answer", message_index: 0, path: "/content" });
  assert.equal(norm.evidence[0]!.start_offset, 0);
  assert.equal(norm.evidence[0]!.end_offset, privateNorm.length);
  assert.equal(bank[norm.evidence[0]!.reference.evidence_index - 1], original.evidence[0]!.evidence_id);
  assert.equal(resolveEvidence(trace, { evidence_id: bank[norm.evidence[0]!.reference.evidence_index - 1] }, "answer", emptyAudit(), "/evidence", candidates.A.input_id).quote, privateNorm);
});
