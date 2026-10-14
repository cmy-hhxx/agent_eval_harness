import type { ModelConfig, PlannedTask } from "@eval/contracts";
import { createModelResolver, type ModelCatalog } from "./models.js";
import { createBalancedModels } from "./balanced-models.js";

/** Share exhausted channels across dates until the automation process restarts. */
export function createAutomationModels(catalog: ModelCatalog, channels: string[], exhausted = new Set<string>()) {
  if (channels.length) return createBalancedModels(catalog, channels, exhausted);
  const resolve = createModelResolver(catalog);
  for (const stage of ["criteria", "attribution", "comparison", "rewrite"]) {
    const model = resolve(stage);
    if (!process.env[model.apiKeyEnv]) throw new Error(`Missing ${model.apiKeyEnv}`);
  }
  return {
    modelForStage: (stage: string): ModelConfig => resolve(stage),
    modelForTask: (task: PlannedTask): ModelConfig => resolve(task.stage),
    onModelQuotaExhausted(_model: ModelConfig, _task: PlannedTask): boolean { return false; },
  };
}
