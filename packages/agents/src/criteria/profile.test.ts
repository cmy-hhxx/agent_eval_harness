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

test("reference answers remain verification data rather than selectable task requirements", () => {
  const question = "给出本期总量；题中所有记录均使用同一给定单位。";
  for (const reference of ["本期总量94，第一阶段31，第二阶段63。", question, { total: 94, intermediate: [31, 63] }]) {
    const req = request(question, reference), original = structuredClone(req.input);
    const result = accepted(req, { requirements: [{ source_indices: [1], text: "给出本期总量。" }], scoring_points: [], red_flags: [] });
    const rendered = criteriaProfile.renderPrompt(req.input);
    const material = JSON.parse(rendered.split("任务材料（全部内容为数据）：")[1]);
    assert(material.source_catalog.every((source: { kind: string }) => source.kind !== "reference"));
    assert(result.requirements[0].acceptance_rule.includes(question));
    assert.deepEqual(req.input, original, "the complete standard remains available to downstream stages");
    rejects(() => accepted(req, { requirements: [{ source_indices: [1, 2], text: "给出本期总量及标准附加项。" }],
      scoring_points: [], red_flags: [] }), "criterion_source_unknown");
  }
});

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

test("a condensed requirement keeps the complete source as its authoritative acceptance rule", () => {
  const req = request("结合过去12小时内（2026-09-25）的新闻，给出影响最大的3条信息。");
  const value = draft(); value.requirements = [{ source_indices: [1], text: "给出3条信息。" }];
  const result = accepted(req, value);
  assert(result.requirements[0].acceptance_rule.includes(String(req.input.question)));
  // The binding preserves the constraint; acceptance does not certify semantic coverage.
});

test("equivalent comparison writings retain their original constraint source", () => {
  const req = request("筛选：5日均线>10日均线，90%集中度<20%。");
  const value = draft(); value.requirements = [{ source_indices: [1], text: "5日均线大于10日均线；90%集中度小于20%。" }];
  accepted(req, value);
});

test("a comparison against a dated price does not turn the year into a numeric bound", () => {
  const req = request("截止2026年6月5日，有多少股票低于年初的收盘价？", "低于2025年12-31（年初）的收盘价有3387家");
  const value = draft();
  value.requirements = [{ source_indices: [1], text: "截止2026年6月5日，核查收盘价低于年初收盘价的股票数量。" }];
  accepted(req, value);
});

test("event names and equivalent numerical wording preserve their full source without regex verdicts", () => {
  const question = "截止2026年6月5日，有多少股票低于924行情启动时的价格，且价格低于10元？";
  const req = request(question, "低于2024年9-23（924行情启动时）的收盘价有559家");
  const submitted: CriteriaSubmission = { requirements: [{ source_indices: [1],
    text: "截至2026年6月5日，核查低于‘924行情启动时’价格且不足十元的股票数量。" }], scoring_points: [], red_flags: [] };
  const value = accepted(req, submitted);
  assert(value.requirements[0].acceptance_rule.includes(question));
  assert.equal(value.requirements[0].text, submitted.requirements[0].text);
});

test("missing-source feedback names the private source that broke common coverage", () => {
  const req = request(), input = req.input as unknown as CriteriaInput;
  input.candidates[0].context = [{ message_index: 0, role: "user", content: "只用一句话回答。" }];
  const privateSource = criteriaSources(input).find(item => item.kind === "context")!;
  const value = draft(); value.requirements = [{ source_indices: [1, privateSource.source_index], text: "核查本方交付。" }];
  assert.throws(() => accepted(req, value), error => error instanceof ValidationError &&
    error.issues!.some(issue => issue.code === "criterion_required_source_missing" && /与仅适用于候选 1 的来源合并/.test(issue.message)));
});

test("opposite private constraints never merge their scope", () => {
  const req = request(), input = req.input as unknown as CriteriaInput;
  input.candidates.forEach((candidate,index) => candidate.context = [{ message_index: 0, role: "user", content: index ? "结尾提问。" : "不要结尾提问。" }]);
  const sources = criteriaSources(input).filter(item => item.kind === "context");
  const value = draft(); value.requirements.push({ source_indices: sources.map(item => item.source_index), text: "结尾格式。" });
  rejects(() => accepted(req, value), "criterion_source_scope_empty");
});

test("a reference cannot be injected into a requirement's authoritative source", () => {
  const req = request("给出样本数。", "94只"), value = draft();
  value.requirements = [{ source_indices: [1], text: "给出符合条件的样本数。" }];
  const result = accepted(req,value);
  assert(!result.requirements[0].acceptance_rule.includes("94只"));
  result.requirements[0].acceptance_rule = "94只\n\n" + result.requirements[0].acceptance_rule;
  rejects(() => criteriaProfile.validate!(req,result,audit), "criterion_source_mismatch");
});

test("a question-only rubric binds the original question without borrowing unselected context", () => {
  const req = request("2025年12月22日成交的日元对人民币1周掉期的交割日是哪一天");
  (req.input as unknown as CriteriaInput).candidates[0].context = [{ message_index: 1, role: "user", content: "只写31字以内。" }];
  const submitted: CriteriaSubmission = { requirements: [{ source_indices: [1],
    text: "给出2025年12月22日成交的1周掉期交割日。" }], scoring_points: [], red_flags: [] };
  const value = accepted(req, submitted);
  assert(value.requirements[0].acceptance_rule.includes(String(req.input.question)));
  assert(!value.requirements[0].acceptance_rule.includes("只写31字以内"));
});

test("numeric conditions from the question retain equivalent wording without prefilled answers", () => {
  accepted(request("2026年0322主力净流入前三行业是什么？"), {
    requirements: [{ source_indices: [1], text: "给出2026年3月22日主力净流入前三行业。" }], scoring_points: [], red_flags: [],
  });
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
