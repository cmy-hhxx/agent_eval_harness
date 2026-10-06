import { ValidationError, type AgentRequest } from "@eval/contracts";
import submissionSchema from "../../../../schemas/attribution/submission.schema.json" with { type: "json" };
import { numericReferenceMaterials } from "./units.js";
import { normDirectoryIssues } from "./norm-directory.js";
import { attributionFindingBasis } from "./finding-basis.js";
import type { TaskAnalysis } from "@eval/contracts";

/** The tool contract and repair feedback share the same request-derived shape. */
export function attributionSubmissionSchema(request: AgentRequest) {
  const issues = normDirectoryIssues(request);
  if (issues.length) throw new ValidationError(issues);
  const schema = structuredClone(submissionSchema);
  const analysis=request.input.task_analysis as unknown as TaskAnalysis;
  const checkCount=[...analysis.requirements,...analysis.scoring_points,...analysis.red_flags]
    .filter(item=>!item.applies_to.length||item.applies_to.includes(request.input.candidate_id as string)).length;
  Object.assign(schema.properties.criterion_assessments,{minItems:checkCount,maxItems:checkCount});
  const indices = attributionFindingBasis(request.input).map(item => item.basis_index);
  for(const field of ["strengths","problems"] as const)
    Object.assign(schema.properties[field].items.properties.basis_index, { enum: [...indices, null] });
  const groundTruth = request.input.ground_truth as { available: boolean; value: unknown };
  if (!groundTruth.available) {
    Object.assign(schema.properties.is_correct,{const:null});
    Object.assign(schema.properties.correctness_reason,{const:""});
    Object.assign(schema.properties.correctness_evidence_indices,{maxItems:0});
  } else Object.assign(schema.properties.correctness_reason,{minLength:1});
  const references = numericReferenceMaterials(request.input).direct;
  if (!references.length) Object.assign(schema.properties.numeric_checks, { maxItems: 0 });
  else (schema.properties.numeric_checks.items.properties.reference_index as { enum?: number[] }).enum = references.map(item => item.reference_index + 1);
  return schema;
}
