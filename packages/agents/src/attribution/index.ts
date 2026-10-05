import { agentPrompt } from "@eval/prompts";
import { type AgentDefinition, type AgentProfile } from "@eval/contracts";
import requestSchema from "../../../../schemas/attribution/request.schema.json" with { type: "json" };
import submissionSchema from "../../../../schemas/attribution/submission.schema.json" with { type: "json" };
import resultSchema from "../../../../schemas/attribution/result.schema.json" with { type: "json" };
import { validateEvaluation, validateSubmission } from "./validate.js";
import { findingIssueContext } from "./finding-feedback.js";
import { resolveSubmission } from "./resolve.js";
import { numericReferenceDirectory } from "./units.js";
import { attributionSubmissionSchema } from "./submission-schema.js";
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
  modelSubmissionSchema: attributionSubmissionSchema,
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
