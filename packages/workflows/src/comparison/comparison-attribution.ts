import type { AttributionResult, SessionAttributionResult, SessionProblem } from "@eval/agents/attribution";
import type { ComparisonAttribution } from "@eval/agents/comparison";

/** Comparison receives accepted problem facts, never private responsibility judgments. */
function sessionFinding(problem: SessionProblem) {
  return { problem_id: problem.problem_id, text: problem.problem_phenomena, reason: problem.reason,
    evidence_status: "已确认" as const,
    evidence: problem.evidence.map((item, index) => ({ evidence_id: `${problem.problem_id}:${index}`,
      message_index: Number(/message\s+(\d+)/u.exec(item.position)?.[1] ?? 0), quote: item.quote })) };
}

function sessionAttribution(result: SessionAttributionResult): ComparisonAttribution {
  const correctness = result.turns.flatMap(turn => turn.is_correct === null ? [] : [turn.is_correct]);
  const consistent = correctness.length > 0 && correctness.every(value => value === correctness[0]) ? correctness[0]! : null;
  return { has_standard_answer: correctness.length > 0,
    is_correct: consistent === null ? null : consistent === 1,
    correct_reason: result.turns.map(turn => turn.correct_reason).filter(Boolean).join("\n") || null,
    summary: result.session_summary,
    Problem: [...result.turns.flatMap(turn => turn.problem), ...result.session_problem].map(sessionFinding) };
}

export function comparisonAttribution(result: AttributionResult | SessionAttributionResult): ComparisonAttribution {
  if ("session_meta" in result) return sessionAttribution(result);
  return {
    has_standard_answer: result.has_standard_answer, is_correct: result.is_correct,
    correct_reason: result.correct_reason, summary: result.summary,
    Problem: result.Problem.map(({problem_id,text,reason,evidence_status,evidence}) => ({
      problem_id,text,reason,evidence_status,evidence: evidence.map(({purposes:_purposes,...item})=>structuredClone(item)),
    })),
  };
}
