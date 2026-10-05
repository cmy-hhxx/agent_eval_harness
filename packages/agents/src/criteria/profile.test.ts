import test from "node:test";
import assert from "node:assert/strict";
import { ValidationError, type AgentRequest, type CriteriaInput, type TaskAnalysis } from "@eval/contracts";
import { AgentRegistry } from "@eval/host";
import { criteriaAgent, criteriaProfile, criteriaSources, eligibleCriterionSource, type CriteriaSubmission } from "./index.js";

const first = "7c4e3ba8-8f7c-46cc-b8fb-3016e10ea2dd";
const second = "631f5f98-a2bb-4a68-aabb-11c2e1280f83";
const unknown = "022c352d-46db-44a6-9e26-5426d96baebc";
const newsQuestion = "每天早上8点，过滤噪音，从海量资讯中提取可能引发股价波动的政策、行业新闻。请你结合过去12小时内的全网财经新闻摘要、政策公告、行业快讯。从一名资深投资顾问的视角，从输入的新闻列表中筛选出对股市影响最大的3条信息。对于每一条：1. 用一句话概括核心内容；2. 明确指出利好/利空的具体板块或概念股；3. 给出短期逻辑强度的评级（高/中/低）。拒绝模棱两可的废话。";
const audit = { calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [] };
const request: AgentRequest = { input: {
  question: "给出三家公司的实际仓位和现金比例，现金至少10%。",
  ground_truth: { available: false, value: null },
  candidates: [
    { candidate_id: first, instructions: [], context: [{ message_index: 0, role: "user", content: "把风险提示放在结论之后。" }] },
    { candidate_id: second, instructions: [], context: [{ message_index: 0, role: "user", content: "把风险提示放在结论之前。" },
      { message_index: 1, role: "user", content: "仓位指组合总资产中的比例。" }] },
  ],
}, sources: {} };
const inputOf = (req: AgentRequest) => req.input as unknown as CriteriaInput;

test("selecting a Markdown norm retains the complete section instead of an isolated heading", () => {
  const req = structuredClone(request);
  const section = "## 回答方式\n\n仅投资决策触发风险提示。\n\n### 边界\n\n参考材料与历史提问不得扩大触发范围。";
  inputOf(req).candidates = [{ candidate_id: first, instructions: [], context: [{ message_index: 0, role: "user", content:
    `${section}\n\n## 引用\n\n只引用真实来源。` }] }];
  const sources = criteriaSources(inputOf(req)).filter(source => source.kind === "context");
  assert.deepEqual(sources.map(source => source.text), [section, "## 引用\n\n只引用真实来源。"]);
  const result = criteriaProfile.resolve!(req, { requirements: [{ source_indices: [1] },
    { source_indices: [sources[0]!.source_index] }], scoring_points: [], red_flags: [] }, audit) as TaskAnalysis;
  assert.equal(result.requirements[1]!.text, section);
});
const draftFor = (req: AgentRequest): CriteriaSubmission => ({
  requirements: criteriaSources(inputOf(req)).filter(eligibleCriterionSource).map((source) => ({ source_indices: [source.source_index] })),
  scoring_points: [], red_flags: [],
});
const resolve = (req: AgentRequest, draft: unknown = draftFor(req)) => criteriaProfile.resolve!(req, draft, audit) as TaskAnalysis;
const accepted = (req: AgentRequest, draft: unknown = draftFor(req)) => {
  const result = resolve(req, draft);
  criteriaProfile.validate!(req, result, audit);
  return result;
};
const rejects = (call: () => unknown, code: string) => assert.throws(call,
  (error: unknown) => error instanceof ValidationError && !!error.issues?.some((issue) => issue.code === code));

test("Criteria accepts only source selections and derives opposite candidate constraints without scope expansion", () => {
  assert.deepEqual(Object.keys(criteriaAgent.profiles), ["default"]);
  assert.deepEqual(criteriaProfile.toolNames, []);
  assert.deepEqual(Object.keys(criteriaProfile.toolDescriptions), ["submit_evaluation"]);
  const result = accepted(request);
  assert.equal(result.goal, request.input.question);
  assert.deepEqual(result.requirements[0]!.applies_to, []);
  assert.deepEqual(result.requirements[1]!.applies_to, [first]);
  assert.deepEqual(result.requirements[2]!.applies_to, [second]);
  const draft = draftFor(request);
  draft.requirements[1]!.source_indices.push(draft.requirements[2]!.source_indices[0]!);
  rejects(() => resolve(request, draft), "criterion_source_scope_empty");
  const scoped = structuredClone(result);
  scoped.requirements[1]!.applies_to = [];
  rejects(() => criteriaProfile.validate!(request, scoped, audit), "criterion_source_mismatch");
});

test("source catalogue preserves complete conditional paragraphs and merges identical shared instructions", () => {
  const req = structuredClone(request);
  const text = "对于事实查询，不必在开头给投资风险提示；如果用户要求建议，则先说明风险。";
  inputOf(req).candidates.forEach((candidate) => {
    candidate.instructions = [];
    candidate.context = [{ message_index: 0, role: "user", content: text }];
  });
  const sources = criteriaSources(inputOf(req));
  const source = sources.find((item) => item.kind === "context")!;
  assert.equal(source.text, text);
  assert.equal(source.paths.length, 2);
  assert.deepEqual(source.applies_to, []);
  assert.equal(sources.filter((item) => item.kind === "context").length, 1);
  const result = accepted(req);
  assert.equal(result.requirements[1]!.text, text);
  assert.doesNotMatch(result.requirements[1]!.text, /^禁止/);
  const draft = draftFor(req);
  draft.requirements[1]!.source_indices = [999];
  rejects(() => resolve(req, draft), "criterion_source_unknown");
});

test("structured user text preserves separate complete instruction paragraphs", () => {
  const req = structuredClone(request);
  const paragraphs = ["默认先回答问题，不以风险提示开场。", "只有涉及买卖决策时，在结论后紧跟关键风险；事实查询不触发。"];
  inputOf(req).candidates.forEach(candidate => {
    candidate.instructions = [];
    candidate.context = [{ message_index: 1, role: "user", content: [
      { type: "text", text: paragraphs.join("\n\n") },
    ] }];
  });
  const sources = criteriaSources(inputOf(req)).filter(source => source.kind === "context");
  assert.deepEqual(sources.map(source => source.text), paragraphs);
  assert(sources.every(source => source.applies_to.length === 0));
  const result = accepted(req);
  assert.deepEqual(result.requirements.slice(1).map(criterion => criterion.text), paragraphs);
});

test("actual quality failures cannot invent tolerance, substitute volume/mass units, or invert an exemption", () => {
  for (const example of [
    { question: "按给定统计口径给出同比变化。", reference: "-0.6个百分点", invented: "允许标准答案-0.6个百分点上下±0.1个百分点。" },
    { question: "2014年销量是多少？", reference: "1087.4万千升", invented: "万千升、万吨、万升和1000万升可作同义单位，偏差10%以内符合标准。" },
    { question: "查询实际销量；此类事实查询不必开头提示投资风险。", reference: null, invented: "禁止在开头给投资风险提示。" },
  ]) {
    const req = structuredClone(request);
    req.input.question = example.question;
    req.input.ground_truth = { available: example.reference !== null, value: example.reference };
    const good = accepted(req);
    assert.equal(good.requirements[0]!.text, example.question);
    if (example.reference !== null) assert.equal(good.requirements[1]!.text, example.reference);
    const bad = structuredClone(good);
    bad.requirements[0]!.acceptance_rule = example.invented;
    rejects(() => criteriaProfile.validate!(req, bad, audit), "criterion_source_mismatch");
    bad.requirements[0]!.text = example.invented;
    rejects(() => criteriaProfile.validate!(req, bad, audit), "criterion_source_mismatch");
    const draft = draftFor(req) as unknown as { requirements: Record<string, unknown>[] };
    draft.requirements[0]!.acceptance_rule = example.invented;
    rejects(() => resolve(req, draft), "schema_additionalProperties");
  }
});

test("question and reference remain required source checks and explicit original tolerances survive intact", () => {
  const req = structuredClone(request);
  req.input.ground_truth = { available: true, value: "-0.6个百分点，允许误差±0.1个百分点。" };
  const result = accepted(req);
  assert.equal(result.requirements[1]!.text, "-0.6个百分点，允许误差±0.1个百分点。");
  assert.match(result.requirements[1]!.acceptance_rule, /明确给出容差/);
  for (const sourceIndex of [1, 2]) {
    const draft = draftFor(req);
    const index = draft.requirements.findIndex((criterion) => criterion.source_indices.includes(sourceIndex));
    draft.scoring_points.push(...draft.requirements.splice(index, 1));
    rejects(() => resolve(req, draft), "criterion_required_source_missing");
  }
  const merged = draftFor(req);
  merged.requirements[0]!.source_indices.push(2);
  merged.requirements.splice(1, 1);
  assert.equal(accepted(req, merged).requirements[0]!.text, `${req.input.question}\n\n${result.requirements[1]!.text}`);
  const narrowed = draftFor(req);
  narrowed.requirements[0]!.source_indices.push(narrowed.requirements[2]!.source_indices[0]!);
  const narrowReference = draftFor(req);
  narrowReference.requirements[1]!.source_indices.push(narrowReference.requirements[2]!.source_indices[0]!);
  for (const [draft, source] of [[narrowed, 1], [narrowReference, 2]] as const) {
    let expected: { source_indices: number[] } | undefined;
    assert.throws(() => resolve(req, draft), (error: unknown) => {
      assert(error instanceof ValidationError);
      const issue = error.issues?.find((item) => item.code === "criterion_required_source_missing");
      assert(issue);
      assert.equal(issue.candidate, undefined, "shared coverage is a requirement for the whole candidate group");
      assert.deepEqual(issue.expected, { source_indices: [source] });
      assert.match(issue.message, /单独新增一条公共要求.*全部候选/u);
      expected = issue.expected as { source_indices: number[] };
      return true;
    });
    const repaired = structuredClone(draft);
    repaired.requirements.push({ ...expected! });
    assert.deepEqual(accepted(req, repaired).requirements.at(-1)!.applies_to, []);
  }
});

test("312 question cannot lose its shared scope through two private source combinations", async t => {
  const req = structuredClone(request);
  const question = newsQuestion;
  const risk = "(若属于推荐、预测、买卖建议等投资类问题，请明确地在回答开头提示投资风险)";
  req.input.question = question;
  inputOf(req).candidates.forEach((candidate, index) => {
    candidate.instructions = [];
    candidate.context = [{ message_index: 1, role: "user", content: index === 0 ? `${question}\n${[risk, risk, risk].join("\n")}` : question }];
  });
  const sources = criteriaSources(inputOf(req)).filter(source => source.kind === "context");
  assert.deepEqual(sources.map(source => source.applies_to), [[first], [second]]);
  const draft: CriteriaSubmission = { requirements: sources.map((source) => ({ source_indices: [1, source.source_index] })),
    scoring_points: [], red_flags: [] };
  const formal = accepted(req);
  formal.requirements = sources.map((source, index) => ({
    ...formal.requirements.find(criterion => criterion.applies_to.includes(source.applies_to[0]!))!,
    id: `r${index + 1}`, text: [...new Set([question, source.text])].join("\n\n"),
  }));
  const draftBefore = structuredClone(draft), formalBefore = structuredClone(formal);
  await t.test("source submission requires one shared question criterion", () =>
    rejects(() => resolve(req, draft), "criterion_required_source_missing"));
  await t.test("direct result validation enforces the same shared criterion", () =>
    rejects(() => criteriaProfile.validate!(req, formal, audit), "criterion_required_source_missing"));
  assert.deepEqual(draft, draftBefore);
  assert.deepEqual(formal, formalBefore);
  const repaired = structuredClone(draft);
  repaired.requirements.push({ source_indices: [1] });
  const result = accepted(req, repaired);
  assert.deepEqual(result.requirements.map(criterion => criterion.applies_to), [[first], [second], []]);
  assert.equal(result.requirements[0]!.text, formal.requirements[0]!.text);
});

test("reference requires one shared criterion and may merge with truly common sources", async t => {
  const req = structuredClone(request);
  req.input.ground_truth = { available: true, value: "-0.6个百分点，允许误差±0.1个百分点。" };
  const sources = criteriaSources(inputOf(req)).filter(source => source.kind === "context");
  const draft: CriteriaSubmission = { requirements: [{ source_indices: [1] },
    ...sources.map((source) => ({ source_indices: [2, source.source_index] }))], scoring_points: [], red_flags: [] };
  const formal = accepted(req);
  const reference = formal.requirements.find(criterion => criterion.text === inputOf(req).ground_truth.value)!;
  formal.requirements = [formal.requirements[0]!, ...sources.map((source, index) => ({
    ...reference, id: `r${index + 2}`, text: `${reference.text}\n\n${source.text}`, applies_to: source.applies_to,
  }))];
  await t.test("source submission cannot union private reference scopes", () =>
    rejects(() => resolve(req, draft), "criterion_required_source_missing"));
  await t.test("direct result validation cannot union private reference scopes", () =>
    rejects(() => criteriaProfile.validate!(req, formal, audit), "criterion_required_source_missing"));

  inputOf(req).candidates.forEach(candidate => {
    candidate.instructions = [];
    candidate.context = [{ message_index: 0, role: "user", content: "给出所用统计口径。" }];
  });
  const common = criteriaSources(inputOf(req)).find(source => source.kind === "context")!;
  assert.deepEqual(common.applies_to, []);
  const combined = accepted(req, { requirements: [{ source_indices: [1, 2, common.source_index] }],
    scoring_points: [], red_flags: [] });
  assert.deepEqual(combined.requirements[0]!.applies_to, []);
  assert.equal(combined.requirements[0]!.text, `${req.input.question}\n\n${reference.text}\n\n${common.text}`);
});

test("the program generates criterion IDs and the combined source-selection budget is 24", () => {
  const draft = draftFor(request);
  draft.requirements.reverse();
  assert.deepEqual(accepted(request, draft).requirements.map(item => item.id), ["r1", "r2", "r3", "r4"]);
  (draft.requirements[1] as unknown as Record<string, unknown>).id = "invented";
  rejects(() => accepted(request, draft), "schema_additionalProperties");
  const req = structuredClone(request);
  inputOf(req).candidates = [{ candidate_id: first, instructions: [], context: [{ message_index: 0, role: "user",
    content: Array.from({ length: 24 }, (_, index) => `第${index + 1}项交付要求。`).join("\n\n") }] }];
  const full = draftFor(req), last = full.requirements.pop()!;
  accepted(req, full);
  full.red_flags = [{ ...last }];
  rejects(() => accepted(req, full), "criteria_budget_exceeded");
  const repeated: CriteriaSubmission = { requirements: Array.from({ length: 24 }, () => ({
    source_indices: [1],
  })), scoring_points: [{ source_indices: [1] }], red_flags: [] };
  rejects(() => resolve(request, repeated), "criteria_budget_exceeded");
});

test("identical question and context sources render once while preserving reference coverage and scope", () => {
  const req = structuredClone(request);
  req.input.ground_truth = { available: true, value: "4" };
  inputOf(req).candidates.forEach((candidate) => {
    candidate.instructions = [];
    candidate.context = [{ message_index: 0, role: "user", content: String(req.input.question) }];
  });
  const context = criteriaSources(inputOf(req)).find((source) => source.kind === "context")!;
  const draft: CriteriaSubmission = { requirements: [{ source_indices: [1, context.source_index, 2] }],
    scoring_points: [], red_flags: [] };
  const result = accepted(req, draft);
  assert.equal(result.requirements[0]!.text, `${req.input.question}\n\n4`);
  assert.deepEqual(result.requirements[0]!.applies_to, []);
  const repeated = structuredClone(result);
  repeated.requirements[0]!.text = `${req.input.question}\n\n${req.input.question}\n\n4`;
  rejects(() => criteriaProfile.validate!(req, repeated, audit), "criterion_source_mismatch");
  repeated.requirements[0]!.text = result.requirements[0]!.text;
  repeated.scoring_points.push({ ...repeated.requirements[0]!, id: "s1" });
  rejects(() => criteriaProfile.validate!(req, repeated, audit), "criterion_duplicate");

  inputOf(req).candidates[1]!.context = [];
  const scopedContext = criteriaSources(inputOf(req)).find((source) => source.kind === "context")!;
  draft.requirements.push({ source_indices: [1, 2] });
  draft.requirements[0]!.source_indices = [1, scopedContext.source_index, 2];
  const scoped = accepted(req, draft);
  assert.deepEqual(scoped.requirements[0]!.applies_to, [first]);
  assert.deepEqual(scoped.requirements[1]!.applies_to, []);
  assert.equal(scoped.requirements[0]!.text, scoped.requirements[1]!.text);
});

test("identical user criteria merge while SYS and DEV copies stay outside new submissions", () => {
  const req = structuredClone(request);
  inputOf(req).candidates.forEach((candidate) => { candidate.instructions = []; candidate.context = []; });
  inputOf(req).candidates[0]!.context = [{ message_index: 0, role: "user", content: String(req.input.question) }];
  inputOf(req).candidates[1]!.context = [{ message_index: 0, role: "user", content: String(req.input.question) }];
  const context = criteriaSources(inputOf(req)).find((source) => source.kind === "context")!;
  const repeated: CriteriaSubmission = { requirements: [{ source_indices: [1] }, { source_indices: [context.source_index] }],
    scoring_points: [], red_flags: [] };
  assert.deepEqual(accepted(req, repeated).requirements.map(criterion => criterion.id), ["r1"]);
  repeated.scoring_points.push(repeated.requirements.pop()!);
  assert.deepEqual(accepted(req, repeated).scoring_points, []);

  inputOf(req).candidates[0]!.instructions = [{ message_index: 0, role: "system", content: String(req.input.question) }];
  inputOf(req).candidates[1]!.instructions = [{ message_index: 0, role: "developer", content: String(req.input.question) }];
  inputOf(req).candidates.forEach((candidate) => { candidate.context = []; });
  const result = accepted(req);
  assert.equal(new Set(result.requirements.map((criterion) => criterion.text)).size, 1);
  assert.deepEqual(result.requirements.map((criterion) => criterion.applies_to), [[]]);
});

test("generated summaries and scopes cannot be replaced through direct result validation", () => {
  const result = accepted(request);
  result.goal = "自行新增任务要求";
  rejects(() => criteriaProfile.validate!(request, result, audit), "criteria_summary_not_derived");
  result.goal = String(request.input.question);
  result.requirements[0]!.applies_to = [unknown];
  rejects(() => criteriaProfile.validate!(request, result, audit), "criterion_scope_unknown");
  const duplicate = structuredClone(request);
  inputOf(duplicate).candidates[1]!.candidate_id = first;
  rejects(() => accepted(duplicate), "criteria_candidate_duplicate");
});

test("312 r2 and s1 selecting source3 resolve into one requirement without changing the submitted draft", () => {
  const req = structuredClone(request);
  req.input.question = newsQuestion;
  inputOf(req).candidates[1]!.context.splice(1);
  const draft: CriteriaSubmission = { requirements: [{ source_indices: [1] }, { source_indices: [3] }],
    scoring_points: [{ source_indices: [3] }], red_flags: [] };
  const before = structuredClone(draft), registry = new AgentRegistry([criteriaAgent]);
  const binding = { agent: "criteria", profile: "default", request: req };
  const result = registry.resolve(binding, draft, audit) as TaskAnalysis;
  registry.validate(binding, result, audit);
  assert.deepEqual(result.requirements.map(criterion => criterion.id), ["r1", "r2"]);
  assert.deepEqual(result.scoring_points, []);
  assert.equal(result.requirements[1]!.text, "把风险提示放在结论之前。");
  assert.deepEqual(draft, before);
});

test("exact source choices retain the first item in requirement, red-flag and scoring priority without hiding invalid inputs", () => {
  const draft: CriteriaSubmission = { requirements: [{ source_indices: [1] },
    { source_indices: [1, 2] }, { source_indices: [2, 1] }],
    red_flags: [{ source_indices: [3] }, { source_indices: [3] }],
    scoring_points: [{ source_indices: [2, 1] }, { source_indices: [3] },
      { source_indices: [4] }] };
  const before = structuredClone(draft), result = accepted(request, draft);
  assert.deepEqual(result.requirements.map(criterion => criterion.id), ["r1", "r2"]);
  assert.deepEqual(result.red_flags.map(criterion => criterion.id), ["f1"]);
  assert.deepEqual(result.scoring_points.map(criterion => criterion.id), ["s1"]);
  assert.deepEqual(draft, before);
  const unknownSource = structuredClone(draft);
  unknownSource.scoring_points[0]!.source_indices.push(999);
  rejects(() => resolve(request, unknownSource), "criterion_source_unknown");
  const malformed = structuredClone(draft);
  malformed.requirements[2]!.source_indices.push(0);
  rejects(() => resolve(request, malformed), "schema_minimum");
  const formal = structuredClone(result);
  formal.scoring_points.push({ ...formal.red_flags[0]!, id: "s4" });
  const formalBefore = structuredClone(formal);
  rejects(() => criteriaProfile.validate!(request, formal, audit), "criterion_duplicate");
  assert.deepEqual(formal, formalBefore);
});

test("identical text with a distinct reference acceptance rule does not merge", () => {
  const req = structuredClone(request);
  req.input.ground_truth = { available: true, value: req.input.question };
  const result = accepted(req, { requirements: [{ source_indices: [1] }, { source_indices: [2] }],
    scoring_points: [], red_flags: [] });
  assert.deepEqual(result.requirements.map(criterion => criterion.id), ["r1", "r2"]);
  assert.equal(result.requirements[0]!.text, result.requirements[1]!.text);
  assert.notEqual(result.requirements[0]!.acceptance_rule, result.requirements[1]!.acceptance_rule);
});

test("criteria request excludes answers and the model only selects numeric catalogue entries", () => {
  const rendered = criteriaProfile.renderPrompt(request.input);
  assert.match(rendered, /source_catalog/);
  assert.match(rendered, /\/candidates\/0\/context\/0\/content/);
  const contaminated = structuredClone(request);
  (contaminated.input.candidates as Record<string, unknown>[])[0]!.final_answer = "仓位35%、35%、20%，现金10%。";
  rejects(() => resolve(contaminated), "schema_additionalProperties");
  const draft = draftFor(request) as unknown as Record<string, unknown>;
  draft.goal = "自行拟定目标";
  rejects(() => resolve(request, draft), "schema_additionalProperties");
});


test("actual SYS/DEV roles never become task criteria even when identical across all known candidates", () => {
  const req = structuredClone(request);
  req.input.ground_truth = { available: true, value: "4" };
  const input = inputOf(req);
  input.candidates.forEach(candidate => {
    candidate.instructions = [{ message_index: 0, role: "system", content: "仅投资决策触发风险开场。" },
      { message_index: 1, role: "developer", content: "保持内部工具细节保密。" }];
    candidate.context = [];
  });
  const before = structuredClone(input);
  const catalogue = criteriaSources(input), eligible = catalogue.filter(eligibleCriterionSource);
  assert.deepEqual(eligible.map(source => source.kind), ["question", "reference"]);
  assert.deepEqual(eligible.map(source => source.source_index), [1, 2]);
  assert.deepEqual(catalogue.filter(source => !eligibleCriterionSource(source)).map(source => source.role), ["system", "developer"]);
  const sys = catalogue.find(source => source.role === "system")!;
  rejects(() => resolve(req, { requirements: [{ source_indices: [1] }, { source_indices: [2] },
    { source_indices: [sys.source_index] }], scoring_points: [], red_flags: [] }), "criterion_source_unknown");
  const grounded = accepted(req);
  grounded.requirements.push({ ...grounded.requirements[0]!, id: "r3", text: sys.text });
  criteriaProfile.validate!(req, grounded, audit);
  const rendered = criteriaProfile.renderPrompt(req.input);
  assert.doesNotMatch(rendered, /仅投资决策触发风险开场|保持内部工具细节保密/u);
  assert.deepEqual(accepted(req).requirements.map(criterion => criterion.text), [input.question, "4"]);
  assert.deepEqual(input, before, "own instruction materials remain intact for later stages");
  const scoped = structuredClone(req);
  inputOf(scoped).candidates[0]!.context = [{ message_index: 2, role: "user", content: "仅本轮回答附单位。" }];
  const user = criteriaSources(inputOf(scoped)).find(source => source.role === "user")!;
  assert.equal(user.source_index, 5, "model catalogue preserves program indices after excluded SYS/DEV entries");
  const selected = accepted(scoped, { requirements: [{ source_indices: [1] }, { source_indices: [2] },
    { source_indices: [user.source_index] }], scoring_points: [], red_flags: [] });
  assert.deepEqual(selected.requirements[2]!.applies_to, [first]);
  assert.equal(selected.requirements[2]!.text, user.text);
  input.candidates.push({ candidate_id: unknown, instructions: [], context: [] });
  const after = criteriaSources(input).filter(eligibleCriterionSource);
  assert.deepEqual(after.map(source => source.source_index), [1, 2]);
  assert(after.every(source => source.applies_to.length === 0));
  assert.equal(accepted(req).requirements.length, 2, "an unavailable third-party SYS creates no assumed obligation");
});
