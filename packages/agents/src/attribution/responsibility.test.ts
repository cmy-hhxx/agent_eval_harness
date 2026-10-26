import test from "node:test";
import assert from "node:assert/strict";
import { attributionComponentLabel } from "./responsibility.js";

test("taxonomy component codes resolve before aliases and the unknown fallback", () => {
  assert.equal(attributionComponentLabel("planner-finquery"), "planner-finquery 取数规划子模型");
  assert.equal(attributionComponentLabel("planner-search"), "planner-search 检索规划子模型");
});

test("complete display labels remain idempotent", () => {
  for (const label of ["planner-finquery 取数规划子模型", "planner-search 检索规划子模型", "finquery 取数服务"])
    assert.equal(attributionComponentLabel(label), label);
});

test("existing aliases and unknown names retain their current mapping", () => {
  assert.equal(attributionComponentLabel("finquery.py"), "finquery.py 脚本（经 shell）");
  assert.equal(attributionComponentLabel("web_search"), "web_search 网页检索");
  assert.equal(attributionComponentLabel("unlisted-tool"), "其他工具（unlisted-tool）");
  assert.equal(attributionComponentLabel("责任主体未确定"), "责任主体未确定");
});
