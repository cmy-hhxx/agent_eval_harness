import type { ModelConfig, ToolContent } from "../../contracts/src/index.js";
import { object } from "../../contracts/src/io.js";

export function modelEventForLog(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const event = object(value);
  // SDK stream updates repeat the entire growing message; keep only the delta.
  if (event.type === "message_update") {
    const { message: _message, assistantMessageEvent, ...rest } = event;
    if (!assistantMessageEvent || typeof assistantMessageEvent !== "object" || Array.isArray(assistantMessageEvent))
      return rest;
    const { partial: _partial, ...update } = object(assistantMessageEvent);
    return { ...rest, assistantMessageEvent: update };
  }
  if (["message_start", "turn_end", "agent_end"].includes(String(event.type))) {
    const { message: _message, messages: _messages, toolResults: _results, ...rest } = event;
    return rest;
  }
  return value;
}

export function providerConfig(config: ModelConfig) {
  return {
    baseUrl: config.baseUrl,
    api: config.api,
    authHeader: true,
    models: [
      {
        id: config.model,
        name: config.model,
        reasoning: config.thinking !== "off",
        input: ["text", "image"] as ("text" | "image")[],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: config.contextWindow,
        maxTokens: config.maxOutputTokens,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: true,
          supportsReasoningEffort: true,
          maxTokensField: "max_completion_tokens" as const,
        },
      },
    ],
  };
}
export function transformPayload(value: unknown, config: ModelConfig): unknown {
  const payload = object(value);
  if (config.api === "openai-completions") {
    delete payload.max_tokens;
    payload.max_completion_tokens = config.maxOutputTokens;
  } else payload.max_output_tokens = config.maxOutputTokens;
  payload.parallel_tool_calls = false;
  return payload;
}
export function sdkContent(content: ToolContent[]) {
  return content.map((c) =>
    c.type === "text"
      ? { type: "text" as const, text: c.text || "" }
      : { type: "image" as const, data: c.data || "", mimeType: c.mimeType || "image/png" },
  );
}
