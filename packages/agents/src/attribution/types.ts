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
    requirement_index: number;
    observation: string;
    evidence_status: "established" | "uncertain";
    impact: string;
  };
}
export interface TaskAnalysis {
  task_type: string;
  goal: string;
  requirements: string[];
  scoring_points: string[];
  red_flags: string[];
}
/**
 * Raw problem description proposed by attribution. The clustering stage owns library classes
 * and decides which class receives this problem; attribution never creates classes.
 */
export interface ProblemProposal {
  /** Concrete tool name from the evaluated answer's call chain, or 模型自身推理. */
  component: string;
  label: string;
  definition: string;
}
export interface AttributionFinding extends Finding {
  /** Stable within this answer; used to preserve problem-library occurrence lineage. */
  finding_id: string;
  /** Null for strengths; problem findings must describe where the problem happened. */
  problem: ProblemProposal | null;
}
export interface AttributionResult {
  /** Whether the case carries a usable standard answer; mirrors the request input. */
  has_standard_answer: boolean;
  /** Must be boolean when a standard answer exists, otherwise null. */
  is_correct: boolean | null;
  correctness_reason: string;
  correctness_evidence: Evidence[];
  task_analysis: TaskAnalysis;
  summary: string;
  findings: AttributionFinding[];
}
