import type { JsonObject, ModelConfig, ToolResult } from "./index.js";

export interface AssistantScope { userId: string; sessionId: string }
export interface AssistantExecutor { pid: number; instanceId: string; url: string }
export interface AssistantOwnership {
  locate(scope: AssistantScope): Promise<AssistantExecutor | undefined>;
  claim(scope: AssistantScope, executor: AssistantExecutor): Promise<() => Promise<void>>;
}
export interface AnalysisReference { runId: string; inputId?: string; taskId?: string; messageIndex?: number }
export interface AnalysisCaseLookup { runId: string; query: string; comparisonTier?: string }
export interface AnalysisQuery {
  runId?: string; view?: "inputs" | "comparisons" | "statistics"; query?: string; offset?: number; limit?: number;
  sample?: boolean; excludeCases?: { batchId: string; caseId: string }[];
  comparisonTier?: string; outcome?: "win" | "both_good" | "both_bad" | "all"; includeAnalysis?: boolean;
}
export interface AnalysisResultReadOptions { view?: "summary" | "details"; offset?: number; limit?: number }
export type AnalysisReadOptions = AnalysisResultReadOptions
  | { view: "case"; audience?: "user" }
  | { view: "evidence"; messages: { messageIndex: number; offset?: number; limit?: number; format?: "text" | "json" }[] };
export interface AnalysisDataSource {
  list(query: AnalysisQuery): Promise<JsonObject>;
  read(reference: AnalysisReference | AnalysisCaseLookup, options?: AnalysisReadOptions): Promise<JsonObject>;
  search(reference: AnalysisReference, query: string | string[], options?: { offset?: number; limit?: number; scope?: "evidence" | "all" }): Promise<JsonObject>;
  image(reference: AnalysisReference): Promise<ToolResult>;
}
export interface WebSearchQuery {
  query: string;
  domains?: string[];
  country?: string;
  language?: string;
  page?: number;
}
export interface WebSearchRequest {
  queries: WebSearchQuery[];
  domains?: string[];
  country?: string;
  language?: string;
  category?: "web" | "news";
  timeRange?: "day" | "week" | "month" | "year";
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
}
export interface WebDateAssessment {
  status: "not_requested" | "unknown" | "within_range" | "outside_range";
  basis: "search_metadata" | "page_metadata" | "none";
  date?: string;
}
export interface WebSearchItem {
  title: string;
  url: string;
  domain: string;
  snippet?: string;
  date?: string;
  source?: string;
  truncatedFields?: string[];
  rank: number;
  matches: { queryIndex: number; position: number; page: number }[];
  dateAssessment: WebDateAssessment;
}
export interface WebSearchAttempt extends WebSearchQuery {
  queryIndex: number;
  searchQuery: string;
  country: string;
  language: string;
  page: number;
  state: "succeeded" | "failed";
  resultCount: number;
  elapsedMs: number;
  credits?: number;
  error?: string;
}
export interface WebSearchResult {
  provider: "serper";
  category: "web" | "news";
  searchedAt: string;
  elapsedMs: number;
  timeRange?: "day" | "week" | "month" | "year";
  dateFrom?: string;
  dateTo?: string;
  attempts: WebSearchAttempt[];
  results: WebSearchItem[];
  excludedResults: WebSearchItem[];
  totalUnique: number;
  hasMore: boolean;
  credits?: number;
  creditsComplete: boolean;
}
export interface WebSearchProvider {
  search(request: WebSearchRequest, signal: AbortSignal): Promise<WebSearchResult>;
}
export interface WebReadRequest {
  url: string;
  find?: string;
  startLine?: number;
  lineCount?: number;
  page?: number;
  dateFrom?: string;
  dateTo?: string;
}
export interface WebReadResult {
  url: string;
  requestedUrl: string;
  title: string;
  format: "html" | "pdf" | "text";
  retrievedAt: string;
  elapsedMs: number;
  publicationDate?: string;
  modifiedDate?: string;
  links?: { text: string; url: string }[];
  dateAssessment: WebDateAssessment;
  lines: { number: number; text: string; page?: number }[];
  matches: { line: number; page?: number; preview?: string }[];
  totalLines: number;
  totalPages?: number;
  readPages?: number;
  nextStartLine?: number;
  truncated: boolean;
  limitations: string[];
}
export interface WebReader {
  read(request: WebReadRequest, signal: AbortSignal): Promise<WebReadResult>;
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
export interface AssistantSource { tool: string; content: ToolResult["content"] }
export interface AssistantTool {
  readOnly?: boolean;
  /** Validate raw arguments before an SDK can coerce values or drop nulls. */
  validate?(args: unknown): void;
  name: string;
  description: string;
  inputSchema: JsonObject;
  execute(args: unknown, context: { scope: AssistantScope; callId: string; signal: AbortSignal; audience?: "model" | "user"; progress(value: unknown): void;
    /** One request to the current model with selected observed sources, without earlier reasoning or tools. */
    complete?(request: { systemPrompt: string; draft: JsonObject; outputSchema: JsonObject; sourceTools?: string[];
      /** Cap this request's reasoning without increasing or changing the session's level. */
      maxThinking?: ModelConfig["thinking"];
      selectSources?(sources: AssistantSource[]): AssistantSource[];
    }): Promise<{ text: string; elapsedMs: number; usage: JsonObject }>;
  }): Promise<ToolResult>;
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
  predictionPrompt?: string;
  recoveryMessage?: string;
  failureSummaryMessage?: string;
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
  predict(scope: AssistantScope, sourceTurn: number, recentSuggestions: string[], signal: AbortSignal): Promise<{ text: string | null }>;
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
export interface AssistantModelEntry { id: string; name: string; provider: string; providerName: string; contextWindow?: number; maxTokens?: number; reasoning?: { defaultEffort?: string; efforts: {id: string; name: string}[] } }
export interface AssistantModelCatalog {
  models: AssistantModelEntry[];
  failures: { id: string; name: string; message: string }[];
}
export interface AssistantModelDirectory {
  list(userId: string, refresh?: boolean): Promise<AssistantModelCatalog & { favorites: string[]; default: AssistantModelSelection }>;
  favorites(userId: string, ids: string[]): Promise<void>;
  readFavorites(userId: string): Promise<string[] | undefined>;
  resolve(selection: AssistantModelSelection): Promise<ModelConfig>;
}
