import type { AttributionLibrary } from "@eval/contracts";

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
/** Where a finding belongs in the model's attribution tree. */
export interface ProblemRef {
  /** Existing problem node ID when recalled; null means "propose a new node". */
  node_id: string | null;
  /** Tool/component class, e.g. a specific tool name. Top-level category of the tree. */
  component: string;
  label: string;
  definition: string;
}
export interface AttributionFinding extends Finding {
  /** Stable within this answer; used to preserve attribution-tree occurrence lineage. */
  finding_id: string;
  /** Null for strengths; problem findings must map into the tree. */
  problem: ProblemRef | null;
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

/** Node directory recalled into an attribution attempt; occurrence counts make samples traceable. */
export interface LibraryProjection {
  components: {
    id: string;
    label: string;
    definition: string;
    problems: { id: string; label: string; definition: string; occurrences: number }[];
  }[];
}
export type { AttributionLibrary };
