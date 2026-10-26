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
  models?: string[];
  efforts?: Thinking[];
  contextWindow?: number;
  maxOutputTokens?: number;
}

/** Binds an evaluation stage to a profile and optionally overrides parameters. */
export interface StageBinding {
  profile: string;
  channel?: string;
  model?: string;
  thinking?: Thinking;
}

export interface ModelCatalog {
  channels: Record<string, ModelProfile>;
  models: Record<string, ModelProfile>;
  bindings: Record<string, StageBinding>;
}

export function assertDeclaredModel(profile: Pick<ModelProfile, "provider" | "models">, model: string): void {
  if (profile.models && !profile.models.includes(model))
    throw new Error(`Model "${model}" is not declared in channel "${profile.provider}"; available models: ${profile.models.join(", ")}`);
}

function routedProfile(catalog: ModelCatalog, binding: StageBinding): ModelProfile {
  const profile = catalog.models[binding.profile];
  if (!profile) throw new Error(`Unknown model profile "${binding.profile}"`);
  if (!binding.channel || binding.channel === profile.provider) return profile;
  const channel = catalog.channels[binding.channel];
  if (!channel) throw new Error(`Unknown channel "${binding.channel}"`);
  return { ...profile, provider: channel.provider, baseUrl: channel.baseUrl, apiKeyEnv: channel.apiKeyEnv,
    api: channel.api, supportsDeveloperRole: channel.supportsDeveloperRole,
    supportsExplicitPromptCaching: channel.supportsExplicitPromptCaching,
    contextWindow: channel.contextWindow, maxOutputTokens: channel.maxOutputTokens,
    models: channel.models, efforts: channel.efforts };
}

export function boundProfiles(catalog: ModelCatalog): ModelProfile[] {
  return Object.values(catalog.bindings).map(binding => routedProfile(catalog, binding));
}

/** Attribution fan-out stages share the single configured attribution binding. */
export function modelBindingStage(stage: string): string {
  return stage.startsWith("attribution-") ? "attribution" : stage;
}

export function createModelResolver(catalog: ModelCatalog): (stage: string) => ModelConfig {
  return (stage) => {
    const supportedStage = modelBindingStage(stage), binding = catalog.bindings[supportedStage];
    if (!binding) throw new Error(`No model binding configured for stage "${stage}"`);
    const profile = routedProfile(catalog, binding);
    if (profile.api !== "openai-responses") throw new Error(`Evaluation channel "${profile.provider}" requires openai-responses`);
    const model = binding.model ?? profile.model;
    if (!model)
      throw new Error(
        `Missing model id for profile "${binding.profile}"; set models.${binding.profile}.model in a local config`,
      );
    const thinking = binding.thinking ?? profile.thinking ?? DEFAULT_THINKING;
    if (!THINKING_LEVELS.includes(thinking)) throw new Error(`Invalid thinking for stage "${stage}"`);
    assertDeclaredModel(profile, model);
    if (profile.efforts && !profile.efforts.includes(thinking))
      throw new Error(`Thinking "${thinking}" is not supported by channel "${profile.provider}"`);
    const contextWindow = profile.contextWindow ?? 524288;
    if (contextWindow === undefined || !Number.isInteger(contextWindow) || contextWindow <= 0)
      throw new Error(`Invalid contextWindow for stage "${stage}"`);
    const maxOutputTokens = profile.maxOutputTokens ?? 32768;
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
