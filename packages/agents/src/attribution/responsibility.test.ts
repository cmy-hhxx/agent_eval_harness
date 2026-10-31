import test from "node:test";
import assert from "node:assert/strict";
import { ValidationError, type JsonObject } from "@eval/contracts";
import { attributionComponentLabel, componentFamilyRole, normalizeComponentFamily, validateComponentReview,
  validateP4Problem, type ComponentReview, type SubmittedProblem } from "./responsibility.js";

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

test("severity feedback names each linked review index and status", () => {
  const rows = disposed("recovered_no_impact", [1]);
  let issues: NonNullable<ValidationError["issues"]> = [];
  assert.throws(() => validateComponentReview(members, review(rows, [problem([1], "P2")]), errors.slice(0, 1)), error => {
    if (!(error instanceof ValidationError)) return false;
    issues = error.issues!;
    return true;
  });
  assert.equal(issues[0]!.code, "tool_error_severity");
  assert.deepEqual(issues[0]!.expected, { reviews: [{ tool_error_idx: 1, review_index: 0, status: "recovered_no_impact" }],
    required_severity: "P4" });
  assert.match(String(issues[0]!.message), /tool_error_reviews\/0（tool_error_idx 1，recovered_no_impact）/);
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

test("component family normalization and session-catalog roles always return a concrete fallback", () => {
  assert.equal(normalizeComponentFamily(undefined), "other");
  assert.equal(normalizeComponentFamily("/opt/skills/finquery.py"), "finquery");
  assert.equal(normalizeComponentFamily("scripts/finquery.sh"), "finquery");
  assert.equal(normalizeComponentFamily("scripts/finquery.js"), "finquery");
  assert.deepEqual(componentFamilyRole({ kind: "model", name: "答案合成" }), { component_family: "answer_synthesis", component_role: "delivery" });
  assert.deepEqual(componentFamilyRole({ kind: "model", name: "planner-finquery" }), { component_family: "model", component_role: "planning" });
  assert.deepEqual(componentFamilyRole({ kind: "script", name: "/opt/finquery.py" }), { component_family: "finquery", component_role: "script" });
  assert.deepEqual(componentFamilyRole({ kind: "tool", name: "web_fetch" }), { component_family: "web_fetch", component_role: "tool" });
  assert.deepEqual(componentFamilyRole({ kind: "mystery" }), { component_family: "other", component_role: "tool" });
  assert.deepEqual(componentFamilyRole({ kind: "script" }), { component_family: "other", component_role: "script" });
  assert.deepEqual(componentFamilyRole({ kind: "model" }), { component_family: "model", component_role: "planning" });
  assert.deepEqual(componentFamilyRole({ kind: "model", name: "planner-finquery", component_family: "finquery", component_role: "planning" }),
    { component_family: "finquery", component_role: "planning" });
});

test("P4 needs confirmed no-impact and a delivery or alternative receipt", () => {
  const messages = [{ type: "final_answer" }, { type: "tool_result" }, { type: "tool_call" }];
  const context = { messages, errorMessages: new Set<number>(), componentRole: "planning" as const };
  assert.doesNotThrow(() => validateP4Problem(problem([], "P4"), [0], context, "/problems/0"));
  assert.doesNotThrow(() => validateP4Problem(problem([], "P4"), [1], context, "/problems/0"));
  assert.throws(() => validateP4Problem(problem([], "P4"), [2], context, "/problems/0"), /交付未受影响/);
  assert.throws(() => validateP4Problem(problem([], "P4"), [0], { ...context, errorMessages: new Set([0]) }, "/problems/0"), /交付未受影响/);
  assert.throws(() => validateP4Problem({ ...problem([], "P4"), severity_reason: "修复后影响未确认。" }, [0], context, "/problems/0"), /未确认/);
  assert.throws(() => validateP4Problem(problem([], "P4"), [0], { ...context, componentRole: "delivery" }, "/problems/0"), /终稿问题/);
  assert.doesNotThrow(() => validateP4Problem({ ...problem([], "P1"), severity_reason: "核心结果不可用。" }, [2], context, "/problems/0"));
});
