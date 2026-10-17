import test from "node:test";
import assert from "node:assert/strict";
import { publicationComparison } from "./publication.js";

test("publication can deliver original prose when no rewrite was accepted", () => {
  const row = { comparison_id: "pair", models: { a: {}, b: {} }, verdicts: { a__vs__b: { reason: "原始理由" } } };
  assert.deepEqual(publicationComparison(row, { A: "a-input", B: "b-input" },
    { "a-input": { version: "a" }, "b-input": { version: "b" } }), row);
  assert(!Object.hasOwn(row, "rewritten"));
});

test("publication maps saved candidate slots by identity, including partial rewrites and third-party pairs", () => {
  const row = { comparison_id: "pair", models: { z_baseline: {}, a_fast: {} }, rewritten: {
    evaluator_version: "fixture", rewrites: [
      { id: "assessment.A.summary", text: "基线模型总评。" },
      { id: "comparison.0.A.summary", text: "基线模型逐项说明。" },
      { id: "comparison.0.B.summary", text: "A组Fast逐项说明。" },
      { id: "tradeoff", text: "A/B类基金、候选A、A组Fast均保持原文。" },
      { id: "verdict.A__vs__B.reason", text: "双方都好。" },
    ],
  } };
  const inputs = { first: { version: "a_fast" }, second: { version: "z_baseline" } };
  const before = structuredClone(row), inputIds = { B: "first", A: "second" };
  const published = publicationComparison(row, inputIds, inputs);
  assert.deepEqual(published.rewritten, { evaluator_version: "fixture", rewrites: [
    { id: "assessment.B.summary", text: "基线模型总评。" },
    { id: "comparison.0.B.summary", text: "基线模型逐项说明。" },
    { id: "comparison.0.A.summary", text: "A组Fast逐项说明。" },
    { id: "tradeoff", text: "A/B类基金、候选A、A组Fast均保持原文。" },
    { id: "verdict.A__vs__B.reason", text: "双方都好。" },
  ] });
  assert.deepEqual(row, before);
  assert.deepEqual(publicationComparison(row, inputIds, inputs), published);
  assert.throws(() => publicationComparison(row, { A: "missing", B: "first" }, inputs), /identity mapping invalid/);
  assert.throws(() => publicationComparison(row, { A: "first", B: "first" }, inputs), /identity mapping invalid/);
  assert.throws(() => publicationComparison(row, inputIds, { ...inputs, second: { version: "another" } }), /identity mapping invalid/);
  row.rewritten.rewrites.push({ id: "assessment.C.summary", text: "未知候选" });
  assert.throws(() => publicationComparison(row, inputIds, inputs), /candidate missing/);
  row.rewritten.rewrites.pop();
  row.rewritten.rewrites.push(row.rewritten.rewrites[0]);
  assert.throws(() => publicationComparison(row, inputIds, inputs), /slots duplicated/);
});
