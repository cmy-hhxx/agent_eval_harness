import { canonicalEvidence } from "../../../../tests/fixtures/evidence.js";
import test from "node:test";
import assert from "node:assert/strict";
import { groupObservations, type ProblemSource } from "./observations.js";
import type { AttributionFinding } from "./types.js";
import { applyClustering, countProblemSamples, emptyLibrary } from "@eval/agents/clustering";

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
  evidence: [canonicalEvidence("11111111-1111-4111-8111-111111111111", 3, `q-${finding_id}`)],
  assessment: {
    requirement_index: 0,
    observation: "o",
    evidence_status: "established",
    impact: "i",
  },
  problem: { component: [component], label, definition: "d" },
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

test("joint responsibility expands by component while preserving one finding identity", () => {
  const finding = problem("f1", "FinQuery", "口径冲突", "返回值冲突且模型忽略冲突");
  finding.problem!.component.push("模型自身推理");
  const observations = groupObservations([source("in-1", "case-1", [finding])]);
  assert.deepEqual(observations.map((item) => item.component).sort(), ["FinQuery", "模型自身推理"]);
  assert(observations.every((item) => item.count === 1 && item.refs[0]!.finding_id === "f1"));
  assert.deepEqual(observations[0]!.refs, observations[1]!.refs);
});

test("unresolved responsibility does not create a speculative component class", () => {
  const finding = problem("f1", "FinQuery", "与标准冲突", "工具数值与标准不同，根因待查");
  finding.problem!.component = [];
  assert.deepEqual(groupObservations([source("in-1", "case-1", [finding])]), []);
  assert.equal(finding.assessment.evidence_status, "established");
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

test("matching labels with different definitions remain separate observations", () => {
  const first = problem("f1", "Search", "来源问题", "来源无法解析");
  const second = problem("f2", "Search", "来源问题", "来源不支持主张");
  first.problem!.definition = "引用标识无法映射到来源。";
  second.problem!.definition = "已定位来源与所附主张不一致。";
  const observations = groupObservations([source("in-1", "case-1", [first, second])]);
  assert.equal(observations.length, 2);
  assert.deepEqual(new Set(observations.map(item => item.definition)), new Set([first.problem!.definition, second.problem!.definition]));
  assert(observations.every(item => item.count === 1));
});


test("a peer-first finding keeps the owner's real evidence coordinates in every responsibility association and one distinct sample", () => {
  const ownerId = "11111111-1111-4111-8111-111111111111", peerId = "22222222-2222-4222-8222-222222222222";
  const finding = problem("date-conflict", "模型自身推理", "日期口径错误", "实际输出与来源不一致");
  finding.problem!.component.push("Search");
  finding.evidence = [{ ...canonicalEvidence(peerId, 15, "对方工具返回的节假日表"), source: "peer_B", source_input_id: peerId },
    canonicalEvidence(ownerId, 3, "本方实际输出的日期")];
  const own = source(ownerId, "case-date", [finding]); own.source = { file: "own-A.jsonl", line: 2 };
  const before = structuredClone(own);
  const observations = groupObservations([own]);
  const library = applyClustering(emptyLibrary("a_fast"), { run_id: "owner-source-test", evaluator_version: "fixture",
    task_id: "task", submission_id: "submission", version: "a_fast", batch_id: "batch", observations,
    result: { assignments: observations.map((item, index) => ({ item_id: item.id, new_class_key: `class${index}` })),
      new_classes: observations.map((item, index) => ({ key: `class${index}`, component: item.component,
        label: item.label, definition: item.definition, closest_existing: null, novelty: "无已有同组件类。" })), merges: [] } });
  assert.equal(library.occurrences.length, 2);
  assert.equal(countProblemSamples(library.occurrences), 1);
  for (const occurrence of library.occurrences) {
    assert.equal(occurrence.input_id, ownerId); assert.equal(occurrence.finding_id, finding.finding_id);
    assert.equal(occurrence.message_index, 3); assert.equal(occurrence.quote, "本方实际输出的日期");
    assert.deepEqual(occurrence.source, own.source);
  }
  assert.deepEqual(own, before, "full formal evidence retains its peer-first order and source UUID");
});

test("an owner sample without genuine own evidence fails explicitly instead of substituting peer coordinates or placeholders", () => {
  const finding = problem("f1", "模型自身推理", "日期错误", "待核日期");
  for (const fields of [{ source: "peer_B", source_input_id: "22222222-2222-4222-8222-222222222222" },
    { source: "peer_B" }, { source_input_id: "22222222-2222-4222-8222-222222222222" }]) {
    finding.evidence = [{ ...canonicalEvidence("22222222-2222-4222-8222-222222222222", 15, "外来日期证据"), ...fields }];
    assert.throws(() => groupObservations([source("owner-input", "case", [finding])]), /问题样本缺少本方证据：owner-input\/f1/);
  }
  finding.evidence = [];
  assert.throws(() => groupObservations([source("owner-input", "case", [finding])]), /问题样本缺少本方证据/);
});
