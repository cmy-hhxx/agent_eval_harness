import type { RewrittenResult, TaskAnalysis } from "@eval/contracts";
import type { JsonObject } from "@eval/contracts";
export type { TaskAnalysis } from "@eval/contracts";

export type CriterionStatus = "met" | "partial" | "unmet" | "unknown" | "not_applicable";
export type EvidenceStatus = "established" | "uncertain";

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
export interface CriterionAssessment {
  criterion_id: string;
  status: CriterionStatus;
  evidence_status: EvidenceStatus;
  summary: string;
}
export interface ComparisonInput {
  source_review?: Record<string, string[]>;
  task_analysis: TaskAnalysis;
  candidates: Record<string, {
    candidate_id: string;
    final_message_index: number;
    deferred_final_material: { message_index: number; path: string; total_chars: number }[];
    original_answer_timing: { finish_seconds: number | null };
    original_answer_usage: { total_tokens: number | null; issues: string[] };
  }>;
  attributions: Record<string, {
    task_analysis: TaskAnalysis;
    findings: Finding[];
    criterion_assessments: CriterionAssessment[];
    core_assessment: { meets_core: boolean | null; reason: string; criterion_ids: string[] };
  }>;
  strength_checks: FindingRef[];
}
/** Reference to a finding owned by the attribution stage. */
export interface FindingRef {
  candidate: string;
  finding_index: number;
}
export interface ComparisonAssessment {
  /** Whether the essential deliverable is usable; not an exact-reference-match flag. */
  meets_core: boolean | null;
  core_failure_refs: string[];
  summary: string;
}
export interface AlignedComparison {
  aspect: string;
  criterion_ids: string[];
  importance: "high" | "medium" | "low";
  /** Empty when no candidate has a verified advantage on this aspect. */
  better_candidates: string[];
  assessments: Record<string, { summary: string; finding_indices: number[]; status: CriterionStatus; evidence_status: EvidenceStatus }>;
}
/**
 * One independently judged pair. The workflow derives a verdict only after a decided result.
 */
export interface ComparisonResult {
  rewritten?: RewrittenResult;
  status: "decided" | "needs_review";
  review_requests: { candidate: string; criterion_ids: string[]; finding_indices: number[]; reason: string }[];
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

export interface SubmittedComparison extends Omit<AlignedComparison, "assessments"> {
  assessments: Record<string, { summary: string; finding_indices: number[] }>;
}
/** The model supplies prose and decision references; source states are resolved by the profile. */
export type ComparisonSubmission = {
  status: "needs_review";
  assessments: Record<string, { summary: string }>;
  review_requests: ComparisonResult["review_requests"];
} | {
  status: "decided";
  assessments: Record<string, { summary: string }>;
  review_requests: ComparisonResult["review_requests"];
  ranking: string[][];
  decision_basis: Omit<ComparisonResult["decision_basis"], "comparisons"> & { comparisons: SubmittedComparison[] };
};
