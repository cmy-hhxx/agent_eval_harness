import { AgentRegistry } from "@eval/host";
import { comparisonAgent, comparisonProfile } from "@eval/agents/comparison";
import { critiqueAgent, correctnessProfile } from "@eval/agents/critique";
import { pairwiseWorkflow, pairwiseRepository, reportRun, outputSchema } from "@eval/workflows/pairwise";
import path from "node:path";
import { createFileLogger } from "@eval/data";
import { ROOT, runtimePaths } from "./paths.js";
export const logger = createFileLogger({
  directory: path.join(ROOT, "log"),
  lockDirectory: path.join(ROOT, ".runtime/log-writer"),
  secrets: [process.env.EVAL_API_KEY || ""],
});
export const agents = new AgentRegistry([comparisonAgent, critiqueAgent]);
export const services = {
  logger,
  agents,
  workflow: pairwiseWorkflow,
  repository: pairwiseRepository,
  runtime: runtimePaths,
  report: reportRun,
  snapshots: {
    "output_schema.json": outputSchema,
    "contract.json": {
      id: "pairwise",

      systemPrompt: comparisonProfile.systemPrompt,
      instructions: {
        pairwise: comparisonProfile.instructions,
        correctness: correctnessProfile.instructions,
      },
      correctnessSchema: correctnessProfile.outputSchema,
      pairwiseSchema: comparisonProfile.outputSchema,
    },
  },
};
