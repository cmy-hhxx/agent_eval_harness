import test from "node:test";
import assert from "node:assert/strict";
import { ValidationError, type AgentRequest, type CriteriaInput, type TaskAnalysis } from "@eval/contracts";
import { criteriaAgent, criteriaProfile, criteriaSources, type CriteriaSubmission } from "./index.js";

const first = "7c4e3ba8-8f7c-46cc-b8fb-3016e10ea2dd";
const second = "631f5f98-a2bb-4a68-aabb-11c2e1280f83";
const unknown = "022c352d-46db-44a6-9e26-5426d96baebc";
const audit = { calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [] };
const request: AgentRequest = { input: {
  question: "给出三家公司的实际仓位和现金比例，现金至少10%。",
  ground_truth: { available: false, value: null },
  candidates: [
    { candidate_id: first, instructions: [{ message_index: 0, role: "system", content: "把风险提示放在结论之后。" }], context: [] },
    { candidate_id: second, instructions: [{ message_index: 0, role: "developer", content: "把风险提示放在结论之前。" }],
      context: [{ message_index: 1, role: "user", content: "仓位指组合总资产中的比例。" }] },
  ],
}, sources: {} };
const inputOf = (req: AgentRequest) => req.input as unknown as CriteriaInput;
const draftFor = (req: AgentRequest): CriteriaSubmission => ({
  requirements: criteriaSources(inputOf(req)).map((source, index) => ({ id: `r${index + 1}`, source_ids: [source.id] })),
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
  draft.requirements[1]!.source_ids.push(draft.requirements[2]!.source_ids[0]!);
  rejects(() => resolve(request, draft), "criterion_source_scope_empty");
  const scoped = structuredClone(result);
  scoped.requirements[1]!.applies_to = [];
  rejects(() => criteriaProfile.validate!(request, scoped, audit), "criterion_source_mismatch");
});

test("source catalogue preserves complete conditional paragraphs and merges identical shared instructions", () => {
  const req = structuredClone(request);
  const text = "对于事实查询，不必在开头给投资风险提示；如果用户要求建议，则先说明风险。";
  inputOf(req).candidates.forEach((candidate) => { candidate.instructions = [{ message_index: 0, role: "system", content: text }]; });
  const sources = criteriaSources(inputOf(req));
  const source = sources.find((item) => item.kind === "instruction")!;
  assert.equal(source.text, text);
  assert.equal(source.paths.length, 2);
  assert.deepEqual(source.applies_to, []);
  assert.equal(sources.filter((item) => item.kind === "instruction").length, 1);
  const result = accepted(req);
  assert.equal(result.requirements[1]!.text, text);
  assert.doesNotMatch(result.requirements[1]!.text, /^禁止/);
  const draft = draftFor(req);
  draft.requirements[1]!.source_ids = ["禁止在开头给投资风险提示"];
  rejects(() => resolve(req, draft), "criterion_source_unknown");
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
  for (const id of ["question", "reference"]) {
    const draft = draftFor(req);
    const index = draft.requirements.findIndex((criterion) => criterion.source_ids.includes(id));
    draft.scoring_points.push(...draft.requirements.splice(index, 1));
    rejects(() => resolve(req, draft), "criterion_required_source_missing");
  }
  const merged = draftFor(req);
  merged.requirements[0]!.source_ids.push("reference");
  merged.requirements.splice(1, 1);
  assert.equal(accepted(req, merged).requirements[0]!.text, `${req.input.question}\n\n${result.requirements[1]!.text}`);
  const narrowed = draftFor(req);
  narrowed.requirements[0]!.source_ids.push(narrowed.requirements[2]!.source_ids[0]!);
  const narrowReference = draftFor(req);
  narrowReference.requirements[1]!.source_ids.push(narrowReference.requirements[2]!.source_ids[0]!);
  for (const [draft, source] of [[narrowed, "question"], [narrowReference, "reference"]] as const) {
    let expected: { source_ids: string[] } | undefined;
    assert.throws(() => resolve(req, draft), (error: unknown) => {
      assert(error instanceof ValidationError);
      const issue = error.issues?.find((item) => item.code === "criterion_required_source_missing");
      assert(issue);
      assert.equal(issue.candidate, second);
      assert.deepEqual(issue.expected, { source_ids: [source] });
      assert.match(issue.message, /单独新增一条公共要求.*全部候选/u);
      expected = issue.expected as { source_ids: string[] };
      return true;
    });
    const repaired = structuredClone(draft);
    repaired.requirements.push({ id: "rrepair", ...expected! });
    assert.deepEqual(accepted(req, repaired).requirements.at(-1)!.applies_to, []);
  }
});

test("criterion IDs remain global identifiers and the combined source-selection budget is 24", () => {
  const draft = draftFor(request);
  draft.requirements.reverse();
  accepted(request, draft);
  draft.requirements[1]!.id = draft.requirements[0]!.id;
  rejects(() => accepted(request, draft), "criterion_id_duplicate");
  const req = structuredClone(request);
  inputOf(req).candidates = [{ candidate_id: first, instructions: [], context: [{ message_index: 0, role: "user",
    content: Array.from({ length: 24 }, (_, index) => `第${index + 1}项交付要求。`).join("\n\n") }] }];
  const full = draftFor(req), last = full.requirements.pop()!;
  accepted(req, full);
  full.red_flags = [{ ...last, id: "f1" }];
  rejects(() => accepted(req, full), "criteria_budget_exceeded");
});

test("identical question and context sources render once while preserving reference coverage and scope", () => {
  const req = structuredClone(request);
  req.input.ground_truth = { available: true, value: "4" };
  inputOf(req).candidates.forEach((candidate) => {
    candidate.instructions = [];
    candidate.context = [{ message_index: 0, role: "user", content: String(req.input.question) }];
  });
  const context = criteriaSources(inputOf(req)).find((source) => source.kind === "context")!;
  const draft: CriteriaSubmission = { requirements: [{ id: "r1", source_ids: ["question", context.id, "reference"] }],
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
  draft.requirements.push({ id: "r2", source_ids: ["question", "reference"] });
  draft.requirements[0]!.source_ids = ["question", scopedContext.id, "reference"];
  const scoped = accepted(req, draft);
  assert.deepEqual(scoped.requirements[0]!.applies_to, [first]);
  assert.deepEqual(scoped.requirements[1]!.applies_to, []);
  assert.equal(scoped.requirements[0]!.text, scoped.requirements[1]!.text);
});

test("duplicate generated criteria are rejected across groups, but identical text with distinct scopes remains legal", () => {
  const req = structuredClone(request);
  inputOf(req).candidates.forEach((candidate) => { candidate.instructions = []; candidate.context = []; });
  inputOf(req).candidates[0]!.context = [{ message_index: 0, role: "user", content: String(req.input.question) }];
  inputOf(req).candidates[1]!.context = [{ message_index: 0, role: "user", content: String(req.input.question) }];
  const context = criteriaSources(inputOf(req)).find((source) => source.kind === "context")!;
  const repeated: CriteriaSubmission = { requirements: [{ id: "r1", source_ids: ["question"] }, { id: "r2", source_ids: [context.id] }],
    scoring_points: [], red_flags: [] };
  rejects(() => resolve(req, repeated), "criterion_duplicate");
  repeated.scoring_points.push(repeated.requirements.pop()!);
  rejects(() => resolve(req, repeated), "criterion_duplicate");

  inputOf(req).candidates[0]!.instructions = [{ message_index: 0, role: "system", content: String(req.input.question) }];
  inputOf(req).candidates[1]!.instructions = [{ message_index: 0, role: "developer", content: String(req.input.question) }];
  inputOf(req).candidates.forEach((candidate) => { candidate.context = []; });
  const result = accepted(req);
  assert.equal(new Set(result.requirements.map((criterion) => criterion.text)).size, 1);
  assert.deepEqual(result.requirements.map((criterion) => criterion.applies_to), [[], [first], [second]]);
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

test("criteria request excludes answers and the model can only submit catalogue source IDs", () => {
  const rendered = criteriaProfile.renderPrompt(request.input);
  assert.match(rendered, /source_catalog/);
  assert.match(rendered, /\/candidates\/0\/instructions\/0\/content/);
  const contaminated = structuredClone(request);
  (contaminated.input.candidates as Record<string, unknown>[])[0]!.final_answer = "仓位35%、35%、20%，现金10%。";
  rejects(() => resolve(contaminated), "schema_additionalProperties");
  const draft = draftFor(request) as unknown as Record<string, unknown>;
  draft.goal = "自行拟定目标";
  rejects(() => resolve(request, draft), "schema_additionalProperties");
});
