import type { JsonObject, ModelConfig, Policy } from "../../contracts/src/index.js";

export interface VersionConfig {
  id: string;
  name: string;
  display_name?: string;
  path: string;
  adapter: "a" | "aa";
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
  judge: Omit<ModelConfig, "model" | "thinking" | "contextWindow" | "maxOutputTokens"> & {
    correctness: Pick<ModelConfig, "model" | "thinking" | "contextWindow" | "maxOutputTokens">;
    pairwise: Pick<ModelConfig, "model" | "thinking" | "contextWindow" | "maxOutputTokens">;
  };
  execution: Policy & {
    concurrency: number;
    retries: number;
    retryDelaySeconds: number;
    initialContextChars: number;
  };
  outputDir: string;
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
  source_revision?: string;
  question: string;
  answer_timing: Timing;
  final_index: number;
  reference: unknown;
  llm: string | null;
}
export interface BatchPreflight {
  cases: number;
  valid_inputs: number;
  correctness_tasks: number;
  pairwise_tasks: number;
  skipped_pairs: number;
  input_issues: number;
}
export interface TaskData {
  initialContextChars?: number;
  stage: "correctness" | "pairwise";
  candidates: Record<string, Candidate>;
  reference: unknown;
  pair?: string[];
  comparisonId?: string;
  revision?: number;
}
export interface Evidence {
  message_index: number;
  quote: string;
}
export interface Finding {
  type: "strength" | "problem";
  dimension: string;
  stage: string;
  importance: "high" | "medium" | "low";
  text: string;
  reason: string;
  evidence: Evidence[];
  assessment: {
    requirement_index: number;
    observation: string;
    evidence_status: "established" | "uncertain";
    impact: string;
  };
  stage_trace?: JsonObject;
}
export interface Review {
  summary: string;
  findings: Finding[];
}
export interface TaskAnalysis {
  task_type: string;
  goal: string;
  requirements: string[];
  scoring_points: string[];
  red_flags: string[];
  timing_analysis: string;
}
export interface FindingRef {
  candidate: string;
  finding_index: number;
}
export interface PairwiseResult {
  verdict: { result: "A_better" | "B_better" | "both_good" | "both_bad" | "not_comparable"; reason: string };
  evaluations: Record<string, Review>;
  task_analysis: TaskAnalysis;
  decision_basis: { decisive_findings: FindingRef[]; counterevidence: FindingRef[]; tradeoff: string };
}
export interface CorrectnessResult {
  is_correct: boolean | null;
  correctness_reason: string;
  evidence: Evidence[];
}
