import { projectEvidenceReferences, type EvidenceBank, type JsonObject } from "@eval/contracts";
const object = (value: unknown): JsonObject | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;

/** Projection is limited to fields constructed by this Workflow; raw source values never enter the traversal. */
function materialEvidence(value: unknown, bank: EvidenceBank): unknown {
  const material = object(value);
  if (!material) return value;
  const project = <T>(value: T) => projectEvidenceReferences(value, bank);
  const array = (value: unknown) => Array.isArray(value) ? value : [];
  const generated = ["final_evidence", "question_evidence", "answer_generation", "criterion_instruction_sources"];
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
  for (const field of ["attributions", "source_review", "comparison_slots", "material_inspection", "pending_concerns"])
    if (Object.hasOwn(input, field)) result[field] = projectEvidenceReferences(input[field], bank);
  const review = object(input.review_context);
  if (review && Object.hasOwn(review, "concerns")) result.review_context = { ...review, concerns: projectEvidenceReferences(review.concerns, bank) };
  const inspection = object(input.inspection_context);
  if (inspection && Object.hasOwn(inspection, "verification_concerns")) result.inspection_context = { ...inspection,
    verification_concerns: projectEvidenceReferences(inspection.verification_concerns, bank) };
  if (Array.isArray(input.sections)) result.sections = input.sections.map(entry => {
    const section = object(entry)!;
    if (section.kind === "original_materials") return { ...section, materials: Array.isArray(section.materials)
      ? section.materials.map(entry => materialEvidence(entry, bank)) : section.materials };
    if (section.kind === "source_directory") return { ...section,
      candidate_sources: materialMap(section.candidate_sources, bank),
      ...Object.fromEntries(["requirement_catalog", "findings", "source_review", "comparison_slots", "pending_concerns"]
        .filter(field => Object.hasOwn(section, field)).map(field => [field, projectEvidenceReferences(section[field], bank)])) };
    if (section.kind === "proposed_comparison") return projectEvidenceReferences(section, bank);
    return section;
  });
  return result;
}
