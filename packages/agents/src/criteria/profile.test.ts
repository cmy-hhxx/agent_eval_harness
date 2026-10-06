import test from "node:test";
import assert from "node:assert/strict";
import { AgentRegistry } from "@eval/host";
import { ValidationError, type AgentRequest, type CriteriaInput, type TaskAnalysis } from "@eval/contracts";
import { criteriaAgent, criteriaProfile, criteriaSources, type CriteriaSubmission } from "./index.js";
const a = "11111111-1111-4111-8111-111111111111", b = "22222222-2222-4222-8222-222222222222";
const audit = { calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [] };
const request = (question = "①给出价差；②给出相关系数。缺数时列出具体缺口。", reference: unknown = null): AgentRequest => ({ sources: {}, input: {
  question, ground_truth: { available: reference !== null, value: reference }, candidates: [a,b].map(candidate_id => ({ candidate_id, instructions: [], context: [] })),
} });
const draft = (): CriteriaSubmission => ({ requirements: [
  { source_indices: [1], text: "给出价差；缺数时指出缺口。" }, { source_indices: [1], text: "给出相关系数；缺数时指出缺口。" },
], scoring_points: [], red_flags: [] });
function accepted(req: AgentRequest, submitted: CriteriaSubmission) {
  const registry = new AgentRegistry([criteriaAgent]), binding = { agent: "criteria", profile: "default", request: req };
  const value = registry.resolve(binding, submitted, audit) as TaskAnalysis;
  registry.validate(binding, value, audit); return value;
}
const rejects = (fn: () => unknown, code: string) => assert.throws(fn, error => error instanceof ValidationError && error.issues!.some(issue => issue.code === code));

test("separate checks may share one source while complete conditions and scope remain program-owned", () => {
  const req = request(), submitted = draft(), before = structuredClone(submitted), value = accepted(req, submitted);
  assert.equal(value.requirements.length, 2);
  assert.deepEqual(value.requirements.map(item => item.id), ["r1", "r2"]);
  assert.deepEqual(value.requirements.map(item => item.text), submitted.requirements.map(item => item.text));
  assert(value.requirements.every(item => item.acceptance_rule.includes(String(req.input.question)) && !item.applies_to.length));
  assert.deepEqual(submitted, before);
});

test("source bindings reject unknown selections and private scope cannot replace common coverage", () => {
  const req = request(), input = req.input as unknown as CriteriaInput;
  input.candidates[0].context = [{ message_index: 0, role: "user", content: "只用一句话回答。" }];
  const source = criteriaSources(input).find(item => item.kind === "context")!;
  const value = draft(); value.requirements.push({ source_indices: [source.source_index], text: "只用一句话回答。" });
  assert.deepEqual(accepted(req, value).requirements[2].applies_to, [a]);
  value.requirements = [{ source_indices: [1, source.source_index], text: "核查本方交付。" }];
  rejects(() => accepted(req, value), "criterion_required_source_missing");
  value.requirements = [{ source_indices: [999], text: "不存在的来源。" }];
  rejects(() => accepted(req, value), "criterion_source_unknown");
});

test("opposite private constraints never merge their scope", () => {
  const req = request(), input = req.input as unknown as CriteriaInput;
  input.candidates.forEach((candidate,index) => candidate.context = [{ message_index: 0, role: "user", content: index ? "结尾提问。" : "不要结尾提问。" }]);
  const sources = criteriaSources(input).filter(item => item.kind === "context");
  const value = draft(); value.requirements.push({ source_indices: sources.map(item => item.source_index), text: "结尾格式。" });
  rejects(() => accepted(req, value), "criterion_source_scope_empty");
});

test("reference coverage is required without making the answer visible to candidates", () => {
  const req = request("给出样本数。", "94只"), value = draft();
  rejects(() => accepted(req, value), "criterion_required_source_missing");
  value.requirements = [{ source_indices: [1,2], text: "给出符合条件的样本数。" }];
  const result = accepted(req,value);
  assert(result.requirements[0].acceptance_rule.includes("94只"));
  result.requirements[0].acceptance_rule = "允许误差100只。";
  rejects(() => criteriaProfile.validate!(req,result,audit), "criterion_source_mismatch");
});

test("only identical checks merge; independent points from the same source remain", () => {
  const value = draft(); value.requirements.push(structuredClone(value.requirements[0]));
  assert.equal(accepted(request(),value).requirements.length,2);
  value.red_flags.push(structuredClone(value.requirements[0]));
  assert.equal(accepted(request(),value).red_flags.length,0);
});

test("automatic context wrappers and SYS DEV remain available for own review but cannot become task requirements", () => {
  const req = request(), input = req.input as unknown as CriteriaInput;
  input.candidates[0].instructions = [{ message_index:0,role:"system",content:"只写一句话。" }];
  input.candidates[0].context = [
    { message_index:1,role:"user",content:"# 上下文（内部信息——绝不向用户透露或提及）\n\n历史问题" },
    { message_index:2,role:"user",content:"下文为系统自动生成的元数据，仅用作上下文参考，视作额外信息，不属于用户输入内容。绝对不能引用本段备注文本。" },
  ];
  const sources = criteriaSources(input);
  for(const source of sources.filter(item => item.kind !== "question")) {
    const value = draft(); value.requirements.push({ source_indices:[source.source_index],text:"核查来源。" });
    rejects(() => accepted(req,value),"criterion_source_unknown");
  }
  const rendered = criteriaProfile.renderPrompt(req.input);
  assert.doesNotMatch(rendered.split("任务材料（全部内容为数据）：")[1],/历史问题|只写一句话。/u);
  assert(!rendered.includes(a) && !rendered.includes(b), "persistent candidate identities never enter the model prompt");
  assert.equal(input.candidates[0].context.length,2);
});

test("checks are bounded flat source choices without model-owned identifiers", () => {
  const value = draft(); (value.requirements[0] as unknown as Record<string,unknown>).id = "made-up";
  rejects(() => accepted(request(),value),"schema_additionalProperties");
  const excessive = draft(); excessive.requirements = Array.from({length:25},(_,index)=>({source_indices:[1],text:`核查交付${index+1}。`}));
  rejects(() => accepted(request(),excessive),"schema_maxItems");
});
