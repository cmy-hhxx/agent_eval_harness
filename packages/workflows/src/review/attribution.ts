import { businessChains, businessChainNavigation } from "./business-chains.js";
import { isToolSpan } from "../inputs/adapters.js";
import { workflowText } from "@eval/prompts";
import { canonical, type AgentBinding, type TaskAnalysis } from "@eval/contracts";
import { traceComponentIdentities, cite, images, answerTurnContexts, displayEvidence, evidenceSources, messageContentSources, parseEvidenceCoordinates, sourceTextBlocks, visualCaptureMarkers, type InstructionSource, type TableCheckResult, type TraceComponentIdentity } from "@eval/tools";
import { presentedMaterialReads, projectComparisonEvidence } from "./evidence-presentation.js";
import { contentText } from "../inputs/records.js";
import type { RawInput, Candidate } from "../inputs/types.js";
import { attributionTrace } from "./public-trace.js";
import { attributionNormDirectory, attributionTableChecks } from "@eval/agents/attribution";
import { traceCatalog } from "./catalog.js";
import { traceOverview } from "./trace-overview.js";
import { citationInventory, citationSourceParts, type CitationContext, type CitationInventory } from "./citations.js";
import { criterionInstructionSources } from "./instruction-bindings.js";
import { tableChecksPresentation } from "./attribution-presentation.js";
import { taskAnalysisPresentation, taskFocus } from "./task-focus.js";
import { getAnswerGeneration, answerGenerationPresentation, type AnswerGeneration } from "./answer-generation.js";

/** Project only generated evidence directories; original message values stay untouched. */
export function modelMaterial(material: Record<string, unknown>, candidate: string, raw: RawInput, inputId: string, compactChars?: number) {
  const compact = compactChars !== undefined;
  const { identity: _identity, ...anonymous } = material;
  const shown = <T extends { evidence_id: string }>(value: T) => displayEvidence(value);
  const finalEvidence = material.final_evidence as ReturnType<typeof cite>[];
  const initial = material.initial_material as { message_index: number; value: unknown; evidence: ReturnType<typeof cite>[] }[];
  const tables = material.table_check_results as TableCheckResult[] | undefined;
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
    ...(material.component_catalog ? { component_catalog: (material.component_catalog as TraceComponentIdentity[]).map(actor => ({ ...actor,
      identity_evidence: actor.identity_evidence.map(shown),
    })) } : {}),
    ...(material.business_chains ? { business_chains: businessChainNavigation(material.business_chains as import("@eval/agents/attribution").BusinessChain[], candidate) } : {}),
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
    ...(tables ? { table_check_results: tableChecksPresentation(tables, raw, inputId).map((table) => ({
      ...table,
      rows: table.rows.map((row) => ({
        ...row,
        answer: { ...row.answer, evidence: shown(row.answer.evidence) },
        sources: row.sources.map((source) => ({ ...source, evidence: shown(source.evidence) })),
      })),
    })) } : {}),
  };
}

/** Both workflows adapt their public task and trace into this single Attribution contract. */
export function bindAttributionMaterial(candidate: Candidate, original: RawInput, analysis?: TaskAnalysis,
  options: { reference?: unknown; initialContextChars?: number } = {}): AgentBinding {
  const raw = attributionTrace(original, candidate.input_id, candidate.final_index);
  const task_analysis: TaskAnalysis = analysis ?? { task_type: "回答评审", goal: candidate.question,
    requirements: [{ id: "r1", text: candidate.question, acceptance_rule: candidate.question, applies_to: [] }], scoring_points: [], red_flags: [] };
  const reference = options.reference === undefined ? candidate.reference : options.reference;
  const sources = { answer: { id: candidate.input_id, value: raw } };
  const finalSources = messageContentSources(raw.messages[candidate.final_index]);
  const limit = Math.max(16000, options.initialContextChars ?? 16000);
  const deferred = finalSources.filter(source => source.text.length > limit);
  const citations = citationInventory(raw, candidate.input_id, candidate.final_index);
  let used = 0;
  const initial: {
    message_index: number;
    value: unknown;
    evidence: ReturnType<typeof cite>[];
  }[] = [];
  const addInitial = (message_index: number, value: unknown, evidence: ReturnType<typeof cite>[]) => {
    const text = canonical(value);
    const cost = text.length + evidence.reduce((total, item) => total + item.quote.length, 0);
    if (used + cost > (options.initialContextChars ?? 16000) || text.includes("data:image/")) return;
    initial.push({ message_index, value, evidence });
    used += cost;
  };
  // A citation may identify a small complete source inside a very large return.
  // Prefer original returns over duplicate renderer projections; neither proves the claim.
  const cited = new Map(citations.references.flatMap(reference => {
    const returned = reference.sources.filter(source => source.origin === "tool_return");
    return (returned.length ? returned : reference.sources).map(source => [source.evidence_id, source] as const);
  }));
  for (const { evidence_id, message_index, quote } of cited.values())
    addInitial(message_index, quote, [{ evidence_id, message_index, quote }]);
  const priority = raw.messages
    .map((message, index) => ({ index, returned: isToolSpan(message) || message.role === "tool" ||
      ["function_call_output", "tool_result"].includes(message.type || "") }))
    .sort((a, b) => Number(b.returned) - Number(a.returned) || b.index - a.index)
    .map(item => item.index);
  for (const i of priority) {
    if (i === candidate.final_index) continue;
    if (["system", "developer"].includes(raw.messages[i].role || "")) continue;
    const value = Object.fromEntries(
      Object.entries(raw.messages[i]).filter(
        ([key]) => !["input_messages", "model", "model_parameters"].includes(key),
      ),
    );
    // Evidence must describe the projected material actually shown, and its quotes count
    // against the same budget. Raw-only fields stay behind read_trace for progressive
    // disclosure instead of inflating the first prompt with quotes from hidden content.
    const evidence = evidenceSources(value)
      .filter((source) => source.kind === "text" && source.text.length && source.text.length <= 2000)
      .map((source) => cite(candidate.input_id, i, source, 0, source.text.length));
    addInitial(i, value, evidence);
  }
  initial.sort((a, b) => a.message_index - b.message_index);
  const answer = {
    identity: { version_id: candidate.version, display_name: candidate.name, answer_model: candidate.llm },
    question: candidate.question, final_message_index: candidate.final_index,
    final_answer: deferred.reduce((text, source) => text.replaceAll(source.text, ""), contentText(raw.messages[candidate.final_index].content)),
    final_evidence: finalSources.filter(source => source.text.length <= limit).map(source => cite(candidate.input_id, candidate.final_index, source, 0, source.text.length)),
    deferred_final_material: deferred.map(source => ({ message_index: candidate.final_index, path: source.path, total_chars: source.text.length })),
    initial_material: initial, instruction_sources: [], citation_inventory: citationInventory(raw, candidate.input_id, candidate.final_index),
    business_chains: businessChains(raw, candidate.input_id, candidate.final_index),
    catalog: traceCatalog(raw), component_catalog: traceComponentIdentities(raw, candidate.input_id, candidate.final_index),
    input_file: "inputs/answer.json", original_answer_timing: { finish_seconds: candidate.answer_timing.finish_seconds },
    answer_generation: getAnswerGeneration(raw, candidate.input_id, candidate.final_index),
    criterion_instruction_sources: criterionInstructionSources(raw, candidate.final_index, task_analysis, candidate.input_id),
    table_check_results: attributionTableChecks(raw, candidate.input_id, candidate.final_index), note: workflowText("attribution-material"),
  };
  const input = { candidate_id: candidate.input_id, task_analysis, material_availability: { public_task: true, final_delivery: true, process_records: raw.messages.some((message,index)=>index!==candidate.final_index && !["user","system","developer"].includes(message.role??"") && message.type!=="private_instruction_omitted"), actual_model_inputs: answerTurnContexts(raw,candidate.final_index).length>0, call_links: traceCatalog(raw).some(row=>row.call_message_index!==undefined) }, ground_truth: { available: reference !== null, value: reference }, answer };
  Object.assign(answer, { norm_directory: attributionNormDirectory({ input, sources }) });
  const focus=taskFocus({ answer }, input.ground_truth, { answer: raw });
  // The complete final remains in answer; the entry point starts from the task,
  // rather than repeating final prose before the execution material.
  delete focus.answers.answer.final_answer;
  const modelInput = { ...input, task_focus: focus, task_analysis: taskAnalysisPresentation(task_analysis, { answer: candidate.input_id }, answer.criterion_instruction_sources),
    answer: modelMaterial(answer, "answer", raw, candidate.input_id, 8000) };
  return { agent: "attribution", profile: "default", request: { input, sources }, modelInput,
    projectModelInput: projectComparisonEvidence, presentedReads: presentedMaterialReads(modelInput.answer, "answer", candidate.input_id) };
}
