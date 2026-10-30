import { isToolSpan } from "../inputs/adapters.js";
import { traceExchanges } from "@eval/tools";
import type { RawInput } from "../inputs/types.js";

/** Link tool returns to their preceding invocation without guessing from nearby messages. */
export function traceCatalog(raw: RawInput, positions?: { trace_index: number; message_index: number }[]): {
  message_index: number; type: string; semantic_role: string; role?: string; name?: string;
  call_message_index?: number; invoking_model_message_index?: number; chars: number;
}[] {
  if (positions) return [...new Set(positions.map(point => point.trace_index))].flatMap(trace_index => {
    const indices = positions.flatMap((point, index) => point.trace_index === trace_index ? [index] : []);
    return traceCatalog({ messages: indices.map(index => raw.messages[index]!) }).map(row => ({ ...row,
      message_index: indices[row.message_index]!,
      ...(row.call_message_index === undefined ? {} : { call_message_index: indices[row.call_message_index] }),
      ...(row.invoking_model_message_index === undefined ? {} : { invoking_model_message_index: indices[row.invoking_model_message_index] }),
    }));
  });
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
      chars: JSON.stringify(message).length,
    };
  });
}
