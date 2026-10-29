import { createChannelRequests } from "@eval/host";
import type { PlannedTask } from "@eval/contracts";
import { createModelResolver, type HostConfig } from "./config.js";
import { createBalancedModels } from "./balanced-models.js";

export function evaluationRouting(host: HostConfig, balanced = false) {
  const resolve = createModelResolver(host.models);
  const routing = balanced ? createBalancedModels(host.models) : { modelForStage: resolve,
    modelRoutesForTask: (task: Pick<PlannedTask, "stage">) => [resolve(task.stage)] };
  for (const stage of Object.keys(host.models.bindings)) routing.modelRoutesForTask({ stage });
  const providers = balanced ? Object.keys(host.models.channels).filter(channel => host.models.channels[channel].api === "openai-responses")
    : [...new Set(Object.keys(host.models.bindings).map(stage => routing.modelForStage(stage).provider))];
  const limits = host.evaluation.execution.modelRequestLimits ?? Object.fromEntries(providers.map(provider => [provider, host.evaluation.execution.concurrency]));
  if (providers.some(provider => !Object.hasOwn(limits, provider))) throw new Error("Missing execution.modelRequestLimits for an evaluation channel");
  return { ...routing, modelRequests: createChannelRequests(limits, undefined, undefined, undefined, host.evaluation.execution.concurrency) };
}
