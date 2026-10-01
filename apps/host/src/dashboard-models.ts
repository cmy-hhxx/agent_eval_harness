import type { AssistantModelEntry } from "@eval/contracts";
import { discoverAssistantModels } from "@eval/runtime/assistant";
import { loadConfig } from "./config.js";

export interface DashboardModel {
  id: string;
  name: string;
}

export type DashboardModelLoader = () => Promise<DashboardModel[]>;

/** Keep only the public model identity; never expose the gateway endpoint or credentials. */
export function toDashboardModels(models: readonly AssistantModelEntry[]): DashboardModel[] {
  return models.map(({ id, name }) => ({ id, name }));
}

/** Loads the model catalog through the same .env-backed gateway as evaluation runs. */
export async function discoverDashboardModels(configPaths: string[]): Promise<DashboardModel[]> {
  const host = await loadConfig(configPaths);
  const binding = host.models.bindings.attribution ?? Object.values(host.models.bindings)[0];
  const profile = binding ? host.models.models[binding.profile] : undefined;
  if (!profile) return [];
  return toDashboardModels(await discoverAssistantModels(profile));
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
