import type { EvaluationConfig } from "@eval/workflows/inputs";
import type { AnswerReviewConfig } from "@eval/workflows/answer-review";
import type { AttributionConfig } from "@eval/workflows/attribution";
import path from "node:path";
import { DEFAULT_POLICY, type OutputTarget, type ProblemLibraryTarget } from "@eval/contracts";
import { readJson } from "@eval/data";
import { DEFAULT_FAILURE_GUARD, validateFailureGuard } from "@eval/host";
import type { EvalConfig } from "@eval/workflows/comparison";
import { assertComparableGroups, selectComparisonGroups } from "@eval/workflows/comparison";
import { inputAdapterIds } from "@eval/workflows/inputs";
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
export { createBalancedModels } from "./balanced-models.js";
export { testEvaluationOutput } from "./evaluation-output.js";
import { readSettings, applySettings, type ApplicationSettings } from "./settings.js";

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
  maxClassesPerModel: 40,
  maxNewClassesPerTask: 3,
  maxComponentsPerModel: 12,
  consolidateAt: 30,
  minSupport: 3,
  maxCasesPerTask: 30,
};
type ConfigObject = Record<string, unknown>;

interface HostConfiguration {
  /** Declared identity of the judging logic; stamped onto every accepted result. */
  evaluatorVersion: string;
  /** Model profiles and per-stage bindings, resolved against config.ini channels. */
  models: ModelCatalog;
  automation: ApplicationSettings["automation"];
}

export type HostConfig = HostConfiguration & (
  | { workflow: "comparison"; evaluation: EvalConfig }
  | { workflow: "answer-review"; evaluation: AnswerReviewConfig }
  | { workflow: "attribution"; evaluation: AttributionConfig }
);
export type ComparisonHostConfig = Extract<HostConfig, { workflow: "comparison" }>;
export type AnswerReviewHostConfig = Extract<HostConfig, { workflow: "answer-review" }>;
export type AttributionHostConfig = Extract<HostConfig, { workflow: "attribution" }>;

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

function buildEvaluationBase(source: ConfigObject): EvaluationConfig {
  const config: EvaluationConfig = {
    inputs: source.inputs as EvaluationConfig["inputs"],
    execution: { ...EXECUTION_DEFAULTS, ...(source.execution as Partial<EvaluationConfig["execution"]>) },
    output: source.output as OutputTarget,
  };
  const scope = config.inputs?.workbench;
  if (scope !== undefined) {
    if (!isObject(scope) || !isObject(scope.task) || typeof scope.task.id !== "string" || !scope.task.id ||
        !Array.isArray(scope.batch_ids) || !scope.batch_ids.length || scope.batch_ids.some(id => typeof id !== "string" || !id) ||
        !Array.isArray(scope.records) || !scope.records.length || scope.records.some(row => !isObject(row) ||
          (["model", "batch_id", "case_id", "input_file", "package_id", "package_name", "original_file"] as const).some(key => typeof row[key] !== "string" || !row[key]) ||
          !Number.isSafeInteger(row.input_index) || Number(row.input_index) < 0 || !path.isAbsolute(String(row.input_file)) ||
          !Number.isSafeInteger(row.original_line) || Number(row.original_line) < 1 || !scope.batch_ids.includes(String(row.package_id))))
      throw new Error("Invalid cleaning scope");
    const coordinates = scope.records.map(row => JSON.stringify([row.model,row.input_file,row.input_index]));
    if (new Set(coordinates).size !== coordinates.length) throw new Error("Duplicate cleaning coordinates");
  }
  const versions = config.inputs?.versions;
  if (!Array.isArray(versions) || versions.length < (config.inputs.workbench || source.workflow === "answer-review" ? 1 : 2)) throw new Error("至少配置两个输入版本");
  for (const item of versions) {
    if (!/^[a-z0-9][a-z0-9_.-]{0,180}$/.test(item.id) || item.id.includes("..") || !inputAdapterIds.includes(item.adapter))
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
  optionalPositiveInteger(config.execution.maxTaskAttempts, "execution.maxTaskAttempts");
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
  return config;
}

type WorkflowEvaluation = EvalConfig | AnswerReviewConfig | AttributionConfig;
function isAnswerReviewEvaluation(config: WorkflowEvaluation): config is AnswerReviewConfig {
  return "workflow" in config && config.workflow === "answer-review";
}
function isAttributionEvaluation(config: WorkflowEvaluation): config is AttributionConfig {
  return "workflow" in config && config.workflow === "attribution";
}

function buildEvaluation(source: ConfigObject): WorkflowEvaluation {
  if (source.workflow !== undefined && !["comparison", "attribution"].includes(String(source.workflow))) throw new Error("Invalid workflow");
  const base = buildEvaluationBase(source);
  if (source.workflow === "attribution") return { ...base, workflow: "attribution" };
  const config: EvalConfig = {
    ...base,
    problemLibrary: source.problemLibrary as ProblemLibraryTarget,
    comparisons: [],
    standardAnswerReview: optionalBoolean(source.standardAnswerReview, "standardAnswerReview") ?? false,
    rewrite: { comparison: true, comparisonItems: true, attribution: true, clustering: true },
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
      comparisonItems: source.rewrite.comparisonItems !== false,
      attribution: source.rewrite.attribution !== false,
      clustering: source.rewrite.clustering !== false,
    };
  }
  const versions = config.inputs.versions;
  const rawGroups = source.comparisons;
  if (!Array.isArray(rawGroups) || (!rawGroups.length && !config.inputs.workbench)) throw new Error("Missing comparisons");
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
      if (!["channel", "model", "thinking"].includes(field))
        throw new Error(`Invalid models.${name}.${field}; configure channel protocol and capabilities in config.ini`);
    const channelId = optionalString(value.channel, `models.${name}.channel`);
    const channel = channelId ? configuration.channels[channelId] : undefined;
    if (!channel) throw new Error(`Unknown models.${name}.channel in config.ini`);
    if (channel.api !== "openai-responses") throw new Error(`Evaluation channel "${channelId}" requires openai-responses`);
    models[name] = {
      ...channel,
      model: optionalString(value.model, `models.${name}.model`) ?? channel.model,
      thinking: optionalThinking(value.thinking, `models.${name}.thinking`) ?? channel.thinking,
    };
  }
  const bindings: Record<string, StageBinding> = {};
  for (const [stage, value] of Object.entries(rawBindings)) {
    if (!isObject(value) || typeof value.profile !== "string" || !models[value.profile])
      throw new Error(`Invalid bindings.${stage}; it must reference a defined model profile`);
    for (const field of Object.keys(value))
      if (!["profile", "channel", "model", "thinking"].includes(field))
        throw new Error(`Invalid bindings.${stage}.${field}; configure channel capabilities in config.ini`);
    const channel = optionalString(value.channel, `bindings.${stage}.channel`);
    if (channel && !configuration.channels[channel]) throw new Error(`Unknown bindings.${stage}.channel in config.ini`);
    if (channel && configuration.channels[channel].api !== "openai-responses")
      throw new Error(`Evaluation channel "${channel}" requires openai-responses`);
    bindings[stage] = {
      ...(channel ? { channel } : {}),
      profile: value.profile,
      model: optionalString(value.model, `bindings.${stage}.model`),
      thinking: optionalThinking(value.thinking, `bindings.${stage}.thinking`),
    };
  }
  return { models, bindings, channels: configuration.channels };
}

const DASHBOARD_STAGES = ["criteria", "score", "attribution", "instruction-review", "comparison", "rewrite", "clustering"] as const;
const DASHBOARD_EXECUTION = ["concurrency", "timeoutSeconds", "maxToolCalls", "retries", "repairAttempts", "maxTaskAttempts", "retryDelaySeconds"] as const;
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
      repairAttempts: execution.repairAttempts ?? EXECUTION_DEFAULTS.repairAttempts,
      maxTaskAttempts: execution.maxTaskAttempts,
      retryDelaySeconds: execution.retryDelaySeconds ?? EXECUTION_DEFAULTS.retryDelaySeconds,
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
export function dashboardSettings(value: unknown, previous: ConfigObject = {}): ConfigObject {
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
    patch.execution = { ...value.execution };
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
  const result = mergeConfig(previous, patch);
  if (isObject(value.execution) && value.execution.maxTaskAttempts === null && isObject(result.execution))
    delete result.execution.maxTaskAttempts;
  return result;
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
function selectVersions(evaluation: WorkflowEvaluation, ids: string[]): WorkflowEvaluation {
  const independent = isAnswerReviewEvaluation(evaluation) || isAttributionEvaluation(evaluation);
  if (ids.length < (independent ? 1 : 2))
    throw new Error(independent ? "至少选择一个模型" : "至少选择两个模型");
  const versions = evaluation.inputs.versions.filter((version) => ids.includes(version.id));
  if (versions.length !== ids.length) throw new Error("运行设置包含未登记的模型");
  if (independent) return { ...evaluation, inputs: { ...evaluation.inputs, versions } };
  const comparisons = selectComparisonGroups(evaluation.comparisons, ids);
  if (!comparisons.length) throw new Error("所选模型没有可比较的组合");
  return { ...evaluation, inputs: { ...evaluation.inputs, versions }, comparisons };
}

/** Evaluation-only load, without model endpoints; the dashboard uses it for input discovery. */
export async function loadComparisonEvaluation(sources: string | string[], settings?: unknown): Promise<EvalConfig> {
  const { source, versions } = await mergedSource(sources, settings);
  readEvaluatorVersion(source);
  const evaluation = buildEvaluation(source);
  const selected = versions ? selectVersions(evaluation, versions) : evaluation;
  if (isAnswerReviewEvaluation(selected) || isAttributionEvaluation(selected)) throw new Error("此入口需要对战工作流配置");
  return selected;
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
  const common = { evaluatorVersion, models, automation: configuration.automation };
  if (isAttributionEvaluation(evaluation)) return { ...common, workflow: "attribution", evaluation };
  if (isAnswerReviewEvaluation(evaluation)) throw new Error("answer-review 已移除，请使用 attribution 或 comparison workflow");
  if ([evaluation.rewrite.comparison, evaluation.rewrite.attribution, evaluation.rewrite.clustering].some(Boolean) && !models.bindings.rewrite)
    throw new Error("rewrite 已启用但缺少 bindings.rewrite");
  if (evaluation.clustering.enabled && !models.bindings.clustering)
    throw new Error("clustering 已启用但缺少 bindings.clustering");
  return { ...common, workflow: "comparison", evaluation };
}

/** Comparison-only callers never receive independent-review configuration. */
export async function loadComparisonConfig(sources: string | string[], configuration?: ApplicationSettings,
  settings?: unknown): Promise<ComparisonHostConfig> {
  const host = await loadConfig(sources, configuration, settings);
  if (host.workflow !== "comparison") throw new Error("此入口需要对战工作流配置");
  return host;
}
