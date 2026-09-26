import path from "node:path";
import { DEFAULT_POLICY, type AttributionTarget, type OutputTarget } from "@eval/contracts";
import { readJson } from "@eval/data";
import type { EvalConfig } from "@eval/workflows/comparison";
import { inputAdapterIds } from "@eval/workflows/comparison";
import {
  THINKING_LEVELS,
  type ModelCatalog,
  type ModelProfile,
  type StageBinding,
  type Thinking,
} from "./models.js";
export * from "./models.js";

const API_KINDS: ModelProfile["api"][] = ["openai-completions", "openai-responses"];
const EXECUTION_DEFAULTS = {
  ...DEFAULT_POLICY,
  concurrency: 4,
  retries: 1,
  retryDelaySeconds: 10,
  initialContextChars: 16000,
};
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
type ConfigObject = Record<string, unknown>;

export interface HostConfig {
  /** Workflow-facing evaluation inputs and budgets. Contains no model configuration. */
  evaluation: EvalConfig;
  /** Model profiles and per-stage bindings, resolved against the environment. */
  models: ModelCatalog;
}

function isObject(value: unknown): value is ConfigObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function mergeConfig(base: ConfigObject, overlay: ConfigObject): ConfigObject {
  const merged: ConfigObject = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const previous = merged[key];
    merged[key] = isObject(previous) && isObject(value) ? mergeConfig(previous, value) : value;
  }
  return merged;
}
function envName(value: unknown, label: string): string {
  if (typeof value !== "string" || !ENV_NAME.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}
function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value) throw new Error(`Invalid ${label}`);
  return value;
}
function optionalThinking(value: unknown, label: string): Thinking | undefined {
  if (value === undefined) return undefined;
  if (!THINKING_LEVELS.includes(value as Thinking)) throw new Error(`Invalid ${label}`);
  return value as Thinking;
}
function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) <= 0) throw new Error(`Invalid ${label}`);
  return value as number;
}

async function readLocated(file: string): Promise<ConfigObject> {
  const source = await readJson<ConfigObject>(file);
  const directory = path.dirname(file);
  if (isObject(source.output) && typeof source.output.path === "string")
    source.output = { ...source.output, path: path.resolve(directory, source.output.path) };
  if (isObject(source.attribution) && typeof source.attribution.path === "string")
    source.attribution = { ...source.attribution, path: path.resolve(directory, source.attribution.path) };
  if (isObject(source.inputs) && Array.isArray(source.inputs.versions))
    source.inputs.versions = source.inputs.versions.map((item) =>
      isObject(item) && Array.isArray(item.sources)
        ? {
            ...item,
            sources: item.sources.map((entry) =>
              isObject(entry) && typeof entry.path === "string"
                ? { ...entry, path: path.resolve(directory, entry.path) }
                : entry,
            ),
          }
        : item,
    );
  return source;
}

/** Reads and deep-merges config files in order, resolving relative paths per file. */
export async function readConfigSources(sources: string | string[]): Promise<ConfigObject> {
  const files = (Array.isArray(sources) ? sources : [sources]).map((file) => path.resolve(file));
  if (!files.length) throw new Error("At least one config file is required");
  const parts = await Promise.all(files.map(readLocated));
  return parts.reduce((base, part) => mergeConfig(base, part), {});
}

function buildEvaluation(source: ConfigObject): EvalConfig {
  const config: EvalConfig = {
    inputs: source.inputs as EvalConfig["inputs"],
    execution: { ...EXECUTION_DEFAULTS, ...(source.execution as Partial<EvalConfig["execution"]>) },
    output: source.output as OutputTarget,
    attribution: source.attribution as AttributionTarget,
    comparisons: [],
    rewrite: { comparison: false, attribution: false },
  };
  if (source.rewrite !== undefined) {
    if (!isObject(source.rewrite)) throw new Error("Invalid rewrite");
    for (const key of ["comparison", "attribution"] as const)
      if (source.rewrite[key] !== undefined && typeof source.rewrite[key] !== "boolean")
        throw new Error(`Invalid rewrite.${key}`);
    config.rewrite = {
      comparison: source.rewrite.comparison === true,
      attribution: source.rewrite.attribution === true,
    };
  }
  const versions = config.inputs?.versions;
  if (!Array.isArray(versions) || versions.length < 2) throw new Error("至少配置两个输入版本");
  for (const item of versions) {
    if (!/^[a-z][a-z0-9_]*$/.test(item.id) || !inputAdapterIds.includes(item.adapter))
      throw new Error("Invalid input version");
    if (!Array.isArray(item.sources) || !item.sources.length) throw new Error("Missing input sources");
    item.timing_unit ??= config.inputs.timing_unit ?? "ms";
    if (!["ms", "s"].includes(item.timing_unit)) throw new Error("Invalid timing unit");
  }
  for (const key of ["id", "name", "display_name"] as const) {
    const values = versions.map((v) => (key === "display_name" ? v.display_name || v.name : v[key]));
    if (values.some((v) => !v) || new Set(values).size !== values.length)
      throw new Error(`Duplicate or empty ${key}`);
  }
  const rawGroups = source.comparisons;
  if (!Array.isArray(rawGroups) || !rawGroups.length) throw new Error("Missing comparisons");
  const seenGroups = new Set<string>();
  for (const group of rawGroups) {
    if (
      !Array.isArray(group) ||
      group.length < 2 ||
      group.some((id) => typeof id !== "string") ||
      new Set(group).size !== group.length ||
      group.some((id) => !versions.some((version) => version.id === id))
    )
      throw new Error("Invalid comparisons; each group needs >=2 distinct registered version IDs");
    const key = [...group].sort().join("\u0000");
    if (seenGroups.has(key)) throw new Error("Duplicate comparison group: " + group.join(" / "));
    seenGroups.add(key);
  }
  config.comparisons = rawGroups as string[][];
  for (const key of [
    "concurrency",
    "timeoutSeconds",
    "idleTimeoutSeconds",
    "maxToolCalls",
    "codeTimeoutSeconds",
    "maxOutputChars",
    "initialContextChars",
  ] as const) {
    if (!Number.isInteger(config.execution[key]) || config.execution[key] <= 0)
      throw new Error(`Invalid execution.${key}`);
  }
  for (const key of ["retries", "retryDelaySeconds", "repairAttempts"] as const)
    if (!Number.isInteger(config.execution[key]) || config.execution[key] < 0)
      throw new Error(`Invalid execution.${key}`);
  if (
    config.execution.maxTokens !== undefined &&
    (!Number.isInteger(config.execution.maxTokens) || config.execution.maxTokens < 1)
  )
    throw new Error("Invalid execution.maxTokens");
  const output = config.output;
  if (!isObject(output) || output.kind !== "directory" || typeof output.path !== "string" || !output.path)
    throw new Error("Missing output target");
  const attribution = config.attribution;
  if (
    !isObject(attribution) ||
    attribution.kind !== "directory" ||
    typeof attribution.path !== "string" ||
    !attribution.path
  )
    throw new Error("Missing attribution target");
  return config;
}

function buildModels(source: ConfigObject, env: NodeJS.ProcessEnv): ModelCatalog {
  const rawModels = source.models;
  if (!isObject(rawModels) || !Object.keys(rawModels).length)
    throw new Error("Missing models; configure at least one model profile");
  const rawBindings = source.bindings;
  if (!isObject(rawBindings) || !Object.keys(rawBindings).length)
    throw new Error("Missing bindings; map every evaluation stage to a model profile");
  const models: Record<string, ModelProfile> = {};
  for (const [name, value] of Object.entries(rawModels)) {
    if (!isObject(value)) throw new Error(`Invalid models.${name}`);
    const provider = optionalString(value.provider, `models.${name}.provider`);
    if (!provider) throw new Error(`Missing models.${name}.provider`);
    const baseUrlEnv = envName(value.baseUrlEnv, `models.${name}.baseUrlEnv`);
    const baseUrl = env[baseUrlEnv];
    if (!baseUrl) throw new Error(`Missing ${baseUrlEnv}; configure the model endpoint in .env`);
    const endpoint = new URL(baseUrl);
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password)
      throw new Error(`Invalid ${baseUrlEnv} for models.${name}`);
    const api = value.api;
    if (!API_KINDS.includes(api as ModelProfile["api"])) throw new Error(`Invalid models.${name}.api`);
    models[name] = {
      provider,
      baseUrl,
      api: api as ModelProfile["api"],
      apiKeyEnv: envName(value.apiKeyEnv, `models.${name}.apiKeyEnv`),
      model: optionalString(value.model, `models.${name}.model`),
      thinking: optionalThinking(value.thinking, `models.${name}.thinking`),
      contextWindow: optionalPositiveInteger(value.contextWindow, `models.${name}.contextWindow`),
      maxOutputTokens: optionalPositiveInteger(value.maxOutputTokens, `models.${name}.maxOutputTokens`),
    };
  }
  const bindings: Record<string, StageBinding> = {};
  for (const [stage, value] of Object.entries(rawBindings)) {
    if (!isObject(value) || typeof value.profile !== "string" || !models[value.profile])
      throw new Error(`Invalid bindings.${stage}; it must reference a defined model profile`);
    bindings[stage] = {
      profile: value.profile,
      model: optionalString(value.model, `bindings.${stage}.model`),
      thinking: optionalThinking(value.thinking, `bindings.${stage}.thinking`),
      contextWindow: optionalPositiveInteger(value.contextWindow, `bindings.${stage}.contextWindow`),
      maxOutputTokens: optionalPositiveInteger(value.maxOutputTokens, `bindings.${stage}.maxOutputTokens`),
    };
  }
  return { models, bindings };
}

const DASHBOARD_STAGES = ["attribution", "comparison", "rewrite"] as const;
const DASHBOARD_EXECUTION = ["concurrency", "timeoutSeconds", "maxToolCalls", "retries"] as const;
const DASHBOARD_BINDING = ["model", "thinking"] as const;

export function editableDashboardSettings(source: Record<string, unknown>) {
  const execution = isObject(source.execution) ? source.execution : {};
  const rewrite = isObject(source.rewrite) ? source.rewrite : {};
  const models = isObject(source.models) ? source.models : {};
  const bindings = isObject(source.bindings) ? source.bindings : {};
  const inputs = isObject(source.inputs) ? source.inputs : {};
  return {
    execution: {
      concurrency: execution.concurrency ?? EXECUTION_DEFAULTS.concurrency,
      timeoutSeconds: execution.timeoutSeconds ?? EXECUTION_DEFAULTS.timeoutSeconds,
      maxToolCalls: execution.maxToolCalls ?? EXECUTION_DEFAULTS.maxToolCalls,
      retries: execution.retries ?? EXECUTION_DEFAULTS.retries,
    },
    rewrite: { attribution: rewrite.attribution === true, comparison: rewrite.comparison === true },
    models: (Array.isArray(inputs.versions) ? inputs.versions : []).flatMap((version) =>
      isObject(version) && typeof version.id === "string"
        ? [{ id: version.id, name: String(version.display_name || version.name || version.id) }]
        : [],
    ),
    // Only stages the launch seam accepts are editable; other bindings stay config-owned.
    bindings: Object.fromEntries(Object.entries(bindings)
      .filter(([stage]) => DASHBOARD_STAGES.includes(stage as typeof DASHBOARD_STAGES[number]))
      .map(([stage, raw]) => {
        const binding = isObject(raw) ? raw : {};
        const profile = models[String(binding.profile)];
        const defaults = isObject(profile) ? profile : {};
        return [stage, {
          model: binding.model ?? defaults.model ?? "",
          thinking: binding.thinking ?? defaults.thinking ?? "off",
        }];
      })),
  };
}

/** Only these non-secret, run-scoped settings may cross the dashboard launch seam. */
export function dashboardSettings(value: unknown): ConfigObject {
  if (!isObject(value)) throw new Error("运行设置必须是对象");
  if (Object.keys(value).some((key) => !["execution", "bindings", "rewrite", "versions"].includes(key)))
    throw new Error("运行设置包含不允许修改的字段");
  const patch: ConfigObject = {};
  if (value.versions !== undefined) {
    if (!Array.isArray(value.versions) || value.versions.some((id) => typeof id !== "string" || !id))
      throw new Error("模型选择无效");
    patch.versions = [...new Set(value.versions)];
  }
  if (value.execution !== undefined) {
    if (!isObject(value.execution) ||
        Object.keys(value.execution).some((key) => !DASHBOARD_EXECUTION.includes(key as typeof DASHBOARD_EXECUTION[number])))
      throw new Error("运行预算包含不允许修改的字段");
    patch.execution = value.execution;
  }
  if (value.bindings !== undefined) {
    if (!isObject(value.bindings) ||
        Object.keys(value.bindings).some((stage) => !DASHBOARD_STAGES.includes(stage as typeof DASHBOARD_STAGES[number])))
      throw new Error("模型绑定包含未知阶段");
    for (const binding of Object.values(value.bindings))
      if (!isObject(binding) ||
          Object.keys(binding).some((key) => !DASHBOARD_BINDING.includes(key as typeof DASHBOARD_BINDING[number])))
        throw new Error("模型绑定包含不允许修改的字段");
    patch.bindings = value.bindings;
  }
  if (value.rewrite !== undefined) {
    if (!isObject(value.rewrite) ||
        Object.keys(value.rewrite).some((key) => !["comparison", "attribution"].includes(key)))
      throw new Error("改写设置包含不允许修改的字段");
    patch.rewrite = value.rewrite;
  }
  return patch;
}

async function mergedSource(
  sources: string | string[],
  settings?: unknown,
): Promise<{ source: ConfigObject; versions?: string[] }> {
  const original = await readConfigSources(sources);
  if (settings === undefined) return { source: original };
  const patch = dashboardSettings(settings);
  const versions = patch.versions as string[] | undefined;
  delete patch.versions;
  return { source: mergeConfig(original, patch), versions };
}

/** Narrows an evaluation to the selected models; configured groups keep their remaining members. */
function selectVersions(evaluation: EvalConfig, ids: string[]): EvalConfig {
  if (ids.length < 2) throw new Error("至少选择两个模型");
  const versions = evaluation.inputs.versions.filter((version) => ids.includes(version.id));
  if (versions.length !== ids.length) throw new Error("运行设置包含未登记的模型");
  const comparisons = evaluation.comparisons
    .map((group) => group.filter((id) => ids.includes(id)))
    .filter((group) => group.length >= 2);
  if (!comparisons.length) throw new Error("所选模型没有可比较的组合");
  return { ...evaluation, inputs: { ...evaluation.inputs, versions }, comparisons };
}

/** Evaluation-only load, without model endpoints; the dashboard uses it for input discovery. */
export async function loadEvaluation(sources: string | string[], settings?: unknown): Promise<EvalConfig> {
  const { source, versions } = await mergedSource(sources, settings);
  const evaluation = buildEvaluation(source);
  return versions ? selectVersions(evaluation, versions) : evaluation;
}

export async function loadConfig(
  sources: string | string[],
  env = process.env,
  settings?: unknown,
): Promise<HostConfig> {
  const { source, versions } = await mergedSource(sources, settings);
  const base = buildEvaluation(source), models = buildModels(source, env);
  const evaluation = versions ? selectVersions(base, versions) : base;
  if ((evaluation.rewrite.comparison || evaluation.rewrite.attribution) && !models.bindings.rewrite)
    throw new Error("rewrite 已启用但缺少 bindings.rewrite");
  return { evaluation, models };
}
