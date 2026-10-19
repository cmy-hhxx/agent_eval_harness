import { errorText, redact, type AssistantModelEntry } from "@eval/contracts";
import { discoverAssistantModels } from "@eval/runtime/assistant";
import { readSettings, applySettings } from "./config.js";

export interface DashboardModel {
  id: string;
  channel: string;
  name: string;
}

export type DashboardModelLoader = () => Promise<DashboardModel[]>;
export interface DashboardModelFailure { channel: string; name: string; message: string }

/** Keep only the public model identity; never expose the gateway endpoint or credentials. */
export function toDashboardModels(models: readonly Pick<AssistantModelEntry, 'id' | 'name' | 'contextWindow' | 'maxTokens'>[], channel: string, name = channel): DashboardModel[] {
  return models.map(({ id, name: modelName }) => ({ id, channel, name: `${name} / ${modelName}` }));
}

/** Discover each configured channel once, including channels not bound to a stage yet. */
export async function discoverDashboardModels(onFailures?: (failures: DashboardModelFailure[]) => void): Promise<DashboardModel[]> {
  const configuration = await readSettings();
  applySettings(configuration);
  const channels = Object.values(configuration.channels).filter(channel => channel.api === "openai-responses");
  const groups = await Promise.allSettled(channels.map(async channel => {
    const rows = channel.models ? channel.models.map(id => ({ id, name: id })) : await discoverAssistantModels(channel);
    if (!rows.length) throw new Error("渠道未返回可用模型");
    return toDashboardModels(rows, channel.provider, channel.name);
  }));
  const failures: DashboardModelFailure[] = [], models: DashboardModel[] = [];
  const secrets = Object.values(configuration.channels).map(channel => process.env[channel.apiKeyEnv] ?? "");
  groups.forEach((group, index) => {
    if (group.status === "fulfilled") models.push(...group.value);
    else failures.push({ channel: channels[index].provider, name: channels[index].name, message: redact(errorText(group.reason), secrets) });
  });
  onFailures?.(failures);
  return models;
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
