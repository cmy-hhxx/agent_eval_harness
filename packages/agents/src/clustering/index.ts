import { agentPrompt } from "@eval/prompts";
import { ValidationError, type AgentDefinition, type AgentProfile } from "@eval/contracts";
import requestSchema from "../../../../schemas/clustering/request.schema.json" with { type: "json" };
import resultSchema from "../../../../schemas/clustering/result.schema.json" with { type: "json" };
import submissionSchema from "../../../../schemas/clustering/submission.schema.json" with { type: "json" };
import { validateEvaluation } from "./validate.js";
import { references, resolveSubmission } from "./references.js";
import type { ClusteringRequest } from "./types.js";
export * from "./types.js";
export * from "./library.js";
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
