import type { ResolvedEvidence, JsonObject } from '@eval/contracts';
export type { TaskAnalysis, TaskCriterion } from '@eval/contracts';
export type TransitionKind = 'request_formation' | 'execution' | 'transfer' | 'generation' | 'delivery';
export interface Evidence extends ResolvedEvidence { source?: string; source_input_id?: string }
/** Final session-level problem. Trace and session problems share this exact shape. */
export interface SessionProblem {
  problem_id: string;
  component: string;
  label: string;
  definition: string;
  problem_phenomena: string;
  reason: string;
  evidence: {
    position: string;
    component: string;
    quote: string;
    reason: string;
  }[];
  calculations?: { text: string }[];
}

export interface TraceAttributionResult {
  meta: JsonObject;
  summary: string;
  problem: SessionProblem[];
  is_correct: 1 | 0 | null;
  correct_reason: string | null;
}

export interface SessionAttributionResult {
  session_meta: JsonObject;
  turns: TraceAttributionResult[];
  session_summary: string;
  session_problem: SessionProblem[];
}

export interface ComponentReviewResult {
  component: string;
  problems: SessionProblem[];
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
