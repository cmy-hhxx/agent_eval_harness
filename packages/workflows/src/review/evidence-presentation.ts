import { projectEvidenceReferences, type EvidenceBank, type JsonObject, type TraceRead } from "@eval/contracts";
import { parseEvidenceCoordinates } from "@eval/tools";

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
  visit(material.trace_overview);
  visit(object(material.citation_inventory)?.references);
  for (const field of ["norm_directory", "instruction_sources", "initial_material"])
    for (const entry of Array.isArray(material[field]) ? material[field] : []) visit(object(entry)?.evidence);
  return reads;
}

/** Projection is limited to fields constructed by this Workflow; raw source values never enter the traversal. */
function materialEvidence(value: unknown, bank: EvidenceBank): unknown {
  const material = object(value);
  if (!material) return value;
  const project = <T>(value: T) => projectEvidenceReferences(value, bank);
  const array = (value: unknown) => Array.isArray(value) ? value : [];
  const generated = ["business_chains", "final_evidence", "question_evidence", "answer_generation", "criterion_instruction_sources", "trace_overview", "review_sections"];
  const result = { ...material };
  for (const field of generated) if (Object.hasOwn(material, field)) result[field] = project(material[field]);
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
const materialMap = (value: unknown, bank: EvidenceBank) => object(value)
  ? Object.fromEntries(Object.entries(value as JsonObject).map(([key, value]) => [key, materialEvidence(value, bank)])) : value;

export function projectComparisonEvidence(input: JsonObject, bank: EvidenceBank): JsonObject {
  const result = { ...input };
  for (const field of ["answer"]) if (Object.hasOwn(input, field)) result[field] = materialEvidence(input[field], bank);
  for (const field of ["candidates", "reference_materials"]) if (Object.hasOwn(input, field)) result[field] = materialMap(input[field], bank);
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
