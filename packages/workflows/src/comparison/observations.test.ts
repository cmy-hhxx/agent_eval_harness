import test from "node:test";
import assert from "node:assert/strict";
import { groupObservations, type ProblemSource } from "./observations.js";
import type { AttributionFinding } from "./types.js";

const problem = (
  finding_id: string,
  component: string,
  label: string,
  text: string,
): AttributionFinding => ({
  finding_id,
  type: "problem",
  dimension: "correctness",
  stage: "final_answer",
  importance: "high",
  text,
  reason: "r",
  evidence: [{ message_index: 3, quote: `q-${finding_id}` }],
  assessment: {
    requirement_index: 0,
    observation: "o",
    evidence_status: "established",
    impact: "i",
  },
  problem: { component, label, definition: "d" },
});
const strength = (finding_id: string): AttributionFinding => ({
  ...problem(finding_id, "模型自身推理", "无", "无"),
  type: "strength",
  problem: null,
});

const source = (inputId: string, caseId: string, findings: AttributionFinding[]): ProblemSource => ({
  input_id: inputId,
  case_id: caseId,
  source: { file: "f.jsonl", line: 7 },
  findings,
});

test("observations collapse identical problems and keep exact finding coordinates", () => {
  const observations = groupObservations([
    source("in-1", "case-b", [problem("f1", "色值工具", "色值错误", "颜色错了"), strength("f2")]),
    source("in-2", "case-a", [
      problem("f1", " 色值工具 ", "色值错误", "颜色不对"),
      problem("f2", "模型自身推理", "算术错误", "算错了"),
    ]),
  ]);
  assert.equal(observations.length, 2);
  const first = observations[0]!;
  assert.equal(first.component, "模型自身推理");
  assert.equal(first.id, "o1");
  assert.equal(first.count, 1);
  const second = observations[1]!;
  assert.equal(second.label, "色值错误");
  assert.equal(second.count, 2);
  assert.equal(second.definition, "d");
  assert.deepEqual(
    second.refs.map((ref) => [ref.case_id, ref.finding_id, ref.message_index]),
    [
      ["case-a", "f1", 3],
      ["case-b", "f1", 3],
    ],
    "refs are sorted deterministically",
  );
  assert.deepEqual(
    second.examples.map((example) => example.finding),
    ["颜色不对", "颜色错了"],
  );
});

test("confirmed and suspected occurrences share a class proposal but keep distinct certainty", () => {
  const confirmed = problem("f1", "Search", "结果时效性风险", "旧时间戳");
  const suspected = problem("f2", "Search", "结果时效性风险", "旧时间戳");
  suspected.assessment.evidence_status = "uncertain";
  const [item] = groupObservations([source("in-1", "a", [confirmed]), source("in-2", "b", [suspected])]);
  assert.equal(item!.count, 2);
  assert.equal(item!.established_count, 1);
  assert.equal(item!.uncertain_count, 1);
  assert.deepEqual(item!.refs.map((ref) => ref.evidence_status), ["established", "uncertain"]);
  assert.deepEqual(item!.examples.map((example) => example.evidence_status), ["established", "uncertain"]);
});

test("identical wording across cases yields one observation with an accurate count", () => {
  const observations = groupObservations([
    source("in-1", "case-1", [problem("f1", "模型自身推理", "算术错误", "算错")]),
    source("in-2", "case-2", [problem("f1", "模型自身推理", "算术错误", "算错")]),
    source("in-3", "case-3", [problem("f1", "模型自身推理", "算术错误", "算错")]),
  ]);
  assert.equal(observations.length, 1);
  assert.equal(observations[0]!.count, 3);
  assert.equal(observations[0]!.examples.length, 1, "examples are deduplicated");
});
