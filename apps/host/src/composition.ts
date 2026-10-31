import { compactAgent, compactProfile, compactFieldProfiles } from "@eval/agents/compact";
import { scoreAgent } from "@eval/agents/score";
import { attributionDimensions } from "@eval/workflows/review";
import { configurationSecrets } from "./settings.js";
import { AgentRegistry } from "@eval/host";
import { comparisonAgent, comparisonProfile } from "@eval/agents/comparison";
import { attributionAgent, sessionAssemblyProfile, componentAttributionProfile, sessionAttributionProfile, traceAttributionProfile } from "@eval/agents/attribution";
import { rewriteAgent, rewriteProfile } from "@eval/agents/rewrite";
import { clusteringAgent, clusteringProfile } from "@eval/agents/clustering";
import { criteriaAgent, criteriaProfile } from "@eval/agents/criteria";
import { comparisonWorkflow, reportRun, outputSchema } from "@eval/workflows/comparison";
import path from "node:path";
import { createFileLogger } from "@eval/data";
import { ROOT, runtimePaths } from "./paths.js";
import { businessComparisonRepository } from "./business-results.js";
const applicationLogger = () => createFileLogger({
  directory: path.resolve(process.env.EVAL_LOG_DIR || path.join(ROOT, "log")),
  lockDirectory: path.resolve(process.env.EVAL_LOG_LOCK_DIR || path.join(ROOT, ".runtime/log-writer")),
  secrets: configurationSecrets(),
});
export let logger = applicationLogger();
export async function initializeServices() {
  logger = applicationLogger();
  services.logger = logger;
  if (!await logger.initialize()) throw new Error("Runtime/evaluation log initialization failed");
}
export const agents = new AgentRegistry([compactAgent, scoreAgent, ...Object.values(attributionDimensions).map(dimension => dimension.agent),
  criteriaAgent, comparisonAgent, attributionAgent, rewriteAgent, clusteringAgent]);
export const services = {
  logger,
  agents,
  taskSource: comparisonWorkflow,
  repository: businessComparisonRepository,
  runtime: runtimePaths,
  report: reportRun,
  snapshots: {
    "output_schema.json": outputSchema,
    "contract.json": {
      id: "comparison",
      profiles: Object.fromEntries(
        Object.entries({
          ...Object.fromEntries(Object.entries(attributionDimensions).map(([stage, dimension]) => [stage, dimension.agent.profiles.default])),
          criteria: criteriaProfile,
          "attribution-compact": compactProfile,
          ...Object.fromEntries(Object.entries(compactFieldProfiles).map(([field, profile]) => [`attribution-compact-${field}`, profile])),
          "attribution-trace": traceAttributionProfile,
          "attribution-session": sessionAttributionProfile,
          "attribution-session-assembly": sessionAssemblyProfile,
          "attribution-component": componentAttributionProfile,
          comparison: comparisonProfile,
          rewrite: rewriteProfile,
          clustering: clusteringProfile,
        }).map(([stage, profile]) => [stage, {
          maxToolCalls: profile.maxToolCalls,
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
