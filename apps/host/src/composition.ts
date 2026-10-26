import { scoreAgent } from "@eval/agents/score";
import { instructionReviewAgent } from "@eval/agents/instruction-review";
import { configurationSecrets } from "./settings.js";
import { AgentRegistry } from "@eval/host";
import { comparisonAgent, comparisonProfile } from "@eval/agents/comparison";
import { attributionAgent, componentAttributionProfile, sessionAttributionProfile, traceAttributionProfile } from "@eval/agents/attribution";
import { rewriteAgent, rewriteProfile } from "@eval/agents/rewrite";
import { clusteringAgent, clusteringProfile } from "@eval/agents/clustering";
import { criteriaAgent, criteriaProfile } from "@eval/agents/criteria";
import { comparisonWorkflow, comparisonRepository, reportRun, outputSchema } from "@eval/workflows/comparison";
import path from "node:path";
import { createFileLogger } from "@eval/data";
import { ROOT, runtimePaths } from "./paths.js";
export const logger = createFileLogger({
  directory: path.resolve(process.env.EVAL_LOG_DIR || path.join(ROOT, "log")),
  lockDirectory: path.resolve(process.env.EVAL_LOG_LOCK_DIR || path.join(ROOT, ".runtime/log-writer")),
  secrets: configurationSecrets(),
});
export const agents = new AgentRegistry([scoreAgent, instructionReviewAgent, criteriaAgent, comparisonAgent, attributionAgent, rewriteAgent, clusteringAgent]);
export const services = {
  logger,
  agents,
  taskSource: comparisonWorkflow,
  repository: comparisonRepository,
  runtime: runtimePaths,
  report: reportRun,
  snapshots: {
    "output_schema.json": outputSchema,
    "contract.json": {
      id: "comparison",
      profiles: Object.fromEntries(
        Object.entries({
          criteria: criteriaProfile,
          "attribution-component": componentAttributionProfile,
          "attribution-trace": traceAttributionProfile,
          "attribution-session": sessionAttributionProfile,
          comparison: comparisonProfile,
          rewrite: rewriteProfile,
          clustering: clusteringProfile,
        }).map(([stage, profile]) => [stage, {
          systemPrompt: profile.systemPrompt,
          instructions: profile.instructions,
          submissionNudge: profile.submissionNudge,
          toolDescriptions: profile.toolDescriptions,
          fileSubmission: profile.fileSubmission,
          jsonStringSubmission: profile.jsonStringSubmission ?? false,
          requestSchema: profile.requestSchema,
          submissionSchema: profile.submissionSchema,
          resultSchema: profile.resultSchema,
        }]),
      ),
    },
  },
};
