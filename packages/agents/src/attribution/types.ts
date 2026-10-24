import type { ResolvedEvidence, TaskAnalysis } from "@eval/contracts";
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
  /** Program-bound complete norms for interpretation; not direct supporting excerpts. */
  context_evidence?: Evidence[];
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
  context_evidence?: Evidence[];
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
  /** Exactly one primary cause, followed by independently supported contributing causes. */
  component: Responsibility[];
  diagnosis: "entity_or_unit" | "source_absence" | "context_loss" | "other";
  investigation: ChainInvestigation[];
  label: string;
  definition: string;
}
export interface Responsibility {
  role: "primary" | "contributing";
  technical_domain: string;
  functional_component: string;
  component: string;
  /** Business operation, independently of the actor and technical classification. */
  business_component: string;
  chain_index: number | null;
  chain_step: string;
  field_names: string[];
  mechanism_source: "explicit_process" | "boundary_comparison";
  failure_stage: string;
  mechanism: string;
  certainty: "confirmed" | "inferred";
  reason: string;
  evidence_ids: string[];
  evidence_gap: string | null;
  alternatives: string[];
}
export interface ChainInvestigation {
  chain_index: number;
  steps: { step: string; status: "checked" | "not_collected"; observation: string; evidence_ids: string[] }[];
}
/** Program-owned navigation, always pointing into the original public process records. */
export interface BusinessChain {
  chain_index: number;
  tool_component: string;
  request_index: number;
  return_indices: number[];
  planner_index: number | null;
  context_indices: number[];
  link_basis: "call_id" | "returned_query";
  references: string[];
  delivery_changed: boolean | null;
  checkpoints: { step: string; availability: "available" | "not_collected"; evidence: Evidence[]; note: string }[];
  final_evidence: Evidence[];
}
export type ResponsibilitySubmission = Omit<Responsibility, "evidence_ids"> & { evidence_indices: number[] };
export interface AttributionFinding extends Finding {
  /** Stable within this answer; used to preserve problem-library occurrence lineage. */
  finding_id: string;
  /** Null for strengths; problem findings must describe where the problem happened. */
  problem: ProblemProposal | null;
}
export interface AttributionResult {
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
  /** With a reference and is_correct=false, set only when verified evidence supports the answer and the standard conflicts. */
  standard_conflict?: boolean;
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

export type ObservationSubmission = Pick<Finding, "dimension" | "stage" | "importance" | "text" | "reason"> & {
  evidence_status: "established" | "uncertain";
  evidence_indices: number[];
  basis_index: number | null;
};

/** Fixed shallow rows: strengths never contain problem responsibility fields. */
export interface AttributionSubmission {
  summary: string;
  meets_core: boolean | null;
  core_reason: string;
  core_requirements: number[];
  is_correct: boolean | null;
  correctness_reason: string;
  correctness_evidence_indices: number[];
  standard_conflict?: boolean;
  criterion_assessments: {
    status: Exclude<CriterionAssessment["status"], "not_applicable">;
    evidence_status: "established" | "uncertain";
    summary: string;
    evidence_indices: number[];
  }[];
  strengths: ObservationSubmission[];
  problems: (ObservationSubmission & Omit<ProblemProposal,"component" | "investigation"> & {
    component:ResponsibilitySubmission[]; impact:string;
    investigation: { chain_index: number; steps: (Omit<ChainInvestigation["steps"][number], "evidence_ids"> & { evidence_indices: number[] })[] }[];
  })[];
  numeric_checks: {
    label: string; reference_index: number; actual: string | number | null; scale: string;
    mode: "rounded" | "exact"; evidence_index: number;
  }[];
  image_observations?: { image_number: number; text: string }[];
  table_resolutions?: {
    table_index: number; row_index: number; outcome: "supported" | "conflict"; reason: string; evidence_indices: number[];
  }[];
}
