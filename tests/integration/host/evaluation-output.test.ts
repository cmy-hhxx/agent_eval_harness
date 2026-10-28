import test from "node:test";
import assert from "node:assert/strict";
import { testEvaluationOutput } from "../../../apps/host/src/config.js";

test("test evaluations use the configured directory and reject paths outside that root", () => {
  const output = { testPath: "/custom/research/experiments" };
  assert.equal(testEvaluationOutput(output), output.testPath);
  assert.equal(testEvaluationOutput(output, `${output.testPath}/pilot`), `${output.testPath}/pilot`);
  for (const outside of ["/custom/research/production", `${output.testPath}-other`, `${output.testPath}/../outside`, "/tmp/evaluation"])
    assert.throws(() => testEvaluationOutput(output, outside), /Test evaluation output/);
  assert.throws(() => testEvaluationOutput({}), /output.testPath/);
});
