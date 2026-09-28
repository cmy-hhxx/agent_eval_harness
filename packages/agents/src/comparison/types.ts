import type { RewrittenResult } from "@eval/contracts";
import type { JsonObject } from "@eval/contracts";

export interface Evidence {
  message_index: number;
  quote: string;
}
export interface Finding {
  type: "strength" | "problem";
  dimension:
    | "correctness"
    | "completeness"
    | "instruction_following"
    | "evidence_quality"
    | "reasoning"
    | "format"
    | "relevance"
    | "efficiency";
  stage: "context_recall" | "reasoning" | "execution" | "final_answer";
  importance: "high" | "medium" | "low";
  text: string;
  reason: string;
  evidence: Evidence[];
  assessment: {
    requirement_index: number | null;
    observation: string;
    evidence_status: "established" | "uncertain";
    impact: string;
  };
  stage_trace?: JsonObject;
}
export interface TaskAnalysis {
  task_type: string;
  goal: string;
  requirements: string[];
  scoring_points: string[];
  red_flags: string[];
}
/** Reference to a finding owned by the attribution stage. */
export interface FindingRef {
  candidate: string;
  finding_index: number;
}
export interface ComparisonAssessment {
  /** Whether the essential deliverable is usable; not an exact-reference-match flag. */
  meets_core: boolean;
  summary: string;
}
export interface AlignedComparison {
  aspect: string;
  importance: "high" | "medium" | "low";
  /** Empty when no candidate has a verified advantage on this aspect. */
  better_candidates: string[];
  assessments: Record<string, { summary: string; finding_indices: number[] }>;
}
/**
 * One comparison over a whole group: a tiered ranking plus per-candidate core
 * classification. Two-way verdicts are derived from these two, never judged in isolation.
 */
export interface ComparisonResult {
  rewritten?: RewrittenResult;
  task_analysis: TaskAnalysis;
  /** Blind labels grouped by tier, best first; every candidate appears exactly once. */
  ranking: string[][];
  assessments: Record<string, ComparisonAssessment>;
  decision_basis: {
    tradeoff: string;
    comparisons: AlignedComparison[];
    decisive_findings: FindingRef[];
  };
}
