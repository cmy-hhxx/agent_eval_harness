import { ValidationError } from "@eval/contracts";
import { agentPrompt } from "@eval/prompts";
import type { AgentDefinition, AgentProfile } from "@eval/contracts";
import requestSchema from "../../../../schemas/rewrite/request.schema.json" with { type: "json" };
import submissionSchema from "../../../../schemas/rewrite/submission.schema.json" with { type: "json" };
import resultSchema from "../../../../schemas/rewrite/result.schema.json" with { type: "json" };
import { validateEvaluation } from "./validate.js";
export * from "./types.js";
// The model returns ordered text; its Workflow binds formal slot identities before result validation.
export const rewriteProfile: AgentProfile = {
  id: "default",

  requestSchema,
  submissionSchema,
  resultSchema,
  ...agentPrompt("rewrite", []),
  toolNames: [],
  modelSubmissionSchema(request) {
    const value = structuredClone(submissionSchema);
    const count = (request.input.items as unknown[]).length;
    Object.assign(value.properties.texts, { minItems: count, maxItems: count });
    return value;
  },
  validate(request,result,audit) {
    try { validateEvaluation(request,result,audit); }
    catch(error) { if (!(error instanceof ValidationError)) throw error;
      throw new ValidationError(error.issues!.map(issue => ({...issue,path:issue.path.replace(/^\/rewrites\/(\d+)\/text$/u,"/texts/$1")}))); }
  },
};
export const rewriteAgent: AgentDefinition = {
  id: "rewrite",
  profiles: { default: rewriteProfile },
};
