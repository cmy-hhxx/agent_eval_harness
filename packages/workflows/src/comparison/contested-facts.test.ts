import test from "node:test";
import assert from "node:assert/strict";
import type { TaskAnalysis } from "@eval/contracts";
import { contestedFactReviews, contestedPairFacts } from "./contested-facts.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

function analysis(): TaskAnalysis {
  return { task_type: "任务原文验收", goal: "2025年12月22日成交的日元对人民币1周掉期的交割日是哪一天",
    requirements: [{ id: "r1", text: "给出交割日", applies_to: [], acceptance_rule: "给出交割日" }], scoring_points: [], red_flags: [] };
}

function attribution(text: string, overrides: {
  importance?: "high" | "medium" | "low"; evidence_status?: "established" | "uncertain";
  type?: "strength" | "problem"; dimension?: string;
} = {}) {
  return {
    task_analysis: analysis(),
    criterion_assessments: [{ criterion_id: "r1", status: "met" as const, evidence_status: "established" as const, summary: "给出结果。" }],
    core_assessment: { meets_core: true, reason: "已给出结果。", criterion_ids: ["r1"] },
    findings: [{
      type: overrides.type ?? "strength", dimension: overrides.dimension ?? "correctness", importance: overrides.importance ?? "high",
      text, assessment: { requirement_index: 0, observation: text, evidence_status: overrides.evidence_status ?? "established", impact: "影响交割日结论。" },
      evidence: [], reason: "fixture",
    }],
  };
}

function input(textA: string, textB: string, options: { shared_applies_to?: string[]; overridesA?: Parameters<typeof attribution>[1]; overridesB?: Parameters<typeof attribution>[1] } = {}) {
  const task_analysis = analysis();
  if (options.shared_applies_to) task_analysis.requirements[0]!.applies_to = options.shared_applies_to;
  return { task_analysis, candidates: { A: { candidate_id: A }, B: { candidate_id: B } },
    attributions: { A: attribution(textA, options.overridesA), B: attribution(textB, options.overridesB) } } as unknown as Parameters<typeof contestedPairFacts>[0];
}

test("fully disjoint dates for one shared requirement are a contest", () => {
  const facts = contestedPairFacts(input("远端交割日 2025年12月31日（周三）", "远端交割日 2026年1月5日（周一）"));
  assert.equal(facts.length, 1);
  assert.equal(facts[0]!.criterion_id, "r1");
  assert.deepEqual(facts[0]!.values, { A: ["2025年12月31日"], B: ["2026年1月5日"] });
  const reviews = contestedFactReviews(facts, ["A", "B"]);
  for (const label of ["A", "B"]) {
    assert.equal(reviews[label]!.length, 1);
    assert.equal(reviews[label]![0]!.kind, "unresolved_conflict");
    assert.equal(reviews[label]![0]!.requires_review, true);
    assert.match(reviews[label]![0]!.reason, /2025年12月31日/);
    assert.match(reviews[label]![0]!.reason, /2026年1月5日/);
  }
});

test("a shared calendar day, including a year-less writing, is not a contest", () => {
  assert.deepEqual(contestedPairFacts(input("结论日为2025-12-31", "结论日为2025年12月31日")), []);
  assert.deepEqual(contestedPairFacts(input("结论日为12月31日", "结论日为2024-12-31")), []);
  assert.deepEqual(contestedPairFacts(input("12月24日近端、12月31日远端", "12月24日近端、1月5日远端")), []);
});

test("only pair-applicable, established, high-importance strengths can contest", () => {
  assert.deepEqual(contestedPairFacts(input("2025-12-31", "2026-01-05", { shared_applies_to: [A] })), []);
  assert.deepEqual(contestedPairFacts(input("2025-12-31", "2026-01-05", { overridesA: { importance: "medium" } })), []);
  assert.deepEqual(contestedPairFacts(input("2025-12-31", "2026-01-05", { overridesA: { evidence_status: "uncertain" } })), []);
  assert.deepEqual(contestedPairFacts(input("2025-12-31", "2026-01-05", { overridesA: { type: "problem" } })), []);
  assert.deepEqual(contestedPairFacts(input("2025-12-31", "2026-01-05", { overridesA: { dimension: "format" } })), []);
  assert.deepEqual(contestedPairFacts(input("无具体日期", "2026-01-05")), []);
  const instruction = input("远端交割日 2025-12-31", "远端交割日 2026-01-05", { overridesA: { dimension: "instruction_following" }, overridesB: { dimension: "instruction_following" } });
  assert.equal(contestedPairFacts(instruction).length, 1);
});
