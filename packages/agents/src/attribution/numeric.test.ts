import test from "node:test";
import assert from "node:assert/strict";
import { containsNumber, matchesReference } from "./numeric.js";

test("reference precision uses decimal rounding, including units and negative ties", () => {
  for (const [actual, expected, scale, matches] of [
    ["9.36", "9.4", "1", true], ["10.14", "10.1", "1", true],
    ["21.87", "21.6256", "1", false], ["10.7143", "10.76", "1", false],
    ["1.005", "1.01", "1", true], ["-1.005", "-1.01", "1", true],
    ["0.0936", "9.4", "100", true], ["936000000", "9.4", "0.00000001", true],
    ["9.35", "9.3", "1", false], ["4", "4.00", "1", true],
  ] as const) assert.equal(matchesReference(actual, expected, scale, "rounded"), matches, `${actual} -> ${expected}`);
  assert.equal(matchesReference("3.4", "3", "1", "exact"), false);
  assert.equal(matchesReference("300", "3", "0.01", "exact"), true);
  assert.throws(() => matchesReference("NaN", "1", "1", "rounded"));
  assert.throws(() => matchesReference("1", "1", "0", "rounded"));
  assert.equal(containsNumber("9.40", "9.4", true), false);
  assert.equal(containsNumber("2023年为9.36%，另有19.4", "9.4"), false);
  assert.equal(containsNumber("金额1,234.00元", "1234"), true);
  assert.equal(containsNumber("收益率 −12.71%", "-12.71"), true);
  assert.equal(containsNumber("收益率 −12.71%", "12.71"), false);
});
