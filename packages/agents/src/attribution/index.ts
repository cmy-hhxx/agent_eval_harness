import { agentPrompt } from "@eval/prompts";
import { ValidationError, type AgentDefinition, type AgentProfile } from "@eval/contracts";
import requestSchema from "../../../../schemas/attribution/request.schema.json" with { type: "json" };
import submissionSchema from "../../../../schemas/attribution/submission.schema.json" with { type: "json" };
import resultSchema from "../../../../schemas/attribution/result.schema.json" with { type: "json" };
import { validateEvaluation, validateSubmission } from "./validate.js";
import { findingIssueContext } from "./finding-feedback.js";
import { resolveSubmission } from "./resolve.js";
import { numericReferenceDirectory } from "./units.js";
import { normDirectoryIssues, attributionNormDirectory } from "./norm-directory.js";
export { attributionNormDirectory, type AttributionNorm } from "./norm-directory.js";
export { numericReferenceDirectory } from "./units.js";
export * from "./types.js";
export { attributionTableChecks, attributionTableReview } from "./table-review.js";
export type { TableReviewConcern } from "./table-review.js";
// Attribution resolves evidence IDs into source locations before the result is accepted.
const toolNames = [
  "read_trace", "search_trace", "view_image", "calculate", "execute_code",
  "read_artifact", "check_table",
];
const prompt = agentPrompt("attribution", toolNames);
export const attributionProfile: AgentProfile = {
  id: "default",

  requestSchema,
  submissionSchema,
  evidenceSelections: true,
  modelSubmissionSchema(request) {
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
  },
  resultSchema,
  ...prompt,
  renderPrompt(input, policy, failure) {
    const groundTruth = input.ground_truth as { available: boolean; value: unknown };
    return prompt.renderPrompt({ ...input, numeric_references: groundTruth?.available ? numericReferenceDirectory(groundTruth.value) : [] }, policy, failure);
  },
  toolNames,
  requiredReads: (request) => (request.input.answer as { deferred_final_material: { message_index: number; path: string; total_chars: number }[] }).deferred_final_material.map((material) => ({
    candidate: "answer", message_index: material.message_index, kind: "text" as const,
    path: material.path, start: 0, end: material.total_chars,
  })),
  validate: validateEvaluation,
  validateSubmission,
  validationIssueContext: findingIssueContext,
  resolve: resolveSubmission,
};
export const attributionAgent: AgentDefinition = {
  id: "attribution",
  profiles: { default: attributionProfile },
};
