import type { ModelConfig } from "@eval/contracts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type Thinking = (typeof THINKING_LEVELS)[number];

/** A reusable model profile: gateway identity plus default parameters. */
export interface ModelProfile {
  provider: string;
  baseUrl: string;
  api: ModelConfig["api"];
  apiKeyEnv: string;
  model?: string;
  thinking?: Thinking;
  contextWindow?: number;
  maxOutputTokens?: number;
}

/** Binds an evaluation stage to a profile and optionally overrides parameters. */
export interface StageBinding {
  profile: string;
  model?: string;
  thinking?: Thinking;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface ModelCatalog {
  models: Record<string, ModelProfile>;
  bindings: Record<string, StageBinding>;
}

export function boundProfiles(catalog: ModelCatalog): ModelProfile[] {
  const names = new Set(Object.values(catalog.bindings).map((binding) => binding.profile));
  return [...names].flatMap((name) => (catalog.models[name] ? [catalog.models[name]] : []));
}

export function createModelResolver(catalog: ModelCatalog): (stage: string) => ModelConfig {
  return (stage) => {
    const binding = catalog.bindings[stage];
    if (!binding) throw new Error(`No model binding configured for stage "${stage}"`);
    const profile = catalog.models[binding.profile];
    if (!profile) throw new Error(`Unknown model profile "${binding.profile}" for stage "${stage}"`);
    const model = binding.model ?? profile.model;
    if (!model)
      throw new Error(
        `Missing model id for profile "${binding.profile}"; set models.${binding.profile}.model in a local config`,
      );
    const thinking = binding.thinking ?? profile.thinking ?? "off";
    if (!THINKING_LEVELS.includes(thinking)) throw new Error(`Invalid thinking for stage "${stage}"`);
    const contextWindow = binding.contextWindow ?? profile.contextWindow;
    if (contextWindow === undefined || !Number.isInteger(contextWindow) || contextWindow <= 0)
      throw new Error(`Invalid contextWindow for stage "${stage}"`);
    const maxOutputTokens = binding.maxOutputTokens ?? profile.maxOutputTokens;
    if (maxOutputTokens === undefined || !Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0)
      throw new Error(`Invalid maxOutputTokens for stage "${stage}"`);
    return {
      provider: profile.provider,
      baseUrl: profile.baseUrl,
      api: profile.api,
      apiKeyEnv: profile.apiKeyEnv,
      model,
      thinking,
      contextWindow,
      maxOutputTokens,
    };
  };
}
