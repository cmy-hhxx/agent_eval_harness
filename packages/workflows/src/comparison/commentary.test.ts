import { canonicalEvidence } from "../../../../tests/fixtures/evidence.js";
import test from "node:test";
import assert from "node:assert/strict";
import type { JsonObject, PlannedTask, RunState } from "@eval/contracts";
import type { Rewrites } from "@eval/agents/rewrite";
import {
  attributionSlots,
  attributionRewriteGroups,
  comparisonSlots,
  clusteringSlots,
  polishComparisonRow,
  polishAttribution,
  verdictSlotId,
  type CommentaryLookup,
} from "./commentary.js";
import type { AttributionResult, ComparisonResult, TaskData } from "./types.js";
import { display } from "./results.js";
import { acceptedRewriteProjection } from "./rewrite-projection.js";
import { attributionResult } from "../../../../tests/fixtures/comparison.js";

test("attribution rewrite groups isolate duplicate prose and each finding even below the slot cap", () => {
  const result = attributionResult(false);
  const original = result.findings[0]!;
  result.findings = [structuredClone(original), { ...structuredClone(original), finding_id: "f1" }];
  for (const finding of result.findings) {
    finding.assessment.observation = finding.text;
    finding.assessment.impact = finding.reason;
  }
  const before = structuredClone(result), groups = attributionRewriteGroups(result);
  assert.deepEqual(groups[0], ["summary", "core_assessment.reason", "correctness_reason"]);
  assert.deepEqual(groups[1], ["criterion_assessments.0.summary"]);
  assert.deepEqual(groups[2], attributionSlots(result).filter(item => item.id.startsWith("findings.0.")).map(item => item.id));
  assert.deepEqual(groups[3], attributionSlots(result).filter(item => item.id.startsWith("findings.1.")).map(item => item.id));
  assert(groups.every(group => group.length <= 20));
  assert.deepEqual(groups.flat(), attributionSlots(result).map(item => item.id));
  assert.deepEqual(attributionRewriteGroups(result, ["findings.1.problem.definition", "summary", "findings.0.text"]),
    [["summary"], ["findings.0.text"], ["findings.1.problem.definition"]]);
  assert.deepEqual(result, before);
});

test("criteria and table prose share bounded semantic batches without entering finding groups", () => {
  const result = attributionResult(false);
  result.criterion_assessments = Array.from({ length: 23 }, (_, index) => ({ ...result.criterion_assessments[0]!, criterion_id: `r${index}` }));
  result.table_resolutions = Array.from({ length: 21 }, (_, index) => ({ table_id: "table", row_index: index, outcome: "conflict", reason: "此行值不符。", evidence: [] }));
  const groups = attributionRewriteGroups(result);
  assert.deepEqual(groups.map(group => group.length), [3, 20, 3, 6, 20, 1]);
  assert(groups[1]!.every(id => id.startsWith("criterion_assessments.")));
  assert(groups[2]!.every(id => id.startsWith("criterion_assessments.")));
  assert(groups[4]!.every(id => id.startsWith("table_resolutions.")));
  assert.deepEqual(groups.flat(), attributionSlots(result).map(item => item.id));
});

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

test("program-derived comparison cells remain outside language rewrite slots", () => {
  const result = structuredClone(comparison);
  result.decision_basis.comparisons.push({ aspect: "原始完成时长与用量", criterion_ids: [], importance: "low", better_candidates: [],
    assessments: { A: { summary: "完成耗时：4.2 秒；总 token：80。", status: "met", evidence_status: "established", finding_indices: [] },
      B: { summary: "完成耗时：3.5 秒；总 token：100。", status: "met", evidence_status: "established", finding_indices: [] } } });
  const items = comparisonSlots(result, "items");
  assert.deepEqual(items.map(item => item.id), ["assessment.A.summary", "assessment.B.summary", "tradeoff"]);
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

test("tied verdict slots retain low-impact preference facts and counteradvantages without changing the result", () => {
  for (const meetsCore of [true, false]) {
    const result = structuredClone(comparison);
    result.ranking = [["B", "A"]];
    for (const label of ["A", "B"]) {
      result.assessments[label].meets_core = meetsCore;
      result.assessments[label].core_failure_refs = meetsCore ? [] : ["r1"];
      result.decision_basis.comparisons[0].assessments[label].status = meetsCore ? "met" : "unmet";
      result.decision_basis.comparisons[0].assessments[label].summary = meetsCore ? "正确给出4。" : "把结果写成5。";
    }
    result.decision_basis.comparisons[0].better_candidates = [];
    result.decision_basis.tradeoff = `${meetsCore ? "双方核心结果正确" : "双方核心结果都错"}。【候选A】少一处操作数标签笔误，轻微偏好【候选A】；【候选B】完成更快，均不足以改变正式判决。`;
    result.decision_basis.comparisons.push({
      aspect: "操作数标签", criterion_ids: ["s1"], importance: "low", better_candidates: ["A"], assessments: {
        A: { status: "met", evidence_status: "established", summary: "标签正确。", finding_indices: [] },
        B: { status: "met", evidence_status: "established", summary: "有一处标签笔误，操作数仍可辨认。", finding_indices: [] },
      },
    }, {
      aspect: "完成等待", criterion_ids: [], importance: "low", better_candidates: ["B"], assessments: {
        A: { status: "met", evidence_status: "established", summary: "完成耗时：4.2 秒。", finding_indices: [] },
        B: { status: "met", evidence_status: "established", summary: "完成耗时：3.5 秒。", finding_indices: [] },
      },
    });
    const before = structuredClone(result), [item] = comparisonSlots(result);
    assert.equal(item.preference, meetsCore ? "双方都好" : "双方都差");
    assert(item.text.includes(result.decision_basis.tradeoff));
    assert.match(item.text, /操作数标签：【候选B】：有一处标签笔误.*【候选A】：标签正确/);
    assert.match(item.text, /完成等待：【候选B】：完成耗时：3\.5 秒.*【候选A】：完成耗时：4\.2 秒/);
    if (!meetsCore) assert.match(item.text, /计算结果.*把结果写成5/);
    const presented = display(item, { A: "B组Fast", B: "A组Fast" });
    assert.match(presented.text, /B组Fast少一处操作数标签笔误，轻微偏好B组Fast；A组Fast完成更快/);
    assert.match(presented.text, /操作数标签：A组Fast：有一处标签笔误.*B组Fast：标签正确/);
    assert.match(presented.text, /完成等待：A组Fast：完成耗时：3\.5 秒.*B组Fast：完成耗时：4\.2 秒/);
    assert.deepEqual(result, before);
    result.assessments.A.meets_core = true;
    result.assessments.B.meets_core = false;
    result.ranking = [["A"], ["B"]];
    assert.doesNotMatch(comparisonSlots(result)[0].text, /操作数标签：|完成等待：/,
      "formal win slots retain their existing decisive-fact scope");
  }
});

test("tied verdict slots exclude low-impact observations without a confirmed shared advantage", () => {
  const result = structuredClone(comparison);
  result.assessments.B.meets_core = true;
  result.ranking = [["A", "B"]];
  result.decision_basis.comparisons = [{
    aspect: "本方专有规范", criterion_ids: ["r1"], importance: "low", better_candidates: [], assessments: {
      A: { status: "met", evidence_status: "established", summary: "符合本方规范。", finding_indices: [] },
      B: { status: "not_applicable", evidence_status: "established", summary: "该规范不适用于本方。", finding_indices: [] },
    },
  }, {
    aspect: "未核实信息", criterion_ids: ["s1"], importance: "low", better_candidates: [], assessments: {
      A: { status: "met", evidence_status: "established", summary: "已确认。", finding_indices: [] },
      B: { status: "unknown", evidence_status: "uncertain", summary: "尚未核实。", finding_indices: [] },
    },
  }];
  const [item] = comparisonSlots(result);
  assert.doesNotMatch(item.text, /本方专有规范|未核实信息/);
});

test("attribution slots include the correctness reason only when it exists", () => {
  assert.deepEqual(attributionSlots(attribution).map((item) => item.id), ["summary", "core_assessment.reason", "correctness_reason"]);
  const subjective = { ...attribution, is_correct: null, correctness_reason: "" };
  assert.deepEqual(attributionSlots(subjective).map((item) => item.id), ["summary", "core_assessment.reason"]);
});

test("attribution rewrites include displayed observations and impact without changing receipts", () => {
  const result = attributionResult();
  const valid = [{ id: "summary", text: "新结论" }, { id: "findings.0.text", text: "新点评" }, { id: "findings.0.reason", text: "新理由" }];
  valid.push({ id: "findings.0.assessment.observation", text: "通俗观察" },
    { id: "findings.0.assessment.impact", text: "通俗影响" });
  const stored = [...valid, { id: "findings.0.problem.component", text: "不能改归属" }];
  const state = {
    manifest: { tasks: [{ id: "rewrite", stage: "rewrite", data: { rewriteOf: { taskId: "source", stage: "attribution" } } }] },
    receipts: { source: { evaluation: result }, rewrite: { acceptedAt: 1, evaluatorVersion: "fixture", evaluation: { rewrites: stored } } },
  } as unknown as RunState;
  const before = structuredClone(state);
  assert.deepEqual(attributionSlots(result).map(item => item.id), ["summary", "core_assessment.reason", "correctness_reason",
    "criterion_assessments.0.summary", "findings.0.text", "findings.0.reason", "findings.0.assessment.observation", "findings.0.assessment.impact"]);
  const projection = acceptedRewriteProjection(state, "source")!;
  assert.deepEqual(projection.rewritten.rewrites, valid);
  assert.deepEqual([...projection.owners.keys()], valid.map(item => item.id));
  assert.deepEqual(state, before);
});

test("attribution display polish covers all prose while preserving judgments, responsibility and original evidence", () => {
  const result = attributionResult(false);
  result.table_resolutions = [{ table_id: "table", row_index: 0, outcome: "conflict", reason: "旧表格理由", evidence: result.correctness_evidence }];
  const before = structuredClone(result), slots = attributionSlots(result);
  const rewrites = Object.fromEntries(slots.map(item => [item.id, `通俗：${item.text}`]));
  const view = polishAttribution(result, rewrites);
  assert.equal(view.core_assessment.reason, `通俗：${result.core_assessment.reason}`);
  assert.equal(view.criterion_assessments[0].summary, `通俗：${result.criterion_assessments[0].summary}`);
  assert.equal(view.findings[0].assessment.observation, `通俗：${result.findings[0].assessment.observation}`);
  assert.equal(view.findings[0].assessment.impact, `通俗：${result.findings[0].assessment.impact}`);
  assert.equal(view.findings[0].problem!.label, `通俗：${result.findings[0].problem!.label}`);
  assert.equal(view.findings[0].problem!.definition, `通俗：${result.findings[0].problem!.definition}`);
  assert.equal(view.table_resolutions![0].reason, "通俗：旧表格理由");
  assert.equal(view.is_correct, result.is_correct);
  assert.equal(view.core_assessment.meets_core, result.core_assessment.meets_core);
  assert.deepEqual(view.findings[0].problem!.component, result.findings[0].problem!.component);
  assert.deepEqual(view.findings[0].evidence, result.findings[0].evidence);
  assert.deepEqual(view.criterion_assessments.map(item => [item.status, item.evidence_status]),
    result.criterion_assessments.map(item => [item.status, item.evidence_status]));
  assert.deepEqual(result, before);
  result.findings[0].assessment.impact = "";
  assert(!attributionSlots(result).some(item => item.id === "findings.0.assessment.impact"));
});

test("item refresh includes only model-written overall prose and preserves derived cells", () => {
  const before = structuredClone(comparison), items = comparisonSlots(comparison, "items");
  assert.deepEqual(items.map(item => item.id), ["assessment.A.summary", "assessment.B.summary", "tradeoff"]);
  assert.deepEqual(items.map(item => item.text), [comparison.assessments.A.summary, comparison.assessments.B.summary,
    comparison.decision_basis.tradeoff]);
  assert(!items.some(item => item.id.startsWith("comparison.")));
  assert.deepEqual(comparison, before);
});

test("complete comparison rewrite includes the verdict and model-written overall prose", () => {
  const slots = comparisonSlots(comparison, "all");
  assert.deepEqual(slots, [...comparisonSlots(comparison, "verdicts"), ...comparisonSlots(comparison, "items")]);
  assert.equal(new Set(slots.map((slot) => slot.id)).size, 4);
  assert.equal(slots[0].preference, "【候选A】更好");
  assert(!slots.some(slot => slot.id.startsWith("comparison.")));
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
  assert.equal(rows[0].assessments.a.summary, "原表现A", "program-derived cells cannot be overwritten by rewrite text");
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
    new_classes: [{ key: "n1", component: "工具", label: "缺失来源", definition: "没有列出来源。", closest_existing: "old", novelty: "适用边界不同。", category_paths: [["数值可靠性"]] }],
    merges: [{ into: "target", from: ["source"], reason: "同一问题。" }],
  };
  const before = structuredClone(result);
  assert.deepEqual(clusteringSlots(result).map((item) => item.id), [
    "new_classes.0.label", "new_classes.0.definition", "new_classes.0.novelty", "merges.0.reason",
  ]);
  assert.deepEqual(result, before);
  assert.deepEqual(clusteringSlots({ assignments: [{ item_id: "item1", class_id: "old" }], new_classes: [], merges: [] }), []);
  const maintenance = { assignments: [{ item_id: "item2", deferred_reason: "本次新增预算为零。" }], new_classes: [], merges: [],
    class_updates: [{ class_id: "old", label: "来源映射错误", definition: "依据真实来源映射。", reason: "修正错误的编号判断。", category_paths: [["溯源"]] }] };
  assert.deepEqual(clusteringSlots(maintenance).map(item => item.id), [
    "assignments.0.deferred_reason", "class_updates.0.label", "class_updates.0.definition", "class_updates.0.reason",
  ]);
});
