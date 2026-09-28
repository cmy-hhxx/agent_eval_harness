import type { AssistantModelEntry, ModelConfig } from "@eval/contracts";
import { discoverAssistantModels } from "@eval/runtime/assistant";
import { loadConfig, type ModelProfile } from "./config.js";

export interface DashboardModel {
  id: string;
  name: string;
}

export type DashboardModelLoader = () => Promise<DashboardModel[]>;

/** The workbench exposes only GPT-family models from the configured gateway. */
export function isGptModel(id: string): boolean {
  return id.toLowerCase().startsWith("gpt");
}

export function filterGptModels(models: readonly AssistantModelEntry[]): DashboardModel[] {
  return models
    .filter((model) => isGptModel(model.id))
    .map(({ id, name }) => ({ id, name }));
}

function modelConfig(profile: ModelProfile): ModelConfig {
  return {
    provider: profile.provider,
    baseUrl: profile.baseUrl,
    api: profile.api,
    apiKeyEnv: profile.apiKeyEnv,
    model: profile.model ?? "gpt",
    thinking: profile.thinking ?? "medium",
    contextWindow: profile.contextWindow ?? 131072,
    maxOutputTokens: profile.maxOutputTokens ?? 8192,
  };
}

/** Loads the model catalog through the same .env-backed gateway as evaluation runs. */
export async function discoverDashboardModels(configPaths: string[]): Promise<DashboardModel[]> {
  const host = await loadConfig(configPaths);
  const binding = host.models.bindings.attribution ?? Object.values(host.models.bindings)[0];
  const profile = binding ? host.models.models[binding.profile] : undefined;
  if (!profile) return [];
  return filterGptModels(await discoverAssistantModels(modelConfig(profile)));
}

export function assertGptModelSelections(settings: unknown): void {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return;
  const bindings = (settings as Record<string, unknown>).bindings;
  if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) return;
  for (const [stage, raw] of Object.entries(bindings)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const model = (raw as Record<string, unknown>).model;
    if (model !== undefined && (typeof model !== "string" || !isGptModel(model)))
      throw new Error(`阶段 ${stage} 只能选择 GPT 系列模型`);
  }
}

export function assertAvailableDashboardModels(
  modelIds: readonly string[],
  settings: unknown,
): void {
  assertGptModelSelections(settings);
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return;
  const bindings = (settings as Record<string, unknown>).bindings;
  if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) return;
  const allowed = new Set(modelIds);
  for (const [stage, raw] of Object.entries(bindings)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const model = (raw as Record<string, unknown>).model;
    if (typeof model === "string" && !allowed.has(model))
      throw new Error(`阶段 ${stage} 的模型不在 .env 网关 GPT 模型列表中`);
  }
}

export function clearUnavailableDashboardModels(
  settings: Record<string, unknown>,
  modelIds: readonly string[],
): void {
  const bindings = settings.bindings;
  if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) return;
  const allowed = new Set(modelIds);
  for (const raw of Object.values(bindings)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const binding = raw as Record<string, unknown>;
    if (typeof binding.model !== "string" || !allowed.has(binding.model)) binding.model = "";
  }
}
