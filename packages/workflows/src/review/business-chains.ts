import { attributionTaxonomy } from "@eval/prompts";
import { canonical } from "@eval/contracts";
import { answerTurnContexts, cite, evidenceSources, messageContentSources, overlapsImagePlaceholder, selectEvidenceSource, traceCallOrigins, traceComponentIdentities, traceExchanges, type EvidenceSelectionCache } from "@eval/tools";
import type { BusinessChain, Evidence } from "@eval/agents/attribution";
import { processSourceInventory } from "./citations.js";
import { getAnswerGeneration } from "./answer-generation.js";
import type { RawInput } from "../inputs/types.js";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const decoded = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
};

/** Link captured boundaries, not imagined intermediate processing or a causal verdict. */
export function businessChains(raw: RawInput, inputId: string, finalIndex: number): BusinessChain[] {
  const inventory = processSourceInventory(raw, inputId, finalIndex), contexts = answerTurnContexts(raw, finalIndex);
  const actors = traceComponentIdentities(raw, inputId, finalIndex);
  const generation = getAnswerGeneration(raw, inputId, finalIndex);
  const selectionCache: EvidenceSelectionCache = new WeakMap();
  const sourcesByIndex = new Map<number, ReturnType<typeof evidenceSources>>();
  const sourcesAt = (index: number) => {
    if (!sourcesByIndex.has(index)) sourcesByIndex.set(index, evidenceSources(raw.messages[index]));
    return sourcesByIndex.get(index)!;
  };
  const at = (index: number, path: string): Evidence[] => {
    const sources = sourcesAt(index);
    let range = selectEvidenceSource(sources, path, selectionCache);
    if (range && range.start === range.end) range = selectEvidenceSource(sources.filter(source => source.kind === "json"), path, selectionCache);
    if (!range) return [];
    if (range.source.quotable === false || overlapsImagePlaceholder(range.source.text, range.start, range.end)) {
      // A multimodal container is navigation, not text evidence for the image inside it.
      return sources.flatMap(source => {
        if (source.quotable === false || source.kind !== "text" || !source.path.startsWith(path + "/") || !source.text.length) return [];
        const end = source.text.length;
        if (overlapsImagePlaceholder(source.text, 0, end)) return [];
        return [cite(inputId, index, source, 0, end)];
      });
    }
    // These coordinates define a boundary, not a preview window. Navigation pages
    // the body separately; later rows remain part of the same captured return.
    return [cite(inputId, index, range.source, range.start, range.end)];
  };
  const outputs = (index: number): Evidence[] => sourcesAt(index)
    .filter(source => source.kind === "text" && /^\/output\/\d+\/content(?:\/|$)/u.test(source.path))
    .flatMap(source => at(index, source.path));
  const goalIndex = raw.messages.findIndex(message => message.type === "user_question" || message.role === "user");
  const goals = goalIndex < 0 ? [] : messageContentSources(raw.messages[goalIndex]).flatMap(source => at(goalIndex, source.path));
  const exchanges = traceExchanges(raw.messages);
  const origins = traceCallOrigins(raw.messages);
  const inputs = contexts.map(context => {
    const input = raw.messages[context.message_index].input_messages;
    const messages = Array.isArray(input) ? input : object(input).messages;
    return { ...context, entries: (Array.isArray(messages) ? messages : []).map((value, index) => ({
      value: object(value), path: `${context.path}/${index}`,
    })) };
  });
  const returnBodies = exchanges.map(exchange => exchange.return_indices.flatMap(index => {
    const message = object(raw.messages[index]), value = message.output ?? message.result ?? message.content;
    return [value, ...sourcesAt(index).filter(source => source.kind === "text" &&
      /^\/(?:output|result|content)(?:\/|$)/u.test(source.path) && source.text.trim()).map(source => source.text)]
      .filter(value => value !== undefined).map(value => canonical(decoded(value)));
  }));
  const assistantKey = (value: Record<string, unknown>) => canonical({ content: value.content ?? null, tool_calls: value.tool_calls ?? [] });
  const returnOwners = new Map<string, number[]>(), outputOwners = new Map<string, number[]>();
  returnBodies.forEach((bodies, index) => {
    for (const body of new Set(bodies)) returnOwners.set(body, [...returnOwners.get(body) ?? [], index]);
  });
  for (const context of contexts) {
    const output = raw.messages[context.message_index].output;
    for (const value of Array.isArray(output) ? output : []) {
      const key = assistantKey(object(value));
      outputOwners.set(key, [...new Set([...outputOwners.get(key) ?? [], context.message_index])]);
    }
  }
  return exchanges.map((exchange, index) => {
    const call = object(raw.messages[exchange.request_index]), query = object(call.input ?? call.arguments).query;
    const uniqueQuery = typeof query === "string" && exchanges.filter(other => {
      const request = object(raw.messages[other.request_index]);
      return object(request.input ?? request.arguments).query === query;
    }).length === 1;
    const references = inventory.references.filter(reference => reference.sources.some(source =>
      source.origin === "tool_return" && exchange.return_indices.includes(source.message_index) ||
      uniqueQuery && source.request_query === query));
    const visible = references.flatMap(reference => reference.sources.filter(source => source.origin === "model_visible" &&
      (source.request_query === query || reference.sources.some(origin => origin.origin === "tool_return" && exchange.return_indices.includes(origin.message_index)))));
    const actual = visible.filter(source => exchange.return_indices.some(index => index < source.message_index));
    const actionIds = new Set(exchange.return_indices.flatMap(i => {
      const output = object(object(raw.messages[i]).output ?? object(raw.messages[i]).result);
      return typeof output.action_id === "string" ? [output.action_id] : [];
    }));
    const callIds = [call.call_id, call.id].filter(value => typeof value === "string");
    const linkedContexts = new Set(actual.map(source => source.message_index));
    const actualInput: Evidence[] = [...actual];
    for (const context of inputs) {
      if (!exchange.return_indices.some(index => index < context.message_index)) continue;
      for (const { value, path } of context.entries) {
        if (value.role === "tool") {
          const body = decoded(value.content), key = canonical(body);
          const exact = returnOwners.get(key) ?? [];
          if (!(typeof value.tool_call_id === "string" && callIds.includes(value.tool_call_id)) && !actionIds.has(object(body).action_id as string) &&
            !(exact.length === 1 && exact[0] === index)) continue;
        } else if (value.role === "assistant") {
          // Propagate only the complete output of an already linked turn. A shared
          // phrase, nearby turn or unrelated sibling tool call is not a lineage edge.
          const key = assistantKey(value);
          const matches = (outputOwners.get(key) ?? []).filter(index => index < context.message_index);
          if (matches.length !== 1 || !linkedContexts.has(matches[0])) continue;
        } else continue;
        const evidence = at(context.message_index, `${path}/content`);
        if (value.role === "assistant") evidence.push(...at(context.message_index, `${path}/tool_calls`));
        if (!evidence.length) continue;
        actualInput.push(...evidence); linkedContexts.add(context.message_index);
      }
    }
    const intermediates = [...linkedContexts].filter(index => index !== generation?.message_index).flatMap(outputs);
    const generated = generation && linkedContexts.has(generation.message_index) ? outputs(generation.message_index) : [];
    const returns = exchange.return_indices.flatMap(i => {
      const output = object(object(raw.messages[i]).output ?? object(raw.messages[i]).result);
      const prefix = Object.hasOwn(object(raw.messages[i]), "output") ? "/output" : "/result";
      const execution = ["status_code", "status_msg", "row_count", "model_sql", "data_sql"]
        .filter(field => Object.hasOwn(output, field)).flatMap(field => at(i, `${prefix}/${field}`));
      // Financial row identity, field units and values stay at their own original coordinates.
      if (Array.isArray(output.columns) && Array.isArray(output.datas)) {
        const fields = output.columns.slice(0, 3).flatMap(column => typeof object(column).key === "string" ? [String(object(column).key)] : []);
        return [...execution, ...output.columns.slice(0, 3).flatMap((_, c) => at(i, `${prefix}/columns/${c}`)),
          ...(fields.length ? fields.flatMap(field => at(i, `${prefix}/datas/0/${field.replaceAll("~", "~0").replaceAll("/", "~1")}`))
            : at(i, `${prefix}/datas/0`)), ...at(i, `${prefix}/query`), ...at(i, prefix)];
      }
      return [...execution, ...["/output", "/result", "/content"].flatMap(path => at(i, path))];
    });
    const origin = origins.find(origin => origin.request_index === exchange.request_index);
    const plannerIndex = origin?.planner_index ?? exchange.planner_index;
    const planner = plannerIndex === null ? [] : outputs(plannerIndex);
    if (origin) planner.push(...at(origin.planner_index, origin.arguments_path));
    const request = ["/input", "/arguments"].flatMap(path => at(exchange.request_index, path));
    const finals = references.flatMap(reference => reference.occurrences.map(occurrence => occurrence.context));
    const stepEvidence = [goals, planner, request, returns, [...returns, ...intermediates, ...actualInput], actualInput,
      [...actualInput, ...generated], [...generated, ...finals]];
    return { chain_index: index + 1, tool_component: actors.find(actor => actor.kind === "tool" && actor.message_indices.includes(exchange.request_index))!.component, ...exchange,
      planner_index: plannerIndex, context_indices: [...linkedContexts].sort((a, b) => a - b),
      references: references.map(reference => reference.reference),
      delivery_changed: generation?.matches_captured_final === null || !generation ? null : !generation.matches_captured_final,
      checkpoints: attributionTaxonomy.investigation_steps.map((step, i) => ({ step,
        availability: stepEvidence[i].length ? "available" as const : "not_collected" as const,
        evidence: [...new Map(stepEvidence[i].map(item => [item.evidence_id, { evidence_id: item.evidence_id, message_index: item.message_index, quote: item.quote }])).values()],
        note: i === 1 ? "分别核对谁选择了标的及选择依据；若计划没有解释代理标的理由，在观察中明确说明未记录，不编造上游责任。"
          : i === 3 ? "分别核对数据载荷、执行状态和实际 SQL；零行不等于正常执行，失败状态也不自动证明请求正确或工具实现有错。"
          : i === 4 ? "对照相关原始返回与最后实际输入，分别检查关键事实和错误状态的保留或丢失。边界变化不证明中间处理者已采集；未捕获整理输出时明确处理节点未知，不能把接收输入的终稿调用当成整理者。只记录本问题有关变化，不把局部一致写成整个返回原样传入。"
          : i === 5 && !actualInput.length ? "尚未建立本链与已采集生成输入的关联；完整输入仍见 answer_generation，不能据此声称输入未采集或未包含相关材料。"
          : i === 6 ? "同时核对实际输入和生成；只有边界差异不能确证内部乘法、换算或转换步骤。"
          : i === 7 ? "核对生成与交付；未记录独立核验不等于已执行核验，也不自动构成关联责任。" : "材料存在须读取后判断；目录关联不证明因果。",
      })), final_evidence: finals.map(({ evidence_id, message_index, quote }) => ({ evidence_id, message_index, quote })) };
  });
}
