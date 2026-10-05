import { agentPrompt } from "@eval/prompts";
import { ValidationError, type AgentDefinition, type AgentProfile } from "@eval/contracts";
import requestSchema from "../../../../schemas/clustering/request.schema.json" with { type: "json" };
import resultSchema from "../../../../schemas/clustering/result.schema.json" with { type: "json" };
import submissionSchema from "../../../../schemas/clustering/submission.schema.json" with { type: "json" };
import { validateEvaluation } from "./validate.js";
import { categorySegmentRule, categorySegmentAction } from "./organization.js";
import { references, resolveSubmission } from "./references.js";
import type { ClusteringRequest } from "./types.js";
export * from "./types.js";
export * from "./library.js";
export * from "./occurrence-review.js";
const prompt = agentPrompt("clustering", []);
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
    if (!["schema_type", "schema_pattern", "clustering_category_characters"].includes(issue.code) || !/^\/(?:new_classes|class_updates)\/\d+\/category_paths(?:\/\d+){0,2}$/.test(issue.path)) return undefined;
    return {
      category_paths_example: [["主题", "子主题", "具体方面"]],
      ...(["schema_pattern", "clustering_category_characters"].includes(issue.code) ? {
        category_paths_rule: categorySegmentRule, category_paths_action: categorySegmentAction,
      } : {}),
      ...(issue.code === "schema_type" ? { category_paths_rule: "category_paths 是路径数组；每条路径也是数组，每级直接填写字符串，不使用 item 对象或其他包装。每类最多三条路径，每条最多三级。" } : {}),
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
