export {checkAttributionLanguage,type AttributionLanguageField,type AttributionLanguageStatus} from './language.js';
import { agentPrompt, attributionConditionalRules } from "@eval/prompts";
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
import { investigationMaterial } from "./investigation-material.js";
export { attributionFindingBasis } from "./finding-basis.js";
export { buildAttributionExecutionNodes, buildAttributionTransitions, type AttributionExecutionNode, type AttributionTransition, type TransitionKind, type TransitionBoundary } from "./transitions.js";
export { attributionNormDirectory, type AttributionNorm } from "./norm-directory.js";
export { numericReferenceDirectory } from "./units.js";
export * from "./types.js";
export { responsibilityLabels,responsibilityComponentName,responsibilityDisplay,responsibilityComponent,transferChanged,responsibilityCode,selectableTransitions,type ResponsibilityMaterial } from "./responsibility.js";
export { attributionTableChecks, attributionTableReview } from "./table-review.js";
export type { TableReviewConcern } from "./table-review.js";
// Attribution resolves evidence IDs into source locations before the result is accepted.
const toolNames = [
  "read_execution", "read_responsibility_chain", "read_trace", "search_trace", "view_image", "calculate", "execute_code",
  "read_artifact",
];
const prompt = agentPrompt("attribution", toolNames, { fileSubmission:false });
export const attributionProfile: AgentProfile = {
  id: "default",
  requestSchema,
  submissionSchema,
  evidenceSelections: true,
  modelSubmissionSchema: attributionSubmissionSchema,
  resultSchema,
  ...prompt,
  renderPrompt(input, policy, failure) {
    const analysis = input.task_analysis as { requirements: Record<string, unknown>[]; scoring_points: Record<string, unknown>[]; red_flags: Record<string, unknown>[] };
    const answer = input.answer as Record<string, unknown>;
    const { norm_directory: _norms, component_catalog: _actors, business_chains: _chains, ...answerMaterial } = answer;
    const requirements: Record<string, unknown>[] = analysis.requirements.map((item,index) => ({ ...item,
      requirement_index: Number(item.requirement_index ?? index) + 1 }));
    const { allow_standard_conflict: _standardReview, ...material } = input;
    const shown = { ...material, task_analysis: { ...analysis, requirements },
      answer: answerMaterial,
      finding_basis: attributionFindingBasis(input).map(({requirement_index:_requirement,norm_index:_norm,...choice})=>choice),
    };
    const truth = input.ground_truth as { available: boolean; value: unknown };
    const numeric = truth.available ? numericReferenceDirectory(truth.value) : [];
    const tables = answer.table_check_results as { rows: unknown[] }[] | undefined;
    const images = answer.final_images as { image_count: number } | undefined;
    const rules = attributionConditionalRules({ standardAnswer: truth.available, numeric: numeric.length > 0,
      tableDoubts: Number(answer.table_check_count ?? 0) > 0 || (tables?.some(table => table.rows.length > 0) ?? false), images: (images?.image_count ?? 0) > 0,
      captureGaps: Array.isArray(answer.capture_gaps) && answer.capture_gaps.length > 0 });
    return (rules ? rules + "\n\n" : "") + prompt.renderPrompt(investigationMaterial({ ...shown,
      numeric_references: numeric.map(item => ({...item,reference_index:item.reference_index+1})),
    }), policy, failure);
  },
  toolNames,
  validate: validateEvaluation,
  validateSubmission: validateModelSubmission,
  validationIssueContext: findingIssueContext,

  resolve: resolveModelSubmission,
};
export const attributionAgent: AgentDefinition = {
  id: "attribution",
  profiles: { default: attributionProfile },
};
