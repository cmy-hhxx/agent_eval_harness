import path from "node:path";
import { DEFAULT_POLICY, type OutputTarget, type ProblemLibraryTarget } from "@eval/contracts";
import { readJson } from "@eval/data";
import { DEFAULT_FAILURE_GUARD, validateFailureGuard } from "@eval/host";
import type { EvalConfig } from "@eval/workflows/comparison";
import { assertComparableGroups, inputAdapterIds, selectComparisonGroups } from "@eval/workflows/comparison";
import {
  THINKING_LEVELS,
  DEFAULT_THINKING,
  type ModelCatalog,
  type ModelProfile,
  type StageBinding,
  type Thinking,
} from "./models.js";
export * from "./models.js";
export * from "./settings.js";
import { readSettings, applySettings, type ApplicationSettings } from "./settings.js";

const API_KINDS: ModelProfile["api"][] = ["openai-completions", "openai-responses"];
const EXECUTION_DEFAULTS = {
  ...DEFAULT_POLICY,
  concurrency: 8,
  retries: 1,
  retryDelaySeconds: 10,
  initialContextChars: 16000,
  failureGuard: DEFAULT_FAILURE_GUARD,
};
const CLUSTERING_DEFAULTS: EvalConfig["clustering"] = {
  enabled: false,
  maxClassesPerModel: 80,
  maxNewClassesPerTask: 8,
  maxComponentsPerModel: 12,
  consolidateAt: 60,
  minSupport: 1,
  maxCasesPerTask: 100,
};
type ConfigObject = Record<string, unknown>;

export interface HostConfig {
  /** Declared identity of the judging logic; stamped onto every accepted result. */
  evaluatorVersion: string;
  /** Workflow-facing evaluation inputs and budgets. Contains no model configuration. */
  evaluation: EvalConfig;
  /** Model profiles and per-stage bindings, resolved against config.ini channels. */
  models: ModelCatalog;
  automation: ApplicationSettings["automation"];
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
function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`Invalid ${label}`);
  return value;
}
function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) <= 0) throw new Error(`Invalid ${label}`);
  return value as number;
}
function optionalNonNegativeInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`Invalid ${label}`);
  return value as number;
}
/** The evaluator identity is declared, never derived; any judging change must bump it. */
function readEvaluatorVersion(source: ConfigObject): string {
  const value = source.evaluatorVersion;
  if (typeof value !== "string" || !value.trim()) throw new Error("Missing evaluatorVersion");
  return value;
}

async function readLocated(file: string): Promise<ConfigObject> {
  const source = await readJson<ConfigObject>(file);
  const directory = path.dirname(file);
  if (isObject(source.output) && typeof source.output.path === "string")
    source.output = { ...source.output, path: path.resolve(directory, source.output.path) };
  if (isObject(source.problemLibrary) && typeof source.problemLibrary.path === "string")
    source.problemLibrary = {
      ...source.problemLibrary,
      path: path.resolve(directory, source.problemLibrary.path),
    };
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
    problemLibrary: source.problemLibrary as ProblemLibraryTarget,
    comparisons: [],
    rewrite: { comparison: true, attribution: true, clustering: true },
    clustering: { ...CLUSTERING_DEFAULTS },
  };
  if (source.reviewQuestions !== undefined) {
    const entries = source.reviewQuestions;
    if (!Array.isArray(entries) || entries.some(entry => !isObject(entry) ||
      Object.keys(entry).some(key => !["batch_id", "case_id", "questions"].includes(key)) ||
      typeof entry.batch_id !== "string" || !entry.batch_id.trim() ||
      typeof entry.case_id !== "string" || !entry.case_id.trim() ||
      !Array.isArray(entry.questions) || !entry.questions.length ||
      entry.questions.some(question => typeof question !== "string" || !question.trim())) ||
      new Set(entries.map(entry => JSON.stringify([entry.batch_id, entry.case_id]))).size !== entries.length)
      throw new Error("Invalid reviewQuestions: unique batch_id/case_id and non-empty questions are required");
    config.reviewQuestions = structuredClone(entries) as EvalConfig["reviewQuestions"];
  }
  if (source.clustering !== undefined) {
    if (!isObject(source.clustering)) throw new Error("Invalid clustering");
    const clustering = source.clustering;
    if (clustering.enabled !== undefined && typeof clustering.enabled !== "boolean")
      throw new Error("Invalid clustering.enabled");
    config.clustering = {
      enabled: clustering.enabled === true,
      maxClassesPerModel:
        optionalPositiveInteger(clustering.maxClassesPerModel, "clustering.maxClassesPerModel") ??
        CLUSTERING_DEFAULTS.maxClassesPerModel,
      maxNewClassesPerTask:
        optionalNonNegativeInteger(
          clustering.maxNewClassesPerTask,
          "clustering.maxNewClassesPerTask",
        ) ?? CLUSTERING_DEFAULTS.maxNewClassesPerTask,
      maxComponentsPerModel:
        optionalPositiveInteger(
          clustering.maxComponentsPerModel,
          "clustering.maxComponentsPerModel",
        ) ?? CLUSTERING_DEFAULTS.maxComponentsPerModel,
      consolidateAt:
        optionalNonNegativeInteger(clustering.consolidateAt, "clustering.consolidateAt") ??
        CLUSTERING_DEFAULTS.consolidateAt,
      minSupport:
        optionalPositiveInteger(clustering.minSupport, "clustering.minSupport") ??
        CLUSTERING_DEFAULTS.minSupport,
      maxCasesPerTask:
        optionalPositiveInteger(clustering.maxCasesPerTask, "clustering.maxCasesPerTask") ??
        CLUSTERING_DEFAULTS.maxCasesPerTask,
    };
  }
  if (source.rewrite !== undefined) {
    if (!isObject(source.rewrite)) throw new Error("Invalid rewrite");
    for (const key of ["comparison", "comparisonItems", "attribution", "clustering"] as const)
      if (source.rewrite[key] !== undefined && typeof source.rewrite[key] !== "boolean")
        throw new Error(`Invalid rewrite.${key}`);
    config.rewrite = {
      comparison: source.rewrite.comparison !== false,
      ...(source.rewrite.comparisonItems !== undefined ? { comparisonItems: source.rewrite.comparisonItems === true } : {}),
      attribution: source.rewrite.attribution !== false,
      clustering: source.rewrite.clustering !== false,
    };
  }
  const versions = config.inputs?.versions;
  if (!Array.isArray(versions) || versions.length < 2) throw new Error("至少配置两个输入版本");
  for (const item of versions) {
    if (!/^[a-z][a-z0-9_]*$/.test(item.id) || !inputAdapterIds.includes(item.adapter))
      throw new Error("Invalid input version");
    if (!Array.isArray(item.sources) || !item.sources.length) throw new Error("Missing input sources");
    if (item.comparison_tier !== undefined &&
        (typeof item.comparison_tier !== "string" || !item.comparison_tier.trim()))
      throw new Error(`Invalid comparison_tier for ${item.id}`);
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
      group.length > 3 ||
      group.some((id) => typeof id !== "string") ||
      new Set(group).size !== group.length ||
      group.some((id) => !versions.some((version) => version.id === id))
    )
      throw new Error("Invalid comparisons; each group needs 2–3 distinct registered version IDs");
    const key = [...group].sort().join("\u0000");
    if (seenGroups.has(key)) throw new Error("Duplicate comparison group: " + group.join(" / "));
    seenGroups.add(key);
  }
  config.comparisons = rawGroups as string[][];
  assertComparableGroups(config);
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
  if (config.execution.stageRepairAttempts !== undefined &&
    (!isObject(config.execution.stageRepairAttempts) || Object.entries(config.execution.stageRepairAttempts)
      .some(([stage,limit])=>!stage.trim()||!Number.isInteger(limit)||limit<0)))
    throw new Error("Invalid execution.stageRepairAttempts");
  validateFailureGuard(config.execution.failureGuard!);
  if (
    config.execution.maxTokens !== undefined &&
    (!Number.isInteger(config.execution.maxTokens) || config.execution.maxTokens < 1)
  )
    throw new Error("Invalid execution.maxTokens");
  const output = config.output;
  if (!isObject(output) || output.kind !== "directory" || typeof output.path !== "string" || !output.path)
    throw new Error("Missing output target");
  const problemLibrary = config.problemLibrary;
  if (
    !isObject(problemLibrary) ||
    problemLibrary.kind !== "directory" ||
    typeof problemLibrary.path !== "string" ||
    !problemLibrary.path
  )
    throw new Error("Missing problemLibrary target");
  return config;
}

function buildModels(source: ConfigObject, configuration: ApplicationSettings): ModelCatalog {
  const rawModels = source.models;
  if (!isObject(rawModels) || !Object.keys(rawModels).length)
    throw new Error("Missing models; configure at least one model profile");
  const rawBindings = source.bindings;
  if (!isObject(rawBindings) || !Object.keys(rawBindings).length)
    throw new Error("Missing bindings; map every evaluation stage to a model profile");
  const models: Record<string, ModelProfile> = {};
  for (const [name, value] of Object.entries(rawModels)) {
    if (!isObject(value)) throw new Error(`Invalid models.${name}`);
    for (const field of Object.keys(value))
      if (!["channel", "api", "model", "thinking", "contextWindow", "maxOutputTokens", "supportsDeveloperRole"].includes(field))
        throw new Error(`Invalid models.${name}.${field}; configure the endpoint in config.ini`);
    const channelId = optionalString(value.channel, `models.${name}.channel`);
    const channel = channelId ? configuration.channels[channelId] : undefined;
    if (!channel) throw new Error(`Unknown models.${name}.channel in config.ini`);
    const api = value.api ?? channel.api;
    if (!API_KINDS.includes(api as ModelProfile["api"])) throw new Error(`Invalid models.${name}.api`);
    const supportsDeveloperRole = optionalBoolean(value.supportsDeveloperRole, `models.${name}.supportsDeveloperRole`);
    models[name] = {
      ...channel,
      api: api as ModelProfile["api"],
      model: optionalString(value.model, `models.${name}.model`) ?? channel.model,
      thinking: optionalThinking(value.thinking, `models.${name}.thinking`) ?? channel.thinking,
      ...(supportsDeveloperRole !== undefined ? { supportsDeveloperRole } : {}),
      contextWindow: optionalPositiveInteger(value.contextWindow, `models.${name}.contextWindow`) ?? channel.contextWindow,
      maxOutputTokens: optionalPositiveInteger(value.maxOutputTokens, `models.${name}.maxOutputTokens`) ?? channel.maxOutputTokens,
    };
  }
  const bindings: Record<string, StageBinding> = {};
  for (const [stage, value] of Object.entries(rawBindings)) {
    if (!isObject(value) || typeof value.profile !== "string" || !models[value.profile])
      throw new Error(`Invalid bindings.${stage}; it must reference a defined model profile`);
    const channel = optionalString(value.channel, `bindings.${stage}.channel`);
    if (channel && !configuration.channels[channel]) throw new Error(`Unknown bindings.${stage}.channel in config.ini`);
    bindings[stage] = {
      ...(channel ? { channel } : {}),
      profile: value.profile,
      model: optionalString(value.model, `bindings.${stage}.model`),
      thinking: optionalThinking(value.thinking, `bindings.${stage}.thinking`),
      contextWindow: optionalPositiveInteger(value.contextWindow, `bindings.${stage}.contextWindow`),
      maxOutputTokens: optionalPositiveInteger(value.maxOutputTokens, `bindings.${stage}.maxOutputTokens`),
    };
  }
  return { models, bindings, channels: configuration.channels };
}

const DASHBOARD_STAGES = ["criteria", "attribution", "comparison", "rewrite", "clustering"] as const;
const DASHBOARD_EXECUTION = ["concurrency", "timeoutSeconds", "maxToolCalls", "retries"] as const;
const DASHBOARD_BINDING = ["channel", "model", "thinking"] as const;

export function editableDashboardSettings(source: Record<string, unknown>) {
  const execution = isObject(source.execution) ? source.execution : {};
  const rewrite = isObject(source.rewrite) ? source.rewrite : {};
  const clustering = isObject(source.clustering) ? source.clustering : {};
  const models = isObject(source.models) ? source.models : {};
  const bindings = isObject(source.bindings) ? { ...source.bindings } : {};
  const inputs = isObject(source.inputs) ? source.inputs : {};
  return {
    execution: {
      concurrency: execution.concurrency ?? EXECUTION_DEFAULTS.concurrency,
      timeoutSeconds: execution.timeoutSeconds ?? EXECUTION_DEFAULTS.timeoutSeconds,
      maxToolCalls: execution.maxToolCalls ?? EXECUTION_DEFAULTS.maxToolCalls,
      retries: execution.retries ?? EXECUTION_DEFAULTS.retries,
    },
    rewrite: { attribution: rewrite.attribution !== false, comparison: rewrite.comparison !== false, clustering: rewrite.clustering !== false },
    clustering: { enabled: clustering.enabled === true },
    comparisons: Array.isArray(source.comparisons) ? source.comparisons : [],
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
          channel: binding.channel ?? defaults.channel ?? "",
          model: binding.model ?? defaults.model ?? "",
          thinking: binding.thinking ?? defaults.thinking ?? DEFAULT_THINKING,
        }];
      })),
  };
}

/** Only these non-secret, run-scoped settings may cross the dashboard launch seam. */
export function dashboardSettings(value: unknown): ConfigObject {
  if (!isObject(value)) throw new Error("运行设置必须是对象");
  if (Object.keys(value).some((key) => !["execution", "bindings", "rewrite", "clustering", "versions"].includes(key)))
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
        Object.keys(value.rewrite).some((key) => !["comparison", "attribution", "clustering"].includes(key)))
      throw new Error("改写设置包含不允许修改的字段");
    patch.rewrite = value.rewrite;
  }
  if (value.clustering !== undefined) {
    if (!isObject(value.clustering) ||
        Object.keys(value.clustering).some((key) => key !== "enabled") ||
        typeof value.clustering.enabled !== "boolean")
      throw new Error("聚类设置包含不允许修改的字段");
    patch.clustering = value.clustering;
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
  const comparisons = selectComparisonGroups(evaluation.comparisons, ids);
  if (!comparisons.length) throw new Error("所选模型没有可比较的组合");
  return { ...evaluation, inputs: { ...evaluation.inputs, versions }, comparisons };
}

/** Evaluation-only load, without model endpoints; the dashboard uses it for input discovery. */
export async function loadEvaluation(sources: string | string[], settings?: unknown): Promise<EvalConfig> {
  const { source, versions } = await mergedSource(sources, settings);
  readEvaluatorVersion(source);
  const evaluation = buildEvaluation(source);
  return versions ? selectVersions(evaluation, versions) : evaluation;
}

export async function loadConfig(
  sources: string | string[],
  configuration?: ApplicationSettings,
  settings?: unknown,
): Promise<HostConfig> {
  const { source, versions } = await mergedSource(sources, settings);
  const evaluatorVersion = readEvaluatorVersion(source);
  configuration ??= await readSettings();
  applySettings(configuration);
  const base = buildEvaluation(source), models = buildModels(source, configuration);
  const evaluation = versions ? selectVersions(base, versions) : base;
  if ([evaluation.rewrite.comparison, evaluation.rewrite.attribution, evaluation.rewrite.clustering].some(Boolean) && !models.bindings.rewrite)
    throw new Error("rewrite 已启用但缺少 bindings.rewrite");
  if (evaluation.clustering.enabled && !models.bindings.clustering)
    throw new Error("clustering 已启用但缺少 bindings.clustering");
  return { evaluatorVersion, evaluation, models, automation: configuration.automation };
}
