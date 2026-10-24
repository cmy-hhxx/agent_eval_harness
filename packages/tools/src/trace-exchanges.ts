type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
export interface TraceExchange {
  request_index: number;
  return_indices: number[];
  planner_index: number | null;
  link_basis: "call_id" | "returned_query";
}

/** Correlate actual invocations; adjacency and a shared tool name alone are not links. */
export function traceExchanges(messages: unknown[]): TraceExchange[] {
  const calls = messages.flatMap((value, index) => {
    const m = row(value);
    return ["tool_call", "function_call"].includes(String(m.type)) ? [{ index, m }] : [];
  });
  const found = new Map<number, TraceExchange>();
  messages.forEach((value, index) => {
    const m = row(value);
    if (!["tool_result", "function_call_output"].includes(String(m.type)) && m.role !== "tool" &&
      !(m.type === "span" && String(m.name).startsWith("tool-"))) return;
    const id = m.call_id ?? m.tool_call_id, returned = row(m.output ?? m.result);
    const matches = calls.filter(call => call.index < index && (!m.name || call.m.name === m.name) &&
      (typeof id === "string" ? [call.m.call_id, call.m.id].includes(id)
        : typeof returned.query === "string" && row(call.m.input ?? call.m.arguments).query === returned.query));
    if (matches.length !== 1) return;
    const call = matches[0], parents = typeof call.m.parent_span === "string" ? messages.flatMap((v, i) => {
      const p = row(v); return i < call.index && p.type === "llm_turn" && p.parent_span === call.m.parent_span ? [i] : [];
    }) : [];
    const exchange = found.get(call.index) ?? { request_index: call.index, return_indices: [],
      planner_index: parents.length === 1 ? parents[0] : null, link_basis: typeof id === "string" ? "call_id" : "returned_query" };
    exchange.return_indices.push(index); found.set(call.index, exchange);
  });
  return [...found.values()].sort((a, b) => a.request_index - b.request_index);
}
