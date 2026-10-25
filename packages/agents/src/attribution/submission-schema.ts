import { ValidationError, type AgentRequest } from "@eval/contracts";
import submissionSchema from "../../../../schemas/attribution/submission.schema.json" with { type: "json" };
import { numericReferenceDirectory } from "./units.js";
import { normDirectoryIssues } from "./norm-directory.js";
import { attributionFindingBasis } from "./finding-basis.js";
import type { TaskAnalysis } from "@eval/contracts";
import { componentCatalogIssues, responsibilityIdentities, responsibilityFunctions } from "./responsibility.js";
import { attributionTaxonomy } from "@eval/prompts";
import { parseTraceTables, type TableCheckResult } from "@eval/tools";
import { businessChainDirectory } from "./investigation.js";

/** The tool contract and repair feedback share the same request-derived shape. */
export function attributionSubmissionSchema(request: AgentRequest) {
  const issues = [...normDirectoryIssues(request), ...componentCatalogIssues(request)];
  if (issues.length) throw new ValidationError(issues);
  const schema = structuredClone(submissionSchema);
  const boundaries = businessChainDirectory(request).map(chain => ({ properties: {
    chain_index: { const: chain.chain_index }, step_index: { enum: chain.checkpoints.flatMap((point, i) => point.availability === "available" ? [i + 1] : []) },
  } }));
  if (boundaries.length) Object.assign(schema.properties.investigation_facts.items, { anyOf: boundaries });
  else Object.assign(schema.properties.investigation_facts, { maxItems: 0 });
  if (request.input.allow_standard_conflict !== true)
    delete (schema.properties as Record<string, unknown>).standard_conflict;
  const responsibility = schema.properties.problems.items.properties.component.items;
  Object.assign(responsibility.properties.actor_index, { maximum: responsibilityIdentities(request).length });
  Object.assign(responsibility.properties.function_index, { maximum: responsibilityFunctions.length });
  Object.assign(responsibility.properties.failure_stage_index, { maximum: attributionTaxonomy.stages.length });
  const analysis=request.input.task_analysis as unknown as TaskAnalysis;
  const checkCount=[...analysis.requirements,...analysis.scoring_points,...analysis.red_flags]
    .filter(item=>!item.applies_to.length||item.applies_to.includes(request.input.candidate_id as string)).length;
  Object.assign(schema.properties.criterion_assessments,{minItems:checkCount,maxItems:checkCount});
  Object.assign(schema.properties.core_requirements.items, {
    enum: analysis.requirements.flatMap((item, index) => item.applies_to.length ? [] : [index + 1]),
  });
  const indices = attributionFindingBasis(request.input).map(item => item.basis_index);
  for(const field of ["strengths","problems"] as const)
    Object.assign(schema.properties[field].items.properties.basis_index, { enum: [...indices, null] });
  const checks = (request.input.answer as { table_check_results?: TableCheckResult[] }).table_check_results ?? [];
  const tables = checks.length ? parseTraceTables(request.sources.answer.value as { messages: unknown[] }, request.sources.answer.id) : [];
  const choices = checks.filter(check => check.rows.length).map(check => ({
    properties: { table_index: { const: tables.findIndex(table => table.table_id === check.answer_table_id) + 1 },
      row_index: { enum: check.rows.map(row => row.row_index) } },
  }));
  if (choices.length) Object.assign(schema.properties.table_resolutions.items, { anyOf: choices });
  else schema.properties.table_resolutions.maxItems = 0;
  const groundTruth = request.input.ground_truth as { available: boolean; value: unknown };
  if (!groundTruth.available) {
    for (const field of ["is_correct", "correctness_reason", "correctness_evidence_indices"] as const)
      delete (schema.properties as Record<string, unknown>)[field];
  } else {
    schema.required.push("is_correct", "correctness_reason", "correctness_evidence_indices");
    Object.assign(schema.properties.correctness_reason,{minLength:1});
  }
  const references = groundTruth.available ? numericReferenceDirectory(groundTruth.value) : [];
  if (!references.length) Object.assign(schema.properties.numeric_checks, { maxItems: 0 });
  else (schema.properties.numeric_checks.items.properties.reference_index as { enum?: number[] }).enum = references.map(item => item.reference_index + 1);
  return schema;
}
