import type { EvaluationSpec, ModelConfig, ToolContent } from "@eval/contracts";
import { object } from "@eval/contracts";

export function inlineToolSchema(schema: Record<string, unknown> | boolean): Record<string, unknown> | boolean {
  const single = new Set(["items", "additionalItems", "additionalProperties", "unevaluatedItems", "unevaluatedProperties", "contains", "propertyNames", "not", "if", "then", "else", "contentSchema"]);
  const maps = new Set(["properties", "patternProperties", "dependentSchemas", "dependencies"]);
  const arrays = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
  const expand = (value: unknown, ancestors: Set<unknown>): Record<string, unknown> | boolean => {
    if (typeof value === "boolean") return value;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Tool schema must be an object or boolean");
    if (ancestors.has(value)) throw new Error("Circular tool schema reference");
    const active = new Set(ancestors).add(value), source = value as Record<string, unknown>;
    if (Object.hasOwn(source, "$dynamicRef") || Object.hasOwn(source, "$recursiveRef"))
      throw new Error("Dynamic or recursive tool schema references are unsupported");
    if (ancestors.size > 0 && Object.hasOwn(source, "$id"))
      throw new Error("Nested tool schema $id changes reference scope and is unsupported");
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(source)) {
      if (["$ref", "$defs", "definitions"].includes(key)) continue;
      if (maps.has(key)) {
        if (!child || typeof child !== "object" || Array.isArray(child)) throw new Error(`Invalid tool schema ${key}`);
        result[key] = Object.fromEntries(Object.entries(child).map(([name, nested]) => [name,
          key === "dependencies" && Array.isArray(nested) ? structuredClone(nested) : expand(nested, active)]));
      } else if (arrays.has(key) || (key === "items" && Array.isArray(child))) {
        if (!Array.isArray(child)) throw new Error(`Invalid tool schema ${key}`);
        result[key] = child.map((nested) => expand(nested, active));
      } else result[key] = single.has(key) ? expand(child, active) : structuredClone(child);
    }
    if (!Object.hasOwn(source, "$ref")) return result;
    const ref = source.$ref;
    if (typeof ref !== "string" || !ref.startsWith("#")) throw new Error(`External tool schema reference is unsupported: ${String(ref)}`);
    let pointer: string;
    try { pointer = decodeURIComponent(ref.slice(1)); }
    catch { throw new Error(`Invalid tool schema JSON pointer: ${ref}`); }
    if ((pointer !== "" && !pointer.startsWith("/")) || /~(?:[^01]|$)/.test(pointer))
      throw new Error(`Invalid tool schema JSON pointer: ${ref}`);
    let target: unknown = schema;
    for (const token of pointer === "" ? [] : pointer.slice(1).split("/")) {
      const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
      if (!target || typeof target !== "object" || !Object.hasOwn(target, key))
        throw new Error(`Unresolved tool schema reference: ${ref}`);
      target = (target as Record<string, unknown>)[key];
    }
    const resolved = expand(target, active);
    return Object.keys(result).length
      ? { ...result, allOf: [resolved, ...((result.allOf as unknown[] | undefined) ?? [])] }
      : resolved;
  };
  return expand(schema, new Set());
}

export function modelEventForLog(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const event = object(value);
  // SDK stream updates repeat the entire growing message; keep only the delta.
  if (event.type === "message_update") {
    const { message: _message, assistantMessageEvent, ...rest } = event;
    if (
      !assistantMessageEvent ||
      typeof assistantMessageEvent !== "object" ||
      Array.isArray(assistantMessageEvent)
    )
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
        // Declare xhigh so SDKs pass it through instead of clamping to high.
        thinkingLevelMap: { xhigh: "xhigh" },
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
export function transformPayload(
  value: unknown,
  config: ModelConfig,
  evaluation?: Pick<EvaluationSpec, "toolNames">,
): unknown {
  const payload = object(value);
  if (config.api === "openai-completions") {
    delete payload.max_tokens;
    payload.max_completion_tokens = config.maxOutputTokens;
  } else payload.max_output_tokens = config.maxOutputTokens;
  payload.parallel_tool_calls = false;
  if (evaluation && config.api === "openai-responses" && /^gpt-(?:5\.6|6)(?:[.-]|$)/.test(config.model)) {
    // Cache accounting belongs to the evaluation workload, not an ephemeral SDK session.
    payload.prompt_cache_key = "evaluation";
    const initialRequest = Array.isArray(payload.input) && payload.input.every((item) =>
      ["system", "developer", "user"].includes(String(object(item).role)),
    );
    // Submission-only tasks rarely reuse their first request. Repairs still benefit from history caching.
    payload.prompt_cache_options = {
      mode: evaluation.toolNames.length === 0 && initialRequest ? "explicit" : "implicit",
    };
    // These models use prompt_cache_options; the SDK's legacy retention parameter does not apply.
    delete payload.prompt_cache_retention;
  }
  return payload;
}
export function sdkContent(content: ToolContent[]) {
  return content.map((c) =>
    c.type === "text"
      ? { type: "text" as const, text: c.text || "" }
      : {
          type: "image" as const,
          data: c.data || "",
          mimeType: c.mimeType || "image/png",
        },
  );
}
