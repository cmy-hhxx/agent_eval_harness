import type { AttributionResult } from "@eval/agents/attribution";
import type { ComparisonAttribution, Evidence } from "@eval/agents/comparison";

/** Only comparison facts cross the boundary; attribution diagnosis and export polish stay upstream. */
export function comparisonAttribution(result: AttributionResult): ComparisonAttribution {
  const evidence = (entries: Evidence[]) => entries.map(({ evidence_id, message_index, quote, source, source_input_id }) => ({
    evidence_id, message_index, quote,
    ...(source !== undefined ? { source } : {}), ...(source_input_id !== undefined ? { source_input_id } : {}),
  }));
  return {
    has_standard_answer: result.has_standard_answer,
    is_correct: result.is_correct,
    correctness_reason: result.correctness_reason,
    correctness_evidence: evidence(result.correctness_evidence),
    numeric_checks: result.numeric_checks.map(({ label, expected, actual, scale, mode, matches, evidence_index }) =>
      ({ label, expected, actual, scale, mode, matches, evidence_index })),
    ...(result.standard_conflict !== undefined ? { standard_conflict: result.standard_conflict } : {}),
    summary: result.summary,
    task_analysis: result.task_analysis,
    criterion_assessments: result.criterion_assessments.map(({ criterion_id, status, evidence_status, summary,
      evidence: entries, context_evidence }) => ({ criterion_id, status, evidence_status, summary, evidence: evidence(entries),
      ...(context_evidence ? { context_evidence: evidence(context_evidence) } : {}) })),
    ...(result.table_resolutions ? { table_resolutions: result.table_resolutions.map(({ table_id, row_index, outcome,
      reason, evidence: entries }) => ({ table_id, row_index, outcome, reason, evidence: evidence(entries) })) } : {}),
    core_assessment: { meets_core: result.core_assessment.meets_core, reason: result.core_assessment.reason,
      criterion_ids: result.core_assessment.criterion_ids },
    findings: result.findings.map(({ type, dimension, stage, importance, text, reason, assessment,
      evidence: entries, context_evidence }, finding_index) => ({ type, dimension, stage, importance, text, reason,
      finding_index, assessment: { requirement_index: assessment.requirement_index, observation: assessment.observation,
        evidence_status: assessment.evidence_status, impact: assessment.impact }, evidence: evidence(entries),
      ...(context_evidence ? { context_evidence: evidence(context_evidence) } : {}) })),
  };
}
