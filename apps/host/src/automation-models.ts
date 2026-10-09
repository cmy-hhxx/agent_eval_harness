import type { ModelConfig } from "@eval/contracts";
import { createModelResolver, type ModelCatalog } from "./models.js";

/** Share exhausted channels across dates until the automation process restarts. */
export function createAutomationModels(catalog: ModelCatalog, channels: string[], exhausted = new Set<string>()) {
  const resolve = createModelResolver(catalog);
  const routes = new Map(channels.map(channel => {
    if (!catalog.channels[channel]) throw new Error(`Unknown automation channel "${channel}"`);
    return [channel, createModelResolver({ ...catalog, bindings: Object.fromEntries(
      Object.entries(catalog.bindings).map(([stage, binding]) => [stage, { ...binding, channel }]),
    ) })];
  }));
  // Validate every configured route before starting work, including the backup key.
  for (const route of routes.size ? routes.values() : [resolve])
    for (const stage of ["criteria", "attribution", "comparison", "rewrite"]) {
      const model = route(stage);
      if (!process.env[model.apiKeyEnv]) throw new Error(`Missing ${model.apiKeyEnv}`);
    }
  const current = () => channels.find(channel => !exhausted.has(channel)) ?? channels.at(-1);
  return {
    modelForStage: (stage: string): ModelConfig => (routes.get(current()!) ?? resolve)(stage),
    onModelQuotaExhausted(model: ModelConfig): boolean {
      const index = channels.indexOf(model.provider);
      if (index < 0 || index === channels.length - 1) return false;
      exhausted.add(model.provider);
      return current() !== model.provider;
    },
  };
}
