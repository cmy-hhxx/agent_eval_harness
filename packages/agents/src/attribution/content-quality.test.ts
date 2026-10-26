import test from "node:test";
import assert from "node:assert/strict";
import { componentContentIssues } from "./content-quality.js";

function problem(overrides: Partial<Parameters<typeof componentContentIssues>[0][number]> = {}) {
  return { label: "零行结果被当作有效数据", definition: "查询返回零行后仍形成肯定事实结论。",
    problem_phenomena: "第一问查询证券行情返回零行。", reason: "下一轮把零行响应当作已取得行情并继续作答。",
    evidence: [{ reason: "原始工具返回明确为零行。" }], ...overrides };
}

test("component content quality rejects placeholders and low-information reasons", () => {
  const issues = componentContentIssues([
    problem({ label: "tmp", definition: " tmp ", problem_phenomena: "TMP", reason: "tmp",
      evidence: [{ reason: "tmp" }] }),
    problem({ label: "零行结果未识别", definition: "问题", problem_phenomena: "工具返回为空。", reason: "有问题",
      evidence: [{ reason: "。。。" }] }),
  ]);
  assert.equal(issues.filter(issue => issue.code === "placeholder_content").length >= 5, true);
  assert.equal(issues.some(issue => issue.code === "duplicate_problem_text"), true);
});

test("component content quality only hard-fails fully duplicated problem text", () => {
  const repeated = componentContentIssues([problem({ label: "同一句话", definition: "同一句话",
    problem_phenomena: "同一句话", reason: "同一句话", evidence: [{ reason: "同一句话" }] })]);
  assert.equal(repeated.some(issue => issue.code === "duplicate_problem_text"), true);
  assert.equal(repeated.some(issue => issue.code === "duplicate_semantics"), false);
  const evidence = componentContentIssues([problem({ evidence: [{ reason: "证明工具返回空列表。" },
    { reason: "证明工具返回空列表。" }] })]);
  assert.deepEqual(evidence, [], "noncritical repeated evidence wording remains repairable without rejection");
  assert.deepEqual(componentContentIssues([problem({ evidence: [
    { reason: "证明工具返回行数为零。" }, { reason: "证明下一轮仍引用了不存在的查询结果。" },
  ] })]), []);
});

test("component content quality rejects duplicate problems so overlapping findings are merged", () => {
  const issues = componentContentIssues([problem(), problem()]);
  assert.equal(issues.some(issue => issue.code === "duplicate_problem" && issue.path === "/problems/1"), true);
});
