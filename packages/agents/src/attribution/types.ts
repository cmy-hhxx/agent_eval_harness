import type { DerivationSubmission, ResolvedDerivation } from './derivations.js';
import type { ResolvedEvidence, JsonObject } from '@eval/contracts';
export type { TaskAnalysis, TaskCriterion } from '@eval/contracts';
export type TransitionKind = 'request_formation' | 'execution' | 'transfer' | 'generation' | 'delivery';
export interface Evidence extends ResolvedEvidence { source?: string; source_input_id?: string }
export type EvidenceStatus = '已确认' | '待核实';
export type EvidencePurpose = '问题' | '归因';
export interface ProblemEvidence extends Evidence { purposes: EvidencePurpose[] }
export interface RelatedResponsibility {
  component: string;
  attribution_reason: string;
  evidence_ids: string[];
  uncertainties?: string[];
}
export interface ProblemProposal {
  text: string;
  reason: string;
  evidence_status: EvidenceStatus;
  component: string;
  responsibility_chain?: { component: string | null; stage: TransitionKind | 'input'; state: string;
    role: 'primary' | 'related' | 'context'; message_index: number | null; evidence_ids: string[] }[];
  attribution_reason: string;
  uncertainties?: string[];
  related_responsibilities?: RelatedResponsibility[];
  calculations?: ResolvedDerivation[];
}
export interface AttributionFinding extends ProblemProposal {
  problem_id: string;
  evidence: ProblemEvidence[];
}
export interface AttributionResult {
  meta: JsonObject;
  summary: string;
  Problem: AttributionFinding[];
  has_standard_answer: boolean;
  is_correct: boolean | null;
  correct_reason: string | null;
}
export interface AttributionSubmission {
  summary: string;
  Problem: {
    text: string; reason: string; evidence_status: EvidenceStatus;
    evidence: { index: number; purposes: EvidencePurpose[]; observation?: string }[];
    responsibility_boundary: string | null; attribution_reason: string; uncertainties?: string[];
    related_responsibilities?: { responsibility_boundary: string; attribution_reason: string;
      evidence_indices: number[]; uncertainties?: string[] }[];
    calculations?: DerivationSubmission[];
  }[];
  is_correct?: boolean | null;
  correct_reason?: string;
}
/** Program-owned navigation, always pointing into the original public process records. */
export interface BusinessChain {
  chain_index: number;
  tool_component: string;
  request_index: number;
  return_indices: number[];
  planner_index: number | null;
  context_indices: number[];
  link_basis: "call_id" | "returned_query" | "end_time";
  references: string[];
  delivery_changed: boolean | null;
  checkpoints: { step: string; availability: "available" | "not_collected"; evidence: Evidence[]; note: string }[];
  final_evidence: Evidence[];
}
