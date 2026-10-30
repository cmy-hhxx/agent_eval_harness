import type { SessionAttributionResult, SessionProblem } from "./types.js";
import { attributionPositionReference, parseEvidenceCoordinates } from "@eval/contracts";

/** The only flattening used by downstream consumers; turn problems stay in trace order. */
export function sessionProblems(result: SessionAttributionResult): SessionProblem[] {
  return [...result.turns.flatMap(turn => turn.problem), ...result.session_problem];
}

export function evidenceMessageIndex(position: string): number | null {
  const reference = attributionPositionReference(position);
  if (reference) return parseEvidenceCoordinates(reference.evidence_id)!.message_index;
  const match = /message_index\s+(\d+)/u.exec(position);
  return match ? Number(match[1]) : null;
}

export function sessionCorrectness(result: SessionAttributionResult): boolean | null {
  const values = result.turns.flatMap(turn => turn.is_correct === null ? [] : [turn.is_correct]);
  return values.length && values.every(value => value === values[0]) ? values[0] === 1 : null;
}
