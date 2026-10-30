import { evidenceId, projectEvidenceReferences, type EvidenceBank, type JsonObject, type TraceRead } from "@eval/contracts";
import { parseEvidenceCoordinates, resolveEvidence } from "@eval/tools";
import { ValidationError } from "@eval/contracts";
import { executionFactsView } from "./process-material.js";

const object = (value: unknown): JsonObject | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;

/** Only generated navigation envelopes, never arbitrary business objects or full unseen references. */
export function presentedMaterialReads(material: JsonObject, candidate: string, inputId: string): TraceRead[] {
  const reads: TraceRead[] = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const item = value as JsonObject, reference = object(item.reference);
    const quote = item.quote ?? item.quote_preview;
    const point = typeof reference?.evidence_id === "string" ? parseEvidenceCoordinates(reference.evidence_id) : null;
    if (typeof quote === "string" && quote.length && point && point.kind !== "image" && point.input_id === inputId)
      reads.push({ candidate, message_index: point.message_index, kind: point.kind, path: point.path,
        start: point.start, end: Math.min(point.end, point.start + quote.length) });
    for (const child of Object.values(item)) if (child && typeof child === "object") visit(child);
  };
  visit(material.process_evidence);
  visit(material.execution_facts);
  for (const row of Array.isArray(material.source_directory) ? material.source_directory : []) {
    visit(object(row)?.identity_evidence); visit(object(row)?.generated_arguments);
  }
  visit(material.final_evidence);
  visit(material.trace_overview);
  visit(material.review_sections);
  visit(material.component_scene);
  visit(material.actor_catalog);
  for(const block of (object(material.answer_generation)?.reasoning_blocks??[]) as JsonObject[])
    visit({...block,quote:block.text});
  visit(object(material.citation_inventory)?.references);
  for (const field of ["norm_directory", "instruction_sources", "initial_material"])
    for (const entry of Array.isArray(material[field]) ? material[field] : []) visit(object(entry)?.evidence);
  return reads;
}

/** Projection is limited to fields constructed by this Workflow; raw source values never enter the traversal. */
function evidenceOnce(value: unknown, shown: Set<string>): unknown {
  if (!Array.isArray(value)) return value;
  return value.map(entry => {
    const node = object(entry), reference = object(node?.reference), quote = node?.quote;
    const point = typeof reference?.evidence_id === "string" ? parseEvidenceCoordinates(reference.evidence_id) : undefined;
    if (!node || typeof quote !== "string" || !point || point.kind === "image" || quote.length !== point.end - point.start) return entry;
    const id = reference!.evidence_id as string;
    if (!shown.has(id)) { shown.add(id); return entry; }
    const { quote: _quote, quote_preview: _preview, ...link } = node;
    return { ...link, already_shown: true };
  });
}
/** A preview selects exactly its displayed bytes; full long excerpts expose separate source ranges. */
function boundedEvidence(value: unknown, limit: number): unknown {
  if (Array.isArray(value)) return value.map(child => boundedEvidence(child, limit));
  const node = object(value);
  if (!node) return value;
  const reference = object(node.reference), point = typeof reference?.evidence_id === "string" ? parseEvidenceCoordinates(reference.evidence_id) : undefined;
  if (point && point.kind !== "image") {
    const quote = typeof node.quote === "string" ? node.quote : node.quote_preview;
    if (typeof quote === "string" && quote.length && quote.length <= point.end - point.start) {
      const { reference: _reference, quote: _quote, quote_preview: _preview, ...navigation } = node;
      const excerpt = (start: number, end: number) => ({ reference: { evidence_id: evidenceId(point.input_id,
        point.message_index, point.kind, point.path, point.start + start, point.start + end) }, quote: quote.slice(start, end) });
      if (quote.length > limit) return { ...navigation, excerpts: Array.from({ length: Math.ceil(quote.length / limit) }, (_, index) =>
        excerpt(index * limit, Math.min(quote.length, (index + 1) * limit))) };
      return { ...node, reference: excerpt(0, quote.length).reference };
    }
  }
  return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, boundedEvidence(child, limit)]));
}
function materialEvidence(value: unknown, bank: EvidenceBank, shown?: Set<string>, maxQuoteChars?: number): unknown {
  const material = object(value);
  if (!material) return value;
  const project = <T>(value: T) => projectEvidenceReferences(maxQuoteChars === undefined ? value : boundedEvidence(value, maxQuoteChars), bank, maxQuoteChars);
  const array = (value: unknown) => Array.isArray(value) ? value : [];
  const generated = ["final_evidence", "process_evidence", "execution_facts", "execution_graph", "transition_evidence", "question_evidence", "answer_generation", "criterion_instruction_sources", "trace_overview", "review_sections", "component_scene"];
  const result = { ...material };
  for (const field of generated) if (Object.hasOwn(material, field)) result[field] = project(shown &&
    ["process_evidence", "final_evidence"].includes(field) ? evidenceOnce(material[field], shown) : material[field]);
  if (Array.isArray(material.source_directory)) result.source_directory = material.source_directory.map(row => ({ ...object(row),
    identity_evidence: project(object(row)?.identity_evidence), generated_arguments: project(object(row)?.generated_arguments) }));
  const graph = object(result.execution_graph);
  if (graph) result.execution_graph = { ...graph, boundaries: array(graph.boundaries).map(value => {
    const boundary = object(value)!;
    const indices = (values: unknown) => array(values).map(value => {
      const index = object(object(value)?.reference)?.evidence_index;
      if (!Number.isInteger(index)) throw new Error("Execution boundary evidence was not registered");
      return index;
    });
    const { before, after, ...identity } = boundary;
    return { ...identity, before_evidence_indices: indices(before), after_evidence_indices: indices(after) };
  }) };
  if (Array.isArray(material.norm_directory)) result.norm_directory = material.norm_directory.map(entry => {
    const original = object(entry)!;
    return { ...original, evidence: project(original.evidence) };
  });
  if (Array.isArray(material.initial_material)) result.initial_material = material.initial_material.map(entry => {
    const original = object(entry)!;
    return { ...original, evidence: project(original.evidence) }; // original.value stays untouched
  });
  if (Array.isArray(material.instruction_sources)) result.instruction_sources = material.instruction_sources.map(entry => {
    const original = object(entry)!;
    return { ...original, evidence: project(original.evidence) }; // original.content stays untouched
  });
  const citations = object(material.citation_inventory);
  if (citations) result.citation_inventory = { ...citations, references: project(citations.references) };
  if (Array.isArray(material.table_check_results)) result.table_check_results = material.table_check_results.map(entry => {
    const table = object(entry)!;
    return { ...table, rows: array(table.rows).map(entry => {
      const row = object(entry)!, answer = object(row.answer)!;
      return { ...row, answer: { ...answer, evidence: project(answer.evidence) },
        sources: array(row.sources).map(entry => { const source = object(entry)!; return { ...source, evidence: project(source.evidence) }; }) };
    }) };
  });
  return result;
}
const materialMap = (value: unknown, bank: EvidenceBank, maxQuoteChars?: number) => object(value)
  ? Object.fromEntries(Object.entries(value as JsonObject).map(([key, value]) => [key, materialEvidence(value, bank, undefined, maxQuoteChars)])) : value;

export function projectComparisonEvidence(input: JsonObject, bank: EvidenceBank, maxQuoteChars?: number): JsonObject {
  const result = { ...input };
  if (Array.isArray(input.actor_catalog)) result.actor_catalog = projectEvidenceReferences(input.actor_catalog, bank, maxQuoteChars);
  const shown = Object.hasOwn(input, "compact") ? new Set<string>() : undefined;
  if (shown) result.compact = projectCompactEvidence(input.compact, bank, shown);
  for (const field of ["answer"]) if (Object.hasOwn(input, field)) result[field] = materialEvidence(input[field], bank, shown, maxQuoteChars);
  for (const field of ["candidates", "reference_materials"]) if (Object.hasOwn(input, field)) result[field] = materialMap(input[field], bank, maxQuoteChars);
  for (const field of ["attributions", "source_review", "comparison_slots", "material_inspection"])
    if (Object.hasOwn(input, field)) result[field] = projectEvidenceReferences(input[field], bank);
  const inspection = object(input.inspection_context);
  if (inspection && Object.hasOwn(inspection, "verification_concerns")) result.inspection_context = { ...inspection,
    verification_concerns: projectEvidenceReferences(inspection.verification_concerns, bank) };
  if (Array.isArray(input.sections)) result.sections = input.sections.map(entry => {
    const section = object(entry)!;
    if (section.kind === "original_materials") return { ...section, materials: Array.isArray(section.materials)
      ? section.materials.map(entry => materialEvidence(entry, bank)) : section.materials };
    if (section.kind === "source_directory") return { ...section,
      candidate_sources: materialMap(section.candidate_sources, bank),
      ...Object.fromEntries(["requirement_catalog", "findings", "source_review", "comparison_slots"]
        .filter(field => Object.hasOwn(section, field)).map(field => [field, projectEvidenceReferences(section[field], bank)])) };
    if (section.kind === "proposed_comparison") return projectEvidenceReferences(section, bank);
    return section;
  });
  return result;
}

/** Only this reserved code-hydrated envelope is original evidence; the rest remains model summary/data. */
export function compactSourceEvidence(value: unknown): JsonObject[] {
  if (Array.isArray(value)) return value.flatMap(compactSourceEvidence);
  const node = object(value);
  if (!node) return [];
  return Object.entries(node).flatMap(([key, child]) => compactMeta(node, key) ? [] : key === "source_evidence" && Array.isArray(child)
    ? child as JsonObject[] : compactSourceEvidence(child));
}
const compactMeta = (node: JsonObject, key: string) => key === "meta" && Array.isArray(node.turns) && Object.hasOwn(node, "session_overview");
/** Keep semantic evidence and input changes; stored compact retains code proofs and repeated source locations. */
export function compactNavigation(value: JsonObject, completeFinal: boolean): JsonObject {
  const { meta: _meta, components: _components, ...navigation } = value;
  const { batch_id: _batch, case_id: _case, model: _model, source_input_id: _source,
    summary_origin: _origin, trace_ids: _traces, ...facts } = object(value.meta) ?? {};
  return { ...navigation, ...(Object.keys(facts).length ? { meta: facts } : {}), turns: (value.turns as JsonObject[]).map(turn => {
    const { final_answer, execution_facts, components: _components, ...process } = turn;
    const facts = object(execution_facts);
    const view = { ...process, ...(facts ? { execution_facts: executionFactsView(facts) } : {}) };
    return completeFinal ? view : { ...view, final_answer };
  }) };
}
export function projectCompactEvidence(value: unknown, bank: EvidenceBank, shown = new Set<string>()): unknown {
  if (Array.isArray(value)) return value.map(child => projectCompactEvidence(child, bank, shown));
  const node = object(value);
  if (!node) return value;
  return Object.fromEntries(Object.entries(node).filter(([key]) => key !== "summary_origin").map(([key, child]) => [key,
    compactMeta(node, key) ? child : key === "source_evidence" ? projectEvidenceReferences((evidenceOnce(child, shown) as JsonObject[]).map(entry => {
      const { location: _location, message_index: _message, ...citation } = entry;
      const point = parseEvidenceCoordinates((entry.reference as JsonObject).evidence_id as string);
      return { ...citation, ...(entry.quote && point && point.kind !== "image" ? { read_request: { candidate: "answer",
        message_index: point.message_index, path: point.path, offset: point.start, max_chars: 1600 } } : {}) };
    }), bank, 400)
      : key === "source_values" && Array.isArray(child) ? child.map(entry => {
        const { location, ...fact } = entry as JsonObject, point = location as JsonObject;
        return { ...projectCompactEvidence(fact, bank, shown) as JsonObject,
          location: { path: point.path, field_path: point.field_path } };
      })
      : projectCompactEvidence(child, bank, shown)]));
}
export function compactPresentedReads(value: unknown, candidate: string, inputId: string): TraceRead[] {
  return presentedMaterialReads({ process_evidence: compactSourceEvidence(value) }, candidate, inputId);
}

/** Summary prose never becomes a quote. Every reserved source envelope is resolved from source again. */
export function verifiedCompact<T>(value: T, raw: { messages: unknown[] }, original: { messages: unknown[] }, inputId: string): T {
  const audit = { traceReads: [], viewedImages: [] };
  const quotes = new Map<string, { publicQuote: string; originalQuote: string }>();
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    const node = object(value);
    if (!node) return value;
    return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, compactMeta(node, key) ? child : key === "source_evidence" && Array.isArray(child)
      ? child.map(value => {
        const entry = object(value)!, reference = object(entry.reference) as { evidence_id: string };
        let source = quotes.get(reference.evidence_id);
        if (!source) {
          source = { publicQuote: resolveEvidence(raw, reference, "answer", audit, "/compact/source_evidence", inputId).quote,
            originalQuote: resolveEvidence(original, reference, "answer", audit, "/compact/source_evidence", inputId).quote };
          quotes.set(reference.evidence_id, source);
        }
        if (source.publicQuote !== source.originalQuote || entry.quote !== source.originalQuote)
          throw new ValidationError([{ category: "evidence", code: "compact_original_scope", path: "/compact/source_evidence",
            message: "摘要引用必须与可见原始片段一致，摘要文本不能代替原文。" }]);
        return { ...entry, quote: source.originalQuote };
      }) : visit(child)]));
  };
  return visit(value) as T;
}
