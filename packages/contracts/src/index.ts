import type { JsonSchema, JsonObject, ModelConfig, ToolResult, TraceRead, FailureCategory, ValidationIssue } from "./primitives.js";
export type * from "./primitives.js";
export { presentSource, type SourcePresentation } from "./source-presentation.js";
export type Engine = "pi";
export { evidenceId, evidenceSources, messageContentSources, evidenceImageAvailable, imagePlaceholder, overlapsImagePlaceholder, parseEvidenceCoordinates, type EvidenceCoordinates } from "./evidence.js";
export * from "./evidence-selection.js";
export { mergeRequiredReadRanges, extendRequiredReadRanges, requiredReadCallLimit, toolBudgetMetadataChars, validationRequiredReads } from "./required-reading.js";
export type * from "./criteria.js";

export interface Policy {
  timeoutSeconds: number;
  idleTimeoutSeconds: number;
  maxToolCalls: number;
  repairAttempts: number;
  /** Explicit content-repair limits by workflow stage; omitted stages use repairAttempts. */
  stageRepairAttempts?: Record<string, number>;
  /** Optional cumulative attempt cap per task, including same-run resumes. */
  maxTaskAttempts?: number;
  codeTimeoutSeconds: number;
  maxOutputChars: number;
  maxTokens?: number;
}
export const DEFAULT_POLICY: Policy = {
  timeoutSeconds: 900,
  idleTimeoutSeconds: 600,
  maxToolCalls: 12,
  repairAttempts: 3,
  codeTimeoutSeconds: 60,
  maxOutputChars: 16000,
};
export interface EvaluationSpec {
  /** Immutable navigation shared by prepared tasks; tools only read it. Never rendered into the model prompt. */
  materialNavigation?: JsonObject;
  id: string;
  profile: string;
  systemPrompt: string;
  /** Model-facing submission schema, projected from the trusted request when supplied by the Profile. */
  outputSchema: JsonSchema;
  /** Optional structured material inspection, sharing the final submission content budget. */
  inspectionSchema?: JsonSchema;
  toolNames: string[];
  /** Whether this profile explicitly submits existing workspace JSON files instead of JSON values. */
  fileSubmission: boolean;
  /** Resolve already applies the profile's final semantic validation; Host still checks the result schema. */
  resolveValidatesResult?: boolean;
  /** Reserve file drafting inside the existing exploration/repair allowance, not in addition to it. */
  draftWriteInCallLimit?: boolean;
  /** Transport the final JSON body as one string to avoid provider object-array coercion. */
  jsonStringSubmission?: boolean;
  /** Model-facing descriptions for exactly the selected and submission tools. */
  toolDescriptions: Record<string, string>;
  /** One bounded follow-up when a session ends without an accepted submission. */
  submissionNudge: string;
  /** Exact material ranges that must be read before this task can be accepted. */
  requiredReads?: TraceRead[];
  /** Source excerpts already shown in initial material; display reuse only, never mandatory-read proof. */
  presentedReads?: TraceRead[];
  /** Display-only source rules; evidence always resolves against original inputs. */
  sourcePresentations?: Record<string, import("./source-presentation.js").SourcePresentation>;
  /** Tool evidence references above this length are shown as quote_chars without a selectable index. */
  maxEvidenceQuoteChars?: number;
}
export interface InputRef {
  id: string;
  name: string;
  /** Host-owned immutable material identity, independent of the evidence/source identity. */
  materialId?: string;
}
export function submissionToolNames(fileSubmission: boolean): string[] {
  return fileSubmission ? ["submit_evaluation_file"] : ["submit_evaluation"];
}
/** Native arguments for both a JSON file submission and a file-backed material inspection. */
export const SUBMISSION_FILE_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path"],
  properties: { path: { type: "string", minLength: 1 } },
};
export const SUBMISSION_JSON_SCHEMA: JsonSchema = {
  type: "object", additionalProperties: false, required: ["json"],
  properties: { json: { type: "string", minLength: 2 } },
};
export interface EngineIdentity {
  engine: Engine;
  version: string;
  commit: string;
  buildId: string;
}
export interface AttemptSpec {
  runId: string;
  debug?: boolean;
  taskId: string;
  attemptId: string;
  inputRevision: number;
  engine: EngineIdentity;
  evaluation: EvaluationSpec;
  model: ModelConfig;
  policy: Policy;
  prompt: string;
  /** Private program coordinates; never included verbatim in a model prompt. */
  evidenceBank: import("./evidence-selection.js").EvidenceBank;
  inputs: InputRef[];
  hostUrl: string;
  deadline: number;
  /** Worker must acquire a Host permit before each provider request. */
  controlModelRequests?: boolean;
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
export interface Artifact {
  id: string;
  name: string;
  bytes: number;
}
/** Recomputable table comparison coordinates; never stores copied cells or verdicts. */
export interface TableCheckSpec {
  candidate: string;
  answer_table_id: string;
  sources: {
    table_id: string;
    key_columns: { answer: number; source: number }[];
    value_columns: { answer: number; source: number }[];
  }[];
}
export interface ToolAudit {
  review?: import("./review.js").ReviewAudit;
  /** Task-local coordinate directory; non-evidence profiles may leave it absent. */
  evidenceBank?: import("./evidence-selection.js").EvidenceBank;
  calls: number;
  /** Successful new mandatory pages; other calls consume the exploration budget. */
  requiredReadCalls: number;
  viewedImages: string[];
  traceReads: TraceRead[];
  calculations: unknown[];
  artifacts: Artifact[];
  tableChecks?: TableCheckSpec[];
  inspection?: InspectionCheckpoint;
}
export type { ReviewCase, ReviewQuote, ReviewAudit } from "./review.js";
export interface Submission {
  submissionId: string;
  attemptId: string;
  taskId: string;
  evaluation: unknown;
  audit: ToolAudit;
  usage: Usage;
  submissionStats?: { contentSubmissions: number; fileErrors: number; jsonRepairs?: number };
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
  /** One-based row in a result file whose public rows contain no internal identity. */
  line?: number;
}
/** Where a run writes its ledger, results and reports. */
export interface OutputTarget {
  kind: "directory";
  path: string;
  /** Explicit root for test runs; never inferred from production directory names. */
  testPath?: string;
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
  /** Optional problem direction; it organizes classes and does not establish causes. */
  category?: string;
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
  /** Independent clustering jobs keep their directory and accepted attribution source. */
  clustering_run?: string;
  attribution?: AttributionSource;
  task_id: string;
  submission_id: string;
  finding_id: string;
  /** Certainty of this occurrence, not of its problem class. */
  evidence_status: "已确认" | "待核实";
  message_index: number;
  source: { file: string; line: number };
  classification: "assigned" | "created";
  previous_class_id: string | null;
  at: string;
}
export interface AttributionSource {
  run: string;
  run_id: string;
  task_id: string;
  submission_id: string;
  evaluator_version: string;
}
/** A source coordinate and short observation; it never stores evidence bodies. */
export interface ProblemObservationRef {
  version: string;
  input_id: string;
  finding_id: string;
  attribution: AttributionSource;
  source: { file: string; line: number };
  batch_id: string;
  case_id: string;
  components: string[];
  evidence_status: "已确认" | "待核实";
  summary: string;
}
export type ProblemEventType = "class_created" | "class_merged" | "occurrence_moved" | "class_updated" | "occurrence_rejected" | "pending_observations_replaced" | "assignments_replaced";
export interface ProblemEvent {
  id: string;
  type: ProblemEventType;
  at: string;
  detail: JsonObject;
}
/** Append-only per-model problem library maintained by clustering rules and explicit source-review events. */
export interface ProblemLibrary {
  model: string;
  updated_at: string;
  components: Record<string, ProblemComponent>;
  classes: Record<string, ProblemClass>;
  occurrences: ProblemOccurrence[];
  events: ProblemEvent[];
  pending_observations?: ProblemObservationRef[];
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
      /** At most three distinct answers, recalled without copying accepted result bodies. */
      examples: {
        input_id: string;
        batch_id: string;
        case_id: string;
        finding_id: string;
        evidence_status: ProblemOccurrence["evidence_status"];
        /** A bounded preview; the source occurrence keeps the original quote. */
        quote?: string;
        run_id: string;
        task_id: string;
        submission_id: string;
        attribution?: AttributionSource;
        finding?: string;
        reason?: string;
      }[];
      category?: string;
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
  /** Unaccepted upstream task IDs at acceptance, propagated without inventing evaluations. */
  incompleteDependencies?: string[];
  submitted?: unknown;
  exported?: ResultReference & { row: JsonObject; auxiliary?: boolean };
}
/** A resolved source coordinate and its exact display text; neither replaces the other. */
export interface ResolvedEvidence {
  evidence_id: string;
  message_index: number;
  quote: string;
}
/** A successful read-only inspection; proof is retained for request-bound validation on resume. */
export interface InspectionCheckpoint {
  id: string;
  value: JsonObject;
  proof: { viewedImages: string[]; traceReads: TraceRead[] };
}
export interface MaterialInspection {
  inspectionId: string;
  attemptId: string;
  taskId: string;
  value: JsonObject;
  audit: ToolAudit;
  contentSubmissions: number;
}
export interface ToolContext {
  /** Trusted navigation supplied by the Host, independent of original source values. */
  materialNavigation?: JsonObject;
  execution?: { python: string };
  attemptId: string;
  workdir: string;
  inputs: Map<string, unknown>;
  /** Immutable registered input UUIDs, keyed exactly like inputs. */
  inputIds: ReadonlyMap<string, string>;
  sourcePresentations?: ReadonlyMap<string, import("./source-presentation.js").SourcePresentation>;
  maxEvidenceQuoteChars?: number;
  audit: ToolAudit;
  /** Delegated by the Worker; validation belongs to the registered Profile. */
  persistEvidenceBank?(bank: import("./evidence-selection.js").EvidenceBank): Promise<void>;
  inspectMaterial?(value: unknown, signal: AbortSignal): Promise<ToolResult>;
  policy: Policy;
  requiredReads?: TraceRead[];
  presentedReads?: TraceRead[];
  draftWriteInCallLimit?: boolean;
  artifacts: {
    put(name: string, data: string | Uint8Array): Promise<Artifact>;
    get(id: string): Promise<Uint8Array>;
  };
}
export interface ToolDefinition {
  name: string;
  /** This registered tool can write a file for submission; reserved repair calls remain bounded. */
  fileWriter?: boolean;
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
    modelRequest?: (signal?: AbortSignal) => Promise<() => Promise<void>>;
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
  errorDetail?: string;
  retryable?: boolean;
  /** Confirmed provider quota/balance exhaustion at the model error boundary. */
  modelQuotaExhausted?: boolean;
  failure?: FailureContext;
}
export interface AttemptRecord {
  /** Latest private coordinate directory, including additions after the initial attempt spec. */
  evidenceBank?: import("./evidence-selection.js").EvidenceBank;
  spec: AttemptSpec;
  status?: AttemptStatus;
  metrics?: { usage: Usage; audit: ToolAudit; timings?: {
    inputIoMs: number; modelMs: number; toolMs: number; submissionMs: number; requiredReadMs: number;
  } };
  pendingSubmission?: Submission;
  error?: string;
  artifactError?: string;
  failure?: FailureContext;
}
export interface PlannedTask {
  id: string;
  stage: string;
  dependencies: Record<string, string>;
  /** These dependency labels may finish unsuccessfully; pending/running/cancelled still wait. */
  settledDependencies?: string[];
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
  sources: Record<string, { id: string; value: unknown; presentation?: import("./source-presentation.js").SourcePresentation }>;
}
export interface AgentProfile {
  id: string;
  /** Schema for the Host-built request material, not the raw source record. */
  requestSchema: JsonSchema;
  /** Schema for the JSON submitted by the model. */
  submissionSchema: JsonSchema;
  /** Model-facing parameter schema; Host validation keeps the static schema and request-bound business rules. */
  modelSubmissionSchema?(request: AgentRequest): JsonSchema;
  /** Model references are task-local choices; canonical schemas and stored results retain coordinates. */
  evidenceSelections?: boolean;
  /** Longest selectable evidence span for this profile; tools expose no index for a longer range. */
  maxEvidenceQuoteChars?: number;
  /** A mandatory read-only inspection before the trusted secondary material is revealed. */
  inspection?: {
    /** Canonical schema also used when restoring an accepted checkpoint. */
    schema: JsonSchema;
    modelSchema?: JsonSchema;
    resolve?(request: AgentRequest, value: unknown, audit: ToolAudit): unknown;
    validate(request: AgentRequest, value: unknown, audit: ToolAudit): void;
    /** Profile-owned read-only context, revealed only after canonical inspection validation. */
    materialContext?(request: AgentRequest, value: unknown, audit: ToolAudit): JsonObject;
  };
  /** Schema for the accepted result after optional submission resolution. */
  resultSchema?: JsonSchema;
  /** Resolve already applies the profile's final semantic validation; Host still checks the result schema. */
  resolveValidatesResult?: boolean;
  systemPrompt: string;
  instructions: string;
  submissionNudge: string;
  toolNames: string[];
  fileSubmission: boolean;
  draftWriteInCallLimit?: boolean;
  jsonStringSubmission?: boolean;
  toolDescriptions: Record<string, string>;
  /** Task material on its own for inspection; policy and recovery are added per attempt. */
  renderPrompt(input: JsonObject, policy?: Policy, recovery?: FailureContext): string;
  requiredReads?(request: AgentRequest): TraceRead[];
  /** Independent checks that safely inspect partial or structurally invalid submissions. */
  validateSubmission?(request: AgentRequest, draft: unknown, audit: ToolAudit): ValidationIssue[];
  /** Read-only repair context merged into expected; checks, constraints and submitted values stay unchanged. */
  validationIssueContext?(request: AgentRequest, value: unknown, issue: ValidationIssue): JsonObject | undefined;
  resolve?(request: AgentRequest, draft: unknown, audit: ToolAudit): unknown;
  validate?(request: AgentRequest, result: unknown, audit: ToolAudit): void;
}
export interface AgentDefinition {
  id: string;
  profiles: Record<string, AgentProfile>;
}
export interface AgentBinding {
  /** Measured once during this assembly; never exposed as model fields. */
  preparationTimings?: Record<string, number>;
  /** Immutable workflow-owned navigation shared with tools without entering modelInput or evidence registration. */
  materialNavigation?: JsonObject;
  agent: string;
  profile: string;
  request: AgentRequest;
  /** Explicit model-facing projection; validation and evidence resolution keep using request. */
  modelInput?: JsonObject;
  /** Workflow-owned ranges actually displayed in modelInput, excluding undisclosed source suffixes. */
  presentedReads?: TraceRead[];
  /** Secondary model material, disclosed only after a valid structured inspection. */
  inspectionInput?: JsonObject;
  /** Workflow-owned projection of generated evidence envelopes; exclude all original source values. */
  projectModelInput?(input: JsonObject, bank: import("./evidence-selection.js").EvidenceBank): JsonObject;
  /** Workflow-owned identity binding after submission validation; the Agent still validates the formal result. */
  resolveSubmission?(value: unknown): unknown;
}
export interface WorkflowScheduling {
  /** Finite session admission derived from task states; lower stage priorities run first. */
  sessionAdmission?: {
    id(task: PlannedTask): string | undefined;
    /** Fixed test/workflow window, or derive the effective value from the run manifest. */
    window: number | ((manifest: RunManifest) => number);
    completed(task: PlannedTask): boolean;
  };
  stagePriority?(stage: string): number;
}
export interface WorkflowDefinition {
  id: string;
  plan(config: unknown, options?: unknown): Promise<TaskPlan>;
  reconcile?(run: string, state: RunState, config: unknown): Promise<TaskPlan>;
  bind(
    task: PlannedTask,
    inputs: Record<string, unknown>,
    dependencies: Record<string, SubmissionReceipt | undefined>,
    context: { tasks: readonly PlannedTask[] },
  ): AgentBinding;
  /** Synchronous, business-owned follow-up planning after a validated receipt. */
  advance?(task: PlannedTask, receipt: SubmissionReceipt, state: RunState, inputs: Readonly<Record<string, unknown>>): {
    tasks: PlannedTask[];
    replace?: PlannedTask[];
  };
  /** A business-owned admission gate, also evaluated when resuming accepted dependencies. */
  blockedReason?(task: PlannedTask, dependencies: Record<string, SubmissionReceipt>): string | undefined;
  /** Wait for a workflow phase without turning unfinished work into a failed dependency. */
  canStart?(task: PlannedTask, manifest: RunManifest): boolean;
  /** Independent optional checks must not pause the primary task stage. */
  observesFailures?(task: PlannedTask): boolean;
  /** Optional workflow-owned ordering and finite session admission. */
  scheduling?: WorkflowScheduling;
}
export interface RunRepository {
  readRun(run: string): Promise<RunState>;
  /** Decode only the requested tasks; unrelated result rows stay on disk. */
  readTasks(run: string, taskIds: string[]): Promise<RunState>;
  writeRun(run: string, state: RunState): Promise<void>;
  createResultWriter(run: string, inputs: Record<string, unknown>): (state: RunState) => Promise<void>;
}
export interface LogContext {
  evaluator_model?: string;
  evaluator_version?: string;
  channel?: string;
  attempt?: number;
  component: string;
  event: string;
  run_id?: string;
  task_id?: string;
  attempt_id?: string;
  stage?: string;
  errors?: FailureContext["errors"];
  detail?: string;
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
  event?(event: string, context: JsonObject & { component: string }): Promise<boolean>;
  error(error: unknown, context: LogContext): Promise<void>;
  evaluation(record: EvaluationLog): Promise<boolean>;
}
export interface TaskState {
  /** Actual channel selected for the most recent dispatched attempt. */
  channel?: string;
  status: "pending" | "running" | "succeeded" | "failed" | "blocked" | "cancelled" | "timed_out";
  attemptId?: string;
  attempts: number;
  /** Network failures charged to this task across automatic retries and restarts. */
  transportFailures?: number;
  reason?: string;
  failure?: FailureContext;
  repeatedErrors?: number;
  revision?: number;
  durationMs?: number;
  startedAt?: number;
  lastProgressAt?: number;
  /** Scheduled retry of this task within the current Host execution. */
  nextRetryAt?: number;
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
  /** Optional dispatch bounds; attempts already spent remain counted across resume. */
  executionLimits?: { maxAttempts?: number; stopStartingAt?: number };
  /** Monotone admissions count, independent of tasks retained by workflow reconciliation. */
  cumulativeAttempts?: number;
  executionStopReason?: "attempt_limit" | "dispatch_deadline";
  /** Explicit repair scope; input discovery resumes only when the operator releases it. */
  executionScope?: string[];
  /** Circuit breaks survive restart; only explicit stage recovery clears them. */
  pausedStages?: StagePause[];
  /** Last journal event compacted into this checkpoint; later events replay over it. */
  journalSequence?: number;
}
export interface FailureGuardPolicy {
  enabled?: boolean;
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
export interface FailureContext {
  review?: import("./review.js").ReviewAudit;
  /** Keep prior choices stable even when the last draft or inspection failed. */
  evidenceBank?: import("./evidence-selection.js").EvidenceBank;
  draft?: unknown;
  inspection?: InspectionCheckpoint;
  errors: ValidationIssue[];
  contentSubmissions: number;
  /** Failed submission file reads, JSON decoding or SDK argument loading; separate from content judgments. */
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

/** Worker progress, separate from model content submissions and immutable inspections. */
export interface EvidenceBankUpdate {
  taskId: string;
  attemptId: string;
  evidenceBank?: import("./evidence-selection.js").EvidenceBank;
  /** Entries appended since the last persisted directory; never replaces earlier choices. */
  append?: import("./evidence-selection.js").EvidenceBank;
}
