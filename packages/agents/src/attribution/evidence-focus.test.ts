import { responsibilitySubmissionFixture } from "../../../../tests/fixtures/responsibility.js";
import test from "node:test";
import assert from "node:assert/strict";
import { AgentRegistry } from "@eval/host";
import { selectEvidence, ValidationError, type AgentRequest, type ToolAudit } from "@eval/contracts";
import { cite, evidenceSources, instructionSources } from "@eval/tools";
import { attributionAgent, type AttributionResult } from "./index.js";
import { attributionSubmission, setFixtureNormDirectory } from "../../../../tests/fixtures/attribution-submission.js";
import example from "./fixtures/example.json" with { type: "json" };

function fixture(answer = "背景。".repeat(1000) + "2+2=4") {
  const request = structuredClone(example.request) as AgentRequest;
  const raw = request.sources.answer.value as { messages: { role: string; content: string }[] };
  raw.messages[1]!.content = answer;
  Object.assign(request.input.answer as object, { final_answer: answer });
  setFixtureNormDirectory(request);
  const leaf = evidenceSources(raw.messages[1]).find(item => item.path === "/content")!;
  const excerpt = (start: number, end: number) => cite(request.sources.answer.id, 1, leaf, start, end);
  const focused = excerpt(answer.length - 5, answer.length);
  const result = structuredClone(example.result) as AttributionResult;
  result.correctness_evidence = [focused];
  result.criterion_assessments.forEach(item => { item.evidence = [focused]; });
  result.findings.forEach(item => { item.evidence = [focused]; });
  const audit: ToolAudit = { calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [], evidenceBank: [] };
  const draft = attributionSubmission(request, result, audit);
  const registry = new AgentRegistry([attributionAgent]), binding = { agent: "attribution", profile: "default", request };
  const choose = (start: number, end: number) => selectEvidence(audit.evidenceBank!, excerpt(start, end)).evidence_index;
  const resolve = () => registry.resolve(binding, draft, audit) as AttributionResult;
  return { request, raw, audit, draft, choose, resolve, registry, binding, answer };
}
const rejects = (run: () => unknown, code: string, path?: string) => assert.throws(run, error => error instanceof ValidationError &&
  error.issues!.some(issue => issue.code === code && (path === undefined || issue.path === path)));

test("real long evidence is accepted at every model selection slot without a repair or silent clipping", () => {
  for (const slot of ["strengths", "problems", "criterion_assessments", "correctness"] as const) {
    const f = fixture(), whole = f.choose(0, f.answer.length);
    if (slot === "problems") f.draft.problems.push({
      ...f.draft.strengths[0]!, dimension: "efficiency", importance: "low", basis_index: null,
      text: "背景较冗长", reason: "给出结果前重复大量背景。", impact: "增加阅读负担。", component: [responsibilitySubmissionFixture("最终作答节点（原始名称未提供）",[whole])],
      label: "重复背景", definition: "背景重复而未增加结果依据。",
    });
    if (slot === "correctness") f.draft.correctness_evidence_indices = [whole];
    else f.draft[slot][0]!.evidence_indices = [whole];
    const before = structuredClone(f.draft);
    const result = f.resolve();
    f.registry.validate(f.binding, result, f.audit);
    const evidence = slot === "correctness" ? result.correctness_evidence : slot === "criterion_assessments"
      ? result.criterion_assessments[0]!.evidence : result.findings.find(item => item.type === (slot === "strengths" ? "strength" : "problem"))!.evidence;
    assert.deepEqual(evidence.map(item => item.quote), [f.answer]);
    assert.deepEqual(f.draft, before);
    assert.equal(f.audit.calls, 0);
  }
});

test("a real multi-excerpt evidence group is accepted without a length-only failure", () => {
  const f = fixture();
  f.draft.strengths[0]!.evidence_indices = [0, 600, 1200, 1800, 2400].map(start => f.choose(start, start + 600));
  const result = f.resolve();
  f.registry.validate(f.binding, result, f.audit);
  assert.equal(result.findings[0]!.evidence.reduce((total, item) => total + item.quote.length, 0), 3000);
  f.draft.strengths[0]!.evidence_indices = Array(5).fill(f.choose(0, 600));
  f.registry.validate(f.binding, f.resolve(), f.audit);
});

test("an explicit exact excerpt stays focused and cannot be replaced by an empty or metadata-only final selection", () => {
  const f = fixture(), result = f.resolve();
  assert.deepEqual(result.findings[0]!.evidence.map(item => item.quote), ["2+2=4"]);
  f.draft.strengths[0]!.evidence_indices = [];
  rejects(f.resolve, "finding_final_evidence_required", "/strengths/0/evidence_indices");
  const leaf = evidenceSources(f.raw.messages[1]).find(item => item.path === "/role")!;
  f.draft.strengths[0]!.evidence_indices = [selectEvidence(f.audit.evidenceBank!, cite(f.request.sources.answer.id, 1, leaf, 0, leaf.text.length)).evidence_index];
  rejects(f.resolve, "finding_final_evidence_required", "/strengths/0/evidence_indices");
});

test("a long norm retains its conditions in separate context and cannot hide answer evidence there", () => {
  const f = fixture();
  const norm = "## 计算规范\n\n" + "只核对明确要求的结果；保留条件与例外。".repeat(100);
  f.raw.messages[0] = { role: "user", content: norm };
  const task = f.request.input.task_analysis as unknown as AttributionResult["task_analysis"];
  task.requirements[0]!.acceptance_rule = norm;
  Object.assign(f.request.input.answer as object, { instruction_sources: instructionSources(f.raw, f.request.sources.answer.id, 1) });
  setFixtureNormDirectory(f.request);
  const result = f.resolve();
  assert.equal(result.findings[0]!.context_evidence![0]!.quote, norm);
  assert.deepEqual(result.findings[0]!.evidence.map(item => item.quote), ["2+2=4"]);
  const bad = structuredClone(result);
  bad.findings[0]!.context_evidence = bad.findings[0]!.evidence;
  rejects(() => f.registry.validate(f.binding, bad, f.audit), "instruction_context_invalid", "/findings/0/context_evidence/0");
});

test("long evidence does not bypass reading the full deferred answer for an omission judgment", () => {
  const f = fixture();
  f.draft.strengths[0]!.evidence_indices = [f.choose(0, f.answer.length)];
  Object.assign(f.request.input.answer as object, { final_answer: "", deferred_final_material: [{ message_index: 1, path: "/content", total_chars: f.answer.length }] });
  rejects(f.resolve, "deferred_final_material_not_read", "/answer/deferred_final_material/0");
  f.audit.traceReads.push({ candidate: "answer", message_index: 1, kind: "text", path: "/content", start: 0, end: f.answer.length });
  const result = f.resolve();
  f.registry.validate(f.binding, result, f.audit);
  assert.equal(result.findings[0]!.evidence[0]!.quote, f.answer);
});

test("numeric repair retains every already selected final excerpt that contains the actual value", () => {
  const f = fixture(), whole = f.choose(0, f.answer.length), focused = f.choose(f.answer.length - 5, f.answer.length);
  f.draft.numeric_checks = [{ label: "结果", reference_index: 1, actual: "4", scale: "1", mode: "exact", evidence_index: f.choose(0, 3) }];
  assert.throws(f.resolve, error => {
    assert(error instanceof ValidationError);
    const issue = error.issues!.find(item => item.code === "numeric_answer_missing");
    assert(issue);
    const choices = (issue.expected as { evidence_indices: number[] }).evidence_indices;
    assert(choices.includes(focused));
    assert(choices.includes(whole));
    return true;
  });
});

test("long evidence still rejects forged coordinates and altered persisted quotes", () => {
  const f = fixture(), whole = f.choose(0, f.answer.length);
  f.draft.strengths[0]!.evidence_indices = [whole];
  const result = f.resolve();
  result.findings[0]!.evidence[0]!.quote += "伪造内容";
  rejects(() => f.registry.validate(f.binding, result, f.audit), "evidence_quote_mismatch");
  f.audit.evidenceBank![whole - 1] = f.audit.evidenceBank![whole - 1]!.replace(`_0_${f.answer.length}_`, `_0_${f.answer.length + 1}_`);
  rejects(f.resolve, "evidence_range_invalid");
});
