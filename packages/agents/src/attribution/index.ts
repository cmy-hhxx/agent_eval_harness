import { readFileSync } from "node:fs";
import type { AgentDefinition, AgentProfile } from "@eval/contracts";
import inputSchema from "./profiles/attribution/input.schema.json" with { type: "json" };
import outputSchema from "./profiles/attribution/output.schema.json" with { type: "json" };
import resolvedSchema from "./profiles/attribution/resolved.schema.json" with { type: "json" };
import { validateEvaluation } from "./validate.js";
import { resolveSubmission } from "./resolve.js";
export * from "./types.js";
export * from "./library.js";
export const attributionProfile: AgentProfile = {
  id: "default",

  inputSchema,
  outputSchema,
  resolvedSchema,
  systemPrompt: readFileSync(
    new URL("./profiles/attribution/system.md", import.meta.url),
    "utf8",
  ).trim(),
  instructions: readFileSync(
    new URL("./profiles/attribution/instructions.md", import.meta.url),
    "utf8",
  ).trim(),
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
export const attributionAgent: AgentDefinition = {
  id: "attribution",
  profiles: { default: attributionProfile },
};
