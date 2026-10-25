import type { AttributionResult } from "@eval/agents/attribution";
import type { ComparisonAttribution } from "@eval/agents/comparison";

/** Comparison receives accepted problem facts, never private responsibility judgments. */
export function comparisonAttribution(result: AttributionResult): ComparisonAttribution {
  return {
    has_standard_answer: result.has_standard_answer, is_correct: result.is_correct,
    correct_reason: result.correct_reason, summary: result.summary,
    Problem: result.Problem.map(({problem_id,text,reason,evidence_status,evidence}) => ({
      problem_id,text,reason,evidence_status,evidence: evidence.map(({purposes:_purposes,...item})=>structuredClone(item)),
    })),
  };
}
