import { readFileSync } from "node:fs";
import type { AgentDefinition, AgentProfile } from "@eval/contracts";
import requestSchema from "../../../../schemas/attribution/request.schema.json" with { type: "json" };
import submissionSchema from "../../../../schemas/attribution/submission.schema.json" with { type: "json" };
import resultSchema from "../../../../schemas/attribution/result.schema.json" with { type: "json" };
import { validateEvaluation } from "./validate.js";
import { resolveSubmission } from "./resolve.js";
export * from "./types.js";
// Attribution resolves evidence IDs into source locations before the result is accepted.
export const attributionProfile: AgentProfile = {
  id: "default",

  requestSchema,
  submissionSchema,
  resultSchema,
  systemPrompt: readFileSync(
    new URL("./profiles/default/system.md", import.meta.url),
    "utf8",
  ).trim(),
  instructions: readFileSync(
    new URL("./profiles/default/instructions.md", import.meta.url),
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
