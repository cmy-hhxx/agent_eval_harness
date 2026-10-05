import { agentPrompt } from "@eval/prompts";
import { type AgentDefinition, type AgentProfile } from "@eval/contracts";
import requestSchema from "../../../../schemas/comparison/request.schema.json" with { type: "json" };
import resultSchema from "../../../../schemas/comparison/result.schema.json" with { type: "json" };
import submissionSchema from "../../../../schemas/comparison/submission.schema.json" with { type: "json" };
import verificationSubmissionSchema from "../../../../schemas/comparison/verification-submission.schema.json" with { type: "json" };
import { validateEvaluation } from "./validate.js";
import { resolveComparison } from "./resolve.js";
import { comparisonSlotChoices } from "./slots.js";
import type { ComparisonInput } from "./types.js";
import { comparisonSubmissionIssues } from "./submission-validation.js";
import { comparisonIssueContext } from "./submission-feedback.js";
import { resolveVerification, validateVerification, validateMaterialInspection, inspectionSchema, modelInspectionSchema, resolveMaterialInspection, inspectionMatchContext } from "./verification.js";
export * from "./types.js";
export { comparisonSlots, comparisonSlotChoices } from "./slots.js";
export { verificationCheckSlots, verificationCheckAspects, verificationConcerns, unresolvedVerificationConcerns,
  validateVerificationConcerns } from "./verification.js";
export { comparisonScope } from "./pair-scope.js";
// The source agent submits its decision; the workflow attaches later language polish.
const toolNames = [
  "read_trace", "search_trace", "view_image", "calculate", "calculate_pair", "execute_code",
  "read_artifact",
];
export const comparisonProfile: AgentProfile = {
  id: "default",

  requestSchema,
  submissionSchema,
  modelSubmissionSchema(request) {
    const schema = structuredClone(submissionSchema), choices = comparisonSlotChoices(request);
    const row = schema.properties.comparisons.items;
    Object.assign(schema.properties.comparisons, { minItems:choices.length,maxItems:choices.length,items:false,
      prefixItems:choices.map(slot => ({ ...row,type:slot.optional ? ['object','null'] : 'object',
        properties:{ ...row.properties,better_candidate:{ enum:[...slot.advantage_candidates,null] } } })) });
    return schema;
  },
  evidenceSelections: true,
  resultSchema,
  ...agentPrompt("comparison", toolNames),
  toolNames,
  validate: validateEvaluation,
  validateSubmission: comparisonSubmissionIssues,
  validationIssueContext: comparisonIssueContext,
  requiredReads: (request) => Object.entries((request.input as unknown as ComparisonInput).candidates).flatMap(([candidate, material]) =>
    material.deferred_final_material.map(item => ({ candidate, message_index: item.message_index, kind: "text" as const,
      path: item.path, start: 0, end: item.total_chars }))),
  resolve: resolveComparison,
};
export const comparisonAgent: AgentDefinition = {
  id: "comparison",
  profiles: { default: comparisonProfile, verification: {
    id: "verification",
    requestSchema: { ...requestSchema, required: [...requestSchema.required, "comparison_draft"],
      properties: { ...requestSchema.properties, comparison_draft: resultSchema } },
    submissionSchema: verificationSubmissionSchema,
    evidenceSelections: true,
    resultSchema,
    ...agentPrompt("comparison", [...toolNames, "inspect_material"], "verification"),
    toolNames: [...toolNames, "inspect_material"],
    inspection: { schema: inspectionSchema, modelSchema: modelInspectionSchema,
      resolve: resolveMaterialInspection,
      validate: validateMaterialInspection,
      materialContext: inspectionMatchContext },
    requiredReads: comparisonProfile.requiredReads,
    resolve: resolveVerification,
    validate: validateVerification,
  } },
};
