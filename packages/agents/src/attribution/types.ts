import type { DerivationSubmission, ResolvedDerivation } from './derivations.js';
import type { ResolvedEvidence, JsonObject } from '@eval/contracts';
export type { TaskAnalysis, TaskCriterion } from '@eval/contracts';
export type TransitionKind = 'request_formation' | 'execution' | 'transfer' | 'generation' | 'delivery';
export interface Evidence extends ResolvedEvidence { source?: string; source_input_id?: string }
export interface Uncertainty { evidence_gap: string; alternatives: string[] }
export interface ResponsibilitySubmission {
  transition_index: number;
  basis: 'input_deviation' | 'independent_addition' | 'unknown_transition';
  mechanism_source: 'explicit_process' | 'boundary_comparison';
  reason: string;
  certainty: 'confirmed' | 'inferred';
  uncertainty?: Uncertainty;
}
export interface Responsibility extends ResponsibilitySubmission {
  actor_index: number | null;
  component: string;
  kind: TransitionKind;
  role: 'primary' | 'contributing';
  evidence_ids: string[];
}
export type CheckOutcome = 'preserved' | 'changed' | 'recovered' | 'unresolved';
export interface TransitionCheckSubmission {
  transition_index: number; outcome: CheckOutcome; observation: string;
  before_evidence_indices: number[]; after_evidence_indices: number[];
}
export interface TransitionCheck {
  transition_index: number; kind: TransitionKind; outcome: CheckOutcome; observation: string;
  before_evidence_ids: string[]; after_evidence_ids: string[];
}
export interface ProblemProposal {
  text: string;
  reason: string;
  evidence_status: 'established' | 'uncertain';
  checks: TransitionCheck[];
  causes: Responsibility[];
  uncertainty?: Uncertainty;
  calculations?: ResolvedDerivation[];
}
export interface AttributionFinding extends ProblemProposal {
  problem_id: string;
  evidence: Evidence[];
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
    text: string; reason: string; evidence_status: 'established' | 'uncertain';
    evidence_indices: (number | {image_number:number;observation:string})[]; checks: TransitionCheckSubmission[]; causes: ResponsibilitySubmission[];
    uncertainty?: Uncertainty; calculations?: DerivationSubmission[];
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
