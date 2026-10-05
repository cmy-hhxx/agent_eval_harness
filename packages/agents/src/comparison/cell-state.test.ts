import assert from "node:assert/strict";
import { test } from "node:test";
import { comparisonCellCriterionIds, comparisonCellState } from "./slots.js";
import type { ComparisonInput } from "./types.js";

function fixture(): ComparisonInput {
  const analysis = { task_type: "检查原要求", goal: "原问", requirements: [
    { id: "common", text: "共同要求", applies_to: [], acceptance_rule: "保留原文条件" },
    { id: "private-a", text: "A 规范", applies_to: ["answer-a"], acceptance_rule: "保留原文条件" },
    { id: "private-b", text: "B 规范", applies_to: ["answer-b"], acceptance_rule: "保留原文条件" },
  ], scoring_points: [], red_flags: [] };
  return {
    task_analysis: analysis,
    candidates: { A: { candidate_id: "answer-a", original_answer_timing: { finish_seconds: 5 },
      original_answer_usage: { total_tokens: 20, issues: [] } },
      B: { candidate_id: "answer-b", original_answer_timing: { finish_seconds: 6 },
        original_answer_usage: { total_tokens: 30, issues: [] } } },
    attributions: Object.fromEntries(["A", "B"].map(candidate => [candidate, {
      task_analysis: structuredClone(analysis),
      findings: [{ type: "problem", dimension: "instruction_following", importance: "low",
        assessment: { requirement_index: candidate === "A" ? 1 : 2, evidence_status: "established" } }],
      criterion_assessments: [
        { criterion_id: "common", status: "met", evidence_status: "established" },
        { criterion_id: "private-a", status: candidate === "A" ? "partial" : "not_applicable", evidence_status: "established" },
        { criterion_id: "private-b", status: candidate === "B" ? "partial" : "not_applicable", evidence_status: "established" },
      ],
    }])) } as unknown as ComparisonInput;
}

test("empty row IDs reuse the actual linked source status, independently of type or importance", () => {
  for (const status of ["met", "partial", "unmet"] as const) for (const type of ["problem", "strength"] as const) {
    const input = fixture(); input.attributions.A.criterion_assessments[1]!.status = status;
    input.attributions.A.findings[0]!.type = type;
    assert.deepEqual(comparisonCellState(input, "A", [], [0]), { status, evidence_status: "established" });
  }
});

test("requirement indexes address the owner source array and map by existing ID", () => {
  const input = fixture(), source = input.attributions.A;
  source.task_analysis.requirements = [source.task_analysis.requirements[1]!, source.task_analysis.requirements[0]!, source.task_analysis.requirements[2]!];
  source.findings[0]!.assessment.requirement_index = 0;
  assert.deepEqual(comparisonCellCriterionIds(input, "A", [], [0]), ["private-a"]);
  assert.equal(comparisonCellState(input, "A", [], [0]).status, "partial");
});

test("linked IDs deduplicate and aggregate source facts; explicit row IDs retain priority", () => {
  const input = fixture(), common = structuredClone(input.attributions.A.findings[0]!);
  common.assessment.requirement_index = 0; input.attributions.A.findings.push(common);
  input.attributions.A.criterion_assessments[1]!.status = "unmet";
  assert.deepEqual(comparisonCellCriterionIds(input, "A", [], [0, 1, 0]), ["private-a", "common"]);
  assert.equal(comparisonCellState(input, "A", [], [0, 1]).status, "unmet");
  assert.equal(comparisonCellState(input, "A", ["common"], [0]).status, "met");
});

test("missing, duplicate or inconsistent not-applicable source facts remain unknown", () => {
  for (const mode of ["missing", "duplicate", "not_applicable"] as const) {
    const input = fixture(), facts = input.attributions.A.criterion_assessments;
    if (mode === "missing") facts.splice(1, 1);
    else if (mode === "duplicate") facts.push(structuredClone(facts[1]!));
    else facts[1]!.status = "not_applicable";
    assert.deepEqual(comparisonCellState(input, "A", [], [0]), { status: "unknown", evidence_status: "uncertain" });
  }
});

test("linked source or finding uncertainty is preserved without strengthening evidence", () => {
  const input = fixture(); input.attributions.A.criterion_assessments[1]!.evidence_status = "uncertain";
  assert.deepEqual(comparisonCellState(input, "A", [], [0]), { status: "partial", evidence_status: "uncertain" });
  input.attributions.A.criterion_assessments[1]!.evidence_status = "established";
  input.attributions.A.findings[0]!.assessment.evidence_status = "uncertain";
  assert.deepEqual(comparisonCellState(input, "A", [], [0]), { status: "unknown", evidence_status: "uncertain" });
  assert.deepEqual(comparisonCellState(input, "A", ["private-a"], [0]), { status: "partial", evidence_status: "uncertain" });
  input.attributions.A.findings[0]!.assessment.requirement_index = null;
  assert.deepEqual(comparisonCellState(input, "A", [], [0]), { status: "unknown", evidence_status: "uncertain" });
});

test("null, absent and invalid indexes cannot turn a low problem into an invented violation", () => {
  for (const index of [null, undefined, -1, 99, 1.5, NaN, "1"]) {
    const input = fixture(); (input.attributions.A.findings[0]!.assessment as { requirement_index: unknown }).requirement_index = index;
    assert.deepEqual(comparisonCellCriterionIds(input, "A", [], [0]), []);
    assert.deepEqual(comparisonCellState(input, "A", [], [0]), { status: "met", evidence_status: "established" });
  }
});

test("private criteria derive each owner state without inventing applicability for the other candidate", () => {
  const input = fixture();
  assert.equal(comparisonCellState(input, "A", [], [0]).status, "partial");
  assert.equal(comparisonCellState(input, "B", [], [0]).status, "partial");
  input.attributions.B.findings[0]!.assessment.requirement_index = 1;
  assert.deepEqual(comparisonCellState(input, "B", [], [0]), { status: "not_applicable", evidence_status: "established" });
});

test("missing findings cannot be promoted to established observations", () => {
  const input = fixture();
  assert.deepEqual(comparisonCellState(input, "A", [], [7]), { status: "unknown", evidence_status: "uncertain" });
  assert.deepEqual(comparisonCellState(input, "A", [], [0, 7]), { status: "unknown", evidence_status: "uncertain" });
});

test("without a requirement relation, original valid-resource and unknown rules stay intact", () => {
  const input = fixture();
  assert.deepEqual(comparisonCellState(input, "A", [], []), { status: "met", evidence_status: "established" });
  input.candidates.A.original_answer_timing.finish_seconds = null;
  input.candidates.A.original_answer_usage.total_tokens = null;
  assert.deepEqual(comparisonCellState(input, "A", [], []), { status: "unknown", evidence_status: "uncertain" });
});

test("a relation requires a real source requirement that exists in current criteria", () => {
  const input = fixture(); input.attributions.A.task_analysis.requirements[1]!.id = "unrelated";
  assert.deepEqual(comparisonCellCriterionIds(input, "A", [], [0]), []);
  assert.equal(comparisonCellState(input, "A", [], [0]).status, "met");
  input.attributions.A.task_analysis.requirements.splice(1);
  assert.deepEqual(comparisonCellCriterionIds(input, "A", [], [0]), []);
});
