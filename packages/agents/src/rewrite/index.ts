import { agentPrompt } from "@eval/prompts";
import type { AgentDefinition, AgentProfile } from "@eval/contracts";
import requestSchema from "../../../../schemas/rewrite/request.schema.json" with { type: "json" };
import submissionSchema from "../../../../schemas/rewrite/submission.schema.json" with { type: "json" };
import resultSchema from "../../../../schemas/rewrite/result.schema.json" with { type: "json" };
import { validateEvaluation } from "./validate.js";
export * from "./types.js";
// The model returns the exact semantic slot ids and edits only their prose.
export const rewriteProfile: AgentProfile = {
  id: "default",

  requestSchema,
  submissionSchema,
  resultSchema,
  ...agentPrompt("rewrite", [], { fileSubmission: false }),
  toolNames: [],
  modelSubmissionSchema(request) {
    const value = structuredClone(submissionSchema);
    const items = request.input.items as { id: string }[];
    Object.assign(value.properties.rewrites, { minItems: items.length, maxItems: items.length,
      prefixItems: items.map(item => ({ ...structuredClone(value.properties.rewrites.items),
        properties: { ...structuredClone(value.properties.rewrites.items.properties), id: { type: "string", const: item.id } } })) });
    return value;
  },
  validate: validateEvaluation,
};
export const rewriteAgent: AgentDefinition = {
  id: "rewrite",
  profiles: { default: rewriteProfile },
};
