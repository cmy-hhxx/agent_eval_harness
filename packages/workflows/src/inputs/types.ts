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

export interface RawInput extends JsonObject {
  request_time?: string | null;
  has_standard_answer?: boolean;
  messages: Message[];
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
}

export interface EvaluationInputs {
  /** Exact published input coordinates selected by a finite ingestion operation. */
  records?: {model:string;batch_id:string;case_id:string;trace_id?:string;input_file:string;input_index:number}[];
  /** Explicit dataset selection persisted for run reconciliation. */
  dataset_id?: string;
  /** Frozen cleaning coordinates; no input bodies are copied into run configuration. */
  workbench?: {
    task: { id: string; name: string; source: string; category: string };
    batch_ids: string[];
    records: { model: string; batch_id: string; case_id: string; date?: string; input_file: string; input_index: number;
      package_id: string; package_name: string; original_file: string; original_line: number; original_item?: number }[];
  };
  versions: VersionConfig[];
  batches?: string[];
  case_ids?: string[];
  default_batch_id?: string;
  timing_unit?: "ms" | "s";
  limit?: number;
}

export type EvaluationExecution = Policy & {
  concurrency: number;
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
