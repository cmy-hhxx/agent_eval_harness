import type { AttributionTarget, InputSource, JsonObject, OutputTarget, Policy } from "@eval/contracts";
import type { LibraryProjection } from "@eval/agents/attribution";

export interface VersionConfig {
  id: string;
  name: string;
  display_name?: string;
  sources: InputSource[];
  adapter: string;
  timing_unit?: "ms" | "s";
}
export interface EvalConfig {
  inputs: {
    versions: VersionConfig[];
    batches?: string[];
    case_ids?: string[];
    default_batch_id?: string;
    timing_unit?: "ms" | "s";
    limit?: number;
  };
  execution: Policy & {
    concurrency: number;
    retries: number;
    retryDelaySeconds: number;
    initialContextChars: number;
  };
  output: OutputTarget;
  attribution: AttributionTarget;
  /** Comparison groups; every version inside a group is compared in one task. */
  comparisons: string[][];
}
export interface Message extends JsonObject {
  type?: string;
  role?: string;
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
export interface BatchPreflight {
  cases: number;
  valid_inputs: number;
  attribution_tasks: number;
  comparison_tasks: number;
  skipped_groups: number;
  input_issues: number;
}
export interface TaskData {
  initialContextChars?: number;
  stage: "attribution" | "comparison";
  candidates: Record<string, Candidate>;
  reference: unknown;
  /** Recalled attribution tree for the single attribution candidate. */
  library?: LibraryProjection;
  /** Compared group version IDs, in declaration order. */
  group?: string[];
  comparisonId?: string;
  revision?: number;
}
export type { Finding, TaskAnalysis, ComparisonResult } from "@eval/agents/comparison";
export type { AttributionResult, LibraryProjection } from "@eval/agents/attribution";
