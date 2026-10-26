import path from "node:path";
import { pathToFileURL } from "node:url";
import { safeId } from "@eval/contracts";
import { readJson } from "@eval/data";
import { validInputDate } from "@eval/runtime/client";
import type { PipelineOptions } from "@eval/automations";
import type { EvalConfig } from "@eval/workflows/comparison";

export interface AutomationConfig extends PipelineOptions {
  /** Persistent evaluation task identity; independent experiments require distinct IDs and local paths. */
  id: string;
  sourceUrl: string;
  remoteModels: string[];
  completedDates: string[];
  hostConfigs: string[];
  stateDirectory: string;
  sourceDirectory: string;
  runPrefix: string;
  requestTimeoutMs: number;
  dailyComparisonLimitPerTier: number;
  channelConcurrency?: Record<string, number>;
  publishProgress: boolean;
  publishMongo: boolean;
  publishStatisticsLog: boolean;
  autoClean?: boolean;
  runtimeSettings?: { debug: boolean; settings: Record<string, unknown> };
  prediction?: { answersFile: string; sourceConfig: string };
  /** Accepted prediction replacements applied to this source's publication and statistics. */
  predictionResults?: string;
  publication: {
    /** Human-readable experiment label stored on both Mongo inputs and results. */
    topic?: string;
    logFile: string;
    logUrl: string;
    mongoUriEnv: string;
    mongoDatabase: string;
    mongoCollection: string;
    mongoTlsCAFileEnv: string;
  };
}

export async function loadAutomationConfig(file: string): Promise<AutomationConfig> {
  const raw = await readJson<Record<string, unknown>>(file), directory = path.dirname(path.resolve(file));
  const keys = ["id", "sourceUrl", "remoteModels", "fromDate", "throughDate", "completedDates", "hostConfigs", "stateDirectory",
    "sourceDirectory", "runPrefix", "pollMs", "refreshMs", "retryMs", "maxEvaluationAttempts",
    "requestTimeoutMs", "dailyComparisonLimitPerTier", "channelConcurrency", "publishProgress", "publishMongo", "publishStatisticsLog", "publication",
    "prediction", "predictionResults", "autoClean"];
  for (const key of Object.keys(raw)) if (!keys.includes(key)) throw new Error(`Unknown automation setting: ${key}`);
  const string = (key: string): string => {
    if (typeof raw[key] !== "string" || !raw[key]) throw new Error(`Invalid automations.${key}`);
    return raw[key];
  };
  const number = (key: string): number => {
    if (!Number.isSafeInteger(raw[key]) || Number(raw[key]) <= 0) throw new Error(`Invalid automations.${key}`);
    return Number(raw[key]);
  };
  const strings = (key: string): string[] => {
    const value = raw[key];
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item) || new Set(value).size !== value.length)
      throw new Error(`Invalid automations.${key}`);
    return value;
  };
  let prediction: AutomationConfig["prediction"];
  if (raw.prediction !== undefined) {
    const value = raw.prediction as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).some(key => !["answersFile", "sourceConfig"].includes(key)) ||
        ["answersFile", "sourceConfig"].some(key => typeof value[key] !== "string" || !value[key]))
      throw new Error("Invalid automations.prediction");
    prediction = { answersFile: path.resolve(directory, String(value.answersFile)), sourceConfig: path.resolve(directory, String(value.sourceConfig)) };
  }
  const source = prediction ? pathToFileURL(prediction.answersFile) : new URL(string("sourceUrl"));
  if (!prediction && (!["http:", "https:"].includes(source.protocol) || source.username || source.password || source.search || source.hash))
    throw new Error("sourceUrl must be an HTTP(S) service URL without credentials/query/fragment");
  const fromDate = raw.fromDate === null ? null : string("fromDate");
  const throughDate = raw.throughDate === null ? null : raw.throughDate === undefined ? undefined : string("throughDate");
  const completedDates = strings("completedDates");
  if (![...(fromDate ? [fromDate] : []), ...(throughDate ? [throughDate] : []), ...completedDates].every(validInputDate) ||
      (throughDate && fromDate && throughDate < fromDate)) throw new Error("Invalid automation date range");
  if (raw.autoClean !== undefined && typeof raw.autoClean !== "boolean") throw new Error("Invalid automations.autoClean");
  if (typeof raw.publishProgress !== "boolean") throw new Error("Invalid automations.publishProgress");
  if (typeof raw.publishStatisticsLog !== "boolean") throw new Error("Invalid automations.publishStatisticsLog");
  if (typeof raw.publishMongo !== "boolean") throw new Error("Invalid automations.publishMongo");
  if (prediction && !raw.publishMongo) throw new Error("Prediction requires Mongo publication");
  if (prediction && (raw.publishProgress || raw.publishStatisticsLog))
    throw new Error("Prediction source publishes results through its original task, without separate progress/statistics uploads");
  const predictionResults = raw.predictionResults === undefined ? undefined : path.resolve(directory, string("predictionResults"));
  const hostConfigs = strings("hostConfigs").map((entry) => path.resolve(directory, entry));
  if (!hostConfigs.length) throw new Error("hostConfigs must not be empty");
  const remoteModels = strings("remoteModels").map(safeId);
  if (!remoteModels.length) throw new Error("remoteModels must not be empty");
  if (typeof raw.runPrefix !== "string") throw new Error("Invalid automations.runPrefix");
  const runPrefix = raw.runPrefix ? safeId(raw.runPrefix) : "";
  const channelConcurrency = raw.channelConcurrency as AutomationConfig["channelConcurrency"];
  if (channelConcurrency !== undefined && (!channelConcurrency || typeof channelConcurrency !== "object" ||
      Array.isArray(channelConcurrency) || Object.entries(channelConcurrency).some(([channel, limit]) =>
        !/^[a-z][a-z0-9_-]*$/.test(channel) || !Number.isSafeInteger(limit) || limit <= 0)))
    throw new Error("Invalid automations.channelConcurrency");
  const publication = raw.publication as AutomationConfig["publication"];
  const publicationKeys = ["logFile", "logUrl", "mongoUriEnv", "mongoDatabase", "mongoCollection", "mongoTlsCAFileEnv"];
  if (!publication || typeof publication !== "object" || Array.isArray(publication) ||
      Object.keys(publication).some((key) => key !== "topic" && !publicationKeys.includes(key)) ||
      (publication.topic !== undefined && (typeof publication.topic !== "string" || !publication.topic.trim())) ||
      publicationKeys.some((key) => typeof (publication as Record<string, unknown>)[key] !== "string" || !(publication as Record<string, unknown>)[key]))
    throw new Error("Invalid automations.publication");
  const logUrl = new URL(publication.logUrl);
  if (!["http:", "https:"].includes(logUrl.protocol) || logUrl.username || logUrl.password || logUrl.hash)
    throw new Error("publication.logUrl must be an HTTP(S) URL without credentials/fragment");
  for (const key of [publication.mongoUriEnv, publication.mongoTlsCAFileEnv])
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error("Invalid publication environment variable name");
  return {
    id: safeId(string("id")), sourceUrl: source.href.replace(/\/$/, ""), remoteModels, fromDate, throughDate, completedDates,
    hostConfigs, stateDirectory: path.resolve(directory, string("stateDirectory")),
    sourceDirectory: path.resolve(directory, string("sourceDirectory")), runPrefix,
    pollMs: number("pollMs"), refreshMs: raw.refreshMs === null ? Infinity : number("refreshMs"), retryMs: number("retryMs"),
    maxEvaluationAttempts: number("maxEvaluationAttempts"), requestTimeoutMs: number("requestTimeoutMs"),
    dailyComparisonLimitPerTier: raw.dailyComparisonLimitPerTier === null ? Infinity : number("dailyComparisonLimitPerTier"),
    channelConcurrency,
    publishProgress: raw.publishProgress,
    publishMongo: raw.publishMongo,
    publishStatisticsLog: raw.publishStatisticsLog,
    autoClean: raw.autoClean as boolean | undefined,
    ...(prediction ? { prediction } : {}),
    ...(predictionResults ? { predictionResults } : {}),
    publication: { ...publication, logFile: path.resolve(directory, publication.logFile), logUrl: logUrl.href },
  };
}

/** Finish evaluations and their rewrites continuously; build the problem library separately. */
export function automationEvaluationConfig(base: EvalConfig, sourceDirectory: string, date: string, remoteModels: readonly string[]): EvalConfig {
  for (const id of remoteModels)
    if (!base.inputs.versions.some((version) => version.id === id)) throw new Error(`Missing automation model: ${id}`);
  return {
    ...base,
    inputs: {
      timing_unit: base.inputs.timing_unit, default_batch_id: date,
      versions: base.inputs.versions.map((version) => ({
        ...version, sources: remoteModels.includes(version.id)
          ? [{ kind: "file", path: path.join(sourceDirectory, date, version.id + ".jsonl") }] : version.sources,
      })),
      batches: [date],
    },
    comparisons: base.comparisons,
    rewrite: base.rewrite,
    clustering: { ...base.clustering, enabled: false },
  };
}
