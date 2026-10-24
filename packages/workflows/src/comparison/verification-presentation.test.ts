import { canonicalEvidence } from "../../../../tests/fixtures/evidence.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolveEvidence } from "@eval/tools";
import { attributionResult, comparisonResult, criteriaResult, emptyAudit } from "../../../../tests/fixtures/comparison.js";
import { verificationPresentation, verificationInspectionPresentation } from "./verification-presentation.js";
import type { RawInput } from "../inputs/types.js";
import { comparisonAttribution } from "./comparison-attribution.js";


test("verification keeps all fixed slot standards and original nested norms without repeating source analyses", () => {
  const privateRule = "风险提示必须置于回答开始，用户明确只要摘要时例外。";
  const irrelevant = "与本题无关的私有长规则。".repeat(3000);
  const inputA = randomUUID(), inputB = randomUUID();
  const analysis = criteriaResult();
  analysis.requirements = [analysis.requirements[0], { id: "private-rule", text: privateRule, applies_to: [inputA], acceptance_rule: privateRule },
    { id: "unrelated", text: irrelevant, applies_to: [inputA], acceptance_rule: irrelevant }];
  const trace: RawInput = { messages: [{ role: "user", timestamp: "2026-09-25T00:00:00Z", content: "计算2+2" },
    { type: "llm_turn", input_messages: [{ role: "system", content: privateRule + "\n" + irrelevant },
      { role: "user", content: "计算2+2" }], output: [{ role: "assistant", content: "2+2=4" }] },
    { type: "final_answer", role: "assistant", content: "2+2=4" }] };
  const result = attributionResult(true, "2+2=4", true, inputA); result.task_analysis = { ...analysis,
    requirements: [analysis.requirements[2], analysis.requirements[1], analysis.requirements[0]] };
  result.findings[0].type = "problem"; result.findings[0].importance = "low";
  result.findings[0].assessment.requirement_index = 1;
  result.correctness_evidence = [canonicalEvidence(inputA, 2, "2+2=4")];
  result.criterion_assessments.forEach(item => { item.evidence = result.correctness_evidence; });
  result.findings[0].evidence = [canonicalEvidence(inputA, 1, privateRule, "/input_messages/0/content"), canonicalEvidence(inputA, 2, "2+2=4")];
  analysis.scoring_points = [{ id: "private-score", text: privateRule, acceptance_rule: privateRule, applies_to: [inputA] }];
  analysis.red_flags = [{ id: "private-red", text: privateRule, acceptance_rule: privateRule, applies_to: [inputA] }];
  const draft = comparisonResult(); draft.task_analysis = analysis; draft.ranking = [["A", "B"]];
  const material = { question: "计算2+2", final_message_index: 2, catalog: [], citation_inventory: {}, answer_generation: null,
    original_answer_timing: { finish_seconds: 1.2 }, original_answer_usage: { total_tokens: 120, issues: [] as string[] },
    criterion_instruction_sources: Object.fromEntries(["private-rule", "private-score", "private-red"].map(id => [id,
      [{ ...canonicalEvidence(inputA, 1, privateRule, "/input_messages/0/content"), path: "/input_messages/0/content" }]])) };
  const request = { task_analysis: analysis, ground_truth: { available: true, value: "4" },
    candidates: { A: { ...material, candidate_id: inputA }, B: { ...material, criterion_instruction_sources: {}, candidate_id: inputB, original_answer_timing: { finish_seconds: null },
      original_answer_usage: { total_tokens: null, issues: ["source usage unavailable"] } } },
    attributions: { A: comparisonAttribution(result), B: comparisonAttribution({ ...attributionResult(true, "2+2=4", true, inputB), correctness_evidence: [canonicalEvidence(inputB, 2, "2+2=4")], criterion_assessments: [], findings: [] }) }, comparison_draft: draft };
  const before = structuredClone({ request, trace });
  const shown = verificationPresentation(request, { A: { id: inputA, value: trace }, B: { id: inputB, value: trace } }, analysis);
  const blind = verificationInspectionPresentation(shown, analysis);
  assert.deepEqual(blind.sections.map(section => section.kind), ["original_materials", "source_directory"]);
  const checkSlots = blind.sections[1].verification_check_slots;
  assert.deepEqual(checkSlots.map(slot => [slot.candidate, slot.requirement_index, slot.aspect]), [
    ["A", 0, "delivery"], ["A", 0, "constraints"], ["A", 1, "delivery"], ["A", 1, "constraints"],
    ["A", 2, "delivery"], ["A", 2, "constraints"], ["B", 0, "delivery"], ["B", 0, "constraints"],
  ]);
  assert.equal(checkSlots[2].criterion.text, privateRule);
  assert.equal(checkSlots[2].evidence.length, 1);
  assert(!Object.hasOwn(checkSlots[1], "slot_index")); assert(!Object.hasOwn(checkSlots[1].criterion, "id"));
  assert(!Object.hasOwn(checkSlots[1].criterion, "applies_to"));
  assert(!Object.hasOwn(blind.sections[1], "findings")); assert(!Object.hasOwn(blind.sections[1], "source_review"));
  assert(!JSON.stringify(blind).includes('"core_assessment"'));
  assert(!JSON.stringify(blind).includes('"criterion_assessments"')); assert(!JSON.stringify(blind).includes('"ranking_tiers"'));
  const own = blind.sections[1].requirement_catalog!.A.find(entry => entry.criterion_id === "private-rule")!;
  assert.equal(own.criterion.text, privateRule); assert.equal(own.requirement_index, 1);
  assert(!Object.hasOwn(own.criterion, "acceptance_rule"), "only an exact duplicate field is omitted in model view");
  assert.equal(analysis.requirements[1].acceptance_rule, privateRule, "trusted criteria retain the full original field");
  assert(!blind.sections[1].requirement_catalog!.B.some(entry => entry.criterion_id === "private-rule"));
  const top = shown.sections[0].materials![0].task as unknown as { requirements: { text?: string; acceptance_rule?: string; requirement_index: number }[] };
  assert.equal(top.requirements[0].text, analysis.requirements[0].text);
  assert.equal(top.requirements.length, 1);
  assert.deepEqual(shown.sections.map(section => section.kind), ["original_materials", "source_directory", "proposed_comparison"]);
  assert(!Object.hasOwn(shown.sections[2].comparison_draft!, "task_analysis"));
  assert.equal(shown.sections[1].findings!.A[0].assessment.criterion_id, "private-rule");
  assert.equal(shown.sections[1].findings!.A[0].assessment.requirement_index, 1);
  assert(!Object.hasOwn(shown.sections[1].findings!.A[0], "problem"));
  assert(!Object.hasOwn(shown.sections[1].findings!.A[0], "finding_id"));
  assert.equal(shown.sections[2].source_assessments!.A.summary, result.summary);
  const candidate = shown.sections[0].materials!.filter(item => item.kind === "answer").find(item => item.candidate === "A")!;
  assert.equal(candidate.final_answer, "2+2=4");
  assert.equal(candidate.original_user_timestamp, "2026-09-25T00:00:00Z");
  assert.equal(candidate.original_user_timestamp_utc, "2026-09-25T00:00:00.000Z");
  assert.deepEqual(shown.sections[2].comparison_draft!.ranking_tiers, [{ tier: 1, candidates: ["A", "B"], relation: "same_tier" }]);
  assert.deepEqual(candidate.original_answer_timing, { finish_seconds: 1.2 });
  assert.deepEqual(candidate.original_answer_usage, { total_tokens: 120, issues: [] });
  assert.deepEqual(shown.sections[0].materials!.filter(item => item.kind === "answer").find(item => item.candidate === "B")!.original_answer_timing, { finish_seconds: null });
  assert.deepEqual(shown.sections[0].materials!.filter(item => item.kind === "answer").find(item => item.candidate === "B")!.original_answer_usage, { total_tokens: null, issues: ["source usage unavailable"] });
  const privateNorm = shown.sections[1].requirement_catalog!.A.find(entry => entry.criterion_id === "private-rule")!;
  assert.equal(privateNorm.scope, "source_only");
  assert.deepEqual(shown.sections[1].requirement_catalog!.A.filter(entry => ["private-score", "private-red"].includes(entry.criterion_id))
    .map(entry => [entry.criterion_id, entry.kind, entry.scope, entry.evidence.length]),
    [["private-score", "scoring_points", "source_only", 1], ["private-red", "red_flags", "source_only", 1]]);
  assert.equal(privateNorm.requirement_index, 1);
  assert(privateNorm.evidence.length >= 1, "all applicable norms remain independently readable");
  for (const evidence of privateNorm.evidence) {
    assert.equal(resolveEvidence(trace, evidence.reference, "A", emptyAudit(), "/evidence", inputA).quote, privateRule);
    assert.equal(evidence.read_request.path, "/input_messages/0/content");
  }
  const privateSlot = shown.sections[1].comparison_slots!.find(slot => slot.standards.some(standard => standard.text === irrelevant))!;
  assert.equal(privateSlot.scope, "source_only");
  assert.equal(privateSlot.optional, true);
  assert(!Object.hasOwn(privateSlot.standards[0]!, "acceptance_rule"), "exactly duplicate text is omitted only from the model view");
  assert(JSON.stringify(shown).length < JSON.stringify(request).length / 4);
  assert.deepEqual({ request, trace }, before);
  for (const [native, utc] of [
    ["2026-09-25T08:00:00+08:00", "2026-09-25T00:00:00.000Z"],
    ["2026-09-25 08:00:00", null], ["2026-02-31T08:00:00+08:00", null],
    ["2024-02-29T08:00:00+08:00", "2024-02-29T00:00:00.000Z"], ["2026-09-25T24:00:00Z", null],
  ] as const) {
    trace.messages[0].timestamp = native;
    const view = verificationPresentation(request, { A: { id: inputA, value: trace }, B: { id: inputB, value: trace } }, analysis);
    assert.equal(view.sections[0].materials!.filter(item => item.kind === "answer").find(item => item.candidate === "A")!.original_user_timestamp, native);
    assert.equal(view.sections[0].materials!.filter(item => item.kind === "answer").find(item => item.candidate === "A")!.original_user_timestamp_utc, utc);
  }
});

test("blind source directory exposes complete readable own governing norms beyond selected criteria and preserves unknown peers", () => {
  const norm = "## Delivery\nEnd a text response with one question.\n\nA file delivery is exempt." + " Original rule detail.".repeat(3000);
  const inputA = randomUUID(), inputB = randomUUID(), analysis = criteriaResult();
  const own: RawInput = { messages: [{ role: "user", content: "计算2+2" },
    { type: "llm_turn", input_messages: [{ role: "system", content: "Independent planner policy" }], output: [{ role: "assistant", content: "plan" }] },
    { type: "llm_turn", input_messages: [{ role: "system", content: norm }, { role: "user", content: "计算2+2" }], output: [{ role: "assistant", content: "2+2=4" }] },
    { role: "assistant", content: "2+2=4" }] };
  const unknown: RawInput = { messages: [{ role: "user", content: "计算2+2" }, { role: "assistant", content: "2+2=4" }] };
  const material = { question: "计算2+2", catalog: [], citation_inventory: {}, answer_generation: null,
    original_answer_timing: { finish_seconds: null }, original_answer_usage: { total_tokens: null, issues: [] } };
  const request = { candidates: { A: { ...material, candidate_id: inputA, final_message_index: 3 }, B: { ...material, candidate_id: inputB, final_message_index: 1 } },
    task_analysis: analysis, ground_truth: { available: true, value: "4" }, attributions: { A: comparisonAttribution({ ...attributionResult(true, "2+2=4", true, inputA), correctness_evidence: [canonicalEvidence(inputA, 3, "2+2=4")], criterion_assessments: [], findings: [] }), B: comparisonAttribution({ ...attributionResult(true, "2+2=4", true, inputB), findings: [] }) },
    comparison_draft: comparisonResult() };
  const before = structuredClone({ request, own, unknown });
  const shown = verificationInspectionPresentation(verificationPresentation(request, { A: { id: inputA, value: own }, B: { id: inputB, value: unknown } }, analysis), analysis);
  const directory = shown.sections[1].candidate_sources!;
  assert.equal(directory.A.instruction_sources.length, 1); assert.equal(directory.A.instruction_sources[0].message_index, 2);
  assert.deepEqual(directory.B.instruction_sources, [], "missing third-party SYS remains unknown rather than receiving the owner's norm");
  const source = directory.A.instruction_sources[0], proof = source.evidence[0];
  assert.equal(source.role, "system"); assert.equal(source.path, "/input_messages/0/content");
  assert.equal(resolveEvidence(own, proof.reference, "A", emptyAudit(), "/norm", inputA).quote, norm);
  assert.equal(proof.end_offset, norm.length); assert.equal(proof.read_request.max_chars, 16000);
  assert(!JSON.stringify(shown).includes(norm), "the readable directory does not repeat a long SYS body in the blind view");
  assert(!JSON.stringify(shown).includes('"comparison_draft"')); assert(!JSON.stringify(shown).includes('"findings"'));
  assert.deepEqual({ request, own, unknown }, before);
});
