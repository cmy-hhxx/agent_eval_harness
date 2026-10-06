import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { canonicalEvidence } from "../../../../tests/fixtures/evidence.js";
import { emptyUsage, type PlannedTask, type SubmissionReceipt } from "@eval/contracts";
import { criteriaProfile } from "@eval/agents/criteria";
import { attributionTableChecks } from "@eval/agents/attribution";
import { comparisonScope } from "@eval/agents/comparison";
import { parseTraceTables, evidenceSources, parseEvidenceCoordinates, resolveEvidence, selectEvidenceSource } from "@eval/tools";
import { attributionResult, criteriaResult, emptyAudit, raw } from "../../../../tests/fixtures/comparison.js";
import { attributionPresentation, tableChecksPresentation } from "./attribution-presentation.js";
import { bindTask } from "./binding.js";
import type { Candidate, RawInput, TaskData } from "./types.js";

const evidenceInputId = "7ebfa07b-55d4-4e19-80d0-545eb576289a";

const long = "完整规则；包含触发条件、例外和回答原文。".repeat(1000);

test("long attribution evidence keeps exact references and a bounded full-quote reading route in every current evidence array", () => {
  const trace: RawInput = { messages: [{ role: "system", content: [{ text: `前文\n${long}\n后文` }] }] };
  const result = attributionResult(), entry = canonicalEvidence(evidenceInputId, 0, long, "/content/0/text", 3);
  result.correctness_evidence = [entry];
  result.criterion_assessments[0]!.evidence = [entry];
  result.findings[0]!.evidence = [entry];
  result.table_resolutions = [{ table_id: "table", row_index: 0, outcome: "supported", reason: "引用原始行。", evidence: [entry] }];
  const before = structuredClone({ result, trace });
  const shown = attributionPresentation(result, "B", trace, evidenceInputId);
  const projected = [shown.correctness_evidence[0]!, shown.criterion_assessments[0]!.evidence[0]!,
    shown.findings[0]!.evidence[0]!, shown.table_resolutions![0]!.evidence[0]!];
  for (const item of projected) {
    assert("reference" in item);
    assert("quote_preview" in item);
    assert("has_more" in item);
    assert("read_request" in item); assert("end_offset" in item);
    assert.equal(item.quote_preview, long.slice(0, 200));
    assert.equal(item.has_more, true);
    assert.equal(Object.hasOwn(item, "quote"), false);
    assert.equal(resolveEvidence(trace, item.reference, "B", emptyAudit(), "/evidence", evidenceInputId).quote, long);
    assert.deepEqual(parseEvidenceCoordinates(item.reference.evidence_id), {
      input_id: evidenceInputId, message_index: 0, kind: "text", path: "/content/0/text", start: 3, end: 3 + long.length,
    });
    assert.deepEqual(item.read_request, { candidate: "B", message_index: 0,
      path: "/content/0/text", offset: 3, max_chars: 16000 });
    assert.equal(item.end_offset, 3 + long.length);
    const source = selectEvidenceSource(evidenceSources(trace.messages[0]), item.read_request.path)!.source;
    let read = "";
    for (let offset = item.read_request.offset; offset < item.end_offset; offset += item.read_request.max_chars)
      read += source.text.slice(offset, Math.min(offset + item.read_request.max_chars, item.end_offset));
    assert.equal(read, long);
  }
  assert.deepEqual({ result, trace }, before);
  assert.deepEqual(shown.task_analysis, result.task_analysis);
  assert.deepEqual(shown.findings[0]!.assessment, result.findings[0]!.assessment);
});

test("repeated text retains its explicit origin and invalid coordinates never use quote fallback", () => {
  const quote = long.slice(0, 300);
  const trace: RawInput = { messages: [{ content: [quote, quote] }] };
  const result = attributionResult(); result.criterion_assessments = []; result.findings = [];
  result.correctness_evidence = [canonicalEvidence(evidenceInputId, 0, quote, "/content/1")];
  const shown = attributionPresentation(result, "A", trace, evidenceInputId).correctness_evidence[0]!;
  assert("reference" in shown);
  const coordinates = parseEvidenceCoordinates(shown.reference.evidence_id)!;
  assert.equal(coordinates.kind, "text");
  assert.equal(coordinates.path, "/content/1");
  assert.equal(resolveEvidence(trace, shown.reference, "A", emptyAudit(), "/evidence", evidenceInputId).quote, quote);
  const invalid = structuredClone(result); invalid.correctness_evidence[0] = canonicalEvidence(evidenceInputId, 0, quote, "/missing");
  assert.throws(() => attributionPresentation(invalid, "A", trace, evidenceInputId), /完整坐标与原文不一致/);
  const short: RawInput = { messages: [{ content: long }] };
  result.correctness_evidence = [canonicalEvidence(evidenceInputId, 0, long.slice(0, 200))];
  const shortShown = attributionPresentation(result, "A", short, evidenceInputId).correctness_evidence[0]!;
  assert("reference" in shortShown); assert("quote" in shortShown);
  assert.equal(shortShown.quote, long.slice(0, 200));
});

test("a uniquely located rendered JSON quote retains its JSON coordinate and reading path", () => {
  const trace: RawInput = { messages: [{ output: { rows: Array.from({ length: 60 }, (_, n) => ({ value: n })) } }] };
  const source = evidenceSources(trace.messages[0]).find(item => item.kind === "json")!;
  const result = attributionResult(); result.criterion_assessments = []; result.findings = [];
  result.correctness_evidence = [canonicalEvidence(evidenceInputId, 0, source.text, "", 0, "json")];
  const shown = attributionPresentation(result, "A", trace, evidenceInputId).correctness_evidence[0]!;
  assert("reference" in shown); assert("read_request" in shown); assert("end_offset" in shown);
  assert.equal(resolveEvidence(trace, shown.reference, "A", emptyAudit(), "/evidence", evidenceInputId).quote, source.text);
  assert.deepEqual(shown.read_request, { candidate: "A", message_index: 0, offset: 0, max_chars: source.text.length });
  assert.equal(shown.end_offset, source.text.length);
  assert.equal(parseEvidenceCoordinates(shown.reference.evidence_id)?.kind, "json");
});

test("Comparison binding projects blinded attribution quotes only in modelInput and preserves source scope and accepted receipts", () => {
  const candidates: Record<string, Candidate> = Object.fromEntries(["A", "B"].map(label => [label, {
    batch_id: "b1", case_id: "q1", input_id: randomUUID(), version: `${label.toLowerCase()}_fast`, name: `${label}组Fast`,
    llm: `secret-model-${label}`, trace_id: null, source: "fixture", line: 1,
    question: "计算2+2", final_index: 1, reference: "4",
    answer_timing: { first_token_seconds: null, first_answer_seconds: null, finish_seconds: 1,
      source_unit: "seconds", source_values: {}, source_fields: {} },
  }]));
  const task: PlannedTask = { id: randomUUID(), stage: "comparison",
    inputIds: Object.fromEntries(Object.entries(candidates).map(([label, candidate]) => [label, candidate.input_id])),
    dependencies: { criteria: randomUUID(), A: randomUUID(), B: randomUUID() },
    data: { stage: "comparison", candidates, reference: "4", group: ["a_fast", "b_fast"] } satisfies TaskData };
  const rubric = criteriaResult();
  rubric.requirements.push({ id: "private", text: "只约束 A 的完整内部指令。", applies_to: [candidates.A!.input_id],
    acceptance_rule: "按 A 的指令检查。" });
  const receipt = (label: string, evaluation: unknown): SubmissionReceipt => ({ taskId: task.dependencies[label]!,
    attemptId: randomUUID(), submissionId: randomUUID(), acceptedAt: 1, status: "succeeded",
    evaluatorVersion: "fixture", judge: "fixture", evaluation, audit: emptyAudit(), usage: emptyUsage() });
  const dependencies = Object.fromEntries(["criteria", "A", "B"].map(label => {
    const result = attributionResult(true, "2+2=4", true, candidates[label]?.input_id ?? evidenceInputId);
    result.task_analysis = structuredClone(rubric);
    if (label === "A") {
      result.findings[0]!.evidence = [canonicalEvidence(candidates.A.input_id, 2, "A组Fast：" + long)];
      result.findings[0]!.assessment.requirement_index = 1;
    }
    return [label, receipt(label, label === "criteria" ? rubric : result)];
  }));
  const inputs = Object.fromEntries(Object.entries(candidates).map(([label, candidate]) =>
    [candidate.input_id, { messages: [...raw().messages, { role: "system", content: `${label}组Fast：${long}` }] }]));
  const before = structuredClone({ dependencies, inputs });
  const criteriaTask: PlannedTask = { id: task.dependencies.criteria!, stage: "criteria", inputIds: task.inputIds,
    dependencies: {}, data: { stage: "criteria", candidates, reference: "4" } satisfies TaskData };
  const binding = bindTask(task, inputs, dependencies, { tasks: [criteriaTask, task] });
  const original = binding.request.input.attributions as Record<string, ReturnType<typeof attributionResult>>;
  const shown = binding.modelInput!.attributions as Record<string, ReturnType<typeof attributionPresentation>>;
  assert.equal(original.A!.findings[0]!.evidence[0]!.quote.length > 200, true);
  const projected = shown.A!.findings[0]!.evidence[0]!;
  assert("reference" in projected);
  assert.equal(resolveEvidence(binding.request.sources.A!.value as RawInput, projected.reference, "A", emptyAudit(), "/evidence", binding.request.sources.A!.id).quote,
    original.A!.findings[0]!.evidence[0]!.quote);
  assert.equal(shown.A!.findings[0]!.finding_id, original.A!.findings[0]!.finding_id);
  assert.deepEqual(binding.modelInput!.comparison_scope, comparisonScope(binding.request));
  assert.equal(comparisonScope(binding.request).findings.A[0]!.scope, "source_only");
  assert.deepEqual(shown.A!.findings[0]!.assessment, original.A!.findings[0]!.assessment);
  assert(!JSON.stringify(shown).includes("A组Fast"));
  assert.deepEqual({ dependencies, inputs }, before);
});


test("foreign evidence previews and reads the actual peer input under its anonymous comparison label", () => {
  const peerId = randomUUID(), quote = "来自真实对方的核验文本。".repeat(100);
  const own: RawInput = { messages: [{ content: "本方同坐标内容。" }] };
  const peer: RawInput = { messages: [{ content: quote }] };
  const result = attributionResult(); result.correctness_evidence = []; result.criterion_assessments = [];
  result.findings[0].evidence = [{ ...canonicalEvidence(peerId, 0, quote), source: "b_fast", source_input_id: peerId }];
  const before = structuredClone(result);
  const shown = attributionPresentation(result, "A", own, evidenceInputId, { A: own, B: peer }, { A: randomUUID(), B: peerId });
  const evidence = shown.findings[0].evidence[0];
  assert.equal(evidence.source, "B");
  assert.equal(evidence.source_input_id, peerId);
  assert("reference" in evidence); assert("read_request" in evidence);
  assert.deepEqual(Object.keys(evidence.reference), ["evidence_id"]);
  assert.equal(parseEvidenceCoordinates(evidence.reference.evidence_id)?.input_id, peerId);
  assert.equal(evidence.read_request.candidate, "B");
  assert.equal(resolveEvidence(peer, evidence.reference, "B", emptyAudit(), "/evidence", peerId).quote, quote);
  assert.deepEqual(result, before);
});


test("table check model views use own full-directory ordinals while trusted own and peer checks remain exact", () => {
  const question = "列出股票名称与代码。", table = (code: string) => `| 股票代码 | 股票简称 |\n|---|---|\n| ${code} | Alpha |`;
  const traces: Record<string, RawInput> = {
    A: { messages: [{ role: "user", content: question }, { role: "tool", content: table("000001") }, { role: "assistant", content: table("000002") }] },
    B: { messages: [{ role: "user", content: question }, { role: "tool", content: "| 键 | 数值 |\n|---|---|\n| k | v |" },
      { role: "tool", content: table("000001") }, { role: "assistant", content: table("000002") }] },
  };
  const candidates: Record<string, Candidate> = Object.fromEntries(["A", "B"].map(label => [label, {
    batch_id: "b1", case_id: "tables", version: label.toLowerCase() + "_fast", name: label + "组Fast", input_id: randomUUID(),
    trace_id: null, source: "fixture", line: 1, llm: null, question, final_index: traces[label].messages.length - 1, reference: null,
    answer_timing: { first_token_seconds: null, first_answer_seconds: null, finish_seconds: 1,
      source_unit: "seconds", source_values: {}, source_fields: {} },
  }]));
  const inputs = Object.fromEntries(Object.entries(candidates).map(([label, candidate]) => [candidate.input_id, traces[label]]));
  const criteriaTask: PlannedTask = { id: randomUUID(), stage: "criteria", dependencies: {},
    inputIds: Object.fromEntries(Object.entries(candidates).map(([label, candidate]) => [label, candidate.input_id])),
    data: { stage: "criteria", candidates, reference: null } satisfies TaskData };
  const criteriaBinding = bindTask(criteriaTask, inputs, {}, { tasks: [criteriaTask] });
  const rubric = criteriaProfile.resolve!(criteriaBinding.request, { requirements: [{ source_indices: [1], text: "核查本项要求的实际交付。" }], scoring_points: [], red_flags: [] }, emptyAudit());
  const receipt: SubmissionReceipt = { taskId: criteriaTask.id, attemptId: randomUUID(), submissionId: randomUUID(), acceptedAt: 1,
    status: "succeeded", evaluatorVersion: "fixture", judge: "fixture", evaluation: rubric, audit: emptyAudit(), usage: emptyUsage() };
  const original: PlannedTask = { id: randomUUID(), stage: "attribution", dependencies: { criteria: criteriaTask.id },
    inputIds: { answer: candidates.A.input_id },
    data: { stage: "attribution", candidates: { A: candidates.A }, reference: null } satisfies TaskData };
  const comparison: PlannedTask = { id: randomUUID(), stage: "comparison", dependencies: { criteria: criteriaTask.id, A: original.id },
    inputIds: { A: candidates.A.input_id, B: candidates.B.input_id },
    data: { stage: "comparison", candidates, group: ["A", "B"], reference: null } satisfies TaskData };
  const task: PlannedTask = { id: randomUUID(), stage: "attribution", dependencies: { criteria: criteriaTask.id },
    inputIds: { answer: candidates.A.input_id, peer_B: candidates.B.input_id },
    data: { stage: "attribution", candidates: { A: candidates.A }, referenceCandidates: { peer_B: candidates.B }, reference: null,
      reviewOf: { taskId: original.id, round: 1, reasons: ["核验本方表格对应的同题来源。"] } } satisfies TaskData };
  const before = structuredClone(inputs), binding = bindTask(task, inputs, { criteria: receipt }, { tasks: [criteriaTask, original, comparison, task] });
  const own = binding.request.input.answer as any, peer = (binding.request.input.reference_materials as any).peer_B;
  const shown = binding.modelInput as any;
  assert.equal(shown.answer.table_check_results[0].answer_table_index, 2);
  assert.equal(shown.reference_materials.peer_B.table_check_results[0].answer_table_index, 3);
  assert.equal(shown.answer.table_check_results[0].rows[0].sources[0].table_index, 1);
  assert.equal(shown.reference_materials.peer_B.table_check_results[0].rows[0].sources[0].table_index, 2);
  for (const checks of [shown.answer.table_check_results, shown.reference_materials.peer_B.table_check_results]) {
    assert(checks.every((check: any) => !Object.hasOwn(check, "answer_table_id")));
    assert(checks.flatMap((check: any) => check.rows).flatMap((row: any) => row.sources).every((source: any) => !Object.hasOwn(source, "table_id")));
  }
  assert.deepEqual(own.table_check_results, attributionTableChecks(traces.A, candidates.A.input_id, candidates.A.final_index));
  assert.deepEqual(peer.table_check_results, attributionTableChecks(traces.B, candidates.B.input_id, candidates.B.final_index));
  assert.equal(own.table_check_results[0].answer_table_id, parseTraceTables(traces.A, candidates.A.input_id)[1].table_id);
  assert.deepEqual(inputs, before);
  const foreign = structuredClone(own.table_check_results);
  foreign[0].answer_table_id = peer.table_check_results[0].answer_table_id;
  assert.throws(() => tableChecksPresentation(foreign, traces.A, candidates.A.input_id), /本方真实表格目录/);
});
