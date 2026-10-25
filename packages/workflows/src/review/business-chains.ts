import { attributionTaxonomy } from "@eval/prompts";
import { answerTurnContexts, cite, evidenceSources, messageContentSources, overlapsImagePlaceholder, parseEvidenceCoordinates, selectEvidenceSource, traceComponentIdentities, traceExchanges } from "@eval/tools";
import type { BusinessChain, Evidence } from "@eval/agents/attribution";
import { processSourceInventory } from "./citations.js";
import { getAnswerGeneration } from "./answer-generation.js";
import type { RawInput } from "../inputs/types.js";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Link captured boundaries, not imagined intermediate processing or a causal verdict. */
export function businessChains(raw: RawInput, inputId: string, finalIndex: number): BusinessChain[] {
  const inventory = processSourceInventory(raw, inputId, finalIndex), contexts = answerTurnContexts(raw, finalIndex);
  const actors = traceComponentIdentities(raw, inputId, finalIndex);
  const generation = getAnswerGeneration(raw, inputId, finalIndex);
  const sourcesByIndex = new Map<number, ReturnType<typeof evidenceSources>>();
  const sourcesAt = (index: number) => {
    if (!sourcesByIndex.has(index)) sourcesByIndex.set(index, evidenceSources(raw.messages[index]));
    return sourcesByIndex.get(index)!;
  };
  const at = (index: number, path: string, limit = 4800): Evidence[] => {
    const sources = sourcesAt(index);
    let range = selectEvidenceSource(sources, path);
    if (range && range.start === range.end) range = selectEvidenceSource(sources.filter(source => source.kind === "json"), path);
    if (!range) return [];
    if (overlapsImagePlaceholder(range.source.text, range.start, Math.min(range.end, range.start + limit))) {
      // A multimodal container is navigation, not text evidence for the image inside it.
      let remaining = limit;
      return sources.flatMap(source => {
        if (source.kind !== "text" || !source.path.startsWith(path + "/") || !source.text.length || remaining <= 0) return [];
        const end = Math.min(source.text.length, remaining);
        if (overlapsImagePlaceholder(source.text, 0, end)) return [];
        remaining -= end;
        return [cite(inputId, index, source, 0, end)];
      });
    }
    return [cite(inputId, index, range.source, range.start, Math.min(range.end, range.start + limit))];
  };
  const outputs = (index: number): Evidence[] => sourcesAt(index)
    .filter(source => source.kind === "text" && /^\/output\/\d+\/content(?:\/|$)/u.test(source.path))
    .flatMap(source => at(index, source.path));
  const goalIndex = raw.messages.findIndex(message => message.type === "user_question" || message.role === "user");
  const goals = goalIndex < 0 ? [] : messageContentSources(raw.messages[goalIndex]).flatMap(source => at(goalIndex, source.path, source.text.length || 4800));
  const exchanges = traceExchanges(raw.messages);
  const lastContext = contexts.at(-1)?.message_index;
  const fallbackInput = contexts.filter(context => context.message_index === lastContext).flatMap(context => sourcesAt(context.message_index)
    .filter(source => source.kind === "text" && source.path.startsWith(context.path + "/") && /\/content(?:\/|$)/u.test(source.path))
    .flatMap(source => at(context.message_index, source.path, source.text.length || 4800)));
  const generated = generation ? outputs(generation.message_index) : [];
  const intermediates = contexts.filter(context => context.message_index !== generation?.message_index)
    .flatMap(context => outputs(context.message_index));
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
    const actual = [...new Map(visible.map(source => [source.evidence_id, source])).values()];
    // When no renderer source envelope exists, expose the captured non-system context leaves.
    // This is navigation only; presence does not certify that a particular source was passed.
    const actionIds = new Set(exchange.return_indices.flatMap(i => {
      const output = object(object(raw.messages[i]).output ?? object(raw.messages[i]).result);
      return typeof output.action_id === "string" ? [output.action_id] : [];
    }));
    const linkedInput = fallbackInput.filter(item => {
      try { return actionIds.has(object(JSON.parse(item.quote)).action_id as string); } catch { return false; }
    });
    const fallback = linkedInput.length ? linkedInput : fallbackInput;
    const actualInput: Evidence[] = actual.length ? [...actual,
      ...(!actual.some(source => source.message_index === lastContext) ? fallback : [])] : fallback;
    const returns = exchange.return_indices.flatMap(i => {
      const output = object(object(raw.messages[i]).output ?? object(raw.messages[i]).result);
      const prefix = Object.hasOwn(object(raw.messages[i]), "output") ? "/output" : "/result";
      const execution = ["status_code", "status_msg", "row_count", "model_sql", "data_sql"]
        .filter(field => Object.hasOwn(output, field)).flatMap(field => at(i, `${prefix}/${field}`, 1600));
      // Financial row identity, field units and values stay at their own original coordinates.
      if (Array.isArray(output.columns) && Array.isArray(output.datas)) {
        const fields = output.columns.slice(0, 3).flatMap(column => typeof object(column).key === "string" ? [String(object(column).key)] : []);
        return [...execution, ...output.columns.slice(0, 3).flatMap((_, c) => at(i, `${prefix}/columns/${c}`)),
          ...(fields.length ? fields.flatMap(field => at(i, `${prefix}/datas/0/${field.replaceAll("~", "~0").replaceAll("/", "~1")}`))
            : at(i, `${prefix}/datas/0`, 2400)), ...at(i, `${prefix}/query`)];
      }
      return [...execution, ...["/output", "/result", "/content"].flatMap(path => at(i, path))];
    });
    const planner = exchange.planner_index === null ? [] : outputs(exchange.planner_index);
    const request = ["/input", "/arguments"].flatMap(path => at(exchange.request_index, path));
    const finals = references.flatMap(reference => reference.occurrences.map(occurrence => occurrence.context));
    const stepEvidence = [goals, planner, request, returns, [...returns, ...intermediates, ...actualInput], actualInput,
      [...actualInput, ...generated], [...generated, ...finals]];
    return { chain_index: index + 1, tool_component: actors.find(actor => actor.kind === "tool" && actor.message_indices.includes(exchange.request_index))!.component, ...exchange,
      context_indices: [...new Set(contexts.map(context => context.message_index))],
      references: references.map(reference => reference.reference),
      delivery_changed: generation?.matches_captured_final === null || !generation ? null : !generation.matches_captured_final,
      checkpoints: attributionTaxonomy.investigation_steps.map((step, i) => ({ step,
        availability: stepEvidence[i].length ? "available" as const : "not_collected" as const,
        evidence: [...new Map(stepEvidence[i].map(item => [item.evidence_id, { evidence_id: item.evidence_id, message_index: item.message_index, quote: item.quote }])).values()],
        note: i === 1 ? "分别核对谁选择了标的及选择依据；若计划没有解释代理标的理由，在观察中明确说明未记录，不编造上游责任。"
          : i === 3 ? "分别核对数据载荷、执行状态和实际 SQL；零行不等于正常执行，失败状态也不自动证明请求正确或工具实现有错。"
          : i === 4 ? "对照相关原始返回与最后实际输入，分别检查关键事实和错误状态的保留或丢失。边界变化不证明中间处理者已采集；未捕获整理输出时明确处理节点未知，不能把接收输入的终稿调用当成整理者。只记录本问题有关变化，不把局部一致写成整个返回原样传入。"
          : i === 6 ? "同时核对实际输入和生成；只有边界差异不能确证内部乘法、换算或转换步骤。"
          : i === 7 ? "核对生成与交付；未记录独立核验不等于已执行核验，也不自动构成关联责任。" : "材料存在须读取后判断；目录关联不证明因果。",
      })), final_evidence: finals.map(({ evidence_id, message_index, quote }) => ({ evidence_id, message_index, quote })) };
  });
}

/** Hide raw bodies here so mandatory reading remains observable in the evidence audit. */
export function businessChainNavigation(chains: BusinessChain[], candidate: string) {
  return chains.map(chain => ({ ...chain, final_evidence: undefined,
    checkpoints: chain.checkpoints.map(checkpoint => ({ ...checkpoint, evidence: checkpoint.evidence.map(item => {
      const point = parseEvidenceCoordinates(item.evidence_id)!;
      if (point.kind === "image") throw new Error("业务链路检查点必须使用文本或JSON坐标。");
      return { message_index: item.message_index, reference: { evidence_id: item.evidence_id },
        read_request: { candidate, message_index: item.message_index, path: point.path, offset: point.start,
          max_chars: Math.min(16000, point.end - point.start) }, end_offset: point.end };
    }) })),
  }));
}
