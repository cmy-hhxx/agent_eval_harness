import { agentPrompt } from "@eval/prompts";
import type { AgentDefinition, AgentProfile, CriteriaInput } from "@eval/contracts";
import requestSchema from "../../../../schemas/criteria/request.schema.json" with { type: "json" };
import submissionSchema from "../../../../schemas/criteria/submission.schema.json" with { type: "json" };
import resultSchema from "../../../../schemas/criteria/result.schema.json" with { type: "json" };
import { validateEvaluation } from "./validate.js";
import { criteriaSources } from "./sources.js";
import { resolveCriteria } from "./resolve.js";

export * from "./types.js";
export { criteriaSources } from "./sources.js";
export type { CriterionSource } from "./sources.js";
export type { CriteriaSubmission } from "./resolve.js";
const prompt = agentPrompt("criteria", []);
export const criteriaProfile: AgentProfile = {
  id: "default",
  requestSchema,
  submissionSchema,
  resultSchema,
  ...prompt,
  renderPrompt(input, policy, failure) {
    const value = input as unknown as CriteriaInput;
    return prompt.renderPrompt({ candidate_ids: value.candidates.map((candidate) => candidate.candidate_id),
      source_catalog: criteriaSources(value) as unknown as import("@eval/contracts").JsonObject[] }, policy, failure);
  },
  toolNames: [],
  resolve: resolveCriteria,
  validate: validateEvaluation,
};
export const criteriaAgent: AgentDefinition = {
  id: "criteria",
  profiles: { default: criteriaProfile },
};
