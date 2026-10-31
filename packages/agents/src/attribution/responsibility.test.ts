import test from "node:test";
import assert from "node:assert/strict";
import { ValidationError, type JsonObject } from "@eval/contracts";
import { attributionComponentLabel, validateComponentReview, type ComponentReview, type SubmittedProblem } from "./responsibility.js";

const components = [
  { component_index: 1, kind: "script", name: "make.py" },
  { component_index: 2, kind: "model", name: "最终答复生成" },
];
const problem = (tool_error_indices: number[] = []): SubmittedProblem => ({ label: "月度矩阵为空", definition: "脚本未生成要求的数据。",
  problem_phenomena: "核心工作簿未交付。", reason: "构建后月度数据仍为空。", severity: "P1", severity_reason: "核心交付不可用。",
  evidence: [{ index: 1, reason: "实际构建回执。" }], tool_error_indices });
const reviews = (): ComponentReview[] => components.map(() => ({ content: "核对实际动作与结果。",
  evidence: [1], tool_error_reviews: [], problems: [] }));
const errors: JsonObject[] = [{ tool_error_idx: 1 }, { tool_error_idx: 2 }];

test("program-bound component names preserve exact script and service names", () => {
  for (const component of components) assert.equal(attributionComponentLabel(component.component_index, components), component.name);
  assert.throws(() => attributionComponentLabel(99, components), ValidationError);
  assert.throws(() => attributionComponentLabel(1, [{ ...components[0]!, name: "llm-call-7" }]), ValidationError);
});

test("unresolved script errors merge into one script problem, never truthful final disclosure", () => {
  const rows = reviews(); rows[0]!.problems = [problem([1, 2])];
  rows[0]!.tool_error_reviews = errors.map(error => ({ tool_error_idx: Number(error.tool_error_idx), status: "unresolved_impact",
    content: "同一实现故障重现，未修复并阻断交付。", evidence: [1] }));
  assert.doesNotThrow(() => validateComponentReview(components[0]!, rows[0]!, errors));
  assert.throws(() => validateComponentReview(components[1]!, rows[0]!, errors), /不能放到最终答复生成/);
  for (const invalid of [[], [rows[0]!.tool_error_reviews[0]!], [...rows[0]!.tool_error_reviews, rows[0]!.tool_error_reviews[0]!]]) {
    const missing = structuredClone(rows); missing[0]!.tool_error_reviews = invalid;
    assert.throws(() => validateComponentReview(components[0]!, missing[0]!, errors), /恰好处置一次/);
  }
  const duplicated = structuredClone(rows); duplicated[0]!.problems.push(problem([1]));
  assert.throws(() => validateComponentReview(components[0]!, duplicated[0]!, errors), /传播症状合并/);
});

test("recovered errors without residual impact and uncertain causes create only internal records", () => {
  const rows = reviews(); rows[0]!.tool_error_reviews = [
    { tool_error_idx: 1, status: "recovered_no_impact", content: "替换字体后重建通过，已交付。", evidence: [1, 2] },
    { tool_error_idx: 2, status: "uncertain", content: "临时文件缺失，无法确认请求或服务内部原因；未证实剩余影响。", evidence: [1] },
  ];
  assert.doesNotThrow(() => validateComponentReview(components[0]!, rows[0]!, errors));
  rows[0]!.problems = [problem([1])];
  assert.throws(() => validateComponentReview(components[0]!, rows[0]!, errors), /无剩余影响或不确定不造问题/);
});

test("normal tool result misread by final answer is an independent final component problem", () => {
  const rows = reviews(); rows[1]!.problems = [problem()];
  assert.doesNotThrow(() => validateComponentReview(components[1]!, rows[1]!, []));
  rows[1]!.problems[0]!.tool_error_indices = [1];
  assert.throws(() => validateComponentReview(components[1]!, rows[1]!, []), /本组件分派/);
});

test("recovered error with proven residual impact must link exactly one local problem", () => {
  const rows = reviews(); rows[0]!.tool_error_reviews = [{ tool_error_idx: 1, status: "recovered_impact",
    content: "执行恢复，但已损坏的数据仍进入交付。", evidence: [1, 2] }];
  assert.throws(() => validateComponentReview(components[0]!, rows[0]!, errors.slice(0, 1)), /必须关联/);
  rows[0]!.problems = [problem([1])];
  assert.doesNotThrow(() => validateComponentReview(components[0]!, rows[0]!, errors.slice(0, 1)));
});
