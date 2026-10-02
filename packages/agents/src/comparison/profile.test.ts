import test from "node:test";
import assert from "node:assert/strict";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { AgentRequest, ToolAudit } from "@eval/contracts";
import { comparisonAgent, comparisonProfile } from "./index.js";
import type { ComparisonInput, ComparisonResult, ComparisonSubmission } from "./types.js";
import example from "./fixtures/example.json" with { type: "json" };

const audit: ToolAudit = { calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [] };
const validate = (request: AgentRequest, result: unknown, reads = audit) => comparisonProfile.validate!(request, result, reads);
const pair = () => ({ request: structuredClone(example.request), result: structuredClone(example.result) as ComparisonResult });
const submission = (result: ComparisonResult): ComparisonSubmission => {
  const common = { assessments: Object.fromEntries(Object.entries(result.assessments).map(([label, item]) => [label, { summary: item.summary }])),
    review_requests: structuredClone(result.review_requests) };
  if (result.status === "needs_review") return { ...common, status: "needs_review" };
  return { ...common, status: "decided", ranking: structuredClone(result.ranking), decision_basis: {
    ...structuredClone(result.decision_basis), comparisons: result.decision_basis.comparisons.map(row => ({ ...structuredClone(row),
      assessments: Object.fromEntries(Object.entries(row.assessments).map(([label, cell]) =>
        [label, { summary: cell.summary, finding_indices: [...cell.finding_indices] }])) })),
  } };
};
const resolve = (data: ReturnType<typeof pair>) => comparisonProfile.resolve!(data.request, submission(data.result), audit) as ComparisonResult;
const review = () => {
  const data = pair();
  data.result.status = "needs_review";
  data.result.ranking = [];
  data.result.decision_basis.decisive_findings = [];
  data.result.review_requests.push({ candidate: "A", criterion_ids: ["sum"], finding_indices: [], reason: "来源遗漏，需要复核最终表格。" } as never);
  return data;
};

test("a located review request resolves without first constructing a complete comparison matrix", () => {
  const data = review();
  Object.assign(data.request.input, { source_review: { A: ["最终表有未核实来源行。"] } });
  const draft = submission(data.result);
  const result = comparisonProfile.resolve!(data.request, draft, audit) as ComparisonResult;
  assert.deepEqual(result.ranking, []);
  assert.deepEqual(result.decision_basis.comparisons, []);
  assert.deepEqual(result.decision_basis.decisive_findings, []);
  assert.equal(result.assessments.A.meets_core, null);
  assert.deepEqual(result.assessments.A.core_failure_refs, []);
  assert.equal(result.assessments.B.meets_core, true);
  validate(data.request, result);
  assert.throws(() => comparisonProfile.resolve!(data.request, { ...draft, ranking: [], decision_basis: data.result.decision_basis }, audit));
  const decided = pair();
  decided.result.decision_basis.comparisons = [];
  assert.throws(() => validate(decided.request, decided.result), /1 items/);
  result.review_requests[0].candidate = "B";
  assert.throws(() => validate(data.request, result), /来源核验/);
});

test("review requests cannot leave an unknown assessment unreviewed or send a blank reason", () => {
  const data = review();
  data.result.assessments.B.meets_core = null;
  assert.throws(() => validate(data.request, data.result), /核心状态未决/);
  data.result.assessments.B.meets_core = true;
  data.result.review_requests[0].reason = "   ";
  assert.throws(() => validate(data.request, data.result), /复核原因不能为空/);
});

test("unresolved source table evidence requires independent review instead of a decided ranking", () => {
  const data = pair();
  Object.assign(data.request.input, { source_review: { A: ["原始来源与最终代码/名称对应仍有冲突。"] } });
  assert.throws(() => validate(data.request, data.result), (error: unknown) =>
    error instanceof Error && error.message.includes("来源核验"));
  const pending = review();
  Object.assign(pending.request.input, { source_review: { A: ["原始来源与最终代码/名称对应仍有冲突。"] } });
  validate(pending.request, pending.result);
});

test("unknown core evidence requests review of the unresolved candidate and its core criteria", () => {
  const data = review();
  data.request.input.attributions.A.core_assessment.meets_core = null as unknown as boolean;
  data.request.input.attributions.A.criterion_assessments[0].status = "unknown";
  data.request.input.attributions.A.criterion_assessments[0].evidence_status = "uncertain";
  data.result.assessments.A.meets_core = null;
  data.result.decision_basis.comparisons[0].assessments.A.status = "unknown";
  data.result.decision_basis.comparisons[0].assessments.A.evidence_status = "uncertain";
  validate(data.request, data.result);
  data.result.review_requests[0].candidate = "B";
  assert.throws(() => validate(data.request, data.result), /核心状态未决/);
  data.result.review_requests[0].candidate = "A";
  data.result.review_requests[0].criterion_ids = [];
  data.result.review_requests[0].finding_indices = [0];
  assert.throws(() => validate(data.request, data.result), /核心状态未决/);
});
const fail = (data: ReturnType<typeof pair>, label: "A" | "B") => {
  const attribution = data.request.input.attributions[label];
  attribution.core_assessment.meets_core = false;
  attribution.core_assessment.criterion_ids = ["sum"];
  attribution.criterion_assessments[0].status = "unmet";
  attribution.findings[0].type = "problem";
  data.result.assessments[label].meets_core = false;
  data.result.assessments[label].core_failure_refs = ["sum"];
  data.result.decision_basis.comparisons[0].assessments[label].status = "unmet";
};

test("Comparison accepts an independently judged pair and mirrors the shared analysis", () => {
  assert.deepEqual(Object.keys(comparisonAgent.profiles), ["default"]);
  validate(example.request, example.result);
  const draft = submission(example.result as ComparisonResult);
  const resolved = comparisonProfile.resolve!(example.request, draft, audit) as typeof example.result;
  assert.deepEqual(resolved.task_analysis, example.request.input.task_analysis);
  assert.notEqual(resolved.task_analysis, example.request.input.task_analysis);
  assert.deepEqual(resolved.assessments, example.result.assessments);
  assert.deepEqual(resolved.decision_basis, example.result.decision_basis);
  validate(example.request, resolved);
  assert.throws(() => comparisonProfile.resolve!(example.request, example.result, audit), /additional properties/);
  const changed = pair(); changed.result.task_analysis.goal = "新目标";
  assert.throws(() => validate(changed.request, changed.result), /不得增加、改写或删除/);
  const localError = pair(); localError.request.input.attributions.A.is_correct = false;
  validate(localError.request, localError.result);
});

test("submissions reject source state fields and resolution preserves source core failures", () => {
  const data = pair(); fail(data, "A"); data.result.ranking = [["B"], ["A"]];
  const draft = submission(data.result);
  const result = comparisonProfile.resolve!(data.request, draft, audit) as ComparisonResult;
  assert.equal(result.assessments.A.meets_core, false);
  assert.deepEqual(result.assessments.A.core_failure_refs, ["sum"]);
  assert.equal(result.decision_basis.comparisons[0].assessments.A.status, "unmet");
  validate(data.request, result);
  assert.deepEqual(draft, submission(data.result), "resolution must not mutate the model submission");
  for (const field of ["meets_core", "core_failure_refs"]) {
    const invalid = structuredClone(draft);
    Object.assign(invalid.assessments.A, { [field]: result.assessments.A[field as "meets_core" | "core_failure_refs"] });
    assert.throws(() => comparisonProfile.resolve!(data.request, invalid, audit), /additional properties/);
  }
  for (const field of ["status", "evidence_status"]) {
    const invalid = structuredClone(draft);
    if (invalid.status !== "decided") throw new Error("expected decided fixture");
    Object.assign(invalid.decision_basis.comparisons[0].assessments.A, { [field]: "met" });
    assert.throws(() => comparisonProfile.resolve!(data.request, invalid, audit), /additional properties/);
  }
  const invalid = structuredClone(draft);
  (invalid.assessments as Record<string, unknown>)["候选A"] = invalid.assessments.A;
  delete invalid.assessments.A;
  assert.throws(() => comparisonProfile.resolve!(data.request, invalid, audit), /合法候选标识.*\["A","B"\]/);
});

test("resolution aggregates applicable source criteria and preserves uncertain findings", () => {
  const data = pair();
  const partial = { id: "detail", text: "补全细节", applies_to: [], acceptance_rule: "给出全部细节。" };
  data.request.input.task_analysis.scoring_points.push(partial as never);
  data.result.decision_basis.comparisons[0].criterion_ids.push("detail");
  for (const label of ["A", "B"] as const) {
    const source = data.request.input.attributions[label];
    source.task_analysis = structuredClone(data.request.input.task_analysis);
    source.criterion_assessments.push({ criterion_id: "detail", status: label === "A" ? "partial" : "unknown",
      evidence_status: label === "A" ? "established" : "uncertain", summary: "细节核对。", evidence: [] });
  }
  const result = resolve(data);
  assert.equal(result.decision_basis.comparisons[0].assessments.A.status, "partial");
  assert.equal(result.decision_basis.comparisons[0].assessments.A.evidence_status, "established");
  assert.equal(result.decision_basis.comparisons[0].assessments.B.status, "unknown");
  assert.equal(result.decision_basis.comparisons[0].assessments.B.evidence_status, "uncertain");
  validate(data.request, result);
  data.request.input.attributions.A.findings[0].assessment.evidence_status = "uncertain";
  data.result.decision_basis.decisive_findings = [{ candidate: "B", finding_index: 0 }];
  const uncertain = resolve(data);
  assert.equal(uncertain.decision_basis.comparisons[0].assessments.A.evidence_status, "uncertain");
  validate(data.request, uncertain);
  data.result.decision_basis.comparisons[0].better_candidates = ["A"];
  assert.throws(() => validate(data.request, resolve(data)), /相对优势需要两方|uncertain finding 的比较行/);
});

test("resource-only rows require valid original metrics and finding-only rows preserve uncertainty", () => {
  const data = pair();
  const candidates = (data.request.input as unknown as ComparisonInput).candidates;
  data.result.decision_basis.comparisons.push({ aspect: "资源用量", criterion_ids: [], importance: "low", better_candidates: [],
    assessments: { A: { summary: "资源未知。", finding_indices: [], status: "unknown", evidence_status: "uncertain" },
      B: { summary: "资源未知。", finding_indices: [], status: "unknown", evidence_status: "uncertain" } } });
  candidates.A.original_answer_timing.finish_seconds = null;
  candidates.B.original_answer_timing.finish_seconds = null;
  candidates.A.original_answer_usage.total_tokens = null;
  candidates.B.original_answer_usage.total_tokens = null;
  let result = resolve(data);
  for (const cell of Object.values(result.decision_basis.comparisons[1].assessments))
    assert.deepEqual({ status: cell.status, evidence_status: cell.evidence_status }, { status: "unknown", evidence_status: "uncertain" });
  validate(data.request, result);
  candidates.A.original_answer_usage.total_tokens = 100;
  candidates.A.original_answer_usage.issues = ["统计冲突"] as never[];
  assert.equal(resolve(data).decision_basis.comparisons[1].assessments.A.status, "unknown");
  candidates.A.original_answer_usage.issues = [];
  result = resolve(data);
  assert.equal(result.decision_basis.comparisons[1].assessments.A.status, "met");
  assert.equal(result.decision_basis.comparisons[1].assessments.A.evidence_status, "established");
  candidates.A.original_answer_usage.total_tokens = null;
  candidates.A.original_answer_timing.finish_seconds = 0;
  assert.equal(resolve(data).decision_basis.comparisons[1].assessments.A.status, "met", "zero is a valid original metric");
  data.request.input.attributions.A.findings[0].assessment.evidence_status = "uncertain";
  data.result.decision_basis.comparisons[1].assessments.A.finding_indices = [0];
  data.result.decision_basis.decisive_findings = [{ candidate: "B", finding_index: 0 }];
  result = resolve(data);
  assert.equal(result.decision_basis.comparisons[1].assessments.A.status, "unknown");
  assert.equal(result.decision_basis.comparisons[1].assessments.A.evidence_status, "uncertain");
  validate(data.request, result);
});

test("required reads declare every deferred final source using its own candidate and path", () => {
  const data = pair();
  data.request.input.candidates.A.deferred_final_material = [{ message_index: 1, path: "/content", total_chars: 5 }] as never[];
  data.request.input.candidates.B.deferred_final_material = [{ message_index: 1, path: "/content/0/text", total_chars: 7 }] as never[];
  assert.deepEqual(comparisonProfile.requiredReads!(data.request), [
    { candidate: "A", message_index: 1, kind: "text", path: "/content", start: 0, end: 5 },
    { candidate: "B", message_index: 1, kind: "text", path: "/content/0/text", start: 0, end: 7 },
  ]);
});

test("Comparison requires exact pair candidate keys and complete row and finding coverage", () => {
  const data = pair();
  const duplicate = structuredClone(data.result); duplicate.ranking = [["A", "A"]];
  assert.throws(() => validate(data.request, duplicate), /重复|恰好/);
  const badLabels = JSON.parse(JSON.stringify(data.result).replaceAll('"A"', '"【候选A】"'));
  assert.throws(() => validate(data.request, badLabels), /合法候选标识.*\["A","B"\]/);
  const incomplete = structuredClone(data.result); delete (incomplete.assessments as Record<string, unknown>).B;
  assert.throws(() => validate(data.request, incomplete), /每个候选/);
  const missingCandidate = structuredClone(data.result); delete (missingCandidate.decision_basis.comparisons[0].assessments as Record<string, unknown>).B;
  assert.throws(() => validate(data.request, missingCandidate), /同一行包含全部候选/);
  const missingStrength = structuredClone(data.result); missingStrength.decision_basis.comparisons[0].assessments.B.finding_indices = [];
  assert.throws(() => validate(data.request, missingStrength), /B\.findings\[0\].*assessments\.B\.finding_indices.*索引从0开始/);
  const badRef = structuredClone(data.result); badRef.decision_basis.comparisons[0].assessments.A.finding_indices = [99];
  assert.throws(() => validate(data.request, badRef), /只能引用该候选/);
  const missed = pair(); missed.request.input.attributions.A.findings.push({ ...missed.request.input.attributions.A.findings[0], type: "problem", importance: "medium" });
  assert.throws(() => validate(missed.request, missed.result), /中高重要性问题/);
  Object.assign(data.request.input.candidates, { C: data.request.input.candidates.A });
  assert.throws(() => validate(data.request, data.result), /只比较 A、B/);
  const requestSchema = new Ajv2020({ strict: false }).compile(comparisonProfile.requestSchema);
  assert.equal(requestSchema(data.request.input), false);
});

test("core gate copies attribution and requires explicit established requirement refs", () => {
  const data = pair(); fail(data, "A");
  data.result.ranking = [["B"], ["A"]]; validate(data.request, data.result);
  data.result.assessments.A.meets_core = true;
  assert.throws(() => validate(data.request, data.result), /只能照录来源/);
  data.result.assessments.A.meets_core = false;
  data.result.assessments.A.core_failure_refs = [];
  assert.throws(() => validate(data.request, data.result), /明确照录来源/);
  data.result.assessments.A.core_failure_refs = ["sum"];
  data.request.input.attributions.A.criterion_assessments[0].evidence_status = "uncertain";
  data.result.decision_basis.comparisons[0].assessments.A.evidence_status = "uncertain";
  assert.throws(() => validate(data.request, data.result), /已证实的 unmet\/partial/);
});

test("both-bad candidates remain tied while the short rationale may retain relative value", () => {
  const data = pair(); fail(data, "A"); fail(data, "B");
  data.result.ranking = [["A", "B"]];
  data.result.decision_basis.tradeoff = "双方核心结果都错。A保留了方法说明，但仍未完成结果交付。";
  validate(data.request, data.result);
  data.result.ranking = [["A"], ["B"]];
  assert.throws(() => validate(data.request, data.result), /未达标候选必须同层/);
});

test("all applicable criteria require rows even when attribution has no finding", () => {
  const data = pair();
  const criterion = { id: "format", text: "表达清晰", applies_to: [], acceptance_rule: "可直接读取结果。" };
  data.request.input.task_analysis.scoring_points.push(criterion as never);
  data.result.task_analysis = structuredClone(data.request.input.task_analysis);
  for (const label of ["A", "B"] as const) data.request.input.attributions[label].task_analysis = structuredClone(data.request.input.task_analysis);
  for (const label of ["A", "B"] as const) data.request.input.attributions[label].criterion_assessments.push({ criterion_id: "format", status: "met", evidence_status: "established", summary: "清晰。", evidence: [] });
  assert.throws(() => validate(data.request, data.result), /全部适用标准/);
  data.result.decision_basis.comparisons.push({ aspect: "表达", criterion_ids: ["format"], importance: "low", better_candidates: [], assessments: { A: { summary: "清晰。", finding_indices: [], status: "met", evidence_status: "established" }, B: { summary: "清晰。", finding_indices: [], status: "met", evidence_status: "established" } } });
  validate(data.request, data.result);
});

test("scope differences do not create an advantage and row states cannot strengthen source facts", () => {
  const data = pair();
  data.request.input.task_analysis.requirements[0].applies_to = [data.request.input.candidates.A.candidate_id] as never[];
  data.result.task_analysis = structuredClone(data.request.input.task_analysis);
  for (const label of ["A", "B"] as const) data.request.input.attributions[label].task_analysis = structuredClone(data.request.input.task_analysis);
  data.request.input.attributions.B.criterion_assessments[0].status = "not_applicable";
  data.result.decision_basis.comparisons[0].assessments.B.status = "not_applicable";
  validate(data.request, data.result);
  data.result.decision_basis.comparisons[0].better_candidates = ["A"] as never[];
  assert.throws(() => validate(data.request, data.result), /不适用不能当作落后/);
  data.request.input.task_analysis.requirements.push({ id: "own_b", text: "B的专有约束", applies_to: [data.request.input.candidates.B.candidate_id], acceptance_rule: "按B自己的要求完成。" } as never);
  data.request.input.attributions.A.criterion_assessments.push({ criterion_id: "own_b", status: "not_applicable", evidence_status: "established", summary: "不适用。", evidence: [] });
  data.request.input.attributions.B.criterion_assessments.push({ criterion_id: "own_b", status: "met", evidence_status: "established", summary: "已完成。", evidence: [] });
  data.result.task_analysis = structuredClone(data.request.input.task_analysis);
  for (const label of ["A", "B"] as const) data.request.input.attributions[label].task_analysis = structuredClone(data.request.input.task_analysis);
  data.result.decision_basis.comparisons[0].criterion_ids.push("own_b");
  data.result.decision_basis.comparisons[0].assessments.B.status = "met";
  assert.throws(() => validate(data.request, data.result), /标准必须共同适用于双方/);
  const uncertain = pair();
  uncertain.request.input.attributions.B.criterion_assessments[0].status = "unknown";
  uncertain.request.input.attributions.B.criterion_assessments[0].evidence_status = "uncertain";
  assert.throws(() => validate(uncertain.request, uncertain.result), /不能把来源 uncertain|只能照录来源标准状态/);
  uncertain.result.decision_basis.comparisons[0].assessments.B.status = "unknown";
  uncertain.result.decision_basis.comparisons[0].assessments.B.evidence_status = "uncertain";
  validate(uncertain.request, uncertain.result);
  uncertain.result.decision_basis.comparisons[0].better_candidates = ["A"] as never[];
  assert.throws(() => validate(uncertain.request, uncertain.result), /相对优势需要两方/);
});

test("uncertain findings cannot be decisive and one-sided material advantages cannot tie or reverse rank", () => {
  const data = pair();
  data.request.input.attributions.A.findings[0].assessment.evidence_status = "uncertain";
  assert.throws(() => validate(data.request, data.result), /uncertain finding 不能作为决定性依据/);
  data.result.decision_basis.decisive_findings = [{ candidate: "B", finding_index: 0 }];
  data.result.decision_basis.comparisons[0].better_candidates = ["A"] as never[];
  assert.throws(() => validate(data.request, data.result), /uncertain finding 的比较行/);
  data.request.input.attributions.A.findings[0].assessment.evidence_status = "established";
  assert.throws(() => validate(data.request, data.result), /不能判都好/);
  data.result.ranking = [["B"], ["A"]];
  assert.throws(() => validate(data.request, data.result), /优势方排后/);
  data.result.ranking = [["A"], ["B"]]; validate(data.request, data.result);
});

test("needs_review carries located requests and never produces a ranking or decisive finding", () => {
  const data = review();
  data.request.input.attributions.A.core_assessment.meets_core = null as unknown as boolean;
  data.result.assessments.A.meets_core = null as unknown as boolean;
  validate(data.request, data.result);
  data.result.ranking = [["A", "B"]];
  assert.throws(() => validate(data.request, data.result), /0 items/);
  data.result.ranking = [];
  data.result.review_requests[0].criterion_ids = [];
  assert.throws(() => validate(data.request, data.result), /定位至少一个标准/);
  const conflict = review();
  conflict.result.assessments.A.meets_core = null as unknown as boolean;
  conflict.result.decision_basis.comparisons[0].assessments.A.status = "unknown";
  conflict.result.decision_basis.comparisons[0].assessments.A.evidence_status = "uncertain";
  validate(conflict.request, conflict.result);
  conflict.result.status = "decided"; conflict.result.review_requests = []; conflict.result.ranking = [["A", "B"]];
  assert.throws(() => validate(conflict.request, conflict.result), /boolean/);
});

test("missing and conflicting source criterion facts route to located review without creating facts", () => {
  const missing = review();
  missing.request.input.attributions.A.criterion_assessments = [];
  missing.result.assessments.A.meets_core = null;
  const cell = missing.result.decision_basis.comparisons[0].assessments.A;
  cell.status = "unknown"; cell.evidence_status = "uncertain";
  validate(missing.request, missing.result);
  cell.status = "met"; cell.evidence_status = "established";
  assert.throws(() => validate(missing.request, missing.result), /只能照录来源标准状态|不能把来源 uncertain/);
  const duplicate = review();
  duplicate.request.input.attributions.A.criterion_assessments.push({ ...duplicate.request.input.attributions.A.criterion_assessments[0], status: "unmet" });
  const conflictCell = duplicate.result.decision_basis.comparisons[0].assessments.A;
  conflictCell.status = "unknown"; conflictCell.evidence_status = "uncertain";
  validate(duplicate.request, duplicate.result);
});

test("same criterion ID cannot hide different acceptance rules or candidate scopes in source attribution", () => {
  const changed = pair();
  changed.request.input.attributions.A.task_analysis.requirements[0].acceptance_rule = "仅给出操作数即可通过。";
  assert.throws(() => validate(changed.request, changed.result), /来源归因的 task_analysis.*不能沿用同名 ID/);
  const pending = review();
  pending.request.input.attributions.A.task_analysis.requirements[0].acceptance_rule = "仅给出操作数即可通过。";
  validate(pending.request, pending.result);
  pending.result.review_requests[0].criterion_ids = [];
  pending.result.review_requests[0].finding_indices = [0];
  assert.throws(() => validate(pending.request, pending.result), /相关 criterion_ids/);
  const scoped = pair();
  scoped.request.input.attributions.B.task_analysis.requirements[0].applies_to = [scoped.request.input.candidates.A.candidate_id] as never[];
  assert.throws(() => validate(scoped.request, scoped.result), /来源归因的 task_analysis/);
});

test("complete deferred final material and final images are hard evidence prerequisites", () => {
  const data = pair();
  data.request.input.candidates.A.deferred_final_material.push({ message_index: 1, path: "/content", total_chars: 5 } as never);
  assert.throws(() => validate(data.request, data.result), /未完整读取/);
  const reads = structuredClone(audit);
  reads.traceReads = [{ candidate: "A", message_index: 1, path: "/content", kind: "text", start: 0, end: 2 }];
  assert.throws(() => validate(data.request, data.result, reads), /未完整读取/);
  reads.traceReads.push({ candidate: "A", message_index: 1, path: "/content", kind: "text", start: 2, end: 5 });
  validate(data.request, data.result, reads);
  (data.request.sources.B.value.messages[1] as Record<string, unknown>).content = "data:image/png;base64,aA==";
  assert.throws(() => validate(data.request, data.result, reads), /必须先 view_image/);
  reads.viewedImages.push("B:1"); validate(data.request, data.result, reads);
});
