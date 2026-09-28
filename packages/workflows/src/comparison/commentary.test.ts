import test from "node:test";
import assert from "node:assert/strict";
import type { JsonObject, PlannedTask } from "@eval/contracts";
import type { Rewrites } from "@eval/agents/rewrite";
import {
  attributionSlots,
  comparisonSlots,
  clusteringSlots,
  polishComparisonRow,
  verdictSlotId,
  type CommentaryLookup,
} from "./commentary.js";
import type { AttributionResult, ComparisonResult, TaskData } from "./types.js";
import { display } from "./results.js";

test("candidate display names do not replace business terms such as 全A", () => {
  assert.equal(display("【候选A】采用同花顺全A（沪深京）及A股口径；B未注明。", { A: "A组Fast", B: "AA组Fast" }),
    "A组Fast采用同花顺全A（沪深京）及A股口径；AA组Fast未注明。");
});

const comparison: ComparisonResult = {
  task_analysis: {
    task_type: "整数加法",
    goal: "计算2+2",
    requirements: ["给出正确的加法结果"],
    scoring_points: ["使用指定操作数"],
    red_flags: ["擅自替换操作数"],
  },
  ranking: [["A"], ["B"]],
  assessments: {
    A: { meets_core: true, summary: "A 结论" },
    B: { meets_core: false, summary: "B 结论" },
  },
  decision_basis: { tradeoff: "A 完成核心要求，B 未完成。", decisive_findings: [], comparisons: [{
    aspect: "计算结果", importance: "high", better_candidates: ["A"], assessments: {
      A: { summary: "正确给出4。", finding_indices: [] }, B: { summary: "未给出结果。", finding_indices: [] },
    },
  }] },
};
const attribution: AttributionResult = {
  has_standard_answer: true,
  is_correct: true,
  correctness_reason: "与标准答案一致。",
  numeric_checks: [],
  correctness_evidence: [{ message_index: 1, quote: "2+2=4" }],
  task_analysis: structuredClone(comparison.task_analysis),
  summary: "回答正确。",
  findings: [],
};

test("comparison slots cover every assessment, the tradeoff and each pair", () => {
  const items = comparisonSlots(comparison);
  assert.deepEqual(
    items.map((item) => item.id).sort(),
    ["assessment.A.summary", "assessment.B.summary", "tradeoff", "comparison.0.A.summary", "comparison.0.B.summary", verdictSlotId("A", "B")].sort(),
  );
  assert.match(items.find((item) => item.id === verdictSlotId("B", "A"))!.text, /【候选A】完成核心要求/);
  const failed = structuredClone(comparison);
  failed.assessments.A!.meets_core = false;
  failed.ranking = [["A", "B"]];
  assert.match(comparisonSlots(failed).find((item) => item.id === "tradeoff")!.label, /全部未达标，无整体胜者/);
  assert.equal(comparisonSlots(failed).find((item) => item.id === "tradeoff")!.constraint, "no_winner");
});

test("attribution slots include the correctness reason only when it exists", () => {
  assert.deepEqual(attributionSlots(attribution).map((item) => item.id), ["summary", "correctness_reason"]);
  const subjective = { ...attribution, is_correct: null, correctness_reason: "" };
  assert.deepEqual(attributionSlots(subjective).map((item) => item.id), ["summary"]);
});

test("presentation view applies rewrites by slot and leaves unknown text alone", () => {
  const task = {
    id: "cmp",
    stage: "comparison",
    dependencies: { A: "attr-a", B: "attr-b" },
    inputIds: {},
    data: {
      stage: "comparison",
      candidates: { A: { version: "a" }, B: { version: "b" } },
    } as unknown as TaskData,
  } as unknown as PlannedTask;
  const row: JsonObject = {
    assessments: { a: { meets_core: true, summary: "原A" }, b: { meets_core: false, summary: "原B" } },
    evaluations: {
      a: { summary: "原归因A", correctness_reason: "原理由A" },
      b: { summary: "原归因B", correctness_reason: "原理由B" },
    },
    verdicts: { "a__vs__b": { reason: "原判决" } },
    decision_basis: { tradeoff: "原权衡", comparisons: [{ aspect: "结果", importance: "high", better_candidates: ["a"], assessments: {
      a: { summary: "原表现A", finding_indices: [] }, b: { summary: "原表现B", finding_indices: [] },
    } }] },
  };
  const bySource: Record<string, Rewrites> = {
    cmp: {
      "assessment.A.summary": "A 精简",
      tradeoff: "精简权衡",
      "comparison.0.A.summary": "A 给出了4。",
      [verdictSlotId("A", "B")]: "精简判决",
    },
    "attr-a": { summary: "归因A精简", correctness_reason: "【候选A】正确" },
  };
  const commentary: CommentaryLookup = { of: (source) => (source ? bySource[source] : undefined) };
  const view = polishComparisonRow(row, task, { a: "A组", b: "B组" }, commentary);
  const assessments = view.assessments as Record<string, { meets_core: boolean; summary: string }>;
  const evaluations = view.evaluations as Record<string, { summary: string; correctness_reason: string }>;
  assert.deepEqual(assessments, {
    a: { meets_core: true, summary: "A组 精简" },
    b: { meets_core: false, summary: "原B" },
  });
  assert.equal((view.decision_basis as { tradeoff: string }).tradeoff, "精简权衡");
  const rows = (view.decision_basis as unknown as ComparisonResult["decision_basis"]).comparisons;
  assert.equal(rows[0].assessments.a.summary, "A组 给出了4。");
  assert.equal(rows[0].assessments.b.summary, "原表现B");
  assert.deepEqual(rows[0].better_candidates, ["a"]);
  assert.equal((view.verdicts as Record<string, { reason: string }>)["a__vs__b"].reason, "精简判决");
  assert.equal(evaluations.a.summary, "归因A组精简");
  assert.equal(evaluations.a.correctness_reason, "A组正确");
  assert.equal(evaluations.b.summary, "原归因B");
  assert.equal(
    (row.assessments as Record<string, { summary: string }>).a.summary,
    "原A",
    "the exported row is never mutated",
  );
});

test("clustering polish selects descriptions without changing class identities or assignments", () => {
  const result = {
    assignments: [{ item_id: "item1", new_class_key: "n1" }],
    new_classes: [{ key: "n1", component: "工具", label: "缺失来源", definition: "没有列出来源。", closest_existing: "old", novelty: "适用边界不同。" }],
    merges: [{ into: "target", from: ["source"], reason: "同一问题。" }],
  };
  const before = structuredClone(result);
  assert.deepEqual(clusteringSlots(result).map((item) => item.id), [
    "new_classes.0.definition", "new_classes.0.novelty", "merges.0.reason",
  ]);
  assert.deepEqual(result, before);
  assert.deepEqual(clusteringSlots({ assignments: [{ item_id: "item1", class_id: "old" }], new_classes: [], merges: [] }), []);
});
