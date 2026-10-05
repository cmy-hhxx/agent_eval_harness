const INPUT_ID = "11111111-1111-4111-8111-111111111111";
import test from "node:test";
import assert from "node:assert/strict";
import type { AgentRequest, ToolAudit } from "@eval/contracts";
import { cite, evidenceSources, resolveEvidence } from "@eval/tools";
import { submissionEvidenceIssues } from "./submission-evidence.js";

const audit: ToolAudit = { calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [] };
const request: AgentRequest = { input: {}, sources: { answer: { id: INPUT_ID, value: { messages: [
  { type: "function_call_output", output: [{ type: "input_text", text: "真实工具数据：价格27.98。" }] },
  { role: "assistant", content: "实际回答。" },
] } } } };
const raw = request.sources.answer!.value as { messages: unknown[] };
const source = evidenceSources(raw.messages[0]).find(source => source.kind === "text" && source.path === "/output/0/text")!;
const valid = { evidence_id: cite(INPUT_ID, 0, source, 0, source.text.length).evidence_id };
const finalSource = evidenceSources(raw.messages[1]).find(source => source.kind === "text" && source.path === "/content")!;
const final = { evidence_id: cite(INPUT_ID, 1, finalSource, 0, finalSource.text.length).evidence_id };
const scoped: AgentRequest = { ...request, input: { ground_truth: { available: true }, answer: { final_message_index: 1 } } };

test("correctness bundles accept own final delivery with tool facts while numeric slots require final delivery", () => {
  const draft = { correctness_evidence: [final, valid], numeric_checks: [{ evidence_index: 0 }] };
  assert.deepEqual(submissionEvidenceIssues(scoped, draft, audit), []);
  const numeric = { ...draft, summary: 7, findings: [{}], numeric_checks: [{ evidence_index: 1 }] };
  const before = structuredClone(numeric);
  assert.deepEqual(submissionEvidenceIssues(scoped, numeric, audit).map(issue => [issue.code, issue.path]), [
    ["evidence_final_required", "/numeric_checks/0/evidence_index"],
  ]);
  assert.deepEqual(numeric, before);
});

test("a recognizable auxiliary-only correctness bundle reports missing final evidence before unrelated schema failures", () => {
  assert.deepEqual(submissionEvidenceIssues(scoped, { summary: 7, correctness_evidence: [valid] }, audit)
    .map(issue => [issue.code, issue.path]), [["evidence_final_required", "/correctness_evidence"]]);
  assert.deepEqual(submissionEvidenceIssues(scoped, { correctness_evidence: [final], numeric_checks: [{ evidence_index: 1 }] }, audit)
    .map(issue => [issue.code, issue.path]), [["numeric_answer_missing", "/numeric_checks/0/evidence_index"]]);
  assert.deepEqual(submissionEvidenceIssues(scoped, { correctness_evidence: [valid, { evidence_id: "invented" }] }, audit)
    .map(issue => [issue.code, issue.path]), [["evidence_id_invalid", "/correctness_evidence/1"]]);
});

test("recognized references expose coordinate errors in every current evidence array before schema or coverage is complete", () => {
  const invalid = { evidence_id: "invented", observation: { text: "保留错误原值" } };
  const range = { evidence_id: "ev_11111111-1111-4111-8111-111111111111_0_text_0_14407_", observation: "不能把结构化工具消息当空路径文本。" };
  const draft = {
    correctness_evidence: [invalid],
    findings: [{ evidence: [valid, range] }],
    criterion_assessments: [{ evidence: [range] }],
    table_resolutions: [{ evidence: [invalid] }],
    other: { evidence: [invalid] },
  };
  const before = structuredClone({ request, draft, audit });
  const issues = submissionEvidenceIssues(request, draft, audit);
  assert.deepEqual(issues.map(issue => [issue.code, issue.path]), [
    ["evidence_id_invalid", "/correctness_evidence/0"],
    ["evidence_range_invalid", "/criterion_assessments/0/evidence/0"],
    ["evidence_range_invalid", "/findings/0/evidence/1"],
    ["evidence_id_invalid", "/table_resolutions/0/evidence/0"],
  ]);
  assert.deepEqual(issues[0]!.actual, invalid);
  assert.deepEqual(issues[1]!.actual, range);
  const feedback = issues[1]!.expected as { read_request: { arguments: object }; suggested_evidence: { reference: { evidence_id: string } }[] };
  assert.deepEqual(feedback.read_request.arguments, { candidate: "answer", message_index: 0, path: "" });
  assert(feedback.suggested_evidence.length);
  for (const suggestion of feedback.suggested_evidence)
    assert(resolveEvidence(raw, suggestion.reference, "answer", audit, "/selected", INPUT_ID).quote);
  assert.deepEqual({ request, draft, audit }, before);
});

test("partial shapes are left to the schema without inventing reference aliases or coercing values", () => {
  for (const draft of [null, "draft", [], { findings: null }, { findings: [null, 1, { evidence: {} }, { evidence: [
    null, 4, { evidence_id: 0 }, { reference: { evidence_id: "invented" } }, valid,
  ] }] }]) assert.deepEqual(submissionEvidenceIssues(request, draft, audit), []);
});

test("raw malformed image observations return evidence feedback without losing the submitted value", () => {
  const images: AgentRequest = { input: {}, sources: { answer: { id: INPUT_ID, value: { messages: [
    { role: "assistant", content: [{ type: "image", mimeType: "image/png", data: "AA==" }] },
  ] } } } };
  const viewed = { ...audit, viewedImages: ["answer:0"] };
  const reference = { evidence_id: "ev_11111111-1111-4111-8111-111111111111_0_image", observation: { text: "不能转成字符串" } };
  const draft = { findings: [{ evidence: [reference] }] };
  const issues = submissionEvidenceIssues(images, draft, viewed);
  assert.equal(issues[0]?.code, "image_observation_missing");
  assert.equal(issues[0]?.path, "/findings/0/evidence/0");
  assert.deepEqual(issues[0]?.actual, reference);
  assert.deepEqual(draft.findings[0]!.evidence[0], reference);
});
