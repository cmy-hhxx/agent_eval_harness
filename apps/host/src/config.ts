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
    execution: {
      ...DEFAULT_POLICY,
      concurrency: 4,
      retries: 1,
      retryDelaySeconds: 10,
      initialContextChars: 16000,
      ...(source.execution as Partial<EvalConfig["execution"]>),
    },
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

export async function loadConfig(sources: string | string[], env = process.env): Promise<HostConfig> {
  const source = await readConfigSources(sources);
  const evaluation = buildEvaluation(source),
    models = buildModels(source, env);
  if ((evaluation.rewrite.comparison || evaluation.rewrite.attribution) && !models.bindings.rewrite)
    throw new Error("rewrite 已启用但缺少 bindings.rewrite");
  return { evaluation, models };
}
