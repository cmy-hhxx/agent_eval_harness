import type { ModelConfig } from "@eval/contracts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Thinking = (typeof THINKING_LEVELS)[number];
export const DEFAULT_THINKING: Thinking = "medium";

/** A reusable model profile: gateway identity plus default parameters. */
export interface ModelProfile {
  provider: string;
  baseUrl: string;
  api: ModelConfig["api"];
  apiKeyEnv: string;
  model?: string;
  thinking?: Thinking;
  /** Gateway capability, independent of the model name and endpoint URL. */
  supportsDeveloperRole?: boolean;
  supportsExplicitPromptCaching?: boolean;
  /** Relative share of newly dispatched evaluation tasks for this channel. */
  trafficWeight?: number;
  contextWindow?: number;
  maxOutputTokens?: number;
}

/** Binds an evaluation stage to a profile and optionally overrides parameters. */
export interface StageBinding {
  profile: string;
  channel?: string;
  model?: string;
  thinking?: Thinking;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface ModelCatalog {
  channels: Record<string, ModelProfile>;
  models: Record<string, ModelProfile>;
  bindings: Record<string, StageBinding>;
}

function routedProfile(catalog: ModelCatalog, binding: StageBinding): ModelProfile {
  const profile = catalog.models[binding.profile];
  if (!profile) throw new Error(`Unknown model profile "${binding.profile}"`);
  if (!binding.channel || binding.channel === profile.provider) return profile;
  const channel = catalog.channels[binding.channel];
  if (!channel) throw new Error(`Unknown channel "${binding.channel}"`);
  return { ...profile, provider: channel.provider, baseUrl: channel.baseUrl, apiKeyEnv: channel.apiKeyEnv,
    api: channel.api, supportsDeveloperRole: channel.supportsDeveloperRole,
    supportsExplicitPromptCaching: channel.supportsExplicitPromptCaching };
}

export function boundProfiles(catalog: ModelCatalog): ModelProfile[] {
  return Object.values(catalog.bindings).map(binding => routedProfile(catalog, binding));
}

export function createModelResolver(catalog: ModelCatalog): (stage: string) => ModelConfig {
  return (stage) => {
    const binding = catalog.bindings[stage];
    if (!binding) throw new Error(`No model binding configured for stage "${stage}"`);
    const profile = routedProfile(catalog, binding);
    const model = binding.model ?? profile.model;
    if (!model)
      throw new Error(
        `Missing model id for profile "${binding.profile}"; set models.${binding.profile}.model in a local config`,
      );
    const thinking = binding.thinking ?? profile.thinking ?? DEFAULT_THINKING;
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
      ...(profile.supportsDeveloperRole !== undefined ? { supportsDeveloperRole: profile.supportsDeveloperRole } : {}),
      ...(profile.supportsExplicitPromptCaching !== undefined ? { supportsExplicitPromptCaching: profile.supportsExplicitPromptCaching } : {}),
      contextWindow,
      maxOutputTokens,
    };
  };
}
