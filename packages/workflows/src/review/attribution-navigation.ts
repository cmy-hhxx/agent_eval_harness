import { displayEvidence, images, parseEvidenceCoordinates, visualCaptureMarkers, type TraceComponentIdentity, type TableCheckResult } from "@eval/tools";
import { responsibilityComponentName, responsibilityComponent, transferChanged, type ResponsibilityMaterial, type AttributionExecutionNode, type AttributionTransition, type AttributionNorm } from "@eval/agents/attribution";
import type { JsonObject } from "@eval/contracts";
import { tableChecksPresentation } from "./attribution-presentation.js";
import type { RawInput } from "../inputs/types.js";

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
  return { table_checks, responsibility_choices, nodes: (answer.execution_nodes as AttributionExecutionNode[]).map(node => {
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
export function initialAttributionMaterial(answer: JsonObject, raw: RawInput, navigation: ReturnType<typeof attributionNavigation>) {
  const candidate = "answer";
  const finalIndex = answer.final_message_index as number;
  const nodes = navigation.nodes.slice(0, 8);
  const readRequest = (item: { evidence_id: string; message_index: number }) => {
    const point = parseEvidenceCoordinates(item.evidence_id)!;
    return point.kind === "image" ? { view_request: { candidate, message_index: point.message_index } }
      : { read_request: { candidate, message_index: point.message_index, kind: point.kind, path: point.path,
        offset: point.start, max_chars: Math.min(16000, point.end - point.start) }, end_offset: point.end };
  };
  const imageCount = images(raw.messages[finalIndex]).length;
  const gaps = visualCaptureMarkers(raw.messages[finalIndex]);
  return {
    question: answer.question, final_message_index: finalIndex,
    // Original final text occurs once and only these displayed ranges count as read.
    final_evidence: (answer.final_evidence as { evidence_id: string; message_index: number; quote: string }[]).map(displayEvidence),
    deferred_final_material: (answer.deferred_final_material as { message_index: number; path: string; total_chars: number }[])
      .map(source => ({ ...source, read_request: { candidate, message_index: source.message_index, path: source.path, offset: 0, max_chars: 16000 } })),
    ...(imageCount ? { final_images: { image_count: imageCount, view_request: { candidate, message_index: finalIndex } } } : {}),
    ...(gaps.length ? { capture_gaps: gaps.map(({ path, status, resource_ref }) => ({ message_index: finalIndex, path, status, resource_ref })) } : {}),
    execution_overview: {
      model_calls: navigation.nodes.filter(node => node.kind === "model").length,
      tool_calls: navigation.nodes.filter(node => node.kind === "tool").length,
      execution_nodes: navigation.nodes.length, transfer_boundaries: navigation.boundaries.filter(boundary => boundary.kind === "transfer").length,
      entries: nodes.map(({ actor_index: _actor, ...node }) => ({...node,
        responsibility_choices:navigation.responsibility_choices.filter(c=>c.execution_node_index===node.execution_node_index)})), offset: 0, total: navigation.nodes.length,
      has_more: nodes.length < navigation.nodes.length,
      next_request: nodes.length < navigation.nodes.length ? { candidate, view: "nodes", offset: nodes.length } : null,
      read_request: { candidate, view: "nodes", offset: 0 },
    },
    final_generation_choices: navigation.responsibility_choices.filter(c=>c.component==='终稿生成轮'),
    context_transfer_choices: navigation.responsibility_choices.filter(c=>c.kind==='transfer'),
    table_check_count: navigation.table_checks.length,
    ...(navigation.table_checks.length ? { table_check_request: { candidate, view: "table_checks", offset: 0 } } : {}),
    norm_directory: (answer.norm_directory as AttributionNorm[]).map(norm => ({ ...norm,
      evidence: norm.evidence.map(({ quote, ...item }) => ({ ...displayEvidence(quote.length <= 200 ? { ...item, quote }
        : { ...item, quote_preview: quote.slice(0, 200), has_more: true }), ...readRequest(item) })),
    })),
    criterion_instruction_sources: Object.fromEntries(Object.entries(answer.criterion_instruction_sources as Record<string,
      { evidence_id: string; message_index: number; quote: string }[]>).map(([key, entries]) => [key, entries.map(({ quote, ...item }) =>
      ({ ...displayEvidence(quote.length <= 200 ? { ...item, quote } : { ...item, quote_preview: quote.slice(0, 200), has_more: true }), ...readRequest(item) }))])),
  };
}
