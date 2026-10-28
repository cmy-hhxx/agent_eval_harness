import type { InputSource, JsonObject, OutputTarget, Policy, FailureGuardPolicy } from "@eval/contracts";

export interface VersionConfig {
  id: string;
  name: string;
  display_name?: string;
  /** Declared size class; every member of a classified comparison must declare the same class. */
  comparison_tier?: string;
  sources: InputSource[];
  adapter: string;
  timing_unit?: "ms" | "s";
}

export interface Message extends JsonObject {
  type?: string;
  role?: string | null;
  name?: string;
  content?: unknown;
  model?: string;
}

/** One QA trace in a session. Message indices are local to this trace. */
export interface SessionTurn {
  meta?: JsonObject;
  messages: Message[];
}

export interface RawInput extends JsonObject {
  request_time?: string | null;
  has_standard_answer?: boolean;
  messages: Message[];
  /** Present for session inputs; one entry per user/assistant QA trace. */
  turns?: SessionTurn[];
  /** Original outer session meta, before any single-trace compatibility merge. */
  session_meta?: JsonObject;
  meta?: JsonObject;
  batch_id?: string;
  case_id?: string;
  version?: string;
}

export interface Timing {
  first_token_seconds: number | null;
  first_answer_seconds: number | null;
  finish_seconds: number | null;
  source_unit: string;
  source_values: Record<string, unknown>;
  source_fields: Record<string, string>;
}

export interface Candidate {
  batch_id: string;
  case_id: string;
  version: string;
  name: string;
  /** Source/configuration names that differ from the display name. */
  identity_names?: string[];
  input_id: string;
  trace_id: string | null;
  source: string;
  line: number;
  question: string;
  answer_timing: Timing;
  final_index: number;
  reference: unknown;
  llm: string | null;
  /** Session identity is shared by every trace in one input row. */
  session_id?: string;
  /** Program-derived trace directory used by session orchestration. */
  turns?: CandidateTurn[];
}

export interface CandidateTurn {
  trace_index: number;
  trace_id: string | null;
  question: string;
  final_index: number | null;
  component_scopes: ComponentReviewScope[];
}

/** One component's review scope for a trace goal, in original evidence coordinates. */
export interface ComponentReviewScope {
  component: string;
  message_indices: number[];
  final_ranges?: { path: string; start: number; end: number }[];
}

export interface EvaluationInputs {
  /** Exact published input coordinates selected by a finite ingestion operation. */
  records?: {model:string;batch_id:string;case_id:string;trace_id?:string;input_file:string;input_index:number}[];
  /** Explicit dataset selection persisted for run reconciliation. */
  dataset_id?: string;
  versions: VersionConfig[];
  batches?: string[];
  case_ids?: string[];
  default_batch_id?: string;
  timing_unit?: "ms" | "s";
  limit?: number;
}

export type EvaluationExecution = Policy & {
  concurrency: number;
  /** Maximum foreground attribution sessions; runner and progress share this effective value. */
  sessionWindow: number;
  /** Local task slots; model permits stay global when shared by concurrent day runs. */
  taskConcurrency?: number;
  retries: number;
  retryDelaySeconds: number;
  initialContextChars: number;
  failureGuard?: FailureGuardPolicy;
};

export interface EvaluationConfig {
  inputs: EvaluationInputs;
  execution: EvaluationExecution;
  output: OutputTarget;
}
