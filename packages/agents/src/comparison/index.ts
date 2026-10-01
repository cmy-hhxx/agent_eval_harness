import { agentPrompt } from "@eval/prompts";
import { Ajv2020 } from "ajv/dist/2020.js";
import { schemaIssues, ValidationError, type AgentDefinition, type AgentProfile } from "@eval/contracts";
import requestSchema from "../../../../schemas/comparison/request.schema.json" with { type: "json" };
import resultSchema from "../../../../schemas/comparison/result.schema.json" with { type: "json" };
import { validateEvaluation } from "./validate.js";
export * from "./types.js";
// The source agent submits its decision; the workflow attaches later language polish.
const submissionSchema = structuredClone(resultSchema);
delete (submissionSchema.properties as Record<string, unknown>).rewritten;
delete (submissionSchema.properties as Record<string, unknown>).task_analysis;
submissionSchema.required = submissionSchema.required.filter((key) => key !== "task_analysis");
const validateSubmission = new Ajv2020({ allErrors: true, strict: false }).compile(submissionSchema);
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
  resolve: (request, draft) => {
    if (!validateSubmission(draft)) throw new ValidationError(schemaIssues(validateSubmission.errors, draft));
    return { ...(draft as Record<string, unknown>), task_analysis: structuredClone(request.input.task_analysis) };
  },
};
export const comparisonAgent: AgentDefinition = {
  id: "comparison",
  profiles: { default: comparisonProfile },
};
