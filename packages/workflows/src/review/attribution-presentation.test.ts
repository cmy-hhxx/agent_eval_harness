import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { canonicalEvidence } from "../../../../tests/fixtures/evidence.js";
import { emptyUsage, type CriteriaInput, type PlannedTask, type SubmissionReceipt } from "@eval/contracts";
import { attributionTableChecks } from "@eval/agents/attribution";
import { parseTraceTables, evidenceSources, parseEvidenceCoordinates, resolveEvidence, selectEvidenceSource } from "@eval/tools";
import { criteriaResult, emptyAudit } from "../../../../tests/fixtures/comparison.js";
import { attributionPresentation, tableChecksPresentation } from "./attribution-presentation.js";
import { bindTask } from "../comparison/binding.js";
import type { Candidate, RawInput } from "../inputs/types.js";
import type { TaskData } from "../comparison/types.js";

const evidenceInputId = "7ebfa07b-55d4-4e19-80d0-545eb576289a";

const long = "完整规则；包含触发条件、例外和回答原文。".repeat(1000);

test("long attribution evidence keeps exact references and a bounded full-quote reading route in every current evidence array", () => {
  const trace: RawInput = { messages: [{ role: "system", content: [{ text: `前文\n${long}\n后文` }] }] };
  const result = {Problem:[{evidence:[] as ReturnType<typeof canonicalEvidence>[],text:"问题"}]}, entry = canonicalEvidence(evidenceInputId, 0, long, "/content/0/text", 3);
  result.Problem[0].evidence = [entry];
  const before = structuredClone({ result, trace });
  const shown = attributionPresentation(result, "B", trace, evidenceInputId);
  const projected = [shown.Problem[0].evidence[0]];
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
  assert.equal(shown.Problem[0].text,result.Problem[0].text);
});

test("repeated text retains its explicit origin and invalid coordinates never use quote fallback", () => {
  const quote = long.slice(0, 300);
  const trace: RawInput = { messages: [{ content: [quote, quote] }] };
  const result = {Problem:[{evidence:[] as ReturnType<typeof canonicalEvidence>[]}]};
  result.Problem[0].evidence = [canonicalEvidence(evidenceInputId, 0, quote, "/content/1")];
  const shown = attributionPresentation(result, "A", trace, evidenceInputId).Problem[0].evidence[0]!;
  assert("reference" in shown);
  const coordinates = parseEvidenceCoordinates(shown.reference.evidence_id)!;
  assert.equal(coordinates.kind, "text");
  assert.equal(coordinates.path, "/content/1");
  assert.equal(resolveEvidence(trace, shown.reference, "A", emptyAudit(), "/evidence", evidenceInputId).quote, quote);
  const invalid = structuredClone(result); invalid.Problem[0].evidence[0] = canonicalEvidence(evidenceInputId, 0, quote, "/missing");
  assert.throws(() => attributionPresentation(invalid, "A", trace, evidenceInputId), /完整坐标与原文不一致/);
  const short: RawInput = { messages: [{ content: long }] };
  result.Problem[0].evidence = [canonicalEvidence(evidenceInputId, 0, long.slice(0, 200))];
  const shortShown = attributionPresentation(result, "A", short, evidenceInputId).Problem[0].evidence[0]!;
  assert("reference" in shortShown); assert("quote" in shortShown);
  assert.equal(shortShown.quote, long.slice(0, 200));
});

test("a uniquely located rendered JSON quote retains its JSON coordinate and reading path", () => {
  const trace: RawInput = { messages: [{ output: { rows: Array.from({ length: 60 }, (_, n) => ({ value: n })) } }] };
  const source = evidenceSources(trace.messages[0]).find(item => item.kind === "json")!;
  const result = {Problem:[{evidence:[] as ReturnType<typeof canonicalEvidence>[]}]};
  result.Problem[0].evidence = [canonicalEvidence(evidenceInputId, 0, source.text, "", 0, "json")];
  const shown = attributionPresentation(result, "A", trace, evidenceInputId).Problem[0].evidence[0]!;
  assert("reference" in shown); assert("read_request" in shown); assert("end_offset" in shown);
  assert.equal(resolveEvidence(trace, shown.reference, "A", emptyAudit(), "/evidence", evidenceInputId).quote, source.text);
  assert.deepEqual(shown.read_request, { candidate: "A", message_index: 0, offset: 0, max_chars: source.text.length });
  assert.equal(shown.end_offset, source.text.length);
  assert.equal(parseEvidenceCoordinates(shown.reference.evidence_id)?.kind, "json");
});

test("foreign evidence previews and reads the actual peer input under its anonymous comparison label", () => {
  const peerId = randomUUID(), quote = "来自真实对方的核验文本。".repeat(100);
  const own: RawInput = { messages: [{ content: "本方同坐标内容。" }] };
  const peer: RawInput = { messages: [{ content: quote }] };
  const result = {Problem:[{evidence:[] as (ReturnType<typeof canonicalEvidence> & {source?:string;source_input_id?:string})[]}]};
  result.Problem[0].evidence = [{ ...canonicalEvidence(peerId, 0, quote), source: "b_fast", source_input_id: peerId }];
  const before = structuredClone(result);
  const shown = attributionPresentation(result, "A", own, evidenceInputId, { A: own, B: peer }, { A: randomUUID(), B: peerId });
  const evidence = shown.Problem[0].evidence[0];
  assert.equal(evidence.source, "B");
  assert.equal(evidence.source_input_id, peerId);
  assert("reference" in evidence); assert("read_request" in evidence);
  assert.deepEqual(Object.keys(evidence.reference), ["evidence_id"]);
  assert.equal(parseEvidenceCoordinates(evidence.reference.evidence_id)?.input_id, peerId);
  assert.equal(evidence.read_request.candidate, "B");
  assert.equal(resolveEvidence(peer, evidence.reference, "B", emptyAudit(), "/evidence", peerId).quote, quote);
  assert.deepEqual(result, before);
});

test("canonical component table views use own full-directory ordinals while trusted checks remain exact", () => {
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
  const rubric = criteriaResult(criteriaBinding.request.input as unknown as CriteriaInput);
  const receipt: SubmissionReceipt = { taskId: criteriaTask.id, attemptId: randomUUID(), submissionId: randomUUID(), acceptedAt: 1,
    status: "succeeded", evaluatorVersion: "fixture", judge: "fixture", evaluation: rubric, audit: emptyAudit(), usage: emptyUsage() };
  const task: PlannedTask = { id: randomUUID(), stage: "attribution-component", dependencies: { criteria: criteriaTask.id },
    inputIds: { answer: candidates.A.input_id },
    data: { stage: "attribution-component", candidate: candidates.A, candidates: { A: candidates.A }, reference: null } satisfies TaskData };
  const before = structuredClone(inputs);
  bindTask(task, inputs, { criteria: receipt }, { tasks: [criteriaTask, task] });
  const own = { table_check_results: attributionTableChecks(traces.A, candidates.A.input_id, candidates.A.final_index) };
  const shown = { answer: { table_check_results: tableChecksPresentation(own.table_check_results, traces.A, candidates.A.input_id) } };
  assert.equal(shown.answer.table_check_results[0].answer_table_index, 2);
  assert.equal(shown.answer.table_check_results[0].rows[0].sources[0].table_index, 1);
  for (const checks of [shown.answer.table_check_results]) {
    assert(checks.every((check: any) => !Object.hasOwn(check, "answer_table_id")));
    assert(checks.flatMap((check: any) => check.rows).flatMap((row: any) => row.sources).every((source: any) => !Object.hasOwn(source, "table_id")));
  }
  assert.deepEqual(own.table_check_results, attributionTableChecks(traces.A, candidates.A.input_id, candidates.A.final_index));
  assert.equal(own.table_check_results[0].answer_table_id, parseTraceTables(traces.A, candidates.A.input_id)[1].table_id);
  assert.deepEqual(inputs, before);
  const foreign = structuredClone(own.table_check_results);
  foreign[0].answer_table_id = parseTraceTables(traces.B, candidates.B.input_id)[1].table_id;
  assert.throws(() => tableChecksPresentation(foreign, traces.A, candidates.A.input_id), /本方真实表格目录/);
});
