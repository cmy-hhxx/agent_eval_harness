import { isToolSpan } from "./adapters.js";
import { canonical } from "@eval/contracts";
import type { RawInput } from "./types.js";

/** Link tool returns to their preceding invocation without guessing from nearby messages. */
export function traceCatalog(raw: RawInput) {
  const calls = new Map<string, { name: string; index: number }>();
  const modelSpans = new Map<string, number[]>();
  raw.messages.forEach((message, index) => {
    if (message.type === "llm_turn" && typeof message.parent_span === "string")
      modelSpans.set(message.parent_span, [...(modelSpans.get(message.parent_span) ?? []), index]);
  });
  return raw.messages.map((message, index) => {
    const isCall = ["function_call", "tool_call"].includes(message.type || "");
    const isReturn = ["function_call_output", "tool_result"].includes(message.type || "") || message.role === "tool" || isToolSpan(message);
    if (isCall && message.name)
      for (const id of [message.call_id, message.id])
        if (typeof id === "string" && id) calls.set(id, { name: message.name, index });
    const callId = message.call_id ?? message.tool_call_id;
    const call = isReturn && typeof callId === "string" ? calls.get(callId) : undefined;
    // An explicit conflicting name must not acquire another tool's invocation link.
    const linked = call && (!message.name || message.name === call.name) ? call : undefined;
    const invoking = isCall && typeof message.parent_span === "string" ? modelSpans.get(message.parent_span) : undefined;
    return {
      message_index: index,
      type: message.type || "message",
      semantic_role: message.type === "llm_turn" ? "model_call" : isCall ? "tool_call" : isReturn ? "tool_return"
        : message.type === "final_answer" ? "final_delivery" : "conversation",
      ...(message.role == null ? {} : { role: message.role }),
      name: message.name || linked?.name,
      ...(linked ? { call_message_index: linked.index } : {}),
      ...(invoking?.length === 1 && invoking[0] < index ? { invoking_model_message_index: invoking[0] } : {}),
      chars: canonical(message).length,
    };
  });
}
