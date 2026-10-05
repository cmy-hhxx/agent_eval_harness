import type { ResolvedEvidence, RewrittenResult, TaskAnalysis } from "@eval/contracts";
export type { TaskAnalysis, TaskCriterion } from "@eval/contracts";
export interface Evidence extends ResolvedEvidence {
  /** Foreign review fact source; both fields are absent on the answer's own evidence. */
  source?: string;
  source_input_id?: string;
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
}
export interface CriterionAssessment {
  criterion_id: string;
  status: "met" | "partial" | "unmet" | "unknown" | "not_applicable";
  evidence_status: "established" | "uncertain";
  summary: string;
  evidence: Evidence[];
}
export interface CoreAssessment {
  /** Null when the evidence does not establish whether the core result is usable. */
  meets_core: boolean | null;
  reason: string;
  /** References applicable shared requirements, never scoring points or red flags. */
  criterion_ids: string[];
}
/**
 * Raw problem description proposed by attribution. The clustering stage owns library classes
 * and decides which class receives this problem; attribution never creates classes.
 */
export interface ProblemProposal {
  /** Evidence-backed responsible tools and/or 模型自身推理; definition explains each role; empty when responsibility is unresolved. */
  component: string[];
  label: string;
  definition: string;
}
/** Model choices bind responsibility to original selected evidence; canonical components are program-owned. */
export interface ProblemSubmission {
  model_responsible: boolean;
  tool_evidence_indices: number[];
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
  rewritten?: RewrittenResult;
  /** Whether the case carries a usable standard answer; mirrors the request input. */
  has_standard_answer: boolean;
  /** With a reference, null requires an uncertain applicable core criterion and independent review; otherwise boolean. Without a reference, null. */
  is_correct: boolean | null;
  correctness_reason: string;
  correctness_evidence: Evidence[];
  /** Same-unit standard-answer checks; matches is verified with decimal arithmetic. */
  numeric_checks: {
    label: string;
    expected: string;
    actual: string | null;
    scale: string;
    mode: "rounded" | "exact";
    matches: boolean;
    evidence_index: number;
  }[];
  task_analysis: TaskAnalysis;
  criterion_assessments: CriterionAssessment[];
  core_assessment: CoreAssessment;
  summary: string;
  findings: AttributionFinding[];
  /** Only independent review can resolve a specific table row with source evidence. */
  table_resolutions?: {
    table_id: string;
    row_index: number;
    outcome: "supported" | "conflict";
    reason: string;
    evidence: Evidence[];
  }[];
}
