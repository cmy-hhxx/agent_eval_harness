import { canonicalEvidence } from "../../../../tests/fixtures/evidence.js";
import test from "node:test";
import assert from "node:assert/strict";
import type { JsonObject, PlannedTask, RunState } from "@eval/contracts";
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
import { acceptedRewriteProjection } from "./rewrite-projection.js";
import { attributionResult } from "../../../../tests/fixtures/comparison.js";

test("candidate display names replace only explicit markers and leave all other text unchanged", () => {
  const names = { A: "A组Fast", B: "B组Fast", C: "C组Fast" };
  const businessText = "基金 A/B 类、A/B/C 类、方案 A 与 B、候选A商品、全A、A股、A+B=C，独立字母 A、B、C。";
  assert.equal(display(businessText, names), businessText);
  assert.equal(display(`【候选A】比较${businessText}【候选B】也有提及；【候选Z】未知。`, names),
    `A组Fast比较${businessText}B组Fast也有提及；【候选Z】未知。`);
  assert.deepEqual(display({ text: "【候选A】引用", evidence: [{ quote: "【候选A】与 A/B 类" }] }, names),
    { text: "A组Fast引用", evidence: [{ quote: "【候选A】与 A/B 类" }] });
});

test("real group names survive reversed blind labels and repeated display", () => {
  const names = { A: "B组Fast", B: "A组Fast" };
  const text = display("【候选A】优于【候选B】；B组Fast核查完整，A组Fast遗漏。", names);
  assert.equal(text, "B组Fast优于A组Fast；B组Fast核查完整，A组Fast遗漏。");
  assert.equal(display(text, names), text);
});

const comparison: ComparisonResult = {
  status: "decided", review_requests: [],
  task_analysis: {
    task_type: "整数加法",
    goal: "计算2+2",
    requirements: [{ id: "r1", text: "给出正确的加法结果", applies_to: [], acceptance_rule: "给出正确的加法结果" }],
    scoring_points: [{ id: "s1", text: "使用指定操作数", applies_to: [], acceptance_rule: "使用指定操作数" }],
    red_flags: [{ id: "f1", text: "擅自替换操作数", applies_to: [], acceptance_rule: "擅自替换操作数" }],
  },
  ranking: [["A"], ["B"]],
  assessments: {
    A: { meets_core: true, core_failure_refs: [], summary: "【候选A】结论" },
    B: { meets_core: false, core_failure_refs: [], summary: "【候选B】结论" },
  },
  decision_basis: { tradeoff: "【候选A】完成核心要求，【候选B】未完成。", decisive_findings: [], comparisons: [{
    aspect: "计算结果", criterion_ids: ["r1"], importance: "high", better_candidates: ["A"], assessments: {
      A: { status: "met", evidence_status: "established", summary: "正确给出4。", finding_indices: [] }, B: { status: "met", evidence_status: "established", summary: "未给出结果。", finding_indices: [] },
    },
  }] },
};
const attribution: AttributionResult = {
  criterion_assessments: [], core_assessment: { meets_core: true, reason: "已完成。", criterion_ids: ["r1"] },
  has_standard_answer: true,
  is_correct: true,
  correctness_reason: "与标准答案一致。",
  numeric_checks: [],
  correctness_evidence: [canonicalEvidence("11111111-1111-4111-8111-111111111111", 1, "2+2=4")],
  task_analysis: structuredClone(comparison.task_analysis),
  summary: "回答正确。",
  findings: [],
};

test("comparison rewrites only the pair preference using its accepted match facts", () => {
  const items = comparisonSlots(comparison);
  assert.deepEqual(
    items.map((item) => item.id).sort(),
    [verdictSlotId("A", "B")],
  );
  assert.match(items.find((item) => item.id === verdictSlotId("B", "A"))!.text, /【候选A】完成核心要求/);
  const failed = structuredClone(comparison);
  failed.assessments.A!.meets_core = false;
  failed.ranking = [["A", "B"]];
  assert.equal(comparisonSlots(failed)[0]!.preference, "双方都差");
  const bothMet = structuredClone(comparison);
  bothMet.assessments.B!.meets_core = true;
  assert.equal(comparisonSlots(bothMet)[0]!.preference, "【候选A】更好");
  assert.match(comparisonSlots(bothMet)[0]!.text, /计算结果.*正确给出4/);
  bothMet.ranking = [["B", "A"]];
  assert.equal(comparisonSlots(bothMet)[0]!.preference, "双方都好");
});

test("recorded resource cells remain outside language rewrite slots", () => {
  const result = structuredClone(comparison);
  result.decision_basis.comparisons.push({ aspect: "原始完成时长与用量", criterion_ids: [], importance: "low", better_candidates: [],
    assessments: { A: { summary: "完成耗时：4.2 秒；总 token：80。", status: "met", evidence_status: "established", finding_indices: [] },
      B: { summary: "完成耗时：3.5 秒；总 token：100。", status: "met", evidence_status: "established", finding_indices: [] } } });
  const items = comparisonSlots(result, "items");
  assert.deepEqual(items.map(item => item.id), ["comparison.0.A.summary", "comparison.0.B.summary"]);
  assert.deepEqual(result.decision_basis.comparisons[1].assessments.A.summary, "完成耗时：4.2 秒；总 token：80。");
});

test("both-bad slots carry the accepted relative tradeoff through reversed blind names", () => {
  const result = structuredClone(comparison);
  result.assessments.A.meets_core = false;
  result.ranking = [["B", "A"]];
  result.decision_basis.tradeoff = "双方都没给回测结果。【候选B】相对更好，给出了代码，【候选A】只有方法。";
  result.decision_basis.comparisons[0] = {
    aspect: "回测交付", criterion_ids: ["r1"], importance: "high", better_candidates: ["B"], assessments: {
      A: { status: "met", evidence_status: "established", summary: "只有方法。", finding_indices: [] }, B: { status: "met", evidence_status: "established", summary: "给出代码，未给结果。", finding_indices: [] },
    },
  };
  const before = structuredClone(result);
  const [item] = comparisonSlots(result);
  assert.equal(item.id, verdictSlotId("A", "B"));
  assert.equal(item.preference, "双方都差");
  assert(item.text.includes(result.decision_basis.tradeoff));
  const presented = display(item, { A: "B组Fast", B: "A组Fast" });
  assert.match(presented.text, /A组Fast相对更好，给出了代码，B组Fast只有方法/);
  assert.deepEqual(result, before);
  result.decision_basis.tradeoff = "双方都没给结果，也没有其他有用内容，无法区分相对优劣。";
  assert(comparisonSlots(result)[0].text.includes(result.decision_basis.tradeoff));
});

test("attribution slots include the correctness reason only when it exists", () => {
  assert.deepEqual(attributionSlots(attribution).map((item) => item.id), ["summary", "correctness_reason"]);
  const subjective = { ...attribution, is_correct: null, correctness_reason: "" };
  assert.deepEqual(attributionSlots(subjective).map((item) => item.id), ["summary"]);
});

test("attribution rewrites only independent prose and projects the current slots without changing receipts", () => {
  const result = attributionResult();
  const valid = [{ id: "summary", text: "新结论" }, { id: "findings.0.text", text: "新点评" }, { id: "findings.0.reason", text: "新理由" }];
  const stored = [...valid, { id: "findings.0.assessment.observation", text: "重复观察" },
    { id: "findings.0.assessment.impact", text: "错位影响" }];
  const state = {
    manifest: { tasks: [{ id: "rewrite", stage: "rewrite", data: { rewriteOf: { taskId: "source", stage: "attribution" } } }] },
    receipts: { source: { evaluation: result }, rewrite: { acceptedAt: 1, evaluatorVersion: "fixture", evaluation: { rewrites: stored } } },
  } as unknown as RunState;
  const before = structuredClone(state);
  assert.deepEqual(attributionSlots(result).map(item => item.id), ["summary", "correctness_reason", "findings.0.text", "findings.0.reason"]);
  const projection = acceptedRewriteProjection(state, "source")!;
  assert.deepEqual(projection.rewritten.rewrites, valid);
  assert.deepEqual([...projection.owners.keys()], valid.map(item => item.id));
  assert.deepEqual(state, before);
});

test("item refresh selects only comparison cells with local advantages and separate counterpart context", () => {
  const before = structuredClone(comparison);
  const items = comparisonSlots(comparison, "items");
  assert.deepEqual(items.map((item) => item.id), ["comparison.0.A.summary", "comparison.0.B.summary"]);
  assert(items.every((item) => !item.preference));
  assert.equal(items[0]!.text, "正确给出4。");
  assert(items[0]!.forbiddenPrefixes!.includes("【候选B】："));
  assert(!items[0]!.forbiddenPrefixes!.includes("【候选A】："));
  assert.match(items[0]!.context!, /本项已确定的优势：【候选A】/);
  assert.match(items[0]!.context!, /不能写成本格事实：【候选B】：未给出结果/);
  assert.deepEqual(comparison, before);
  const shared = structuredClone(comparison);
  shared.decision_basis.comparisons[0]!.better_candidates = [];
  assert.match(comparisonSlots(shared, "items")[0]!.context!, /没有已证实的单方优势/);
});

test("complete comparison rewrite includes the verdict and every cell with its own context", () => {
  const slots = comparisonSlots(comparison, "all");
  assert.deepEqual(slots, [...comparisonSlots(comparison, "verdicts"), ...comparisonSlots(comparison, "items")]);
  assert.equal(new Set(slots.map((slot) => slot.id)).size, 3);
  assert.equal(slots[0].preference, "【候选A】更好");
  assert(slots.slice(1).every((slot) => slot.context && slot.forbiddenPrefixes?.length));
});

test("presentation view applies already-unblinded rewrites by slot without interpreting their text", () => {
  const task = {
    id: "cmp",
    stage: "comparison",
    dependencies: { A: "attr-a", B: "attr-b" },
    inputIds: {},
    data: {
      stage: "comparison",
      candidates: { A: { version: "b", name: "B组" }, B: { version: "a", name: "A组" } },
    } as unknown as TaskData,
  } as unknown as PlannedTask;
  const row: JsonObject = {
    assessments: { a: { meets_core: true, core_failure_refs: [], summary: "原A" }, b: { meets_core: false, core_failure_refs: [], summary: "原B" } },
    evaluations: {
      a: { summary: "原归因A", correctness_reason: "原理由A" },
      b: { summary: "原归因B", correctness_reason: "原理由B", findings: [{ text: "原点评", reason: "原理由",
        assessment: { observation: "原始观察", impact: "独立的原始影响" } }] },
    },
    verdicts: { "a__vs__b": { reason: "原判决" } },
    decision_basis: { tradeoff: "原权衡", comparisons: [{ aspect: "结果", criterion_ids: ["r1"], importance: "high", better_candidates: ["a"], assessments: {
      a: { status: "met", evidence_status: "established", summary: "原表现A", finding_indices: [] }, b: { status: "met", evidence_status: "established", summary: "原表现B", finding_indices: [] },
    } }] },
  };
  const bySource: Record<string, Rewrites> = {
    cmp: {
      "assessment.B.summary": "A组精简",
      tradeoff: "精简权衡",
      "comparison.0.B.summary": "A组给出了4。",
      [verdictSlotId("A", "B")]: "精简判决",
    },
    "attr-b": { summary: "归因A精简", correctness_reason: "A组正确" },
    "attr-a": { summary: "B组保留基金A/B类及原文“【候选A】”。", correctness_reason: "B组与标准答案一致。",
      "findings.0.text": "精简点评", "findings.0.reason": "精简理由" },
  };
  const commentary: CommentaryLookup = { of: (source) => (source ? bySource[source] : undefined) };
  const view = polishComparisonRow(row, task, commentary);
  const assessments = view.assessments as Record<string, { meets_core: boolean; summary: string }>;
  const evaluations = view.evaluations as Record<string, { summary: string; correctness_reason: string }>;
  assert.deepEqual(assessments, {
    a: { meets_core: true, core_failure_refs: [], summary: "A组精简" },
    b: { meets_core: false, core_failure_refs: [], summary: "原B" },
  });
  assert.equal((view.decision_basis as { tradeoff: string }).tradeoff, "精简权衡");
  const rows = (view.decision_basis as unknown as ComparisonResult["decision_basis"]).comparisons;
  assert.equal(rows[0].assessments.a.summary, "A组给出了4。");
  assert.equal(rows[0].assessments.b.summary, "原表现B");
  assert.deepEqual(rows[0].better_candidates, ["a"]);
  assert.equal((view.verdicts as Record<string, { reason: string }>)["a__vs__b"].reason, "精简判决");
  assert.equal(evaluations.a.summary, "归因A精简");
  assert.equal(evaluations.a.correctness_reason, "A组正确");
  assert.equal(evaluations.b.summary, "B组保留基金A/B类及原文“【候选A】”。");
  assert.equal(evaluations.b.correctness_reason, "B组与标准答案一致。");
  const finding = (view.evaluations as unknown as Record<string, AttributionResult>).b.findings[0];
  assert.equal(finding.text, "精简点评");
  assert.equal(finding.reason, "精简理由");
  assert.deepEqual(finding.assessment, { observation: "原始观察", impact: "独立的原始影响" });
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
  const maintenance = { assignments: [{ item_id: "item2", deferred_reason: "本次新增预算为零。" }], new_classes: [], merges: [],
    class_updates: [{ class_id: "old", definition: "依据真实来源映射。", reason: "修正错误的编号判断。", category_paths: [["溯源"]] }] };
  assert.deepEqual(clusteringSlots(maintenance).map(item => item.id), [
    "assignments.0.deferred_reason", "class_updates.0.definition", "class_updates.0.reason",
  ]);
});
