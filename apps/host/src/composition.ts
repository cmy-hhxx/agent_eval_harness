import { AgentRegistry } from "@eval/host";
import { comparisonAgent, comparisonProfile } from "@eval/agents/comparison";
import { attributionAgent, attributionProfile } from "@eval/agents/attribution";
import { comparisonWorkflow, comparisonRepository, reportRun, outputSchema } from "@eval/workflows/comparison";
import path from "node:path";
import { createFileLogger } from "@eval/data";
import { ROOT, runtimePaths } from "./paths.js";
export const logger = createFileLogger({
  directory: path.join(ROOT, "log"),
  lockDirectory: path.join(ROOT, ".runtime/log-writer"),
  secrets: [process.env.EVAL_API_KEY || ""],
});
export const agents = new AgentRegistry([comparisonAgent, attributionAgent]);
export const services = {
  logger,
  agents,
  workflow: comparisonWorkflow,
  repository: comparisonRepository,
  runtime: runtimePaths,
  report: reportRun,
  snapshots: {
    "output_schema.json": outputSchema,
    "contract.json": {
      id: "comparison",

      systemPrompt: comparisonProfile.systemPrompt,
      instructions: {
        comparison: comparisonProfile.instructions,
        attribution: attributionProfile.instructions,
      },
      attributionSubmissionSchema: attributionProfile.submissionSchema,
      attributionResultSchema: attributionProfile.resultSchema,
      comparisonResultSchema: comparisonProfile.resultSchema,
    },
  },
};
