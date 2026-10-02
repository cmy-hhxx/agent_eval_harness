import { agentPrompt } from "@eval/prompts";
import type { AgentDefinition, AgentProfile } from "@eval/contracts";
import requestSchema from "../../../../schemas/comparison/request.schema.json" with { type: "json" };
import resultSchema from "../../../../schemas/comparison/result.schema.json" with { type: "json" };
import submissionSchema from "../../../../schemas/comparison/submission.schema.json" with { type: "json" };
import { validateEvaluation } from "./validate.js";
import { resolveComparison } from "./resolve.js";
import type { ComparisonInput } from "./types.js";
export * from "./types.js";
// The source agent submits its decision; the workflow attaches later language polish.
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
  requiredReads: (request) => Object.entries((request.input as unknown as ComparisonInput).candidates).flatMap(([candidate, material]) =>
    material.deferred_final_material.map(item => ({ candidate, message_index: item.message_index, kind: "text" as const,
      path: item.path, start: 0, end: item.total_chars }))),
  resolve: resolveComparison,
};
export const comparisonAgent: AgentDefinition = {
  id: "comparison",
  profiles: { default: comparisonProfile },
};
