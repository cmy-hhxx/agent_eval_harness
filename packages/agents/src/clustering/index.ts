import { agentPrompt } from "@eval/prompts";
import { ValidationError, type AgentDefinition, type AgentProfile } from "@eval/contracts";
import requestSchema from "../../../../schemas/clustering/request.schema.json" with { type: "json" };
import resultSchema from "../../../../schemas/clustering/result.schema.json" with { type: "json" };
import submissionSchema from "../../../../schemas/clustering/submission.schema.json" with { type: "json" };
import { validateEvaluation } from "./validate.js";
import { categoryRule, categoryAction } from "./organization.js";
import { references, resolveSubmission } from "./references.js";
import type { ClusteringRequest } from "./types.js";
export * from "./types.js";
export * from "./library.js";
export * from "./occurrence-review.js";
export * from "./pending-observations.js";
export { representativeSamples } from "./samples.js";
const prompt = agentPrompt("clustering", [], { fileSubmission: false });
export const clusteringProfile: AgentProfile = {
  id: "default",

  requestSchema,
  submissionSchema,
  resultSchema,
  ...prompt,
  renderPrompt(input, policy) {
    const refs = references(input as unknown as ClusteringRequest);
    // A new attempt can have a refreshed library. Old drafts and error indices must
    // not be interpreted against its new reference table; in-session feedback is mapped below.
    return prompt.renderPrompt(refs.project(input), policy);
  },
  validationIssueContext(_request, _draft, issue) {
    if (!["schema_type", "schema_pattern", "clustering_category_characters"].includes(issue.code) || !/^\/(?:new_classes|class_updates)\/\d+\/category$/.test(issue.path)) return undefined;
    return {
      category_example: "指令遵循",
      ...(["schema_pattern", "clustering_category_characters"].includes(issue.code) ? {
        category_rule: categoryRule, category_action: categoryAction,
      } : {}),
      ...(issue.code === "schema_type" ? { category_rule: "category 直接填写一个问题方向字符串，不使用数组、对象或其他包装，不重复组件和具体问题。" } : {}),
    };
  },
  toolNames: [],
  resolve: resolveSubmission,
  validate(request, result, audit) {
    try { validateEvaluation(request, result, audit); }
    catch (error) {
      if (error instanceof ValidationError && error.issues)
        throw new ValidationError(references(request.input as unknown as ClusteringRequest).project(error.issues));
      throw error;
    }
  },
};
export const clusteringAgent: AgentDefinition = {
  id: "clustering",
  profiles: { default: clusteringProfile },
};
