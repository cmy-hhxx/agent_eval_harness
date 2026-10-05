import { ValidationError, type AgentRequest } from "@eval/contracts";
import submissionSchema from "../../../../schemas/attribution/submission.schema.json" with { type: "json" };
import { numericReferenceDirectory } from "./units.js";
import { normDirectoryIssues, attributionNormDirectory } from "./norm-directory.js";

/** The tool contract and repair feedback share the same request-derived shape. */
export function attributionSubmissionSchema(request: AgentRequest) {
  const issues = normDirectoryIssues(request);
  if (issues.length) throw new ValidationError(issues);
  const schema = structuredClone(submissionSchema);
  const indices = attributionNormDirectory(request).map(item => item.norm_index);
  Object.assign(schema.properties.findings.items.properties.norm_index, { enum: [...indices, null] });
  const fields = ["is_correct", "correctness_reason", "correctness_evidence"] as const;
  if ((request.input.ground_truth as { available: boolean }).available) schema.required.push(...fields);
  else for (const field of fields) delete (schema.properties as Partial<typeof schema.properties>)[field];
  const groundTruth = request.input.ground_truth as { available: boolean; value: unknown };
  const references = groundTruth.available ? numericReferenceDirectory(groundTruth.value) : [];
  if (!references.length) schema.properties.numeric_checks.maxItems = 0;
  else (schema.properties.numeric_checks.items.properties.reference_index as { enum?: number[] }).enum = references.map(item => item.reference_index);
  return schema;
}
