import test from "node:test";
import assert from "node:assert/strict";
import { ValidationError } from "@eval/contracts";
import { attributionProfile } from "./index.js";
import type { AttributionResult } from "./types.js";
import example from "./fixtures/example.json" with { type: "json" };

const audit = { calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [] };
function fixture(reference: string, answer: string, checks: AttributionResult["numeric_checks"] = []) {
  const request = structuredClone(example.request);
  request.input.ground_truth.value = reference;
  request.sources.answer.value.messages[1]!.content = answer;
  const result = structuredClone(example.result) as AttributionResult;
  result.correctness_evidence = [{ message_index: 1, quote: answer }];
  result.criterion_assessments.forEach((item) => { item.evidence = result.correctness_evidence; });
  result.findings = [];
  result.numeric_checks = checks;
  return { request, result, validate: () => attributionProfile.validate!(request, result, audit) };
}
function check(expected: string, actual: string | null, scale = "1"): AttributionResult["numeric_checks"][number] {
  return { label: "目标结果", expected, actual, scale, mode: "rounded", matches: true, evidence_index: 0 };
}
const code = (wanted: string) => (error: unknown) => error instanceof ValidationError &&
  !!error.issues?.some((issue) => issue.code === wanted);

test("a single explicit reference quantity cannot disappear from the numeric ledger", () => {
  for (const reference of ["总销量为1087.4万千升", "−0.6个百分点", "1.13018E+12元", "-0.6"])
    assert.throws(fixture(reference, reference).validate, code("numeric_reference_unchecked"), reference);
  fixture("总销量为1087.4万千升", "总销量1087.40万千升", [check("1087.4", "1087.40")]).validate();
  fixture("−0.6个百分点", "减少0.60个百分点", [check("-0.6", "-0.60")]).validate();
});

test("ambiguous identifiers and compound references do not become invented scalar targets", () => {
  for (const reference of ["301689", "2024", "2024年", "2024年总销量为1087.4万千升", "1至2万吨",
    "1087.4万千升±10%", "至少1087.4万千升", "销量为1087.4万千升，收入为3亿元", "约1087.4万千升", "1/3", "24年11个月"])
    fixture(reference, reference).validate();
});

test("equal numerals cannot make mass and volume or percentages and percentage points equivalent", () => {
  const incompatible = fixture("总销量为1087.4万千升", "总销量为1087.4万吨", [check("1087.4", "1087.4")]);
  assert.throws(incompatible.validate, code("numeric_unit_mismatch"));
  incompatible.result.numeric_checks[0].matches = false;
  incompatible.result.is_correct = false;
  incompatible.result.correctness_reason = "回答把体积万千升写成质量万吨，未提供密度，不能视为等价。";
  incompatible.validate();
  incompatible.result.numeric_checks[0].scale = "1000";
  assert.throws(incompatible.validate, code("numeric_scale_mismatch"));
  incompatible.result.numeric_checks[0].scale = "1";
  incompatible.result.is_correct = true;
  assert.throws(incompatible.validate, code("numeric_correctness_contradiction"));
  fixture("总销量为1087.4万千升", "总销量为1087.4万千升", [check("1087.4", "1087.4")]).validate();
  assert.throws(fixture("-0.6个百分点", "-0.6%", [check("-0.6", "-0.6")]).validate, code("numeric_unit_mismatch"));
  fixture("-0.6个百分点", "-0.60 个百分点", [check("-0.6", "-0.60")]).validate();
});

test("unit scale is derived from the cited number's adjacent units", () => {
  fixture("1087.4万千升", "10,874,000千升", [check("1087.4", "10874000", "0.0001")]).validate();
  fixture("1.13018E+12元", "1130181百万元", [check("1.13018E+12", "1130181", "1000000")]).validate();
  const wrong = fixture("1087.4万千升", "1087.4万升", [check("1087.4", "1087.4")]);
  assert.throws(wrong.validate, code("numeric_scale_mismatch"));
  assert.throws(fixture("10元", "5元", [check("10", "5", "2")]).validate, code("numeric_scale_mismatch"));
  assert.throws(fixture("10", "5", [check("10", "5", "2")]).validate, code("numeric_scale_unverified"));
  assert.throws(fixture("10元", "|数值|销量（万吨）|\n|5|3|", [check("10", "5", "2")]).validate,
    code("numeric_scale_unverified"));
  assert.throws(fixture("10元", "利润10元，重量10吨", [check("10", "10")]).validate,
    code("numeric_unit_ambiguous"));
  assert.throws(fixture("10元/股", "5元/股", [check("10", "5", "2")]).validate,
    code("numeric_scale_unverified"));
});

test("missing scalar result remains explicit and cannot be called correct", () => {
  const missing = fixture("1087.4万千升", "没有查到销量", [{ ...check("1087.4", null), matches: false }]);
  assert.throws(missing.validate, code("numeric_correctness_contradiction"));
  missing.result.is_correct = false;
  missing.validate();
});

test("a cropped numeric quote cannot hide the original final answer's unit", () => {
  const cropped = fixture("1087.4万千升", "总销量为1087.4万吨。", [check("1087.4", "1087.4")]);
  cropped.result.correctness_evidence[0].quote = "1087.4";
  assert.throws(cropped.validate, code("numeric_unit_mismatch"));
  cropped.result.numeric_checks[0].matches = false;
  cropped.result.is_correct = false;
  cropped.validate();
  const repeated = fixture("1087.4万千升", "销量1087.4万千升；重量1087.4万吨。", [check("1087.4", "1087.4")]);
  repeated.result.correctness_evidence[0].quote = "1087.4";
  assert.throws(repeated.validate, code("numeric_unit_ambiguous"));
  repeated.result.correctness_evidence[0].quote = "销量1087.4";
  repeated.validate();
  const substring = fixture("1087.4万千升", "销量21087.4万千升", [check("1087.4", "1087.4")]);
  substring.result.correctness_evidence[0].quote = "1087.4";
  assert.throws(substring.validate, code("numeric_answer_context_missing"));
});

test("a unit-bearing table header is tied to the cited target cell's column", () => {
  const table = "| 指标 | 销量（千升） |\n| --- | --- |\n| 总销量 | 10874000 |";
  const valid = fixture("1087.4万千升", table, [check("1087.4", "10874000", "0.0001")]);
  valid.validate();
  valid.result.correctness_evidence[0].quote = "10874000";
  valid.validate();
  valid.result.correctness_evidence[0].quote = JSON.stringify(valid.request.sources.answer.value.messages[1], null, 2);
  valid.validate();
  const otherColumn = fixture("1087.4万千升", "| 指标 | 数值 | 重量（千升） |\n| --- | --- | --- |\n| 总销量 | 10874000 | 1 |",
    [check("1087.4", "10874000", "0.0001")]);
  assert.throws(otherColumn.validate, code("numeric_scale_unverified"));
  const wrong = fixture("1087.4万千升", "| 指标 | 重量（万吨） |\n| --- | --- |\n| 总销量 | 1087.4 |", [check("1087.4", "1087.4")]);
  wrong.result.correctness_evidence[0].quote = "1087.4";
  assert.throws(wrong.validate, code("numeric_unit_mismatch"));
});

test("unverifiable scalar conversions have an explicit pending-review state", () => {
  const pending = fixture("1087.4万千升", "总销量为3/7个标准容器，资料未说明容器容量。");
  pending.result.is_correct = null;
  pending.result.core_assessment.meets_core = null;
  pending.result.core_assessment.reason = "无法确定容器容量，不能核实最终销量；需要独立复核。";
  pending.result.criterion_assessments[0].status = "unknown";
  pending.result.criterion_assessments[0].evidence_status = "uncertain";
  pending.result.correctness_reason = "标准以万千升表示，回答使用分数容器；容量未知，不能编造换算比例，待复核。";
  pending.validate();
  pending.result.core_assessment.meets_core = true;
  assert.throws(pending.validate, code("correctness_required"));
  pending.result.core_assessment.meets_core = null;
  pending.result.correctness_reason = " ";
  assert.throws(pending.validate, code("correctness_reason_required"));
  pending.result.correctness_reason = "缺少可信换算依据，待复核。";
  pending.result.correctness_evidence = [];
  assert.throws(pending.validate, code("correctness_evidence_required"));
});

test("a known numeric contradiction cannot be submitted as an uncertain verdict", () => {
  const known = fixture("1087.4万千升", "总销量为1087.4万吨。", [{ ...check("1087.4", "1087.4"), matches: false }]);
  known.result.is_correct = null;
  known.result.core_assessment.meets_core = null;
  known.result.criterion_assessments[0].status = "unknown";
  known.result.criterion_assessments[0].evidence_status = "uncertain";
  assert.throws(known.validate, code("numeric_uncertainty_contradiction"));
});
