import type { ResolvedEvidence, TaskAnalysis } from "@eval/contracts";
export type { TaskAnalysis } from "@eval/contracts";

export type CriterionStatus = "met" | "partial" | "unmet" | "unknown" | "not_applicable";
export type EvidenceStatus = "已确认" | "待核实";

export interface Evidence extends ResolvedEvidence {
  source?: string;
  source_input_id?: string;
}
export interface Finding {
  problem_id: string;
  text: string;
  reason: string;
  evidence_status: EvidenceStatus;
  evidence: Evidence[];
}
/** Accepted problems are immutable; Comparison judges common requirements independently. */
export interface ComparisonAttribution {
  has_standard_answer: boolean;
  is_correct: boolean | null;
  correct_reason: string | null;
  summary: string;
  Problem: Finding[];
}
export interface SourceReviewItem {
  kind: "unverified" | "unresolved_conflict" | "invalid_material";
  reason: string;
  requires_review: boolean;
}
export interface ComparisonInput {
  source_review?: Record<string, SourceReviewItem[]>;
  task_analysis: TaskAnalysis;
  candidates: Record<string, {
    candidate_id: string;
    final_message_index: number;
    answer_generation?: { available: true; message_type: "llm_turn"; matches_captured_final: boolean | null; message_index: number; captured_final_message_index: number;
      input_contexts: { message_index: number; path: string; total_chars: number;
        read_request: { message_index: number; path: string; offset: number; max_chars: number } }[];
      blocks: { path: string; total_chars: number }[] } | null;
    deferred_final_material: { message_index: number; path: string; total_chars: number }[];
    original_answer_timing: { finish_seconds: number | null };
    original_answer_usage: { total_tokens: number | null; issues: string[] };
  }>;
  attributions: Record<string, ComparisonAttribution>;
}
export interface ComparisonVerificationInput extends ComparisonInput {
  comparison_draft: ComparisonResult;
}
/** A source-grounded check of a program-bound applicable requirement, without a new attribution or verdict. */
export interface ComparisonVerificationCheck {
  candidate: string;
  criterion_id: string;
  result: "supported" | "contradicted" | "unverified" | "not_applicable";
  /** Program-bound complete actual review scope; specific counterevidence remains in concerns. */
  answer_evidence: { evidence_id: string; observation?: unknown }[];
  source_evidence: ComparisonVerificationCheck["answer_evidence"];
  observation: string;
}
export interface ComparisonMaterialInspection {
  checks: ComparisonVerificationCheck[];
  /** Empty criterion_ids denote a proof-bound own SYS/DEV norm outside the fixed requirements, never a new common standard. */
  concerns: { candidate: string; criterion_ids: string[]; answer_evidence: ComparisonVerificationCheck["answer_evidence"];
    source_evidence: ComparisonVerificationCheck["answer_evidence"]; reason: string }[];
}
export interface ComparisonConcernMatch {
  concern_index: number;
  finding_indices: number[];
  observation: string;
}
export interface ComparisonVerificationSubmission {
  concern_matches: ComparisonConcernMatch[];
  /** Explicit corrections of the inspector's own concerns, backed by original material. */
  concern_refutations?: { concern_index: number; source_evidence: ComparisonVerificationCheck["source_evidence"]; reason: string }[];
  /** Only nonempty review choices are submitted; the program owns the full row associations. */
  source_reviews: { slot_index: number; candidate: string; reason: string }[];
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

export interface ComparisonSlot {
  aspect: string;
  criterion_ids: string[];
  shared: boolean;
  kind: "criterion" | "resource";
  optional: boolean;
  finding_indices: Record<string, number[]>;
}
export interface SubmittedComparison {
  slot_index: number;
  kind: "criterion" | "resource";
  importance: "high" | "medium" | "low";
  /** Only commentary rows accept a model direction; resource direction is derived. */
  better_candidate?: string | null;
  assessments?: { candidate: string; status: CriterionStatus; evidence_status: EvidenceStatus;
    summary: string; finding_indices: number[] }[];
}
/** Program-normalized judgments; the model submits flat A/B fields defined by the submission schema. */
export interface ComparisonSubmission {
  assessments: (ComparisonAssessment & { candidate: string })[];
  scope_conflicts?: { slot_index: number; reason: string }[];
  source_reviews?: ComparisonVerificationSubmission["source_reviews"];
  comparisons: SubmittedComparison[];
  quality_winner?: string | null;
  relative_preference: "A" | "B" | null;
  tradeoff: string;
}
