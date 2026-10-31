import { processMaterial } from "./process-material.js";
import { processComponents, actorCatalog } from "./components.js";
import { initialAttributionMaterial } from "./attribution-navigation.js";
import { type AgentBinding, type TaskAnalysis, type JsonObject } from "@eval/contracts";
import { cite, images, displayEvidence, evidenceSources, parseEvidenceCoordinates, sourceTextBlocks, visualCaptureMarkers, type InstructionSource } from "@eval/tools";
import { presentedMaterialReads, projectComparisonEvidence, compactNavigation } from "./evidence-presentation.js";
import type { RawInput, Candidate } from "../inputs/types.js";
import { attributionTrace } from "./public-trace.js";
import { attributionNormDirectory } from "@eval/agents/attribution";
import { traceOverview } from "./trace-overview.js";
import { citationInventory, citationSourceParts, type CitationContext, type CitationInventory } from "./citations.js";
import { criterionInstructionSources } from "./instruction-bindings.js";
import { taskAnalysisPresentation } from "./task-focus.js";
import { answerGenerationPresentation, type AnswerGeneration } from "./answer-generation.js";

/** Project only generated evidence directories; original message values stay untouched. */
export function modelMaterial(material: Record<string, unknown>, candidate: string, raw: RawInput, inputId: string, compactChars?: number) {
  const compact = compactChars !== undefined;
  const { identity: _identity, ...anonymous } = material;
  const shown = <T extends { evidence_id: string }>(value: T) => displayEvidence(value);
  const finalEvidence = material.final_evidence as ReturnType<typeof cite>[];
  const initial = material.initial_material as { message_index: number; value: unknown; evidence: ReturnType<typeof cite>[] }[];
  const instructions = material.instruction_sources as InstructionSource[];
  const citations = material.citation_inventory as CitationInventory;
  const normBindings = material.criterion_instruction_sources as Record<string, {
    evidence_id: string; message_index: number; path: string; quote: string;
  }[]> | undefined;
  const norms = material.norm_directory as ReturnType<typeof attributionNormDirectory> | undefined;
  let outlineChars = 0;
  const outlined = new Set<string>();
  const instructionOutline = (quote: string, start: number) => {
    if (!compact) return {};
    const headings: { offset: number; title: string }[] = [];
    let offset = start, fence = "";
    for (const line of quote.split("\n")) {
      const marker = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1];
      if (marker) { if (!fence) fence = marker; else if (marker[0] === fence[0] && marker.length >= fence.length) fence = ""; }
      else if (!fence && /^(?:#{1,6} +\S|\*\*[^*\n]+\*\*\s*$)/u.test(line))
        headings.push({ offset, title: line.slice(0, 120) });
      offset += line.length + 1;
    }
    if (!headings.length) return {};
    const outline: typeof headings = [];
    for (const heading of headings) {
      const cost = JSON.stringify(heading).length + 1;
      if (outlineChars + cost > 2400) break;
      outline.push(heading); outlineChars += cost;
    }
    return { outline, omitted_headings: headings.length - outline.length };
  };
  const instructionNavigation = (message_index: number, path: string, start: number, end: number) => ({
    ...(compact && end - start > 1800
      ? { search_scope: { candidate, message_index, path }, start_offset: start }
      : { read_request: { candidate, message_index, path, offset: start, max_chars: Math.min(16000, end - start) } }),
    end_offset: end,
  });
  const finalIndex = material.final_message_index as number, imageCount = images(raw.messages[finalIndex]).length;
  const captureGaps = visualCaptureMarkers(raw.messages[finalIndex]).map(({ path, status, resource_ref }) => ({
    message_index: finalIndex, path, status, resource_ref, user_visible_rendering: "unknown",
  }));
  const citationRange = (source: CitationContext) => {
    const { quote, ...coordinates } = source;
    const displayed = shown(quote.length <= 200 ? source : {
      ...coordinates, quote_preview: quote.slice(0, 200), has_more: true,
    });
    return { ...displayed, read_request: { ...source.read_request, candidate } };
  };
  const occurrenceRange = (source: CitationContext) => {
    const point = parseEvidenceCoordinates(source.evidence_id)!;
    if (point.kind === "image") return citationRange(source);
    const visible = compact && finalEvidence.some(item => {
      const full = parseEvidenceCoordinates(item.evidence_id)!;
      return full.kind !== "image" && full.kind === point.kind && full.message_index === point.message_index && full.path === point.path &&
        full.start <= point.start && full.end >= point.end;
    });
    if (!visible) return citationRange(source);
    const { quote: _quote, read_request: _request, ...coordinates } = source;
    return { ...shown(coordinates), already_shown: true, start_offset: point.start, end_offset: point.end };
  };
  // Split only visible original text; headings and their tables stay together. A citation
  // links to a section for investigation, never certifies any of its individual claims.
  const reviewSections = compact ? finalEvidence.flatMap(item => {
    const point = parseEvidenceCoordinates(item.evidence_id)!;
    if (point.kind !== "text") return [];
    const source = evidenceSources(raw.messages[point.message_index]).find(source => source.kind === "text" && source.path === point.path)!;
    return sourceTextBlocks(item.quote).map(block => {
      const start = point.start + block.start, end = point.start + block.end;
      return { ...shown(cite(inputId, point.message_index, source, start, end)),
        citation_indices: citations.references.flatMap((reference, index) => reference.occurrences.some(occurrence => {
          const location = parseEvidenceCoordinates(occurrence.evidence_id)!;
          return location.kind !== "image" && location.message_index === point.message_index && location.path === point.path && location.start < end && start < location.end;
        }) ? [index + 1] : []) };
    });
  }).map((section, index) => ({ section_index: index + 1, ...section })) : [];
  return {
    ...anonymous,
    ...(captureGaps.length ? { capture_gaps: captureGaps } : {}),
    ...(imageCount ? { final_images: { image_count: imageCount,
      view_request: { candidate, message_index: finalIndex } } } : {}),
    deferred_final_material: (material.deferred_final_material as { message_index: number; path: string; total_chars: number }[])
      .map(source => ({ ...source, read_request: { candidate, message_index: source.message_index,
        path: source.path, offset: 0, max_chars: 16000 } })),
    ...(norms ? { norm_directory: norms.map(norm => ({ ...norm,
      evidence: norm.evidence.map(item => {
        const point = parseEvidenceCoordinates(item.evidence_id);
        if (!point || point.kind !== "text" || point.input_id !== inputId)
          throw new Error("规范目录的完整坐标不属于本方原始来源。");
        const source = evidenceSources(raw.messages[point.message_index]).find(source => source.kind === "text" && source.path === point.path);
        if (!source || cite(inputId, point.message_index, source, point.start, point.end).quote !== item.quote)
          throw new Error("规范目录的完整坐标与原文不一致。");
        const { quote, ...coordinates } = item;
        const outline = outlined.has(item.evidence_id) ? {} : instructionOutline(quote, point.start);
        outlined.add(item.evidence_id);
        return { ...shown(quote.length <= 200 ? item : { ...coordinates, quote_preview: quote.slice(0, 200), has_more: true }),
          ...outline,
          ...instructionNavigation(point.message_index, point.path, point.start, point.end) };
      }) })) } : {}),
    final_evidence: finalEvidence.map(item => {
      const { quote, ...coordinates } = item;
      const point = parseEvidenceCoordinates(item.evidence_id)!;
      return shown(compact && point.kind === "text" ? { ...coordinates, path: point.path,
        start_offset: point.start, end_offset: point.end } : item);
    }),
    ...(Object.hasOwn(material, "answer_generation") ? { answer_generation: (() => {
      const generation = answerGenerationPresentation(material.answer_generation as AnswerGeneration | null, candidate);
      return generation;
    })() } : {}),
    initial_material: compact ? [] : initial.map((entry) => ({ ...entry, evidence: entry.evidence.map(shown) })),
    ...(compact ? { trace_overview: traceOverview(raw, candidate, inputId, compactChars) } : {}),
    ...(compact ? { review_sections: reviewSections } : {}),
    instruction_sources: instructions.map(({ content, ...source }) => ({ ...source, ...(!compact ? { content } : {}), evidence: source.evidence.map(item => {
      const { quote, ...coordinates } = item;
      const point = parseEvidenceCoordinates(item.evidence_id)!;
      return { ...shown(quote.length <= 200 ? item : { ...coordinates, quote_preview: quote.slice(0, 200), has_more: true }),
        ...(compact && point.kind === "text" ? instructionNavigation(point.message_index, point.path, point.start, point.end) : {}) };
    }) })),
    citation_inventory: { ...citations, references: citations.references.map(item => ({ ...item,
      occurrences: item.occurrences.map(({ context, ...marker }) => ({
        ...shown(marker), context: occurrenceRange(context),
      })), sources: item.sources.flatMap(source => citationSourceParts(raw, inputId, source)).map(citationRange),
    })) },
    ...(normBindings ? { criterion_instruction_sources: Object.fromEntries(Object.entries(normBindings).map(([id, entries]) =>
      [id, entries.map(entry => {
        const location = parseEvidenceCoordinates(entry.evidence_id);
        if (!location || location.kind !== "text" || location.input_id !== inputId ||
          location.message_index !== entry.message_index || location.path !== entry.path)
          throw new Error("规范关联的完整坐标不属于原始来源。");
        const source = evidenceSources(raw.messages[entry.message_index]).find(item => item.kind === "text" && item.path === entry.path)!;
        const full = cite(inputId, entry.message_index, source, location.start, location.end);
        if (full.quote !== entry.quote) throw new Error("规范关联的完整坐标与原文不一致。");
        const { quote: _quote, ...coordinates } = entry;
        const { evidence_id: _id, ...display } = coordinates;
        return { ...display, ...(full.quote.length <= 200 ? { quote: full.quote } : {
          quote_preview: full.quote.slice(0, 200), has_more: true }),
          reference: { evidence_id: full.evidence_id }, ...instructionNavigation(entry.message_index, entry.path, location.start, location.end) };
      })])) } : {}),
  };
}

/** Source facts are shared by the input window; there is no per-task execution graph. */
function prepareAttributionMaterial(candidate: Candidate, original: RawInput, analysis?: TaskAnalysis, publicRaw?: RawInput) {
  const raw = publicRaw ?? attributionTrace(original);
  const task_analysis: TaskAnalysis = analysis ?? { task_type: "回答评审", goal: candidate.question,
    requirements: [{ id: "r1", text: candidate.question, acceptance_rule: candidate.question, applies_to: [] }], scoring_points: [], red_flags: [] };
  const sources = { answer: { id: candidate.input_id, value: raw } };
  const answer = { final_message_index: candidate.final_index,
    criterion_instruction_sources: criterionInstructionSources(raw, candidate.final_index, task_analysis, candidate.input_id) };
  const input = { candidate_id: candidate.input_id, task_analysis, answer };
  const norms = attributionNormDirectory({ input, sources });
  const citations = citationInventory(raw, candidate.input_id, candidate.final_index);
  return { raw, sources, task_analysis, answer, norms, citations };
}

/** One trace review follows the complete process in program-bound Compact component slots. */
export function bindAttributionMaterial(candidate: Candidate, original: RawInput, analysis: TaskAnalysis | undefined,
  options: { reference?: unknown; compact: JsonObject; source?: { raw: RawInput; positions: { trace_index: number; message_index: number }[]; traceIndex: number } }): AgentBinding {
  const started = performance.now();
  const prepared = prepareAttributionMaterial(candidate, original, analysis, options.source?.raw);
  const { raw, sources, answer, task_analysis, norms, citations } = prepared;
  const reference = options.reference === undefined ? candidate.reference : options.reference;
  const ground_truth = { available: reference !== null, value: reference };
  const citation_inventory = { references: citations.references.map(reference => ({ reference: reference.reference,
    format: reference.format, status: reference.status,
    sources: reference.sources.flatMap(source => citationSourceParts(raw, candidate.input_id, source)).map(source => {
      const point = parseEvidenceCoordinates(source.evidence_id)!;
      if (point.kind === "image") return displayEvidence(source);
      const { quote, ...coordinates } = source;
      return { ...displayEvidence(quote.length <= 200 ? source : { ...coordinates, quote_preview: quote.slice(0, 200), has_more: true }),
        read_request: { candidate: "answer", message_index: point.message_index, path: point.path, offset: point.start,
          max_chars: Math.min(16000, point.end - point.start) }, end_offset: point.end };
    }) })) };
  const delivery = initialAttributionMaterial(candidate.final_index, raw, candidate.input_id, 6400);
  const { execution_facts, ...process } = processMaterial(raw, original, candidate.input_id, "answer", 12000, options.source?.positions, options.source?.traceIndex);
  const components = processComponents(raw, original, candidate.input_id, options.source?.positions ??
    raw.messages.map((_, message_index) => ({ trace_index: 0, message_index })),
    (options.compact.turns as JsonObject[]).flatMap(turn => turn.components as JsonObject[] ?? []));
  const catalog = actorCatalog(options.source ? components.filter(entry => entry.positions.some(position =>
    position.trace_index === options.source!.traceIndex)) : components);
  const modelInput = { ground_truth, compact: compactNavigation(options.compact),
    actor_catalog: catalog,
    task_analysis: taskAnalysisPresentation(task_analysis, { answer: candidate.input_id }, answer.criterion_instruction_sources),
    answer: { question: candidate.question, ...delivery,
      ...process, execution_facts,
      citation_inventory,
      norm_directory: norms.map(norm => ({ ...norm, evidence: norm.evidence.map(displayEvidence) })) } };
  return { agent: "attribution", profile: "trace", request: { input: { trace_index: 0, ground_truth, compact: options.compact, trace_meta: original.meta ?? {},
    question: candidate.question, answer: String(original.messages[candidate.final_index]?.content ?? ""),
    components, source_positions: options.source?.positions ?? original.messages.map((_, message_index) => ({ trace_index: 0, message_index })) }, sources }, modelInput,
    preparationTimings: { materialMs: performance.now() - started },
    materialNavigation: { answer: { final_message_index: candidate.final_index } },
    projectModelInput: (input, bank) => projectComparisonEvidence(input, bank, 400),
    presentedReads: presentedMaterialReads({ ...modelInput.answer, actor_catalog: catalog }, "answer", candidate.input_id) };
}
