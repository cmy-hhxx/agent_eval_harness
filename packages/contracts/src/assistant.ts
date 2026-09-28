import type { JsonObject, ModelConfig, ToolResult } from "./index.js";

export interface AssistantScope { userId: string; sessionId: string }
export interface AssistantExecutor { pid: number; instanceId: string; url: string }
export interface AssistantOwnership {
  locate(scope: AssistantScope): Promise<AssistantExecutor | undefined>;
  claim(scope: AssistantScope, executor: AssistantExecutor): Promise<() => Promise<void>>;
}
export interface AnalysisReference { runId: string; inputId?: string; taskId?: string; messageIndex?: number }
export interface AnalysisQuery { runId?: string; query?: string; offset?: number; limit?: number }
export interface AnalysisDataSource {
  list(query: AnalysisQuery): Promise<JsonObject>;
  read(reference: AnalysisReference, options?: { offset?: number; limit?: number }): Promise<JsonObject>;
  search(reference: AnalysisReference, query: string, options?: { offset?: number; limit?: number }): Promise<JsonObject>;
  image(reference: AnalysisReference): Promise<ToolResult>;
}
export interface SpecialistRequest {
  operationId: string;
  kind: "attribution" | "comparison";
  inputs: AnalysisReference[];
  attributions?: { inputId: string; operationId?: string; runId?: string; taskId?: string }[];
}
export interface SpecialistResult {
  operationId: string;
  kind: "attribution" | "comparison";
  state: "running" | "succeeded" | "failed" | "cancelled";
  evaluatorVersion: string;
  result?: unknown;
  reference?: AnalysisReference;
  error?: string;
}
export interface SpecialistGateway {
  invoke(scope: AssistantScope, request: SpecialistRequest, signal: AbortSignal, progress?: (value: unknown) => void): Promise<SpecialistResult>;
  read(scope: AssistantScope, operationId: string): Promise<SpecialistResult>;
}
export interface AssistantTool {
  readOnly?: boolean;
  name: string;
  description: string;
  inputSchema: JsonObject;
  execute(args: unknown, context: { scope: AssistantScope; callId: string; signal: AbortSignal; progress(value: unknown): void }): Promise<ToolResult>;
}
export interface AssistantPrompt {
  requestId: string;
  sessionId: string;
  mode: "queue" | "steer";
  content: { type: "text"; text: string }[];
}
/** The upstream browser's event vocabulary; concrete event producers own data. */
export interface AssistantEvent {
  type: string;
  seq: number;
  time: number;
  data: JsonObject;
  surfaceOp?: "append";
  ignorable?: true;
}
export interface AssistantSessionState extends AssistantScope {
  title: string;
  createdAt: number;
  updatedAt: number;
  status: "idle" | "running" | "interrupted";
  lastSeq: number;
  archived: boolean;
  pinned: boolean;
  modelSelection?: AssistantModelSelection;
  modelUsed?: AssistantModelSelection;
  requests: Record<string, "queued" | "running" | "completed" | "interrupted">;
}
export type AssistantRecord =
  | { kind: "event"; event: AssistantEvent }
  | { kind: "command"; prompt: AssistantPrompt }
  | { kind: "compaction"; summary: string; firstKeptEntryId: string; tokensBefore: number };
export interface AssistantModelOptions {
  model: ModelConfig;
  systemPrompt: string;
  recoveryMessage?: string;
  tools: AssistantTool[];
}
export interface AssistantSessionRuntime {
  readonly options: { directory: string; model: ModelConfig; models?: AssistantModelDirectory };
  settings(userId: string): Promise<JsonObject>;
  mutateSettings(userId: string, namespace: string, ops: unknown, expectedRevision: unknown): Promise<JsonObject>;
  selectModel(scope: AssistantScope, selection: AssistantModelSelection): Promise<void>;
  list(userId: string): Promise<AssistantSessionState[]>;
  create(userId: string, sessionId?: string): Promise<AssistantSessionState>;
  prompt(userId: string, value: AssistantPrompt): Promise<void>;
  cancel(scope: AssistantScope): Promise<void>;
  projections(scope: AssistantScope): Promise<unknown>;
  updateQueue(scope: AssistantScope, itemId: string, action: JsonObject): Promise<unknown>;
  rename(scope: AssistantScope, title: string): Promise<unknown>;
  mark(scope: AssistantScope, field: "archived" | "pinned", marked: boolean): Promise<unknown>;
  page(scope: AssistantScope, beforeSeq?: number, maxMessages?: number): Promise<unknown>;
  toolResult(scope: AssistantScope, callId: string): Promise<ToolResult>;
  changes(userId: string, signal: AbortSignal, kind: "events" | "control"): AsyncIterable<unknown>;
  events(scope: AssistantScope, signal: AbortSignal): AsyncIterable<unknown>;
  dispose(): Promise<void>;
}

/** Upstream settings revisions detect concurrent writes; they are not format versions. */
export interface AssistantPreferences { revision: number; revisions: Record<string, number>; values: Record<string, JsonObject> }

export interface AssistantModelSelection { provider: string; model: string; reasoningEffort?: ModelConfig['thinking'] }
export interface AssistantModelEntry { id: string; name: string; contextWindow?: number; maxTokens?: number; reasoning?: { defaultEffort?: string; efforts: {id: string; name: string}[] } }
export interface AssistantModelDirectory {
  list(userId: string, refresh?: boolean): Promise<{ models: AssistantModelEntry[]; favorites: string[]; default: AssistantModelSelection }>;
  favorites(userId: string, ids: string[]): Promise<void>;
  readFavorites(userId: string): Promise<string[] | undefined>;
  resolve(selection: AssistantModelSelection): Promise<ModelConfig>;
}
