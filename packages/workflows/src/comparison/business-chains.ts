import { attributionTaxonomy } from "@eval/prompts";
import { answerTurnContexts, cite, evidenceSources, messageContentSources, parseEvidenceCoordinates, selectEvidenceSource, traceComponentIdentities, traceExchanges } from "@eval/tools";
import type { BusinessChain, Evidence } from "@eval/agents/attribution";
import { citationInventory } from "./citations.js";
import { getAnswerGeneration } from "./answer-generation.js";
import type { RawInput } from "./types.js";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Link captured boundaries, not imagined intermediate processing or a causal verdict. */
export function businessChains(raw: RawInput, inputId: string, finalIndex: number): BusinessChain[] {
  const inventory = citationInventory(raw, inputId, finalIndex), contexts = answerTurnContexts(raw, finalIndex);
  const actors = traceComponentIdentities(raw, inputId, finalIndex);
  const generation = getAnswerGeneration(raw, inputId, finalIndex);
  const at = (index: number, path: string, limit = 4800): Evidence[] => {
    const range = selectEvidenceSource(evidenceSources(raw.messages[index]), path);
    if (!range) return [];
    return [cite(inputId, index, range.source, range.start, Math.min(range.end, range.start + limit))];
  };
  const outputs = (index: number): Evidence[] => evidenceSources(raw.messages[index])
    .filter(source => source.kind === "text" && /^\/output\/\d+\/content(?:\/|$)/u.test(source.path))
    .map(source => cite(inputId, index, source, 0, Math.min(source.text.length, 4800)));
  const goalIndex = raw.messages.findIndex(message => message.type === "user_question" || message.role === "user");
  const goals = goalIndex < 0 ? [] : messageContentSources(raw.messages[goalIndex]).map(source => cite(inputId, goalIndex, source, 0, source.text.length));
  const exchanges = traceExchanges(raw.messages);
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
    const fallbackInput = contexts.flatMap(context => evidenceSources(raw.messages[context.message_index])
      .filter(source => source.kind === "text" && source.path.startsWith(context.path + "/") && /\/content(?:\/|$)/u.test(source.path))
      .map(source => cite(inputId, context.message_index, source, 0, source.text.length)));
    const actualInput: Evidence[] = actual.length ? actual : fallbackInput;
    const returns = exchange.return_indices.flatMap(i => {
      const output = object(object(raw.messages[i]).output ?? object(raw.messages[i]).result);
      const prefix = Object.hasOwn(object(raw.messages[i]), "output") ? "/output" : "/result";
      // Financial row identity, field units and values stay at their own original coordinates.
      if (Array.isArray(output.columns) && Array.isArray(output.datas)) {
        const fields = output.columns.slice(0, 3).flatMap(column => typeof object(column).key === "string" ? [String(object(column).key)] : []);
        return [...output.columns.slice(0, 3).flatMap((_, c) => at(i, `${prefix}/columns/${c}`)),
          ...(fields.length ? fields.flatMap(field => at(i, `${prefix}/datas/0/${field.replaceAll("~", "~0").replaceAll("/", "~1")}`))
            : at(i, `${prefix}/datas/0`, 2400)), ...at(i, `${prefix}/query`)];
      }
      return ["/output", "/result", "/content"].flatMap(path => at(i, path));
    });
    const planner = exchange.planner_index === null ? [] : outputs(exchange.planner_index);
    const request = ["/input", "/arguments"].flatMap(path => at(exchange.request_index, path));
    const generated = generation ? outputs(generation.message_index) : [];
    const finals = references.flatMap(reference => reference.occurrences.map(occurrence => occurrence.context));
    const stepEvidence = [goals, planner, request, returns, [...returns, ...actualInput], actualInput,
      [...actualInput, ...generated], [...generated, ...finals]];
    return { chain_index: index + 1, tool_component: actors.find(actor => actor.kind === "tool" && actor.message_indices.includes(exchange.request_index))!.component, ...exchange,
      context_indices: [...new Set(contexts.map(context => context.message_index))],
      references: references.map(reference => reference.reference),
      delivery_changed: generation?.matches_captured_final === null || !generation ? null : !generation.matches_captured_final,
      checkpoints: attributionTaxonomy.investigation_steps.map((step, i) => ({ step,
        availability: stepEvidence[i].length ? "available" as const : "not_collected" as const,
        evidence: [...new Map(stepEvidence[i].map(item => [item.evidence_id, { evidence_id: item.evidence_id, message_index: item.message_index, quote: item.quote }])).values()],
        note: i === 4 ? "仅登记返回和实际输入边界；中间整理者、摘要规则和换算记录须继续查证，不能由相邻顺序推断。"
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
