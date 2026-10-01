import test from "node:test";
import assert from "node:assert/strict";
import { ValidationError, type AgentRequest, type TaskAnalysis, type TaskCriterion } from "@eval/contracts";
import { criteriaAgent, criteriaProfile } from "./index.js";

const first = "7c4e3ba8-8f7c-46cc-b8fb-3016e10ea2dd";
const second = "631f5f98-a2bb-4a68-aabb-11c2e1280f83";
const unknown = "022c352d-46db-44a6-9e26-5426d96baebc";
const audit = { calls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [] };
const request: AgentRequest = {
  input: {
    question: "给出三家公司的实际仓位和现金比例，现金至少10%。",
    ground_truth: { available: false, value: null },
    candidates: [
      { candidate_id: first, instructions: [{ message_index: 0, role: "system", content: "把风险提示放在结论之后。" }], context: [] },
      { candidate_id: second, instructions: [{ message_index: 0, role: "developer", content: "把风险提示放在结论之前。" }],
        context: [{ message_index: 1, role: "user", content: "仓位指组合总资产中的比例。" }] },
    ],
  },
  sources: {},
};
const criterion = (id: string, text: string, acceptance_rule: string, applies_to: string[] = []): TaskCriterion =>
  ({ id, text, applies_to, acceptance_rule });
const result: TaskAnalysis = {
  task_type: "组合仓位交付",
  goal: "给出三家公司与现金的实际仓位",
  requirements: [
    criterion("r1", "交付实际仓位", "列出三家公司和现金各自占组合总资产的比例，比例合计100%。"),
    criterion("r2", "现金满足下限", "已交付的现金比例不低于10%。"),
    criterion("r3", "风险提示在结论之后", "最终回答中风险提示位于仓位结论之后。", [first]),
    criterion("r4", "风险提示在结论之前", "最终回答中风险提示位于仓位结论之前。", [second]),
  ],
  scoring_points: [],
  red_flags: [],
};
const rejects = (input: AgentRequest, output: unknown, code: string) =>
  assert.throws(() => criteriaProfile.validate!(input, output, audit),
    (error: unknown) => error instanceof ValidationError && !!error.issues?.some((issue) => issue.code === code));

test("Criteria prepares shared acceptance rules and separately scoped opposite candidate constraints", () => {
  assert.deepEqual(Object.keys(criteriaAgent.profiles), ["default"]);
  assert.deepEqual(criteriaProfile.toolNames, []);
  assert.deepEqual(Object.keys(criteriaProfile.toolDescriptions), ["submit_evaluation", "submit_evaluation_file"]);
  criteriaProfile.validate!(request, result, audit);
  const standalone = structuredClone(request);
  (standalone.input.candidates as unknown[]).pop();
  const single = structuredClone(result);
  single.requirements.pop();
  criteriaProfile.validate!(standalone, single, audit);
});

test("criterion IDs are global identifiers independent of array position", () => {
  const reordered = structuredClone(result);
  reordered.requirements.reverse();
  criteriaProfile.validate!(request, reordered, audit);
  const duplicate = structuredClone(result);
  duplicate.scoring_points = [criterion("r1", "额外可用分析", "提供独立支撑任务的分析。")];
  rejects(request, duplicate, "criterion_id_duplicate");
});

test("criterion scopes use only actual input UUIDs and reject duplicate or named candidate scopes", () => {
  const scoped = structuredClone(result);
  scoped.requirements[0]!.applies_to = [unknown];
  rejects(request, scoped, "criterion_scope_unknown");
  scoped.requirements[0]!.applies_to = ["a_fast"];
  rejects(request, scoped, "schema_pattern");
  scoped.requirements[0]!.applies_to = [first, first];
  rejects(request, scoped, "schema_uniqueItems");
  const duplicate = structuredClone(request);
  (duplicate.input.candidates as { candidate_id: string }[])[1]!.candidate_id = first;
  rejects(duplicate, result, "criteria_candidate_duplicate");
});

test("criteria budget is shared across all three arrays and permits exactly 24 independent checks", () => {
  const full = structuredClone(result);
  full.requirements = Array.from({ length: 24 }, (_, index) =>
    criterion(`r${index + 1}`, `验收项${index + 1}`, `核对所要求的第${index + 1}项交付。`));
  criteriaProfile.validate!(request, full, audit);
  full.red_flags = [criterion("f1", "禁止项", "核对任务明确禁止的行为。")];
  rejects(request, full, "criteria_budget_exceeded");
  full.requirements = [];
  rejects(request, full, "schema_minItems");
});

test("every candidate has at least one applicable requirement before answer assessment", () => {
  const scoped = structuredClone(result);
  scoped.requirements = [criterion("r1", "本候选格式", "第一候选使用指定格式。", [first])];
  rejects(request, scoped, "criterion_requirement_scope_empty");
  scoped.requirements.push(criterion("r2", "另一候选格式", "第二候选使用其指定格式。", [second]));
  criteriaProfile.validate!(request, scoped, audit);
  scoped.requirements = [criterion("r1", "共同核心交付", "两候选均交付题目所求的仓位比例。")];
  criteriaProfile.validate!(request, scoped, audit);
});

test("criteria material cannot carry candidate answers or assistant conversations", () => {
  const contaminated = structuredClone(request);
  (contaminated.input.candidates as Record<string, unknown>[])[0]!.final_answer = "仓位35%、35%、20%，现金10%。";
  rejects(contaminated, result, "schema_additionalProperties");
  delete (contaminated.input.candidates as Record<string, unknown>[])[0]!.final_answer;
  ((contaminated.input.candidates as { context: unknown[] }[])[0]!.context).push({
    message_index: 2, role: "assistant", content: "最终结果。",
  });
  rejects(contaminated, result, "schema_const");
});

test("each criterion requires a nonblank executable acceptance rule without extra result fields", () => {
  const blank = structuredClone(result);
  blank.requirements[0]!.acceptance_rule = "  ";
  rejects(request, blank, "criterion_text_empty");
  const extra = { ...structuredClone(result), winner: first };
  rejects(request, extra, "schema_additionalProperties");
  const primitive = structuredClone(result) as unknown as { requirements: unknown[] };
  primitive.requirements = ["给出实际仓位"];
  rejects(request, primitive, "schema_type");
});
