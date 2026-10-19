import { isToolSpan } from "./adapters.js";
import { canonical } from "@eval/contracts";
import type { RawInput } from "./types.js";

/** Link tool returns to their preceding invocation without guessing from nearby messages. */
export function traceCatalog(raw: RawInput) {
  const calls = new Map<string, { name: string; index: number }>();
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
    return {
      message_index: index,
      type: message.type || "message",
      ...(message.role == null ? {} : { role: message.role }),
      name: message.name || linked?.name,
      ...(linked ? { call_message_index: linked.index } : {}),
      chars: canonical(message).length,
    };
  });
}
