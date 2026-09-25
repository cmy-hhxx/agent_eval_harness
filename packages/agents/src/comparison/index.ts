import { readFileSync } from "node:fs";
import type { AgentDefinition, AgentProfile } from "@eval/contracts";
import inputSchema from "./profiles/default/input.schema.json" with { type: "json" };
import outputSchema from "./profiles/default/output.schema.json" with { type: "json" };
import resolvedSchema from "./profiles/default/resolved.schema.json" with { type: "json" };
import { validateEvaluation } from "./validate.js";
import { resolveSubmission } from "./resolve.js";
export * from "./types.js";
export const comparisonProfile: AgentProfile = {
  id: "default",

  inputSchema,
  outputSchema,
  resolvedSchema,
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
  resolve: resolveSubmission,
};
export const comparisonAgent: AgentDefinition = {
  id: "comparison",
  profiles: { default: comparisonProfile },
};
