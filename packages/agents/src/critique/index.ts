import { readFileSync } from "node:fs";
import type { AgentDefinition, AgentProfile } from "@eval/contracts";
import inputSchema from "./profiles/correctness/input.schema.json" with { type: "json" };
import outputSchema from "./profiles/correctness/output.schema.json" with { type: "json" };
import resolvedSchema from "./profiles/correctness/resolved.schema.json" with { type: "json" };
import { validateEvaluation } from "./validate.js";
import { resolveSubmission } from "./resolve.js";
export * from "./types.js";
export const correctnessProfile: AgentProfile = {
  id: "correctness",

  inputSchema,
  outputSchema,
  resolvedSchema,
  systemPrompt: readFileSync(new URL("./profiles/correctness/system.md", import.meta.url), "utf8").trim(),
  instructions: readFileSync(
    new URL("./profiles/correctness/instructions.md", import.meta.url),
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
export const critiqueAgent: AgentDefinition = {
  id: "critique",
  profiles: { correctness: correctnessProfile },
};
