import { responsibilityFixture } from "../../../../tests/fixtures/responsibility.js";
import test from "node:test";
import assert from "node:assert/strict";
import { AgentRegistry } from "@eval/host";
import { ValidationError } from "@eval/contracts";
import { comparisonAgent, comparisonSlots, type ComparisonInput, type ComparisonResult, type ComparisonSubmission } from "./index.js";
import { requestComparisonSubmission } from "../../../../tests/fixtures/comparison-submission.js";
import { canonicalEvidence } from "../../../../tests/fixtures/evidence.js";
import example from "./fixtures/example.json" with { type: "json" };

const audit = { calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [] };
function scenario() {
  const request = structuredClone(example.request), registry = new AgentRegistry([comparisonAgent]);
  const input = request.input as unknown as ComparisonInput;
  const binding = { agent: "comparison", profile: "default", request };
  const draft = requestComparisonSubmission(request, example.result as ComparisonResult);
  return { request, input, registry, binding, draft };
}
const reason = "同一报告要求，A按报告发布时间判未完成，B按预测年份判完成，需统一期间口径。";
const conflictDraft = (draft: ComparisonSubmission, slot_index = 0) => ({ ...draft, preference: null, relative_preference: null,
  scope_conflicts: [{ slot_index, reason }] });

test("a reported critical conflict defers both known cores even when its row is low", () => {
  const f = scenario(), before = structuredClone(f.input.attributions);
  const slot = comparisonSlots(f.request)[0];
  const draft = conflictDraft(f.draft);
  draft.comparisons[0] = { importance: "low", better_candidate: null };
  const result = f.registry.resolve(f.binding, draft, audit) as ComparisonResult;
  f.registry.validate(f.binding, result, audit);
  assert.equal(result.status, "needs_review");
  assert.deepEqual(result.ranking, []);
  assert.deepEqual(result.decision_basis.comparisons, []);
  assert.deepEqual(result.decision_basis.decisive_findings, []);
  assert.deepEqual(result.review_requests, ["A", "B"].map(candidate => ({ candidate,
    criterion_ids: slot.criterion_ids, finding_indices: slot.finding_indices[candidate], reason })));
  assert(Object.values(result.assessments).every(assessment => assessment.meets_core === null));
  assert.deepEqual(f.input.attributions, before);
});

test("an independent core failure decides the pair while a minor uncertain aspect stays unused", () => {
  const f = scenario(), failed = f.input.attributions.B;
  const final = "2+2=5", evidence = canonicalEvidence(f.input.candidates.B.candidate_id, 1, final);
  f.request.sources.B.value.messages[1].content = final;
  f.request.input.candidates.B.final_answer = final;
  Object.assign(failed, { is_correct: false, correctness_reason: "加法结果错误。", correctness_evidence: [evidence],
    summary: "给出5，未完成所求计算。" });
  Object.assign(failed.core_assessment, { meets_core: false, reason: "所求结果应为4，实际给出5。" });
  Object.assign(failed.criterion_assessments[0], { status: "unmet", summary: "错误给出5。", evidence: [evidence] });
  Object.assign(failed.findings[0], { type: "problem", text: "加法结果错误", reason: "2+2应为4，回答给出5。",
    evidence: [evidence], problem: { component: [responsibilityFixture("最终作答节点（原始名称未提供）", {evidence_ids: ([evidence]).map(item=>item.evidence_id)})], label: "计算错误", definition: "所求加法结果错误。" } });
  Object.assign(failed.findings[0].assessment, { observation: final, impact: "所求结果不可用。" });
  f.input.task_analysis.scoring_points.push({ id: "explanation", text: "附加说明便于理解",
    acceptance_rule: "可附加说明，不影响核心加法结果的完成判定。", applies_to: [] });
  for (const attribution of Object.values(f.input.attributions)) {
    attribution.task_analysis = structuredClone(f.input.task_analysis);
    attribution.criterion_assessments.push({ ...structuredClone(attribution.criterion_assessments[0]),
      criterion_id: "explanation", status: "unknown", evidence_status: "uncertain",
      summary: "未独立核查附加说明质量，不影响已确认的数值结论。" });
  }
  const before = structuredClone(f.input.attributions), slots = comparisonSlots(f.request);
  const minorIndex = slots.findIndex(slot => slot.criterion_ids.includes("explanation"));
  const draft = requestComparisonSubmission(f.request, example.result as ComparisonResult);
  draft.preference = "A";
  draft.b_summary = f.request.input.attributions.B.summary;
  draft.comparisons[0] = { importance: "high", better_candidate: "A" };
  draft.comparisons[minorIndex] = { importance: "low", better_candidate: null };
  draft.tradeoff = "A正确给出4，B给出5，所求计算结果足以决定A胜出；附加说明未核查，不作为优势。";
  const result = f.registry.resolve(f.binding, draft, audit) as ComparisonResult;
  f.registry.validate(f.binding, result, audit);
  assert.equal(result.status, "decided");
  assert.deepEqual(result.ranking, [["A"], ["B"]]);
  assert.deepEqual(result.review_requests, []);
  const minor = result.decision_basis.comparisons.find(row => row.criterion_ids.includes("explanation"))!;
  assert.deepEqual(minor.better_candidates, []);
  assert(Object.values(minor.assessments).every(cell => cell.status === "unknown" && cell.evidence_status === "uncertain"));
  assert.deepEqual(result.decision_basis.decisive_findings, [
    { candidate: "A", finding_index: 0 }, { candidate: "B", finding_index: 0 },
  ]);
  assert.deepEqual(f.input.attributions, before);
});

test("absent or empty scope conflicts preserve the existing decided result", () => {
  const f = scenario();
  const original = f.registry.resolve(f.binding, f.draft, audit);
  assert.equal((original as ComparisonResult).status, "decided");
  assert.deepEqual(f.registry.resolve(f.binding, { ...f.draft, scope_conflicts: [] }, audit), original);
});

test("a decisive source interpretation dispute binds the existing finding and defers ranking without changing attribution", () => {
  const f = scenario(), before = structuredClone(f.input.attributions), slot = comparisonSlots(f.request)[0];
  const reason = "原文给综合位次，归因却按单项排序判错；这项解释影响正式胜负，须退回来源核查。";
  const result = f.registry.resolve(f.binding, { ...f.draft, preference: null, relative_preference: null,
    source_reviews: [{ slot_index: 0, candidate: "B", reason }] }, audit) as ComparisonResult;
  f.registry.validate(f.binding, result, audit);
  assert.equal(result.status, "needs_review");
  assert.deepEqual(result.ranking, []);
  assert.deepEqual(result.decision_basis.decisive_findings, []);
  assert.deepEqual(result.review_requests, [{ candidate: "B", criterion_ids: slot.criterion_ids,
    finding_indices: slot.finding_indices.B, reason }]);
  assert.equal(result.assessments.B.meets_core, null);
  assert.equal(result.assessments.A.meets_core, before.A.core_assessment.meets_core);
  assert.deepEqual(f.input.attributions, before);
});

test("source review cannot coexist with a winner or an inclination", () => {
  for (const preference of ["A", null]) {
    const f = scenario();
    assert.throws(() => f.registry.resolve(f.binding, { ...f.draft, preference, relative_preference: "A",
      source_reviews: [{ slot_index: 0, candidate: "A", reason }] }, audit), error => error instanceof ValidationError &&
      error.issues!.some(issue => issue.code === "source_review_preference"));
  }
});

test("source review rejects duplicate, resource and invented choices instead of changing source facts", () => {
  const f = scenario(), before = structuredClone(f.input.attributions), review = { slot_index: 0, candidate: "A", reason };
  const resource = comparisonSlots(f.request).findIndex(slot => slot.kind === "resource");
  for (const source_reviews of [[review, review], [{ ...review, slot_index: 999 }], [{ ...review, candidate: "C" }],
    ...(resource < 0 ? [] : [[{ ...review, slot_index: resource }]])]) {
    assert.throws(() => f.registry.resolve(f.binding, { ...f.draft, preference: null, relative_preference: null, source_reviews }, audit), ValidationError);
  }
  assert.throws(() => f.registry.resolve(f.binding, { ...conflictDraft(f.draft), source_reviews: [review] }, audit),
    error => error instanceof ValidationError && error.issues!.some(issue => issue.code === "source_review_duplicate"));
  assert.deepEqual(f.input.attributions, before);
  assert.deepEqual(f.registry.resolve(f.binding, { ...f.draft, source_reviews: [] }, audit),
    f.registry.resolve(f.binding, f.draft, audit), "uncontested factual comparisons still decide normally");
});

test("scope conflict choices reject duplicate slots, invalid scope and free-form identities", () => {
  const f = scenario();
  const own = { id: "own", text: "本方格式", acceptance_rule: "本方格式", applies_to: [f.input.candidates.A.candidate_id] };
  f.input.task_analysis.requirements.push(own);
  for (const [candidate, attribution] of Object.entries(f.input.attributions)) {
    attribution.task_analysis = structuredClone(f.input.task_analysis);
    attribution.criterion_assessments.push({ ...structuredClone(attribution.criterion_assessments[0]),
      criterion_id: own.id, status: candidate === "A" ? "met" : "not_applicable",
      evidence_status: "established", summary: "本方要求按适用范围记录。" });
  }
  f.input.candidates.A.original_answer_timing.finish_seconds = 1;
  const slots = comparisonSlots(f.request), draft = requestComparisonSubmission(f.request, example.result as ComparisonResult);
  const invalid = [
    [{ slot_index: 0, reason }, { slot_index: 0, reason: "另一段相同口径疑点。" }],
    [{ slot_index: slots.length, reason }],
    [{ slot_index: -1, reason }],
    [{ slot_index: 0.5, reason }],
    [{ slot_index: slots.findIndex(slot => !slot.shared), reason }],
    [{ slot_index: slots.findIndex(slot => slot.kind === "resource"), reason }],
    [{ criterion_id: "sum", reason }],
    [{ slot_index: 0, reason: " " }],
  ];
  for (const scope_conflicts of invalid) assert.throws(() => f.registry.resolve(f.binding,
    { ...conflictDraft(draft), scope_conflicts }, audit), error => error instanceof ValidationError &&
      error.issues!.some(issue => issue.path.startsWith("/scope_conflicts")));
});

test("a reported scope conflict cannot coexist with a formal or relative preference", () => {
  const f = scenario();
  for (const preference of [{ preference: "A" }, { relative_preference: "B" }])
    assert.throws(() => f.registry.resolve(f.binding, { ...conflictDraft(f.draft), ...preference }, audit),
      error => error instanceof ValidationError && error.issues!.some(issue => issue.code === "scope_conflict_preference"));
});

test("scope conflict review does not erase program-required source reviews", () => {
  const f = scenario();
  f.input.source_review = { A: [{ kind: "unresolved_conflict", requires_review: true, reason: "来源另有未解决核查。" }] };
  const result = f.registry.resolve(f.binding, conflictDraft(f.draft), audit) as ComparisonResult;
  f.registry.validate(f.binding, result, audit);
  assert(result.review_requests.some(review => review.reason === "来源另有未解决核查。"));
  assert(result.review_requests.some(review => review.candidate === "B" && review.reason === reason));
});
