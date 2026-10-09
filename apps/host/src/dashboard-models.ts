import type { AssistantModelEntry } from "@eval/contracts";
import { discoverAssistantModels } from "@eval/runtime/assistant";
import { readSettings, applySettings } from "./config.js";

export interface DashboardModel {
  id: string;
  channel: string;
  name: string;
}

export type DashboardModelLoader = () => Promise<DashboardModel[]>;

/** Keep only the public model identity; never expose the gateway endpoint or credentials. */
export function toDashboardModels(models: readonly Pick<AssistantModelEntry, 'id' | 'name' | 'contextWindow' | 'maxTokens'>[], channel: string, name = channel): DashboardModel[] {
  return models.map(({ id, name: modelName }) => ({ id, channel, name: `${name} / ${modelName}` }));
}

/** Discover each configured channel once, including channels not bound to a stage yet. */
export async function discoverDashboardModels(): Promise<DashboardModel[]> {
  const configuration = await readSettings();
  applySettings(configuration);
  return (await Promise.all(Object.values(configuration.channels).map(async channel =>
    toDashboardModels((await discoverAssistantModels(channel)).filter(model => !channel.models || channel.models.includes(model.id)), channel.provider, channel.name)))).flat();
}

export function clearUnavailableDashboardModels(
  settings: Record<string, unknown>,
  models: readonly DashboardModel[],
): void {
  const bindings = settings.bindings;
  if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) return;
  const allowed = new Set(models.map(model => JSON.stringify([model.channel, model.id])));
  for (const raw of Object.values(bindings)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const binding = raw as Record<string, unknown>;
    if (typeof binding.model !== "string" || !allowed.has(JSON.stringify([binding.channel, binding.model]))) binding.model = "";
  }
}
