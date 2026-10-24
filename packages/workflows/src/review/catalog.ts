import { isToolSpan } from "../inputs/adapters.js";
import { canonical } from "@eval/contracts";
import { traceExchanges } from "@eval/tools";
import type { RawInput } from "../inputs/types.js";

/** Link tool returns to their preceding invocation without guessing from nearby messages. */
export function traceCatalog(raw: RawInput) {
  const returns = new Map(traceExchanges(raw.messages).flatMap(exchange => exchange.return_indices.map(index =>
    [index, { index: exchange.request_index, name: raw.messages[exchange.request_index].name }] as const)));
  const modelSpans = new Map<string, number[]>();
  raw.messages.forEach((message, index) => {
    if (message.type === "llm_turn" && typeof message.parent_span === "string")
      modelSpans.set(message.parent_span, [...(modelSpans.get(message.parent_span) ?? []), index]);
  });
  return raw.messages.map((message, index) => {
    const isCall = ["function_call", "tool_call"].includes(message.type || "");
    const isReturn = ["function_call_output", "tool_result"].includes(message.type || "") || message.role === "tool" || isToolSpan(message);
    const linked = returns.get(index);
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
