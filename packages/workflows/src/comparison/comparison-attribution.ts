import { sessionProblems, type SessionAttributionResult, type SessionProblem } from "@eval/agents/attribution";
import type { ComparisonAttribution } from "@eval/agents/comparison";
import { attributionPositionReference, parseEvidenceCoordinates } from "@eval/contracts";

/** Comparison receives accepted problem facts, never private responsibility judgments. */
function sessionFinding(problem: SessionProblem) {
  return { problem_id: problem.problem_id, text: problem.problem_phenomena, reason: problem.reason,
    evidence_status: "已确认" as const,
    evidence: problem.evidence.flatMap(item => {
      const reference = attributionPositionReference(item.position);
      return reference ? [{ ...reference, message_index: parseEvidenceCoordinates(reference.evidence_id)!.message_index, quote: item.quote }] : [];
    }) };
}

function sessionAttribution(result: SessionAttributionResult): ComparisonAttribution {
  const correctness = result.turns.flatMap(turn => turn.is_correct === null ? [] : [turn.is_correct]);
  const consistent = correctness.length > 0 && correctness.every(value => value === correctness[0]) ? correctness[0]! : null;
  return { has_standard_answer: correctness.length > 0,
    is_correct: consistent === null ? null : consistent === 1,
    correct_reason: result.turns.map(turn => turn.correct_reason).filter(Boolean).join("\n") || null,
    summary: result.session_summary,
    Problem: sessionProblems(result).map(sessionFinding) };
}

export function comparisonAttribution(result: SessionAttributionResult): ComparisonAttribution {
  return sessionAttribution(result);
}
