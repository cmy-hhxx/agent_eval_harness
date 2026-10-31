import type { ResolvedEvidence, JsonObject } from '@eval/contracts';
export type { TaskAnalysis, TaskCriterion } from '@eval/contracts';
export interface Evidence extends ResolvedEvidence { source?: string; source_input_id?: string }
/** Final session-level problem. Trace and session problems share this exact shape. */
export interface SessionProblem {
  component: string;
  label: string;
  definition: string;
  problem_phenomena: string;
  reason: string;
  severity: "P0" | "P1" | "P2" | "P3";
  severity_reason: string;
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
