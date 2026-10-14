import type { ModelConfig, PlannedTask } from "@eval/contracts";
import { createModelResolver, type ModelCatalog } from "./models.js";

/** Share whole tasks by channel weights; ordinary retries keep their route. */
export function createBalancedModels(catalog: ModelCatalog, channels = Object.keys(catalog.channels), exhausted = new Set<string>()) {
  if (!channels.length || new Set(channels).size !== channels.length)
    throw new Error("负载均衡需要不同的 config.ini 渠道");
  const routes = new Map(channels.map(channel => {
    if (!catalog.channels[channel]) throw new Error(`Unknown channel "${channel}"`);
    const resolve = createModelResolver({ ...catalog, bindings: Object.fromEntries(
      Object.entries(catalog.bindings).map(([stage, binding]) => [stage, { ...binding, channel }]),
    ) });
    for (const stage of Object.keys(catalog.bindings)) {
      const model = resolve(stage);
      if (!process.env[model.apiKeyEnv]) throw new Error(`Missing ${model.apiKeyEnv}`);
    }
    return [channel, resolve] as const;
  }));
  const assignments = new Map<string, string>();
  const credits = new Map(channels.map(channel => [channel, 0]));
  const weights = new Map(channels.map(channel => {
    const weight = catalog.channels[channel].trafficWeight ?? 1;
    if (!Number.isSafeInteger(weight) || weight <= 0) throw new Error(`Invalid channel ${channel}.trafficWeight`);
    return [channel, weight];
  }));
  const selectChannel = (available: string[]) => {
    let selected = available[0], total = 0;
    for (const channel of available) {
      const weight = weights.get(channel)!;
      total += weight;
      credits.set(channel, credits.get(channel)! + weight);
      if (credits.get(channel)! > credits.get(selected)!) selected = channel;
    }
    credits.set(selected, credits.get(selected)! - total);
    return selected;
  };
  const modelForStage = createModelResolver(catalog);
  const modelForTask = (task: PlannedTask, previousChannel?: string): ModelConfig => {
    let channel = assignments.get(task.id);
    if (!channel && previousChannel && routes.has(previousChannel)) {
      channel = previousChannel;
      assignments.set(task.id, channel);
    }
    if (!channel || exhausted.has(channel)) {
      const available = channels.filter(id => !exhausted.has(id));
      channel = available.length ? selectChannel(available) : assignments.get(task.id) ?? channels[0];
      assignments.set(task.id, channel);
    }
    return routes.get(channel)!(task.stage);
  };
  return {
    modelForStage, modelForTask,
    onModelQuotaExhausted(model: ModelConfig, task: PlannedTask): boolean {
      if (!routes.has(model.provider)) return false;
      exhausted.add(model.provider);
      return channels.some(channel => !exhausted.has(channel)) && modelForTask(task).provider !== model.provider;
    },
  };
}
