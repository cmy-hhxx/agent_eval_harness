import test from "node:test";
import assert from "node:assert/strict";
import { Ajv2020 } from "ajv/dist/2020.js";
import { attributionProfile } from "@eval/agents/attribution";
import { comparisonProfile } from "@eval/agents/comparison";
import { clusteringProfile } from "@eval/agents/clustering";
import { object } from "@eval/contracts";
import { attributionResult } from "../../../../tests/fixtures/comparison.js";
import comparisonExample from "../../../agents/src/comparison/fixtures/example.json" with { type: "json" };
import { comparisonAttribution } from "./comparison-attribution.js";
import { clusteringSchema, rewrittenSchema } from "./schema.js";

test("comparison receives ordered findings and exact evidence without attribution-private diagnosis or identities", () => {
  const result = attributionResult(false), before = structuredClone(result);
  result.findings[0].context_evidence = structuredClone(result.findings[0].evidence);
  const projected = comparisonAttribution(result);
  assert.deepEqual(Object.keys(projected).sort(), ["has_standard_answer", "is_correct", "correctness_reason", "correctness_evidence",
    "numeric_checks", "summary", "task_analysis", "criterion_assessments", "core_assessment", "findings"].sort());
  assert.deepEqual(projected.findings.map(item => item.finding_index), [0]);
  assert.deepEqual(projected.findings[0].evidence, result.findings[0].evidence);
  assert.deepEqual(projected.findings[0].context_evidence, result.findings[0].context_evidence);
  assert.deepEqual(projected.findings[0].assessment, result.findings[0].assessment);
  assert.deepEqual(projected.criterion_assessments, result.criterion_assessments);
  const changed = structuredClone(result);
  changed.findings[0].finding_id = "f99";
  changed.findings[0].problem!.label = "另一责任诊断标签";
  assert.deepEqual(comparisonAttribution(changed), projected);
  delete result.findings[0].context_evidence;
  assert.deepEqual(result, before);
});

test("comparison retains numerical rules, standard conflicts and table support needed for source verification", () => {
  const result = attributionResult(false);
  result.standard_conflict = true;
  result.numeric_checks = [{ label: "原始加法", expected: "4", actual: "5", scale: "1", mode: "exact", matches: false, evidence_index: 1 }];
  result.table_resolutions = [{ table_id: "table", row_index: 0, outcome: "conflict", reason: "原表返回与回答不符。",
    evidence: structuredClone(result.findings[0].evidence) }];
  const projected = comparisonAttribution(result);
  assert.equal(projected.correctness_reason, result.correctness_reason);
  assert.equal(projected.is_correct, result.is_correct);
  assert.equal(projected.standard_conflict, true);
  assert.deepEqual(projected.correctness_evidence, result.correctness_evidence);
  assert.deepEqual(projected.numeric_checks, result.numeric_checks);
  assert.deepEqual(projected.table_resolutions, result.table_resolutions);
});

test("comparison request schema closes the upstream boundary and validates each finding's evidence", () => {
  const validate = new Ajv2020({ strict: false }).compile(comparisonProfile.requestSchema);
  const input = structuredClone(comparisonExample.request.input);
  assert(validate(input), JSON.stringify(validate.errors));
  for (const path of ["diagnosis", "rewritten", "responsibility"]) {
    const invalid = structuredClone(input);
    Object.assign(invalid.attributions.A, { [path]: null });
    assert.equal(validate(invalid), false, path);
  }
  const privateFinding = structuredClone(input);
  Object.assign(privateFinding.attributions.A.findings[0], { problem: {} });
  assert.equal(validate(privateFinding), false);
  const malformed = structuredClone(input);
  malformed.attributions.A.findings[0].evidence[0].message_index = -1;
  assert.equal(validate(malformed), false);
});

test("Agent results reject export polish while Workflow accepts its unchanged shape", () => {
  const rewritten = { evaluator_version: "fixture", rewrites: [{ id: "summary", text: "润色后的文案。" }] };
  for (const [profile, result] of [[attributionProfile, attributionResult()], [comparisonProfile, comparisonExample.result],
    [clusteringProfile, { assignments: [], merges: [], new_classes: [] }]] as const) {
    const validate = new Ajv2020({ strict: false }).compile(profile.resultSchema!);
    assert(validate(result), JSON.stringify(validate.errors));
    assert.equal(validate({ ...result, rewritten }), false);
    assert(validate.errors!.some(error => error.keyword === "additionalProperties"));
  }
  assert(new Ajv2020({ strict: false }).compile(rewrittenSchema)(rewritten));
  const validateExport = new Ajv2020({ strict: false }).compile(object(object(clusteringSchema.properties).result));
  assert(validateExport({ assignments: [], merges: [], new_classes: [], rewritten }), JSON.stringify(validateExport.errors));
});
