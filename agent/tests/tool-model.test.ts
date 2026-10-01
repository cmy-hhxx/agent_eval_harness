import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "../../tests/fixtures/services.js";

const { analysisToolModel } = await import(pathToFileURL(path.join(ROOT, "agent/src/client/tool-model.js")).href);

test("calculation summaries tolerate rejected arguments and incomplete streaming calls", () => {
  for (const operands of ["1", {}, 1, null, undefined]) {
    const args = JSON.stringify({ operation: "add", operands });
    assert.deepEqual(analysisToolModel("calculate", { state: "error", bodyRaw: args, output: "invalid operands" }),
      { summary: "加法 · 未完成" });
    assert.deepEqual(analysisToolModel("calculate", { state: "preparing", bodyRaw: args }),
      { summary: "加法 · 准备中" });
  }
  assert.deepEqual(analysisToolModel("calculate", { state: "running", bodyRaw: '{"operation":' }),
    { summary: "计算 · 进行中" });
});

test("calculation summaries retain valid expressions and zero-valued results", () => {
  const args = JSON.stringify({ operation: "subtract", operands: ["1", "1"] });
  const result = analysisToolModel("calculate", { state: "ok", bodyRaw: args, output: "0" });
  assert.equal(result.summary, "减法 · 1 − 1 = 0");
});
