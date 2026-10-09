import { agentPrompt } from "@eval/prompts";
export { standardConflictReviewInstructions } from "@eval/prompts";
import { type AgentDefinition, type AgentProfile } from "@eval/contracts";
import requestSchema from "../../../../schemas/attribution/request.schema.json" with { type: "json" };
import submissionSchema from "../../../../schemas/attribution/submission.schema.json" with { type: "json" };
import resultSchema from "../../../../schemas/attribution/result.schema.json" with { type: "json" };
import { validateEvaluation } from "./validate.js";
import { resolveModelSubmission, validateModelSubmission } from "./submission.js";
import { numericReferenceDirectory } from "./units.js";
import { findingIssueContext } from "./finding-feedback.js";
import { attributionSubmissionSchema } from "./submission-schema.js";
import { attributionFindingBasis } from "./finding-basis.js";
export { attributionFindingBasis } from "./finding-basis.js";
export { attributionNormDirectory, type AttributionNorm } from "./norm-directory.js";
export { numericReferenceDirectory } from "./units.js";
export * from "./types.js";
export { attributionTableChecks, attributionTableReview } from "./table-review.js";
export type { TableReviewConcern } from "./table-review.js";
// Attribution resolves evidence IDs into source locations before the result is accepted.
const toolNames = [
  "read_trace", "search_trace", "view_image", "calculate", "execute_code",
  "read_artifact",
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
  jsonStringSubmission: true,
  renderPrompt(input, policy, failure) {
    const analysis = input.task_analysis as { requirements: Record<string, unknown>[]; scoring_points: Record<string, unknown>[]; red_flags: Record<string, unknown>[] };
    const answer = input.answer as Record<string, unknown>;
    const { norm_directory: _norms, ...answerMaterial } = answer;
    const requirements: Record<string, unknown>[] = analysis.requirements.map((item,index) => ({ ...item,
      requirement_index: Number(item.requirement_index ?? index) + 1 }));
    const focus = input.task_focus as Record<string,unknown> | undefined;
    const shown = { ...input, task_analysis: { ...analysis, requirements },
      criterion_check_count: requirements.length+analysis.scoring_points.length+analysis.red_flags.length,
      criterion_checks: [...requirements,...analysis.scoring_points,...analysis.red_flags].map(item => ({ text:item.text })),
      answer: answerMaterial,
      finding_basis: attributionFindingBasis(input).map(({requirement_index:_requirement,norm_index:_norm,...choice})=>choice),
      ...(focus ? { task_focus: { ...focus, common_requirements: Array.isArray(focus.common_requirements)
        ? focus.common_requirements.map((item: any) => ({...item,requirement_index:item.requirement_index+1})) : focus.common_requirements } } : {}),
    };
    const truth = input.ground_truth as { available: boolean; value: unknown };
    const numeric = truth.available ? numericReferenceDirectory(truth.value) : [];
    return prompt.renderPrompt({ ...shown,
      numeric_references: numeric.map(item => ({...item,reference_index:item.reference_index+1})),
    }, policy, failure);
  },
  toolNames,
  requiredReads: (request) => (request.input.answer as { deferred_final_material: { message_index: number; path: string; total_chars: number }[] }).deferred_final_material.map((material) => ({
    candidate: "answer", message_index: material.message_index, kind: "text" as const,
    path: material.path, start: 0, end: material.total_chars,
  })),
  validate: validateEvaluation,
  validateSubmission: validateModelSubmission,
  validationIssueContext: findingIssueContext,

  resolve: resolveModelSubmission,
};
export const attributionAgent: AgentDefinition = {
  id: "attribution",
  profiles: { default: attributionProfile },
};
