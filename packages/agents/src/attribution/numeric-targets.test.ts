import test from "node:test";
import assert from "node:assert/strict";
import { numericReferenceDirectory } from "./units.js";
import { attributionProfile } from "./index.js";
import example from "./fixtures/example.json" with { type: "json" };
import { setFixtureComponentCatalog } from "../../../../tests/fixtures/attribution-submission.js";

test("index names and month ranges do not become numerical answer targets", () => {
  assert.deepEqual(numericReferenceDirectory("上证50的年涨幅+12.90%，相对上证-5.51%；中证2000年涨幅+36.42%，相对上证+18.01%")
    .map(item => item.expected), ["+12.90", "-5.51", "+36.42", "+18.01"]);
  for (const range of ["1-5月", "1—5月", "1至5月", "1月到5月"])
    assert.deepEqual(numericReferenceDirectory(`比亚迪2025年销量：4602436；2026年${range}销量：1405039；比亚迪2026年${range}股价涨跌幅为：-1.58%；同时期的长城汽车股价涨跌幅为：-25.36%`)
      .map(item => item.expected), ["4602436", "1405039", "-1.58", "-25.36"]);
});

test("quantities beside index identities remain available with original precision", () => {
  assert.deepEqual(numericReferenceDirectory("沪深300涨幅4.50%；中证500上涨3.25%；科创50下跌2.00%；样本50只，截至2026年5月")
    .map(item => item.expected), ["4.50", "3.25", "-2.00", "50"]);
});

test("candidate wording cannot alter which standard values are selectable", () => {
  const request = structuredClone(example.request);
  setFixtureComponentCatalog(request);
  request.input.ground_truth.value = "上证50年涨幅12.90%，相对上证-5.51%；中证2000年涨幅36.42%，相对上证18.01%";
  assert.deepEqual(numericReferenceDirectory(request.input.ground_truth.value).map(item => item.expected),
    ["12.90", "-5.51", "36.42", "18.01"]);
  for (const unit of ["%", "个百分点"]) {
    request.input.answer.final_answer = `上证50上涨12.90%，相对上证-5.51${unit}；中证2000上涨36.42%，相对上证18.01${unit}。`;
    const schema = attributionProfile.modelSubmissionSchema!(request) as {
      properties: { numeric_checks: { items: { properties: { reference_index: { enum: number[] } } } } };
    };
    assert.deepEqual(schema.properties.numeric_checks.items.properties.reference_index.enum, [1, 2, 3, 4]);
  }
});
