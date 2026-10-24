import { agentPrompt } from "@eval/prompts";
import type { AgentDefinition, AgentProfile, CriteriaInput } from "@eval/contracts";
import requestSchema from "../../../../schemas/criteria/request.schema.json" with { type: "json" };
import submissionSchema from "../../../../schemas/criteria/submission.schema.json" with { type: "json" };
import resultSchema from "../../../../schemas/criteria/result.schema.json" with { type: "json" };
import { validateEvaluation } from "./validate.js";
import { criteriaSources, eligibleCriterionSource, requiredCriterionSource } from "./sources.js";
import { resolveCriteria } from "./resolve.js";

export * from "./types.js";
export { criteriaSources, eligibleCriterionSource } from "./sources.js";
export type { CriterionSource } from "./sources.js";
export type { CriteriaSubmission } from "./resolve.js";
const prompt = agentPrompt("criteria", [], { fileSubmission: false });
export const criteriaProfile: AgentProfile = {
  id: "default",
  requestSchema,
  submissionSchema,
  resultSchema,
  ...prompt,
  renderPrompt(input, policy, failure) {
    const value = input as unknown as CriteriaInput;
    const positions = new Map(value.candidates.map((candidate,index) => [candidate.candidate_id,index+1]));
    const sources = criteriaSources(value).filter(eligibleCriterionSource);
    return prompt.renderPrompt({ candidate_count: value.candidates.length,
      required_common_source_indices: sources.filter(requiredCriterionSource).map(source => source.source_index),
      source_catalog: sources.sort((a,b) => Number(a.applies_to.length > 0) - Number(b.applies_to.length > 0))
        .map(({paths:_paths,applies_to,...source}) => ({
          ...source,applies_to:applies_to.length ? applies_to.map(candidate=>positions.get(candidate)!) : [...positions.values()],
        })) }, policy, failure);
  },
  toolNames: [],
  resolve: resolveCriteria,
  validate: validateEvaluation,
};
export const criteriaAgent: AgentDefinition = {
  id: "criteria",
  profiles: { default: criteriaProfile },
};
