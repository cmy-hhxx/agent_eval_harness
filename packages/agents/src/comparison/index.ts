import { agentPrompt } from "@eval/prompts";
import type { AgentDefinition, AgentProfile } from "@eval/contracts";
import requestSchema from "../../../../schemas/comparison/request.schema.json" with { type: "json" };
import resultSchema from "../../../../schemas/comparison/result.schema.json" with { type: "json" };
import { validateEvaluation } from "./validate.js";
export * from "./types.js";
// The source agent submits its decision; the workflow attaches later language polish.
const submissionSchema = structuredClone(resultSchema);
delete (submissionSchema.properties as Record<string, unknown>).rewritten;
const toolNames = [
  "read_trace", "search_trace", "view_image", "calculate", "calculate_pair", "execute_code",
  "read_artifact",
];
export const comparisonProfile: AgentProfile = {
  id: "default",

  requestSchema,
  submissionSchema,
  resultSchema,
  ...agentPrompt("comparison", toolNames),
  toolNames,
  validate: validateEvaluation,
};
export const comparisonAgent: AgentDefinition = {
  id: "comparison",
  profiles: { default: comparisonProfile },
};
