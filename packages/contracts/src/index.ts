export type Engine = "pi" | "prime";
export type JsonSchema = Record<string, unknown>;
export type JsonObject = Record<string, unknown>;

export interface Policy {
  timeoutSeconds: number;
  idleTimeoutSeconds: number;
  maxToolCalls: number;
  repairAttempts: number;
  codeTimeoutSeconds: number;
  maxOutputChars: number;
  maxTokens?: number;
}
export const DEFAULT_POLICY: Policy = {
  timeoutSeconds: 900,
  idleTimeoutSeconds: 600,
  maxToolCalls: 12,
  repairAttempts: 2,
  codeTimeoutSeconds: 60,
  maxOutputChars: 16000,
};
export interface ModelConfig {
  provider: string;
  baseUrl: string;
  api: "openai-completions" | "openai-responses";
  apiKeyEnv: string;
  model: string;
  thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  contextWindow: number;
  maxOutputTokens: number;
}
export interface EvaluationSpec {
  id: string;
  profile: string;
  systemPrompt: string;
  /** Worker-facing copy of AgentProfile.submissionSchema. */
  outputSchema: JsonSchema;
  toolNames: string[];
  /** Model-facing descriptions for exactly the selected and submission tools. */
  toolDescriptions: Record<string, string>;
  /** One bounded follow-up when a session ends without an accepted submission. */
  submissionNudge: string;
}
export interface InputRef {
  id: string;
  name: string;
}
export interface EngineIdentity {
  engine: Engine;
  version: string;
  commit: string;
  buildId: string;
}
export interface AttemptSpec {
  runId: string;
  taskId: string;
  attemptId: string;
  inputRevision: number;
  engine: EngineIdentity;
  evaluation: EvaluationSpec;
  model: ModelConfig;
  policy: Policy;
  prompt: string;
  inputs: InputRef[];
  hostUrl: string;
  deadline: number;
  recovery?: FailureContext;
}
export type AttemptState = "running" | "succeeded" | "failed" | "timed_out" | "cancelled";
export interface WorkerEvent {
  seq: number;
  attemptId: string;
  time: number;
  type: "started" | "model" | "tool_start" | "tool_end" | "usage" | "submission" | "finished";
  data: unknown;
}
export interface ToolContent {
  type: "text" | "image";
  text?: string;
  data?: string;
  mimeType?: string;
}
export interface ToolResult {
  content: ToolContent[];
  details?: unknown;
  isError?: boolean;
  terminate?: boolean;
}
export interface Artifact {
  id: string;
  name: string;
  bytes: number;
}
export interface ToolAudit {
  calls: number;
  viewedImages: string[];
  calculations: unknown[];
  artifacts: Artifact[];
}
export interface Submission {
  submissionId: string;
  attemptId: string;
  taskId: string;
  evaluation: unknown;
  audit: ToolAudit;
  usage: Usage;
  submissionStats?: { contentSubmissions: number; fileErrors: number };
}
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}
export const emptyUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
});
export interface ResultReference {
  file?: string;
  id: string;
}
/** Where a run writes its ledger, results and reports. */
export interface OutputTarget {
  kind: "directory";
  path: string;
}
/** Where a version's records come from. Resolved by Data. */
export type InputSource =
  | { kind: "file"; path: string }
  | { kind: "directory"; path: string; include?: string[] };
/** Where per-model problem libraries are persisted. */
export interface ProblemLibraryTarget {
  kind: "directory";
  path: string;
}
export interface ProblemOrigin {
  run_id: string;
  evaluator_version: string;
  batch_id: string;
  case_id: string;
  input_id: string;
  at: string;
}
/** Where problems happen: a tool or a top-level class such as model reasoning. */
export interface ProblemComponent {
  id: string;
  label: string;
  definition: string;
  aliases: string[];
  first_seen: ProblemOrigin | null;
}
/** A stable problem class shared across runs; clustering is its only writer. */
export interface ProblemClass {
  id: string;
  component_id: string;
  label: string;
  definition: string;
  aliases: string[];
  status: "active" | "merged";
  merged_into: string | null;
  first_seen: ProblemOrigin | null;
}
export interface ProblemOccurrence {
  id: string;
  class_id: string;
  version: string;
  evaluator_version: string;
  batch_id: string;
  case_id: string;
  input_id: string;
  run_id: string;
  task_id: string;
  submission_id: string;
  finding_id: string;
  /** Certainty of this occurrence, not of its problem class. */
  evidence_status: "established" | "uncertain";
  message_index: number;
  quote: string;
  source: { file: string; line: number };
  classification: "assigned" | "created";
  previous_class_id: string | null;
  at: string;
}
export type ProblemEventType = "class_created" | "class_merged" | "occurrence_moved";
export interface ProblemEvent {
  id: string;
  type: ProblemEventType;
  at: string;
  detail: JsonObject;
}
/** Append-only per-model problem library maintained by the clustering stage. */
export interface ProblemLibrary {
  model: string;
  updated_at: string;
  components: Record<string, ProblemComponent>;
  classes: Record<string, ProblemClass>;
  occurrences: ProblemOccurrence[];
  events: ProblemEvent[];
}
/** Recall projection handed to the clustering stage; one entry per active component. */
export interface ProblemProjection {
  components: {
    id: string;
    label: string;
    definition: string;
    aliases: string[];
    classes: {
      id: string;
      label: string;
      definition: string;
      aliases: string[];
      occurrences: number;
    }[];
  }[];
}
export interface SubmissionReceipt extends Submission {
  acceptedAt: number;
  status: "succeeded";
  /** Evaluation logic that produced this receipt; fixed at acceptance time. */
  evaluatorVersion: string;
  /** Resolved judge model ID used by the accepted attempt (no endpoint configuration). */
  judge: string;
  submitted?: unknown;
  exported?: ResultReference & { row: JsonObject; auxiliary?: boolean };
}
export interface ToolContext {
  execution?: { python: string };
  attemptId: string;
  workdir: string;
  inputs: Map<string, unknown>;
  audit: ToolAudit;
  policy: Policy;
  artifacts: {
    put(name: string, data: string | Uint8Array): Promise<Artifact>;
    get(id: string): Promise<Uint8Array>;
  };
}
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  execute(context: ToolContext, arguments_: unknown, signal: AbortSignal): Promise<ToolResult>;
}
export interface AgentSession {
  run(prompt: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): Promise<void>;
}
export interface AgentBackend {
  identity: EngineIdentity;
  createSession(options: {
    spec: AttemptSpec;
    workdir: string;
    tools: ToolDefinition[];
    execute: (name: string, args: unknown, signal?: AbortSignal) => Promise<ToolResult>;
    onEvent: (value: unknown) => void;
  }): Promise<AgentSession>;
}
export interface WorkerStatus {
  identity: EngineIdentity;
  tools: string[];
  activeAttempt: string | null;
}
export interface AttemptStatus {
  state: AttemptState;
  lastSeq: number;
  error?: string;
  retryable?: boolean;
  failure?: FailureContext;
}
export interface AttemptRecord {
  spec: AttemptSpec;
  status?: AttemptStatus;
  metrics?: { usage: Usage; audit: ToolAudit };
  pendingSubmission?: Submission;
  error?: string;
  artifactError?: string;
  failure?: FailureContext;
}
export interface PlannedTask {
  id: string;
  stage: string;
  dependencies: Record<string, string>;
  inputIds: Record<string, string>;
  data: unknown;
}
export interface TaskPlan {
  tasks: PlannedTask[];
  inputs: Record<string, unknown>;
  summary: JsonObject;
  catalog?: unknown[];
}
export interface AgentRequest {
  input: JsonObject;
  sources: Record<string, { id: string; value: unknown }>;
}
export interface AgentProfile {
  id: string;
  /** Schema for the Host-built request material, not the raw source record. */
  requestSchema: JsonSchema;
  /** Schema for the JSON submitted by the model. */
  submissionSchema: JsonSchema;
  /** Schema for the accepted result after optional submission resolution. */
  resultSchema?: JsonSchema;
  systemPrompt: string;
  instructions: string;
  submissionNudge: string;
  toolNames: string[];
  toolDescriptions: Record<string, string>;
  /** Task material on its own for inspection; policy and recovery are added per attempt. */
  renderPrompt(input: JsonObject, policy?: Policy, recovery?: FailureContext): string;
  resolve?(request: AgentRequest, draft: unknown, audit: ToolAudit): unknown;
  validate?(request: AgentRequest, result: unknown, audit: ToolAudit): void;
}
export interface AgentDefinition {
  id: string;
  profiles: Record<string, AgentProfile>;
}
export interface AgentBinding {
  agent: string;
  profile: string;
  request: AgentRequest;
}
export interface WorkflowDefinition {
  id: string;
  plan(config: unknown, options?: unknown): Promise<TaskPlan>;
  reconcile?(run: string, state: RunState, config: unknown): Promise<TaskPlan>;
  bind(
    task: PlannedTask,
    inputs: Record<string, unknown>,
    dependencies: Record<string, SubmissionReceipt | undefined>,
  ): AgentBinding;
}
export interface RunRepository {
  readRun(run: string): Promise<RunState>;
  /** Decode only the requested tasks; unrelated result rows stay on disk. */
  readTasks(run: string, taskIds: string[]): Promise<RunState>;
  writeRun(run: string, state: RunState): Promise<void>;
  createResultWriter(run: string, inputs: Record<string, unknown>): (state: RunState) => Promise<void>;
}
export interface LogContext {
  component: string;
  event: string;
  run_id?: string;
  task_id?: string;
  attempt_id?: string;
}
export interface EvaluationLog {
  time: string;
  workflow: string;
  run_id: string;
  task_id: string;
  attempt_id: string;
  submission_id: string;
  stage: string;
  result: JsonObject;
}
/** Logging is best effort: failures are reported separately and never revoke a receipt. */
export interface LogSink {
  error(error: unknown, context: LogContext): Promise<void>;
  evaluation(record: EvaluationLog): Promise<boolean>;
}
export interface TaskState {
  status: "pending" | "running" | "succeeded" | "failed" | "blocked" | "cancelled" | "timed_out";
  attemptId?: string;
  attempts: number;
  reason?: string;
  failure?: FailureContext;
  repeatedErrors?: number;
  revision?: number;
  durationMs?: number;
  startedAt?: number;
  lastProgressAt?: number;
  artifactStatus?: {
    status: "available" | "missing" | "not_retained";
    source: string;
    error?: string;
  };
}
export interface RunManifest {
  format: "evaluation-run";
  debug: boolean;
  runId: string;
  status: "running" | "finished" | "interrupted";
  engine: EngineIdentity;
  /** Current evaluator version; new receipts are stamped with it, accepted ones keep theirs. */
  evaluatorVersion: string;
  config: unknown;
  tasks: PlannedTask[];
  inputs: Record<string, InputRef>;
  inputCatalog?: unknown[];
  states: Record<string, TaskState>;
  preflight: JsonObject;
  startedAt: number;
  finishedAt?: number;
  concurrency?: number;
  /** Explicit repair scope; input discovery resumes only when the operator releases it. */
  executionScope?: string[];
  /** Circuit breaks survive restart; only explicit stage recovery clears them. */
  pausedStages?: StagePause[];
}
export interface FailureGuardPolicy {
  windowSize: number;
  threshold: number;
}
export interface StagePause {
  stage: string;
  category: FailureCategory;
  code: string;
  path: string;
  taskIds: string[];
  at: number;
}
export interface RunState {
  manifest: RunManifest;
  receipts: Record<string, SubmissionReceipt>;
  usage: Usage;
  recordedAttempts: number;
}

export type FailureCategory =
  | "input"
  | "structure"
  | "evidence"
  | "decision"
  | "file"
  | "transport"
  | "interruption";
export interface ValidationIssue {
  code: string;
  path: string;
  candidate?: string;
  expected?: unknown;
  actual?: unknown;
  message: string;
  category: FailureCategory;
}
export interface FailureContext {
  draft?: unknown;
  errors: ValidationIssue[];
  contentSubmissions: number;
  fileErrors: number;
  repeatedErrors: number;
  stopped: boolean;
  attemptId: string;
}

export * from "./validation.js";
export type * from "./assistant.js";

/** Optional language polish attached after a stage has accepted its decision. */
export interface RewrittenResult {
  evaluator_version: string;
  rewrites: { id: string; text: string }[];
}
