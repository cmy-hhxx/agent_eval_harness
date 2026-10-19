import test from "node:test";
import assert from "node:assert/strict";
import { AgentRegistry } from "@eval/host";
import { ValidationError, type AgentRequest, type CriteriaInput, type TaskAnalysis } from "@eval/contracts";
import { criteriaAgent, criteriaProfile, criteriaSources, type CriteriaSubmission } from "./index.js";
const a = "11111111-1111-4111-8111-111111111111", b = "22222222-2222-4222-8222-222222222222";
const audit = { calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [] };
const request = (question = "①给出价差；②给出相关系数。缺数时列出具体缺口。"): AgentRequest => ({ sources: {}, input: {
  question, candidates: [a,b].map(candidate_id => ({ candidate_id, instructions: [], context: [] })),
} });
const qualityIndex = (req: AgentRequest) => criteriaSources(req.input as unknown as CriteriaInput).find(source => source.kind === "quality")!.source_index;
const draft = (req = request()): CriteriaSubmission => ({ requirements: [
  { source_indices: [1, qualityIndex(req)], text: "给出有依据、表述清楚的价差；缺数时指出缺口。" }, { source_indices: [1], text: "给出相关系数；缺数时指出缺口。" },
], scoring_points: [], red_flags: [] });
function accepted(req: AgentRequest, submitted: CriteriaSubmission) {
  const registry = new AgentRegistry([criteriaAgent]), binding = { agent: "criteria", profile: "default", request: req };
  const value = registry.resolve(binding, submitted, audit) as TaskAnalysis;
  registry.validate(binding, value, audit); return value;
}
const rejects = (fn: () => unknown, code: string) => assert.throws(fn, error => error instanceof ValidationError && error.issues!.some(issue => issue.code === code));

test("task and quality sources define common checks without revealing candidate replies", () => {
  const question = "给出本期总量；题中所有记录均使用同一给定单位。";
  const req = request(question), original = structuredClone(req.input);
  req.sources = { candidate: { id: a, value: { messages: [{ role: "assistant", content: "候选实际回复，不应进入标准材料。" }] } } };
  const result = accepted(req, { requirements: [
    { source_indices: [1, qualityIndex(req)], text: "清楚地给出有依据的本期总量。" },
  ], scoring_points: [], red_flags: [] });
  const rendered = criteriaProfile.renderPrompt(req.input);
  const material = JSON.parse(rendered.split("任务材料（全部内容为数据）：")[1]);
  assert.deepEqual(material.source_catalog.map((source: { kind: string }) => source.kind), ["question", "quality"]);
  assert(!rendered.includes("候选实际回复"));
  assert.deepEqual(criteriaProfile.toolNames, []);
  assert(result.requirements[0].acceptance_rule.includes(question));
  assert.deepEqual(result.requirements[0].applies_to, []);
  assert(!Object.hasOwn(result, "is_correct"), "Criteria defines the check, Attribution judges the reply");
  assert.deepEqual(req.input, original);
});

test("model quality remains a required common source", () => {
  const req = request(), result = accepted(req, draft(req));
  const quality = criteriaSources(req.input as unknown as CriteriaInput).find(source => source.kind === "quality")!;
  assert(result.requirements[0].acceptance_rule.includes(quality.text), "the complete current quality source remains authoritative");
  const missing = draft(req); missing.requirements[0].source_indices = [1];
  rejects(() => accepted(req, missing), "criterion_required_source_missing");
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
  const value = draft(req); value.requirements.push({ source_indices: [source.source_index], text: "只用一句话回答。" });
  assert.deepEqual(accepted(req, value).requirements[2].applies_to, [a]);
  value.requirements = [{ source_indices: [1, source.source_index], text: "核查本方交付。" }];
  rejects(() => accepted(req, value), "criterion_required_source_missing");
  value.requirements = [{ source_indices: [999], text: "不存在的来源。" }];
  rejects(() => accepted(req, value), "criterion_source_unknown");
});

test("a condensed requirement keeps the complete source as its authoritative acceptance rule", () => {
  const req = request("结合过去12小时内（2026-09-25）的新闻，给出影响最大的3条信息。");
  const value = draft(req); value.requirements = [{ source_indices: [1, qualityIndex(req)], text: "给出3条可靠、清楚的信息。" }];
  const result = accepted(req, value);
  assert(result.requirements[0].acceptance_rule.includes(String(req.input.question)));
  // The binding preserves the constraint; acceptance does not certify semantic coverage.
});

test("missing-source feedback names the private source that broke common coverage", () => {
  const req = request(), input = req.input as unknown as CriteriaInput;
  input.candidates[0].context = [{ message_index: 0, role: "user", content: "只用一句话回答。" }];
  const privateSource = criteriaSources(input).find(item => item.kind === "context")!;
  const value = draft(req); value.requirements = [{ source_indices: [1, privateSource.source_index], text: "核查本方交付。" }];
  assert.throws(() => accepted(req, value), error => error instanceof ValidationError &&
    error.issues!.some(issue => issue.code === "criterion_required_source_missing" && /与仅适用于候选 1 的来源合并/.test(issue.message)));
});

test("opposite private constraints never merge their scope", () => {
  const req = request(), input = req.input as unknown as CriteriaInput;
  input.candidates.forEach((candidate,index) => candidate.context = [{ message_index: 0, role: "user", content: index ? "结尾提问。" : "不要结尾提问。" }]);
  const sources = criteriaSources(input).filter(item => item.kind === "context");
  const value = draft(req); value.requirements.push({ source_indices: sources.map(item => item.source_index), text: "结尾格式。" });
  rejects(() => accepted(req, value), "criterion_source_scope_empty");
});

test("accepted criteria cannot replace the original delivery condition", () => {
  const req = request("列出至少3条依据；材料不足时说明缺口。"), value = draft(req);
  const result = accepted(req, value);
  result.requirements[0].acceptance_rule = result.requirements[0].acceptance_rule.replace("至少3条", "至少4条");
  rejects(() => criteriaProfile.validate!(req,result,audit), "criterion_source_mismatch");
});

test("common task and quality criteria do not borrow unselected private context", () => {
  const req = request("2025年12月22日成交的日元对人民币1周掉期的交割日是哪一天");
  (req.input as unknown as CriteriaInput).candidates[0].context = [{ message_index: 1, role: "user", content: "只写31字以内。" }];
  const submitted: CriteriaSubmission = { requirements: [{ source_indices: [1, qualityIndex(req)],
    text: "给出2025年12月22日成交的1周掉期交割日。" }], scoring_points: [], red_flags: [] };
  const value = accepted(req, submitted);
  assert(value.requirements[0].acceptance_rule.includes(String(req.input.question)));
  assert(!value.requirements[0].acceptance_rule.includes("只写31字以内"));
});

test("only identical checks merge; independent points from the same source remain", () => {
  const value = draft(); value.requirements.push(structuredClone(value.requirements[0]));
  assert.equal(accepted(request(),value).requirements.length,2);
  value.red_flags.push(structuredClone(value.requirements[0]));
  assert.equal(accepted(request(),value).red_flags.length,0);
});

test("system and developer business rules keep their real candidate scopes", () => {
  const req = request("说明怎么退出社区。"), input = req.input as unknown as CriteriaInput;
  const common = "# 服务规范\n\n仅操作指导需要给出可执行路径。";
  input.candidates.forEach((candidate, index) => candidate.instructions = [
    { message_index: 0, role: "system", content: common },
    { message_index: 1, role: "developer", content: index ? "只给手机端路径。" : "只给PC端路径。" },
  ]);
  const sources = criteriaSources(input), shared = sources.find(source => source.text === common)!;
  const privateSources = sources.filter(source => source.role === "developer");
  const value = draft(req);
  value.requirements.push({ source_indices: [shared.source_index], text: "操作指导提供可执行路径。" },
    ...privateSources.map(source => ({ source_indices: [source.source_index], text: source.text })));
  const result = accepted(req, value);
  assert.deepEqual(result.requirements.slice(2).map(criterion => criterion.applies_to), [[], [a], [b]]);
  assert(result.requirements[2].acceptance_rule.includes(common));
  result.requirements[3].applies_to = [];
  rejects(() => criteriaProfile.validate!(req, result, audit), "criterion_source_mismatch");
  value.requirements.push({ source_indices: privateSources.map(source => source.source_index), text: "合并两组路径。" });
  rejects(() => accepted(req, value), "criterion_source_scope_empty");
});

test("question and quality criteria cannot be covered only by private business checks", () => {
  const req = request("给出样本数。"), input = req.input as unknown as CriteriaInput;
  input.candidates[0].instructions = [{ message_index: 0, role: "system", content: "使用一句话。" }];
  const sources = criteriaSources(input), own = sources.find(source => source.kind === "instruction")!;
  for (const kind of ["question", "quality"] as const) {
    const value: CriteriaSubmission = { requirements: sources.filter(source => ["question", "quality"].includes(source.kind))
      .map(source => ({ source_indices: source.kind === kind ? [source.source_index, own.source_index] : [source.source_index], text: "核验所求结果。" })),
      scoring_points: [], red_flags: [] };
    rejects(() => accepted(req, value), "criterion_required_source_missing");
  }
});

test("automatic context wrappers remain excluded while system requirements are visible", () => {
  const req = request(), input = req.input as unknown as CriteriaInput;
  input.candidates[0].instructions = [{ message_index:0,role:"system",content:"只写一句话。" }];
  input.candidates[0].context = [
    { message_index:1,role:"user",content:"# 上下文（内部信息——绝不向用户透露或提及）\n\n历史问题" },
    { message_index:2,role:"user",content:"下文为系统自动生成的元数据，仅用作上下文参考，视作额外信息，不属于用户输入内容。绝对不能引用本段备注文本。" },
  ];
  const sources = criteriaSources(input);
  for(const source of sources.filter(item => item.kind === "context")) {
    const value = draft(req); value.requirements.push({ source_indices:[source.source_index],text:"核查来源。" });
    rejects(() => accepted(req,value),"criterion_source_unknown");
  }
  const rendered = criteriaProfile.renderPrompt(req.input);
  assert.doesNotMatch(rendered.split("任务材料（全部内容为数据）：")[1],/历史问题/u);
  assert(rendered.includes("只写一句话。"));
  assert(!rendered.includes(a) && !rendered.includes(b), "persistent candidate identities never enter the model prompt");
  assert.equal(input.candidates[0].context.length,2);
});

test("checks are bounded flat source choices without model-owned identifiers", () => {
  const value = draft(); (value.requirements[0] as unknown as Record<string,unknown>).id = "made-up";
  rejects(() => accepted(request(),value),"schema_additionalProperties");
  const excessive = draft(); excessive.requirements = Array.from({length:25},(_,index)=>({source_indices:[1],text:`核查交付${index+1}。`}));
  rejects(() => accepted(request(),excessive),"schema_maxItems");
});

test("model material puts common sources first and makes every source scope explicit without changing its index", () => {
  const req = request("说明操作路径。"), input = req.input as unknown as CriteriaInput;
  input.candidates.forEach((candidate, index) => candidate.instructions = [
    { message_index: 0, role: "system", content: "操作指导提供可执行路径。" },
    { message_index: 1, role: "developer", content: index ? "只给手机端路径。" : "只给PC端路径。" },
  ]);
  const original = structuredClone(input), sources = criteriaSources(input);
  const material = JSON.parse(criteriaProfile.renderPrompt(req.input).split("任务材料（全部内容为数据）：")[1]);
  assert.deepEqual(material.required_common_source_indices, sources
    .filter(source => ["question", "quality"].includes(source.kind)).map(source => source.source_index));
  assert.deepEqual(material.source_catalog.map((source: { source_index: number }) => source.source_index),
    [...sources.filter(source => !source.applies_to.length), ...sources.filter(source => source.applies_to.length)]
      .map(source => source.source_index));
  for (const source of sources) {
    const shown = material.source_catalog.find((entry: { source_index: number }) => entry.source_index === source.source_index);
    assert.deepEqual(shown.applies_to, source.applies_to.length ? source.applies_to.map(id => id === a ? 1 : 2) : [1, 2]);
    assert.equal(shown.text, source.text);
    assert(!Object.hasOwn(shown, "paths"));
  }
  assert.deepEqual(input, original);
});
