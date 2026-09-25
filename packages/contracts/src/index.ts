export type Engine = "pi" | "prime";
export type JsonSchema = Record<string, unknown>;
export type JsonObject = Record<string, unknown>;
export const PROTOCOL_VERSION = 3;

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
  version: string;
  systemPrompt: string;
  outputSchema: JsonSchema;
  toolNames: string[];
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
  protocolVersion: number;
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
export const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });
export type ResultReference = { file?: string } & (
  | { comparisonId: string; taskId?: never }
  | { taskId: string; comparisonId?: never }
);
export interface SubmissionReceipt extends Submission {
  acceptedAt: number;
  status: "succeeded";
  submitted?: unknown;
  exported?: ResultReference & { row: JsonObject };
}
export interface ToolContext {
  attemptId: string;
  workdir: string;
  inputs: Map<string, unknown>;
  inputIds?: Map<string, string>;
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
  protocolVersion: number;
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
export interface EvaluationPack {
  id: string;
  version: string;
  snapshots?(): Record<string, unknown>;
  plan(config: unknown): Promise<TaskPlan>;
  reconcile?(run: string, state: RunState, config: unknown): Promise<TaskPlan>;
  resolve?(task: PlannedTask, inputs: Record<string, unknown>, draft: unknown, audit: ToolAudit): unknown;
  prepare(
    task: PlannedTask,
    inputs: Record<string, unknown>,
    dependencies: Record<string, SubmissionReceipt>,
  ): {
    evaluation: EvaluationSpec;
    prompt: string;
  };
  validate(
    task: PlannedTask,
    inputs: Record<string, unknown>,
    evaluation: unknown,
    audit: ToolAudit,
    dependencies: Record<string, SubmissionReceipt | undefined>,
  ): void;
  report(run: string): Promise<JsonObject>;
  createResultWriter(run: string, inputs: Record<string, unknown>): (state: RunState) => Promise<void>;
  readRun(run: string): Promise<RunState>;
  writeRun(run: string, state: RunState): Promise<void>;
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
  artifactStatus?: { status: "available" | "missing" | "not_retained"; source: string; error?: string };
}
export interface RunManifest {
  format: "dual-agent-eval/6";
  debug: boolean;
  runId: string;
  status: "running" | "finished" | "interrupted";
  engine: EngineIdentity;
  config: unknown;
  tasks: PlannedTask[];
  inputs: Record<string, InputRef>;
  inputCatalog?: unknown[];
  states: Record<string, TaskState>;
  preflight: JsonObject;
  startedAt: number;
  finishedAt?: number;
  concurrency?: number;
}
export interface RunState {
  manifest: RunManifest;
  receipts: Record<string, SubmissionReceipt>;
  usage: Usage;
  recordedAttempts: number;
}

export type FailureCategory = "input" | "structure" | "evidence" | "decision" | "file" | "transport" | "interruption";
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
