import test from "node:test";
import assert from "node:assert/strict";
import { ValidationError, type JsonObject } from "@eval/contracts";
import { attributionComponentLabel, validateComponentReview, type ComponentReview, type SubmittedProblem } from "./responsibility.js";

const members: JsonObject[] = [
  { component_index: 1, kind: "script", name: "make.py" },
  { component_index: 2, kind: "model", name: "shell 请求生成" },
  { component_index: 3, kind: "model", name: "答案合成", contains_final_generation: true },
];
const problem = (tool_error_indices: number[] = [], severity: SubmittedProblem["severity"] = "P1", actor_index = 1): SubmittedProblem => ({
  actor_index, label: "月度矩阵为空", definition: "脚本未生成要求的数据。", problem_phenomena: "核心工作簿未交付。",
  reason: "构建后月度数据仍为空。", severity, severity_reason: "核心交付不可用。",
  evidence: [{ index: 1, reason: "实际构建回执。" }], tool_error_indices });
const review = (tool_error_reviews: ComponentReview["tool_error_reviews"] = [], problems: SubmittedProblem[] = []): ComponentReview => ({
  content: "核对实际动作与结果。", evidence: [1], tool_error_reviews, problems });
const errors: JsonObject[] = [{ tool_error_idx: 1 }, { tool_error_idx: 2 }];
const disposed = (status: ComponentReview["tool_error_reviews"][number]["status"], ids = [1, 2]) =>
  ids.map(tool_error_idx => ({ tool_error_idx, status, content: "核对报错与后续回执。", evidence: [1] }));

test("program-bound actors preserve exact script, service and program-named request generation names", () => {
  for (const member of members) assert.equal(attributionComponentLabel(Number(member.component_index), members), member.name);
  assert.throws(() => attributionComponentLabel(99, members), ValidationError);
  assert.throws(() => attributionComponentLabel(1, [{ ...members[0]!, name: "llm-call-7" }]), ValidationError);
});

test("same-root-cause errors merge into one problem that links every occurrence exactly once", () => {
  assert.doesNotThrow(() => validateComponentReview(members, review(disposed("unresolved_impact"), [problem([1, 2])]), errors));
  for (const invalid of [[], disposed("unresolved_impact", [1]), disposed("unresolved_impact", [1, 2, 1])])
    assert.throws(() => validateComponentReview(members, review(invalid, [problem([1, 2])]), errors), /恰好处置一次/);
  assert.throws(() => validateComponentReview(members, review(disposed("unresolved_impact"), [problem([1, 2]), problem([1])]), errors),
    /同一报错不分到多条问题/);
  assert.throws(() => validateComponentReview(members, review([], [problem([1])]), []), /只能关联本组分派/);
});

test("recovered or harmless errors become P4 process defects; only uncertain causes stay unlinked", () => {
  const rows = [...disposed("recovered_no_impact", [1]), ...disposed("uncertain", [2])];
  assert.throws(() => validateComponentReview(members, review(rows), errors), /除 uncertain 外/);
  assert.doesNotThrow(() => validateComponentReview(members, review(rows, [problem([1], "P4", 2)]), errors));
  assert.throws(() => validateComponentReview(members, review(rows, [problem([1], "P2", 2)]), errors), /记 P4/);
  assert.throws(() => validateComponentReview(members, review(rows, [problem([1, 2], "P4", 2)]), errors), /除 uncertain 外/);
  assert.doesNotThrow(() => validateComponentReview(members, review(disposed("no_delivery_impact"), [problem([1, 2], "P4")]), errors));
});

test("errors with residual delivery impact require a P0–P3 problem", () => {
  const rows = disposed("recovered_impact", [1]);
  assert.throws(() => validateComponentReview(members, review(rows), errors.slice(0, 1)), /必须关联/);
  assert.throws(() => validateComponentReview(members, review(rows, [problem([1], "P4")]), errors.slice(0, 1)), /P0–P3/);
  assert.doesNotThrow(() => validateComponentReview(members, review(rows, [problem([1], "P2")]), errors.slice(0, 1)));
});

test("problems without tool errors keep any severity except P4 on the final answer", () => {
  assert.doesNotThrow(() => validateComponentReview(members, review([], [problem([], "P4", 2), problem([], "P1", 3)]), []));
  assert.throws(() => validateComponentReview(members, review([], [problem([], "P4", 3)]), []), /终稿问题都影响交付/);
});
