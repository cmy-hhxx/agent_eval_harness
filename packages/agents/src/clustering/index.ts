import { readFileSync } from "node:fs";
import type { AgentDefinition, AgentProfile } from "@eval/contracts";
import requestSchema from "../../../../schemas/clustering/request.schema.json" with { type: "json" };
import resultSchema from "../../../../schemas/clustering/result.schema.json" with { type: "json" };
import { validateEvaluation } from "./validate.js";
export * from "./types.js";
export * from "./library.js";
// Clustering only assigns observations to classes, so one JSON Schema serves submission and result.
export const clusteringProfile: AgentProfile = {
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
export const clusteringAgent: AgentDefinition = {
  id: "clustering",
  profiles: { default: clusteringProfile },
};
