export type JsonSchema = Record<string, unknown>;

export type JsonObject = Record<string, unknown>;

export interface ModelConfig {
  provider: string;
  baseUrl: string;
  api: "openai-completions" | "openai-responses";
  apiKeyEnv: string;
  model: string;
  thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** Explicit endpoint capability; false preserves system instructions as system messages. */
  supportsDeveloperRole?: boolean;
  /** Opt in only on endpoints supporting prompt_cache_breakpoint and prompt_cache_options. */
  supportsExplicitPromptCaching?: boolean;
  contextWindow: number;
  maxOutputTokens: number;
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

/** Characters actually returned from one trace source; ranges are half-open UTF-16 offsets. */
export interface TraceRead {
  candidate: string;
  message_index: number;
  kind: "text" | "json";
  path: string;
  start: number;
  end: number;
}

/** A copied self-contained registered source coordinate. */
export interface EvidenceReference {
  evidence_id: string;
  observation?: unknown;
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
  /** Present for schema_maxLength so a rejected submission can see how far it overran. */
  actualLength?: number;
  excess?: number;
  message: string;
  category: FailureCategory;
}
