import { agentPrompt } from "@eval/prompts";
import type { AgentDefinition, AgentProfile } from "@eval/contracts";
import requestSchema from "../../../../schemas/criteria/request.schema.json" with { type: "json" };
import resultSchema from "../../../../schemas/criteria/result.schema.json" with { type: "json" };
import { validateEvaluation } from "./validate.js";

export * from "./types.js";
export const criteriaProfile: AgentProfile = {
  id: "default",
  requestSchema,
  submissionSchema: resultSchema,
  resultSchema,
  ...agentPrompt("criteria", []),
  toolNames: [],
  validate: validateEvaluation,
};
export const criteriaAgent: AgentDefinition = {
  id: "criteria",
  profiles: { default: criteriaProfile },
};
