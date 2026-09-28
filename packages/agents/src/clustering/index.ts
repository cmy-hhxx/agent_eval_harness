import { agentPrompt } from "@eval/prompts";
import type { AgentDefinition, AgentProfile } from "@eval/contracts";
import requestSchema from "../../../../schemas/clustering/request.schema.json" with { type: "json" };
import resultSchema from "../../../../schemas/clustering/result.schema.json" with { type: "json" };
import { validateEvaluation } from "./validate.js";
export * from "./types.js";
export * from "./library.js";
// The source agent submits its decision; the workflow attaches later language polish.
const submissionSchema = structuredClone(resultSchema);
delete (submissionSchema.properties as Record<string, unknown>).rewritten;
export const clusteringProfile: AgentProfile = {
  id: "default",

  requestSchema,
  submissionSchema,
  resultSchema,
  ...agentPrompt("clustering", []),
  toolNames: [],
  validate: validateEvaluation,
};
export const clusteringAgent: AgentDefinition = {
  id: "clustering",
  profiles: { default: clusteringProfile },
};
