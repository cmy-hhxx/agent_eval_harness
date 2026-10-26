import path from "node:path";
import { HttpError } from "@eval/contracts";
import { readJson, writeJson } from "@eval/data";
import { dashboardSettings, editableDashboardSettings, loadComparisonConfig, readConfigSources, createModelResolver, type ComparisonHostConfig } from "./config.js";
import type { AutomationConfig } from "./automation-config.js";

export interface DailySettings {
  debug: boolean;
  settings: Record<string, unknown>;
}
const settingsFile = (config: AutomationConfig) => path.join(config.stateDirectory, "execution-settings.json");
export async function readDailySettings(config: AutomationConfig): Promise<DailySettings> {
  try { return await readJson<DailySettings>(settingsFile(config)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { debug: false, settings: {} };
  }
}
export async function loadDailyHost(config: AutomationConfig): Promise<DailySettings & { host: ComparisonHostConfig }> {
  const execution = config.runtimeSettings ?? await readDailySettings(config);
  return { ...execution, host: await loadComparisonConfig(config.hostConfigs, undefined, execution.settings) };
}
export async function dailySettingsView(config: AutomationConfig) {
  const execution = await readDailySettings(config);
  const base = editableDashboardSettings(await readConfigSources(config.hostConfigs));
  const host = await loadComparisonConfig(config.hostConfigs, undefined, execution.settings);
  const bindings = Object.fromEntries(Object.entries(host.models.bindings).filter(([stage]) => ["criteria", "attribution", "comparison", "rewrite"].includes(stage)).map(([stage, binding]) => {
    const profile = host.models.models[binding.profile];
    return [stage, { channel: binding.channel ?? profile.provider, model: binding.model ?? profile.model,
      thinking: binding.thinking ?? profile.thinking }];
  }));
  return { ...base, execution: host.evaluation.execution, rewrite: host.evaluation.rewrite, bindings,
    debug: execution.debug };
}
export async function saveDailySettings(config: AutomationConfig, value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "运行设置必须是对象");
  const previous = await readDailySettings(config);
  const { debug = previous.debug, ...settings } = value as Record<string, unknown>;
  if (typeof debug !== "boolean") throw new HttpError(400, "debug 设置无效");
  const patch = dashboardSettings(settings, previous.settings);
  if (patch.clustering || patch.versions) throw new HttpError(400, "日常来源范围由收包目录决定，聚类单独启动");
  const host = await loadComparisonConfig(config.hostConfigs, undefined, patch);
  const resolve = createModelResolver(host.models);
  for (const stage of ["criteria", "attribution", "comparison", "rewrite"]) resolve(stage);
  if (config.publishMongo && (!host.evaluation.rewrite.comparison || host.evaluation.rewrite.comparisonItems === false))
    throw new HttpError(400, "MongoDB 交付需要比较改写");
  await writeJson(settingsFile(config), { debug, settings: patch });
  return dailySettingsView(config);
}
