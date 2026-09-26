import { readFileSync } from "node:fs";
import type { AgentDefinition, AgentProfile } from "@eval/contracts";
import requestSchema from "../../../../schemas/rewrite/request.schema.json" with { type: "json" };
import resultSchema from "../../../../schemas/rewrite/result.schema.json" with { type: "json" };
import { validateEvaluation } from "./validate.js";
export * from "./types.js";
// Rewrite only returns text for the requested slots, so one JSON Schema serves both submission and result.
export const rewriteProfile: AgentProfile = {
  id: "default",

  requestSchema,
  submissionSchema: resultSchema,
  resultSchema,
  systemPrompt: readFileSync(
    new URL("./profiles/default/system.md", import.meta.url),
    "utf8",
  ).trim(),
  instructions: readFileSync(
    new URL("./profiles/default/instructions.md", import.meta.url),
    "utf8",
  ).trim(),
  toolNames: [],
  validate: validateEvaluation,
};
export const rewriteAgent: AgentDefinition = {
  id: "rewrite",
  profiles: { default: rewriteProfile },
};
