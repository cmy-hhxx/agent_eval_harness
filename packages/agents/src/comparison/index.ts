import { agentPrompt } from "@eval/prompts";
import type { AgentDefinition, AgentProfile } from "@eval/contracts";
import requestSchema from "../../../../schemas/comparison/request.schema.json" with { type: "json" };
import resultSchema from "../../../../schemas/comparison/result.schema.json" with { type: "json" };
import { validateEvaluation } from "./validate.js";
export * from "./types.js";
// Comparison does not resolve evidence or normalize the submission, so one JSON Schema serves both roles.
const toolNames = [
  "read_trace", "search_trace", "view_image", "calculate", "calculate_pair", "execute_code",
  "read_artifact",
];
export const comparisonProfile: AgentProfile = {
  id: "default",

  requestSchema,
  submissionSchema: resultSchema,
  resultSchema,
  ...agentPrompt("comparison", toolNames),
  toolNames,
  validate: validateEvaluation,
};
export const comparisonAgent: AgentDefinition = {
  id: "comparison",
  profiles: { default: comparisonProfile },
};
