import test from "node:test";
import assert from "node:assert/strict";
import { attributionProfile, numericReferenceDirectory } from "./index.js";
import example from "./fixtures/example.json" with { type: "json" };
import { attributionSubmission } from "../../../../tests/fixtures/attribution-submission.js";
import type { AttributionResult } from "./types.js";
import { canonicalEvidence } from "../../../../tests/fixtures/evidence.js";
import { ValidationError } from "@eval/contracts";

const audit = { calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [] };

test("an ETF identity standard forbids supplemental source numbers and reports them beside a missing problem", () => {
  const request = structuredClone(example.request);
  request.input.ground_truth.value = "510630.SH华夏消费etf";
  const schema = attributionProfile.modelSubmissionSchema!(request);
  const ledger = (schema.properties as Record<string, { maxItems?: number }>).numeric_checks;
  assert.equal(ledger.maxItems, 0, "security identifiers are not standard-answer numeric quantities");
  const issues = attributionProfile.validateSubmission!(request, {
    findings: [{ type: "problem", dimension: "format", assessment: { requirement_index: null } }],
    numeric_checks: [{ reference_index: 0, actual: "27.98", scale: "1", mode: "rounded", evidence_index: 0 }],
  }, audit);
  assert(issues.some(issue => issue.code === "problem_required"));
  assert(issues.some(issue => issue.code === "numeric_reference_index_invalid"));
});

test("the program retains multiple standard quantities, signed declines and original scientific precision", () => {
  const standard = "日期2024-03-15；基金代码510630.SH；总销量为1087.40万千升，资产为1.13018E+12元，利润下降0.60个百分点，样本3家。";
  const directory = numericReferenceDirectory(standard);
  assert.deepEqual(directory.map(item => item.expected), ["1087.40", "1.13018E+12", "-0.60", "3"]);
  assert.deepEqual(directory.map(item => item.reference_index), [0, 1, 2, 3]);
  assert(directory.every(item => item.context.includes("基金代码510630.SH")), "the original context remains available without turning the code into a target");
  const request = structuredClone(example.request);
  request.input.ground_truth.value = "4元";
  request.sources.answer.value.messages[1]!.content = "2+2=4元";
  const result = structuredClone(example.result) as AttributionResult;
  result.correctness_evidence = [canonicalEvidence(request.sources.answer.id, 1, "2+2=4元")];
  const draft = attributionSubmission(request, result);
  draft.numeric_checks = [{ label: "加法结果", reference_index: 0, actual: "4", scale: "1", mode: "exact", evidence_index: 0 }];
  const resolved = attributionProfile.resolve!(request, draft, audit) as AttributionResult;
  assert.equal(resolved.numeric_checks[0]!.expected, "4");
  assert.equal(resolved.numeric_checks[0]!.matches, true);
  assert(!Object.hasOwn(resolved.numeric_checks[0]!, "reference_index"));
  draft.numeric_checks[0]!.scale = "0";
  assert.throws(() => attributionProfile.resolve!(request, draft, audit), (error: unknown) => {
    assert(error instanceof ValidationError);
    assert(error.issues?.some(issue => issue.code === "numeric_invalid"));
    return true;
  });
});

test("a missing problem does not hide a real standard-value contradiction or unit mismatch", () => {
  const request = structuredClone(example.request);
  request.input.ground_truth.value = "4元";
  request.sources.answer.value.messages[1]!.content = "结果为5元";
  const malformed = {
    is_correct: true, correctness_evidence: [{ evidence_id: canonicalEvidence(request.sources.answer.id, 1, "结果为5元").evidence_id }],
    findings: [{ type: "problem", dimension: "format", assessment: { requirement_index: null } }],
    numeric_checks: [{ reference_index: 0, actual: "5", scale: "1", mode: "rounded", evidence_index: 0 }],
  };
  const issues = attributionProfile.validateSubmission!(request, malformed, audit);
  assert(issues.some(issue => issue.code === "problem_required"));
  assert(issues.some(issue => issue.code === "numeric_correctness_contradiction"));
  request.sources.answer.value.messages[1]!.content = "结果为4吨";
  malformed.correctness_evidence = [{ evidence_id: canonicalEvidence(request.sources.answer.id, 1, "结果为4吨").evidence_id }];
  malformed.numeric_checks[0]!.actual = "4";
  assert(attributionProfile.validateSubmission!(request, malformed, audit).some(issue => issue.code === "numeric_correctness_contradiction"));
});

test("standard tables retain quantity columns while identifier and date columns stay outside the directory", () => {
  const directory = numericReferenceDirectory("| 基金代码 | 日期 | 数量（家） | 收入（亿元） |\n| --- | --- | --- | --- |\n| 510630.SH | 2024-03-15 | 108 | 3.50 |\n| 000001.SZ | 2024-03-16 | 9 | 1.13018E+12 |");
  assert.deepEqual(directory.map(item => item.expected), ["108", "3.50", "9", "1.13018E+12"]);
  assert(directory[0]!.context.includes("数量（家）"));
  assert.deepEqual(numericReferenceDirectory({ 证券代码: "510630.SH", 日期: "2024-03-15", 销量: "1087.4万千升" }).map(item => item.expected), ["1087.4"]);
});

test("standalone integer standards and original source context remain selectable without changing their precision", () => {
  for (const standard of [0, -0, 108, "0", "-0", "108", "9007199254740992"])
    assert.deepEqual(numericReferenceDirectory(standard).map(item => item.expected), [Object.is(standard, -0) ? "-0" : String(standard)]);
  const original = "总销量为1,087.40万千升；利润下降0.60个百分点。";
  assert.deepEqual(numericReferenceDirectory(original).map(item => [item.expected, item.context]), [["1087.40", original], ["-0.60", original]]);
  assert.deepEqual(numericReferenceDirectory("销量10台，面积12.50亩，合计订单108").map(item => item.expected), ["10", "12.50", "108"]);
});
