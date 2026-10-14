import test from "node:test";
import assert from "node:assert/strict";
import { AgentRegistry } from "@eval/host";
import { selectEvidence, ValidationError, type AgentRequest, type ToolAudit } from "@eval/contracts";
import { cite, evidenceSources, parseTraceTables } from "@eval/tools";
import { attributionAgent, attributionTableChecks, attributionTableReview, type AttributionResult, type AttributionSubmission } from "./index.js";
import { setFixtureNormDirectory } from "../../../../tests/fixtures/attribution-submission.js";
import example from "./fixtures/example.json" with { type: "json" };

function fixture(sourceCount = 1, noteChars = 1040, finalNoteChars = 0, sourceCode = "588000.SH", sourceName = "华夏科创50etf") {
  const request = structuredClone(example.request) as AgentRequest;
  const question = "按查询结果列出基金代码和名称。";
  const answer = "| 代码 | 名称 | 说明 |\n|---|---|---|\n| 588000.SH | 华夏上证科创板50成份ETF | " + "答".repeat(finalNoteChars) + " |";
  const raw = { messages: [
    { role: "user", content: question },
    ...Array.from({ length: sourceCount }, (_, index) => ({ role: "tool", name: "lookup",
      content: `| 基金代码 | 基金简称 | 说明 |\n|---|---|---|\n| ${sourceCode} | ${sourceName} | ` + String(index).repeat(noteChars) + " |" })),
    { role: "assistant", content: answer },
  ] };
  const finalIndex = raw.messages.length - 1, inputId = request.sources.answer.id;
  request.sources.answer.value = raw;
  request.input.ground_truth = { available: false, value: null };
  request.input.task_analysis = { task_type: "基金查询", goal: question,
    requirements: [{ id: "r1", text: question, applies_to: [], acceptance_rule: question }], scoring_points: [], red_flags: [] };
  const checks = attributionTableChecks(raw, inputId, finalIndex), row = checks[0].rows[0];
  Object.assign(request.input.answer as object, { question, final_answer: answer, final_message_index: finalIndex,
    catalog: raw.messages.slice(1, finalIndex).map((message, index) => ({ message_index: index + 1, role: "tool", type: "tool_result", name: "lookup", chars: message.content.length })),
    table_check_results: checks });
  setFixtureNormDirectory(request);
  const audit: ToolAudit = { calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [], evidenceBank: [] };
  const choose = (evidence: { evidence_id: string }) => selectEvidence(audit.evidenceBank!, evidence).evidence_index;
  const excerpt = (messageIndex: number, start: number, end: number) => {
    const leaf = evidenceSources(raw.messages[messageIndex]).find(item => item.path === "/content")!;
    return cite(inputId, messageIndex, leaf, start, end);
  };
  const finalExcerpt = choose(excerpt(finalIndex, answer.indexOf("588000.SH"), answer.indexOf("588000.SH") + 9));
  const draft: AttributionSubmission = {
    summary: "代码一致，来源使用简称，回答使用基金全称。", meets_core: true, core_reason: "代码与基金对象可对应。", core_requirements: [1],
    is_correct: null, correctness_reason: "", correctness_evidence_indices: [], numeric_checks: [],
    criterion_assessments: [{ status: "met", evidence_status: "established", summary: "列出原查询对象。", evidence_indices: [finalExcerpt] }],
    strengths: [], problems: [], table_resolutions: [{
      table_index: parseTraceTables(raw, inputId).findIndex(table => table.table_id === checks[0].answer_table_id) + 1,
      row_index: row.row_index, outcome: "supported", reason: "代码588000.SH一致，来源使用基金简称，回答使用全称；已核对全部来源。",
      evidence_indices: [row.answer.evidence, ...row.sources.map(source => source.evidence)].map(choose),
    }],
  };
  const registry = new AgentRegistry([attributionAgent]), binding = { agent: "attribution", profile: "default", request };
  const resolve = () => registry.resolve(binding, draft, audit) as AttributionResult;
  return { request, raw, row, draft, audit, registry, binding, choose, excerpt, resolve };
}

function rejects(run: () => unknown, code: string, path?: string) {
  assert.throws(run, error => error instanceof ValidationError && error.issues!.some(issue =>
    issue.code === code && (path === undefined || issue.path === path)), code);
}

test("public Attribution submission accepts complete long final and source rows on its first attempt", () => {
  const f = fixture(1, 1040, 1040), before = structuredClone(f.draft);
  assert(f.row.answer.evidence.quote.length > 800);
  assert(f.row.sources[0].evidence.quote.length > 800);
  const result = f.resolve();
  f.registry.validate(f.binding, result, f.audit);
  assert.deepEqual(result.table_resolutions![0].evidence, [f.row.answer.evidence, ...f.row.sources.map(source => source.evidence)]);
  assert.deepEqual(attributionTableReview(f.request, result).concerns, []);
  assert.deepEqual(f.draft, before, "acceptance preserves the complete submitted evidence");
  assert.equal(f.audit.calls, 0, "program-owned table evidence requires no repair tool call");
});

test("public Attribution submission accepts all required source rows even when their group exceeds 2400 characters", () => {
  const f = fixture(4, 650), evidence = [f.row.answer.evidence, ...f.row.sources.map(source => source.evidence)];
  assert(evidence.every(item => item.quote.length <= 800));
  assert(evidence.reduce((total, item) => total + item.quote.length, 0) > 2400);
  const result = f.resolve();
  f.registry.validate(f.binding, result, f.audit);
  assert.deepEqual(result.table_resolutions![0].evidence, evidence);
  assert.deepEqual(attributionTableReview(f.request, result).concerns, []);
});

test("table resolution still rejects a missing source row at the public submission boundary", () => {
  const f = fixture(2, 40);
  f.draft.table_resolutions![0].evidence_indices.pop();
  rejects(f.resolve, "table_resolution_unsupported", "/table_resolutions");
});

test("table resolution still rejects cropped source and final rows instead of treating excerpts as complete", () => {
  for (const cropped of ["source", "final"] as const) {
    const f = fixture(), messageIndex = cropped === "source" ? 1 : f.raw.messages.length - 1;
    const content = f.raw.messages[messageIndex].content, start = content.indexOf("588000.SH");
    f.draft.table_resolutions![0].evidence_indices[cropped === "source" ? 1 : 0] = f.choose(f.excerpt(messageIndex, start, start + 9));
    rejects(f.resolve, "table_resolution_unsupported", "/table_resolutions");
  }
});

test("table resolution still requires an independent returned source", () => {
  const f = fixture(1, 40);
  Object.assign(f.raw.messages[1], { stdout: f.raw.messages[1].content });
  rejects(f.resolve, "table_resolution_unsupported", "/table_resolutions");
});

test("complete table evidence can also support an ordinary finding without a length-only failure", () => {
  const f = fixture(1, 1040, 1040);
  f.draft.strengths.push({ dimension: "correctness", stage: "final_answer", importance: "high", text: "代码正确", reason: "与原查询代码一致。",
    evidence_status: "established", basis_index: 1, evidence_indices: [f.draft.table_resolutions![0].evidence_indices[0]] });
  const result = f.resolve();
  f.registry.validate(f.binding, result, f.audit);
  assert.equal(result.findings[0].evidence[0].quote, f.row.answer.evidence.quote);
});

function conflictFixture() {
  const f = fixture(1, 1040, 1040, "588001.SH", "华夏上证科创板50成份ETF");
  const indices = [f.raw.messages.length - 1, 1].map(messageIndex => {
    const text = f.raw.messages[messageIndex].content, start = text.indexOf("58800"), end = text.indexOf("ETF", start) + 3;
    return f.choose(f.excerpt(messageIndex, start, end));
  });
  f.draft.meets_core = false;
  f.draft.core_reason = "基金代码与原查询不一致，无法用于目标对象。";
  f.draft.criterion_assessments[0].status = "unmet";
  f.draft.problems.push({ dimension: "correctness", stage: "final_answer", importance: "high", text: "基金代码与原查询不同",
    reason: "相同基金全称，原查询为588001.SH，回答为588000.SH。", impact: "核心标的代码不可用。",
    evidence_status: "established", basis_index: 1, evidence_indices: indices,
    component: ["模型自身推理"], label: "基金代码错误", definition: "最终基金代码与同一名称的原查询代码不一致。" });
  f.draft.table_resolutions![0].outcome = "conflict";
  f.draft.table_resolutions![0].reason = "完整行与聚焦代码、名称证据均确认同一基金的代码冲突。";
  return f;
}

test("public Attribution submission confirms a long-row conflict with focused finding evidence and complete resolution context", () => {
  const f = conflictFixture(), result = f.resolve();
  f.registry.validate(f.binding, result, f.audit);
  assert(result.findings[0].evidence.every(item => item.quote.length < 800));
  assert(result.table_resolutions![0].evidence.every(item => item.quote.length > 800));
  assert.deepEqual(attributionTableReview(f.request, result).concerns, []);
});

test("a conflict finding must cite both the compared code and identity, not a lone code or unrelated row text", () => {
  for (const choice of ["code_only", "outside_row"] as const) {
    const f = conflictFixture();
    let start = f.raw.messages[1].content.indexOf("588001.SH"), end = start + 9;
    if (choice === "outside_row") {
      f.raw.messages[1].content += "\n\n588001.SH 华夏上证科创板50成份ETF";
      start = f.raw.messages[1].content.lastIndexOf("588001.SH");
      end = f.raw.messages[1].content.length;
    }
    f.draft.problems[0].evidence_indices[1] = f.choose(f.excerpt(1, start, end));
    rejects(f.resolve, "table_resolution_unsupported", "/table_resolutions");
  }
});
