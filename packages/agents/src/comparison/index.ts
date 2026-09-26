import { readFileSync } from "node:fs";
import type { AgentDefinition, AgentProfile } from "@eval/contracts";
import requestSchema from "../../../../schemas/comparison/request.schema.json" with { type: "json" };
import resultSchema from "../../../../schemas/comparison/result.schema.json" with { type: "json" };
import { validateEvaluation } from "./validate.js";
export * from "./types.js";
// Comparison does not resolve evidence or normalize the submission, so one JSON Schema serves both roles.
export const comparisonProfile: AgentProfile = {
  id: "default",

  requestSchema,
  submissionSchema: resultSchema,
  resultSchema,
  systemPrompt: readFileSync(new URL("./profiles/default/system.md", import.meta.url), "utf8").trim(),
  instructions: readFileSync(new URL("./profiles/default/instructions.md", import.meta.url), "utf8").trim(),
  toolNames: [
    "read_trace",
    "search_trace",
    "view_image",
    "calculate",
    "calculate_pair",
    "execute_code",
    "read_artifact",
  ],
  validate: validateEvaluation,
};
export const comparisonAgent: AgentDefinition = {
  id: "comparison",
  profiles: { default: comparisonProfile },
};
