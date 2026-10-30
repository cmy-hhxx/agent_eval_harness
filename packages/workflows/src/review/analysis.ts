import type { RunReference } from "@eval/contracts";
import { isToolSpan } from "../inputs/adapters.js";
import { contentText } from "../inputs/records.js";
import { traceCatalog } from "./catalog.js";
import type { RawInput } from "../inputs/types.js";
import { sessionSource } from "../inputs/session.js";

/** A navigation map, not a second copy of each model request's input history. */
export function analysisTraceMap(input: RawInput, reference: RunReference, finalIndex: number, audience: "model" | "user" = "model") {
  const { raw, positions } = sessionSource(input);
  const previewChars = audience === "user" ? 2000 : 160;
  const catalog = traceCatalog(raw, positions);
  // Some source spans omit call IDs but record the same completion time on both ends.
  // Require a unique pair across the entire trace; adjacency and timestamps alone are insufficient.
  const spans = new Map<string, { calls: number[]; results: number[] }>();
  const spanKey = (message: RawInput["messages"][number], index: number) =>
    message.name && typeof message.end === "string" && message.end
      ? JSON.stringify([positions[index]!.trace_index, message.name, message.end]) : undefined;
  const withoutId = (message: RawInput["messages"][number]) => !message.call_id && !message.tool_call_id && !message.id;
  for (const entry of catalog) {
    const key = spanKey(raw.messages[entry.message_index], entry.message_index);
    if (!key) continue;
    const span = spans.get(key) ?? { calls: [], results: [] };
    if (["function_call", "tool_call"].includes(entry.type)) span.calls.push(entry.message_index);
    else if (["function_call_output", "tool_result"].includes(entry.type) || entry.role === "tool") span.results.push(entry.message_index);
    spans.set(key, span);
  }
  const nodes = catalog.map((entry) => {
    const message = raw.messages[entry.message_index];
    const call = ["function_call", "tool_call"].includes(entry.type);
    const result = isToolSpan(message) || ["function_call_output", "tool_result"].includes(entry.type) || entry.role === "tool";
    const span = spans.get(spanKey(message, entry.message_index) ?? "");
    const callIndex = entry.call_message_index ?? (result && withoutId(message) && span?.calls.length === 1 && span.results.length === 1 &&
      span.calls[0] < entry.message_index && withoutId(raw.messages[span.calls[0]]) ? span.calls[0] : undefined);
    const body = audience === "user" ? contentText(message.content) : "";
    const summary = audience === "user" && entry.type === "reasoning" && !body.trim() ? contentText(message.summary) : "";
    const value = call ? message.arguments ?? message.input : result ? message.output ?? message.content
      : audience !== "user" ? undefined : entry.type === "llm_turn" ? message.output
      : summary || body;
    let text = value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);
    if (call && audience === "model" && value && typeof value === "object" && "description" in value && typeof value.description === "string" && value.description.trim())
      text = value.description + "\n" + text;
    const limit = entry.type === "reasoning" && audience === "user" ? text.length : previewChars;
    return {
      messageIndex: entry.message_index, position: positions[entry.message_index], type: entry.type, ...(entry.role ? { role: entry.role } : {}),
      ...(entry.name ? { name: entry.name } : {}), chars: entry.chars,
      ...(callIndex !== undefined ? { callMessageIndex: callIndex } : {}),
      ...(text ? { preview: text.slice(0, limit), previewTruncated: text.length > limit } : {}),
      ...(summary ? { previewKind: "summary" as const } : {}),
      reference: { ...reference, messageIndex: entry.message_index },
    };
  });
  return { messageCount: nodes.length, finalMessageIndex: finalIndex,
    toolCalls: nodes.filter(node => ["function_call", "tool_call"].includes(node.type)).length, nodes };
}
