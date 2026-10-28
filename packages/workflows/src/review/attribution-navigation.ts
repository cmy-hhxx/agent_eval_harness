import { cite, evidenceSources, selectEvidenceSource, displayEvidence, images, overlapsImagePlaceholder, parseEvidenceCoordinates, visualCaptureMarkers, type TraceComponentIdentity, type TableCheckResult } from "@eval/tools";
import { responsibilityComponentName, responsibilityComponent, transferChanged, type ResponsibilityMaterial, type AttributionExecutionNode, type AttributionTransition, type AttributionNorm } from "@eval/agents/attribution";
import type { JsonObject } from "@eval/contracts";
import { tableChecksPresentation } from "./attribution-presentation.js";
import type { RawInput, ComponentReviewScope } from "../inputs/types.js";

/** The graph travels to the tool runtime, never through the initial model prompt. */
export function attributionNavigation(answer: JsonObject, raw: RawInput, inputId: string) {
  const actors = answer.component_catalog as TraceComponentIdentity[];
  const checks = answer.table_check_results as TableCheckResult[];
  const reference = ({ quote: _quote, ...item }: { evidence_id: string; message_index: number; quote: string }) => displayEvidence(item);
  const table_checks = checks.some(check => check.rows.length) ? tableChecksPresentation(checks, raw, inputId).flatMap(table =>
    table.rows.map(row => ({ table_index: table.answer_table_index, ...row,
      answer: { ...row.answer, evidence: reference(row.answer.evidence) },
      sources: row.sources.map(source => ({ ...source, evidence: reference(source.evidence) })),
    }))) : [];
  const model = answer as unknown as ResponsibilityMaterial;
  const responsibility_choices = (answer.transitions as AttributionTransition[]).flatMap(t => {
    if (t.execution_node_index === null && !(t.kind === "transfer" && transferChanged(model, raw, t))) return [];
    const node = (answer.execution_nodes as AttributionExecutionNode[]).find(n => n.execution_node_index === t.execution_node_index);
    return [{ transition_index:t.transition_index, responsibility_boundary:`boundary:${t.transition_index}`, execution_node_index:t.execution_node_index,
      message_index:node?.message_index ?? null, component:responsibilityComponent(model, raw, t.transition_index), kind:t.kind }];
  });
  return { final_message_index: answer.final_message_index, table_checks, responsibility_choices, nodes: (answer.execution_nodes as AttributionExecutionNode[]).map(node => {
    const message = raw.messages[node.message_index];
    const outputs = Array.isArray(message.output) ? message.output : [];
    const calls = outputs.flatMap(value => value && typeof value === "object" && Array.isArray(value.tool_calls) ? value.tool_calls : []);
    const names = calls.flatMap(call => typeof call?.function?.name === "string" ? [call.function.name] : []).slice(0, 3);
    const text = outputs.find(value => value && typeof value === "object" && typeof value.content === "string")?.content;
    return { ...node, component: node.actor_index === null ? null : responsibilityComponentName(actors[node.actor_index - 1]),
      summary: names.length ? names.join(", ") : typeof text === "string" ? text.slice(0, 120) : String(message.name ?? message.type ?? node.kind),
    };
  }), boundaries: answer.transitions as AttributionTransition[] };
}

/** Explicit allowlist: new canonical fields cannot silently inflate the model context. */
export function initialAttributionMaterial(answer: JsonObject, raw: RawInput, navigation: ReturnType<typeof attributionNavigation>, inputId: string, scope?: ComponentReviewScope) {
  const candidate = "answer";
  const finalIndex = answer.final_message_index as number;
  const finalReview = !scope || scope.message_indices.includes(finalIndex);
  const selectedNodes = scope ? navigation.nodes.filter(node => scope.message_indices.includes(node.message_index)) : navigation.nodes;
  const nodes = selectedNodes.slice(0, 8);
  const readRequest = (item: { evidence_id: string; message_index: number }) => {
    const point = parseEvidenceCoordinates(item.evidence_id)!;
    return point.kind === "image" ? { view_request: { candidate, message_index: point.message_index } }
      : { read_request: { candidate, message_index: point.message_index, path: point.path,
        offset: point.start, max_chars: Math.min(16000, point.end - point.start) }, end_offset: point.end };
  };
  const imageCount = finalReview ? images(raw.messages[finalIndex]).length : 0;
  const gaps = finalReview ? visualCaptureMarkers(raw.messages[finalIndex]) : [];
  const finalEvidence = scope?.final_ranges ? scope.final_ranges.flatMap(range => {
    const source = evidenceSources(raw.messages[finalIndex]).find(source => source.kind === "text" && source.path === range.path);
    if (!source || range.start < 0 || range.end > source.text.length || range.end <= range.start)
      throw new Error("归因原子任务的终稿范围与原文不一致");
    const entries = [];
    // A chart resource may contain tens of thousands of encoded data/style bytes.
    // Keep its ownership intact, but defer the tail instead of flooding the first prompt.
    for (let start = range.start; start < Math.min(range.end, range.start + 1600); start += 400)
      entries.push(cite(inputId, finalIndex, source, start, Math.min(range.end, start + 400)));
    return entries;
  }) : finalReview ? answer.final_evidence as { evidence_id: string; message_index: number; quote: string }[] : [];
  return {
    question: answer.question, final_message_index: finalIndex,
    // Original final text occurs once and only these displayed ranges count as read.
    final_evidence: finalEvidence.map(displayEvidence),
    ...(scope?.final_ranges ? { final_context: {
      partial: scope.final_ranges.some(range => range.end - range.start > 1600),
      continuations: scope.final_ranges.filter(range => range.end - range.start > 1600).map(range => ({
        end_offset: range.end, read_request: { candidate, message_index: finalIndex, path: range.path,
          offset: range.start + 1600, max_chars: Math.min(16000, range.end - range.start - 1600) },
      })),
    } } : {}),
    deferred_final_material: (finalReview && !scope?.final_ranges ? answer.deferred_final_material as { message_index: number; path: string; total_chars: number }[] : [])
      .map(source => ({ ...source, read_request: { candidate, message_index: source.message_index, path: source.path, offset: 0, max_chars: 16000 } })),
    ...(imageCount ? { final_images: { image_count: imageCount, view_request: { candidate, message_index: finalIndex } } } : {}),
    ...(gaps.length ? { capture_gaps: gaps.map(({ path, status, resource_ref }) => ({ message_index: finalIndex, path, status, resource_ref })) } : {}),
    execution_overview: {
      model_calls: navigation.nodes.filter(node => node.kind === "model").length,
      tool_calls: navigation.nodes.filter(node => node.kind === "tool").length,
      execution_nodes: navigation.nodes.length, transfer_boundaries: navigation.boundaries.filter(boundary => boundary.kind === "transfer").length,
      entries: nodes.map(({ actor_index: _actor, ...node }) => ({...node,
        responsibility_choices:navigation.responsibility_choices.filter(c=>c.execution_node_index===node.execution_node_index)})), offset: 0, total: selectedNodes.length,
      has_more: nodes.length < selectedNodes.length,
      next_request: !scope && nodes.length < navigation.nodes.length ? { candidate, view: "nodes", offset: nodes.length } : null,
    },
    final_generation_choices: finalReview ? navigation.responsibility_choices.filter(c=>c.component==='终稿生成轮') : [],
    context_transfer_choices: navigation.responsibility_choices.filter(c=>c.kind==='transfer' &&
      (!scope || c.message_index !== null && scope.message_indices.includes(c.message_index))),
    table_check_count: finalReview ? navigation.table_checks.length : 0,
    ...(navigation.table_checks.length && finalReview ? { table_check_request: { candidate, view: "table_checks", offset: 0 } } : {}),
    ...(finalReview ? { norm_directory: (answer.norm_directory as AttributionNorm[]).map(norm => ({ ...norm,
      evidence: norm.evidence.map(({ quote, ...item }) => ({ ...displayEvidence(quote.length <= 200 ? { ...item, quote }
        : { ...item, quote_preview: quote.slice(0, 200), has_more: true }), ...readRequest(item) })),
    })),
    criterion_instruction_sources: Object.fromEntries(Object.entries(answer.criterion_instruction_sources as Record<string,
      { evidence_id: string; message_index: number; quote: string }[]>).map(([key, entries]) => [key, entries.map(({ quote, ...item }) =>
      ({ ...displayEvidence(quote.length <= 200 ? { ...item, quote } : { ...item, quote_preview: quote.slice(0, 200), has_more: true }), ...readRequest(item) }))])) } : {}),
  };
}

/** Preload a bounded part of the selected component, with exact original coordinates. */
export function initialComponentScene(raw: RawInput, original: RawInput, inputId: string,
  navigation: ReturnType<typeof attributionNavigation>, component: string, scope?: ComponentReviewScope) {
  const choices = navigation.responsibility_choices.filter(choice => scope
    ? choice.message_index !== null && scope.message_indices.includes(choice.message_index)
    : choice.component === component);
  const sources = new Map<number, ReturnType<typeof evidenceSources>>();
  const originals = new Map<number, ReturnType<typeof evidenceSources>>();
  const entries = [];
  const unread = [];
  const seen = new Set<string>();
  let remaining = 12000;
  // An invocation's actual arguments and result precede duplicated model input history.
  // Register only exact bytes that survive the public projection at the same coordinates.
  for (const messageIndex of scope?.message_indices ?? []) {
    const message = raw.messages[messageIndex];
    if (!message) throw new Error("归因原子任务的消息坐标不存在");
    const locations = evidenceSources(message), originals = evidenceSources(original.messages[messageIndex]);
    for (const key of ["input", "arguments", "output", "result", "content"]) {
      if (!Object.hasOwn(message, key)) continue;
      const value = message[key];
      const whole = selectEvidenceSource(locations, `/${key}`);
      const textBlocks = typeof value === "string" || Array.isArray(value) && value.every(part =>
        part && typeof part === "object" && ["text", "input_text", "output_text"].includes(String(part.type)) && typeof part.text === "string");
      const leaves = textBlocks || whole?.source.quotable === false || whole && overlapsImagePlaceholder(whole.source.text, whole.start, whole.end) ? locations.filter(source => source.kind === "text" && source.quotable !== false &&
        (source.path === `/${key}` || source.path.startsWith(`/${key}/`) && /\/(?:text|content|arguments|reasoning_content)$/u.test(source.path)))
        : [];
      const selected = leaves.length ? leaves.map(source => ({ source, start: 0, end: source.text.length }))
        : [whole].filter(item => item !== undefined);
      for (const item of selected) {
        if (item.source.quotable === false) continue;
        const originalSource = originals.find(source => source.kind === item.source.kind && source.path === item.source.path);
        const shownEnd = Math.min(item.end, item.start + 6000, item.start + remaining);
        if (shownEnd < item.end) unread.push({ end_offset: item.end, read_request: { candidate: "answer",
          message_index: messageIndex, path: item.source.path, offset: shownEnd, max_chars: Math.min(16000, item.end - shownEnd) } });
        for (let start = item.start; start < shownEnd; start += 400) {
          const end = Math.min(shownEnd, start + 400), evidence = cite(inputId, messageIndex, item.source, start, end);
          if (!evidence.quote || overlapsImagePlaceholder(item.source.text, start, end) ||
            evidence.quote !== originalSource?.text.slice(start, end) || seen.has(evidence.evidence_id)) continue;
          seen.add(evidence.evidence_id); remaining -= end - start;
          const hasMore = end === shownEnd && end < item.end;
          entries.push({ part: key, ...displayEvidence(evidence), end_offset: item.end, has_more: hasMore,
            ...(hasMore ? { next_request: { candidate: "answer", message_index: messageIndex,
              path: item.source.path, offset: end, max_chars: Math.min(16000, item.end - end) } } : {}) });
        }
      }
    }
  }
  for (const choice of choices.filter(choice => choice.kind !== "execution" || !entries.length).slice(0, 2)) {
    const boundary = navigation.boundaries.find(boundary => boundary.transition_index === choice.transition_index)!;
    for (const [part, items] of [["before", boundary.before], ["after", boundary.after]] as const) {
      for (const item of items) {
        if (entries.length >= 40) break;
        const point = parseEvidenceCoordinates(item.evidence_id);
        if (!point || point.kind === "image") continue;
        if (!sources.has(point.message_index)) sources.set(point.message_index, evidenceSources(raw.messages[point.message_index]));
        if (!originals.has(point.message_index)) originals.set(point.message_index, evidenceSources(original.messages[point.message_index]));
        const source = sources.get(point.message_index)!.find(source => source.kind === point.kind && source.path === point.path);
        const originalSource = originals.get(point.message_index)!.find(source => source.kind === point.kind && source.path === point.path);
        if (!source || source.quotable === false || !originalSource) continue;
        const end = Math.min(point.end, point.start + 400);
        const evidence = cite(inputId, point.message_index, source, point.start, end);
        if (!evidence.quote || overlapsImagePlaceholder(source.text, point.start, end) ||
          evidence.quote !== originalSource.text.slice(point.start, end) || seen.has(evidence.evidence_id)) continue;
        seen.add(evidence.evidence_id);
        entries.push({ transition_index: choice.transition_index, part, ...displayEvidence(evidence),
          end_offset: point.end, has_more: end < point.end,
          ...(end < point.end ? { next_request: { candidate: "answer", message_index: point.message_index,
            path: point.path, offset: end, max_chars: Math.min(16000, point.end - end) } } : {}) });
      }
    }
  }
  return { component, partial: unread.length > 0 || entries.some(entry => entry.has_more), entries, unread,
    images: (scope?.message_indices ?? []).flatMap(message_index => {
      const count = images(raw.messages[message_index]).length;
      return count ? [{ message_index, image_count: count, view_request: { candidate: "answer", message_index } }] : [];
    }), responsibility_choices_total: choices.length };
}
