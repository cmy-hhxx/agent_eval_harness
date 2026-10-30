import { type JsonObject } from "@eval/contracts";
import { cite, displayEvidence, evidenceSources, isComponentLocator, traceExchanges, traceCallOrigins } from "@eval/tools";
import type { RawInput } from "../inputs/types.js";

/** Model navigation needs identities and proof, while code retains full positions and invocation bookkeeping. */
export function actorCatalog(components: JsonObject[]) {
  return components.map(({ component_index, kind, name, source_evidence }) => ({ actor_index: component_index, kind, name, source_evidence }));
}

/** Source identities only. This directory never decides which component caused a failure. */
export function processComponents(raw: RawInput, original: RawInput, inputId: string,
  positions: { trace_index: number; message_index: number }[], extracted: JsonObject[] = []) {
  const entries: JsonObject[] = [];
  const add = (kind: string, name: string, message_indices: number[], source_evidence: JsonObject[], extra: JsonObject = {}) => {
    const existing = entries.find(entry => entry.kind === kind && entry.name === name);
    if (existing) {
      existing.message_indices = [...new Set([...existing.message_indices as number[], ...message_indices])];
      return;
    }
    entries.push({ ...extra, kind, name, message_indices: [...new Set(message_indices)], source_evidence });
  };
  const proof = (index: number, path: string) => evidenceSources(raw.messages[index]).filter(source =>
    source.kind === "text" && source.path === path && source.quotable !== false && source.text.length &&
    evidenceSources(original.messages[index]).some(other => other.kind === source.kind && other.path === source.path && other.text === source.text))
    .map(source => displayEvidence(cite(inputId, index, source, 0, Math.min(400, source.text.length))));
  const returned = new Map<number, number>();
  const owners = new Map<number, number>();
  const modelTurns = new Set(raw.messages.flatMap((message, index) => message.type === "llm_turn" ? [positions[index]!.trace_index] : []));
  for (const trace_index of new Set(positions.map(point => point.trace_index))) {
    const indices = positions.flatMap((point, index) => point.trace_index === trace_index ? [index] : []);
    for (const exchange of traceExchanges(indices.map(index => raw.messages[index]!))) {
      for (const index of exchange.return_indices) returned.set(indices[index]!, indices[exchange.request_index]!);
      if (exchange.planner_index !== null) owners.set(indices[exchange.request_index]!, indices[exchange.planner_index]!);
    }
    for (const origin of traceCallOrigins(indices.map(index => raw.messages[index]!)))
      owners.set(indices[origin.request_index]!, indices[origin.planner_index]!);
  }
  raw.messages.forEach((message, index) => {
    const tool = ["tool_call", "function_call", "tool_result", "function_call_output"].includes(String(message.type)) || message.role === "tool";
    const model = message.type === "llm_turn" || message.type === "final_answer" || message.role === "assistant";
    if (!tool && !model) return;
    if (model && message.type !== "llm_turn" && modelTurns.has(positions[index]!.trace_index)) return;
    const origin = returned.get(index) ?? index, source = raw.messages[origin]!;
    const nameKey = ["agent_name", "node_name", "service_name", "tool_name", "name"].find(key =>
      typeof source[key] === "string" && String(source[key]).trim() && !isComponentLocator(String(source[key])));
    const modelKey = typeof source.model === "string" && source.model.trim() ? "model" : undefined;
    const key = nameKey ?? modelKey ?? (typeof source.name === "string" && source.name.trim() ? "name" : undefined);
    const name = key ? String(source[key]) : `${tool ? "工具调用" : "模型调用"}（轮次${positions[index]!.trace_index}，消息${positions[index]!.message_index}）`;
    add(tool ? "tool" : "model", name, [origin, index], key ? proof(origin, `/${key}`) : proof(origin, "/type"),
      { ...(modelKey ? { model: source.model } : {}), identity_basis: "source_record",
        identity_status: key && !isComponentLocator(name) ? "named" : "located" });
  });
  for (const entry of extracted) {
    const evidence = entry.source_evidence as JsonObject[] ?? [];
    const indices = evidence.flatMap(item => typeof item.message_index === "number" ? [item.message_index] : []);
    add(String(entry.kind), String(entry.name), indices, evidence, { ...entry, identity_basis: "source_reference" });
  }
  return entries.map((entry, index) => ({ ...entry, component_index: index + 1, name: String(entry.name), kind: String(entry.kind),
    identity_basis: String(entry.identity_basis),
    source_evidence: entry.source_evidence as JsonObject[],
    invoked_by: [...new Set((entry.message_indices as number[]).flatMap(index => {
      const owner = owners.get(returned.get(index) ?? index);
      return owner === undefined ? [] : entries.flatMap((actor, index) => actor.kind === "model" &&
        (actor.message_indices as number[]).includes(owner) ? [index + 1] : []);
    }))],
    positions: (entry.message_indices as number[]).map(index => ({ source_message_index: index, ...positions[index] })) }));
}
