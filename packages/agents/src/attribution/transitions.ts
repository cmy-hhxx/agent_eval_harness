import { canonical } from "@eval/contracts";
import { answerTurnContexts, cite, evidenceCovers, evidenceId, evidenceSources, images, messageContentSources, overlapsImagePlaceholder,
  selectEvidenceSource, traceCallOrigins, traceExchanges, type EvidenceSelectionCache, type TraceComponentIdentity } from "@eval/tools";
import type { BusinessChain, Evidence, TransitionKind } from "./types.js";

export type { TransitionKind } from "./types.js";
/** Boundaries locate original material; they never duplicate source text or image observations. */
export type TransitionBoundary = { evidence_id: string; message_index: number };
export interface AttributionExecutionNode {
  execution_node_index: number;
  kind: "model" | "tool";
  actor_index: number | null;
  message_index: number;
}
export interface AttributionTransition {
  transition_index: number;
  kind: TransitionKind;
  actor_index: number | null;
  chain_index: number | null;
  chain_indices: number[];
  execution_node_index: number | null;
  source_node_index: number | null;
  target_node_index: number | null;
  input_path: string | null;
  before: TransitionBoundary[];
  after: TransitionBoundary[];
  predecessors: number[];
  relation: "captured" | "unresolved";
}

type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const unique = <T extends TransitionBoundary>(items: T[]) => [...new Map(items.map(item => [item.evidence_id, item])).values()];
const assistantKey = (value: Row) => canonical({ content: value.content ?? null, tool_calls: value.tool_calls ?? [] });

/** Count only captured invocations; returns and copies in model history are not executions. */
export function buildAttributionExecutionNodes(raw: { messages: unknown[] }, actors: TraceComponentIdentity[]): AttributionExecutionNode[] {
  const pairedReturns = new Set(traceExchanges(raw.messages).flatMap(exchange => exchange.return_indices));
  const nodes: AttributionExecutionNode[] = [];
  raw.messages.forEach((value, message_index) => {
    const message = row(value);
    const kind = message.type === "llm_turn" ? "model"
      : ["tool_call", "function_call"].includes(String(message.type)) || message.type === "span" &&
        String(message.name).startsWith("tool-") && Object.hasOwn(message, "output") && !pairedReturns.has(message_index) ? "tool" : null;
    if (!kind) return;
    const owner = actors.findIndex(actor => actor.kind === kind && actor.message_indices.includes(message_index));
    nodes.push({ execution_node_index: nodes.length + 1, kind, actor_index: owner < 0 ? null : owner + 1, message_index });
  });
  return nodes;
}

/** Index evidence boundaries; repeated history is a transfer, not another execution. */
export function buildAttributionTransitions({ raw, inputId, finalIndex, actors, chains }: {
  raw: { messages: unknown[] }; inputId: string; finalIndex: number;
  actors: TraceComponentIdentity[]; chains: BusinessChain[];
}): AttributionTransition[] {
  const nodes = new Map(buildAttributionExecutionNodes(raw, actors).map(node => [node.message_index, node.execution_node_index]));
  const node = (index: number) => nodes.get(index) ?? null;
  const execution = (index: number) => ({ execution_node_index: node(index), source_node_index: node(index), target_node_index: node(index), input_path: null });
  const sourceCache = new Map<number, ReturnType<typeof evidenceSources>>();
  const selectionCache: EvidenceSelectionCache = new WeakMap();
  const sources = (index: number) => {
    if (!sourceCache.has(index)) sourceCache.set(index, evidenceSources(raw.messages[index]));
    return sourceCache.get(index)!;
  };
  const at = (index: number, path: string): Evidence[] => {
    const selected = selectEvidenceSource(sources(index), path, selectionCache);
    if (!selected) return [];
    if (selected.source.quotable === false || overlapsImagePlaceholder(selected.source.text, selected.start, selected.end))
      return sources(index).filter(source => source.kind === "text" && source.quotable !== false && source.path.startsWith(path + "/") &&
        source.text.trim() && !overlapsImagePlaceholder(source.text, 0, source.text.length))
        .map(source => cite(inputId, index, source, 0, source.text.length));
    return selected.end > selected.start ? [cite(inputId, index, selected.source, selected.start, selected.end)] : [];
  };
  const owner = (index: number, kind: "model" | "tool") => {
    const found = actors.findIndex(actor => actor.kind === kind && actor.message_indices.includes(index));
    return found < 0 ? null : found + 1;
  };
  const models = raw.messages.slice(0, finalIndex).flatMap((value, index) => {
    const message = row(value);
    if (message.type !== "llm_turn") return [];
    const input = message.input_messages, nested = row(input);
    const messages = Array.isArray(input) ? input : Array.isArray(nested.messages) ? nested.messages : [];
    const root = Array.isArray(input) ? "/input_messages" : "/input_messages/messages";
    const entries = messages.flatMap((value, i) => {
      const item = row(value);
      if (!["user", "assistant", "tool"].includes(String(item.role))) return [];
      const path = `${root}/${i}`;
      return [{ value: item, path, evidence: [...at(index, path + "/content"), ...at(index, path + "/tool_calls")] }];
    });
    const output = Array.isArray(message.output) ? message.output.map(row) : [];
    const prose = sources(index).filter(source => source.kind === "text" &&
      /^\/output\/\d+\/(?:content|reasoning(?:_content)?|analysis|thinking|calculation(?:s|_steps)?)(?:\/|$)/u.test(source.path) &&
      source.text.trim() && source.quotable !== false && !overlapsImagePlaceholder(source.text, 0, source.text.length))
      .map(source => cite(inputId, index, source, 0, source.text.length));
    return [{ index, entries, output, prose, input: unique(entries.flatMap(entry => entry.evidence)) }];
  });
  type Pending = Omit<AttributionTransition, "transition_index" | "predecessors"> & {
    key: string; target: number; order: number; previous: string[];
  };
  const pending: Pending[] = [];
  const coordinates = (items: TransitionBoundary[]) => unique(items).map(({ evidence_id, message_index }) => ({ evidence_id, message_index }));
  const add = (event: Pending) => pending.push({ ...event, before: coordinates(event.before), after: coordinates(event.after) });
  const origins = traceCallOrigins(raw.messages);
  for (const origin of origins) {
    const model = models.find(model => model.index === origin.planner_index);
    const chain = chains.find(chain => chain.request_index === origin.request_index);
    add({ key: `request:${origin.request_index}`, target: origin.planner_index, order: 1, kind: "request_formation",
      ...execution(origin.planner_index), chain_indices: chain ? [chain.chain_index] : [],
      actor_index: owner(origin.planner_index, "model"), chain_index: chain?.chain_index ?? null,
      before: model?.input ?? [], after: at(origin.planner_index, origin.arguments_path), previous: [], relation: "captured" });
  }
  for (const chain of chains) {
    add({ key: `execution:${chain.chain_index}`, target: Math.max(...chain.return_indices), order: 1, kind: "execution",
      ...execution(chain.request_index), chain_indices: [chain.chain_index],
      actor_index: owner(chain.request_index, "tool"), chain_index: chain.chain_index,
      before: [...at(chain.request_index, "/input"), ...at(chain.request_index, "/arguments")],
      after: chain.checkpoints[3].evidence,
      previous: origins.some(origin => origin.request_index === chain.request_index) ? [`request:${chain.request_index}`] : [], relation: "captured" });
  }
  for (const model of models) {
    if (!model.prose.length) continue;
    const related = chains.filter(chain => chain.context_indices.includes(model.index));
    add({ key: `generation:${model.index}`, target: model.index, order: 1, kind: "generation",
      ...execution(model.index), chain_indices: related.map(chain => chain.chain_index),
      actor_index: owner(model.index, "model"), chain_index: related.length === 1 ? related[0].chain_index : null,
      before: model.input, after: model.prose, previous: [], relation: "captured" });
  }
  const outputEvents = [...pending];
  const coverageCache = new Map<string, Map<string, boolean>>();
  const covers = (container: TransitionBoundary, item: TransitionBoundary) => {
    if (container.message_index !== item.message_index) return false;
    let covered = coverageCache.get(container.evidence_id);
    if (!covered) { covered = new Map(); coverageCache.set(container.evidence_id, covered); }
    if (!covered.has(item.evidence_id)) covered.set(item.evidence_id,
      evidenceCovers(raw, inputId, container.evidence_id, item.evidence_id, sources(container.message_index), selectionCache));
    return covered.get(item.evidence_id)!;
  };
  const transfers = new Map<string, Pending>();
  for (const chain of chains) {
    for (const evidence of chain.checkpoints[5].evidence) {
      const model = models.find(model => model.index === evidence.message_index);
      if (!model) continue;
      const entry = model.entries.find(entry => entry.evidence.some(whole => covers(whole, evidence)));
      let before = chain.checkpoints[3].evidence, previous = [`execution:${chain.chain_index}`], source = `return:${chain.request_index}`;
      let sourceNode = node(chain.request_index);
      if (entry?.value.role === "assistant") {
        const matches = models.filter(other => other.index < model.index).flatMap(other => other.output.flatMap((output, i) =>
          assistantKey(output) === assistantKey(entry.value) ? [{ model: other, output: i }] : []));
        if (matches.length !== 1) continue;
        const match = matches[0];
        before = [...at(match.model.index, `/output/${match.output}/content`), ...at(match.model.index, `/output/${match.output}/tool_calls`)];
        previous = outputEvents.filter(event => event.target === match.model.index && event.after.some(after => before.some(item =>
          covers(item, after) || covers(after, item)))).map(event => event.key);
        source = `model:${match.model.index}:${match.output}`;
        sourceNode = node(match.model.index);
      }
      const key = `transfer:${model.index}:${source}:${entry?.path ?? evidence.evidence_id}`;
      const existing = transfers.get(key);
      if (existing) {
        existing.before = unique([...existing.before, ...before]);
        existing.after.push(evidence);
        existing.previous = [...new Set([...existing.previous, ...previous])];
        existing.chain_indices = [...new Set([...existing.chain_indices, chain.chain_index])];
        if (existing.chain_index !== chain.chain_index) existing.chain_index = null;
      }
      else transfers.set(key, { key, target: model.index, order: 0, kind: "transfer", actor_index: null,
        execution_node_index: null, source_node_index: sourceNode, target_node_index: node(model.index),
        input_path: entry?.path ?? null, chain_indices: [chain.chain_index],
        chain_index: chain.chain_index, before, after: [evidence], previous, relation: "unresolved" });
    }
  }
  for (const event of transfers.values()) add(event);
  for (const event of pending) {
    if (event.kind !== "request_formation" && event.kind !== "generation") continue;
    event.previous = pending.filter(other => other.kind === "transfer" && other.target === event.target).map(other => other.key);
  }
  const generationIndex = answerTurnContexts(raw, finalIndex).at(-1)?.message_index;
  const generation = pending.find(event => event.key === `generation:${generationIndex}`);
  const delivered: TransitionBoundary[] = messageContentSources(raw.messages[finalIndex]).filter(source =>
    !overlapsImagePlaceholder(source.text, 0, source.text.length)).map(source => cite(inputId, finalIndex, source, 0, source.text.length));
  if (images(raw.messages[finalIndex]).length) delivered.push({ evidence_id: evidenceId(inputId, finalIndex, "image"), message_index: finalIndex });
  add({ key: "delivery", target: finalIndex, order: 2, kind: "delivery", actor_index: null, chain_index: null,
    execution_node_index: null, source_node_index: generationIndex === undefined ? null : node(generationIndex), target_node_index: null,
    input_path: null, chain_indices: [],
    before: generation?.after ?? [], after: delivered, previous: generation ? [generation.key] : [], relation: "unresolved" });
  pending.sort((a, b) => a.target - b.target || a.order - b.order || a.key.localeCompare(b.key));
  const indices = new Map(pending.map((event, index) => [event.key, index + 1]));
  return pending.map(({ key: _key, target: _target, order: _order, previous, ...event }, index) => ({
    ...event, transition_index: index + 1,
    predecessors: [...new Set(previous.map(key => indices.get(key)).filter((value): value is number => value !== undefined))].sort((a, b) => a - b),
  }));
}
