import path from "node:path";
import { REMOTE_MODELS, safeId, type Engine } from "@eval/contracts";
import { readJson } from "@eval/data";
import { validInputDate } from "@eval/runtime/client";
import type { PipelineOptions } from "@eval/automations";
import type { EvalConfig } from "@eval/workflows/comparison";

export interface AutomationConfig extends PipelineOptions {
  id: string;
  sourceUrl: string;
  fromDate: string;
  throughDate?: string;
  completedDates: string[];
  hostConfigs: string[];
  stateDirectory: string;
  sourceDirectory: string;
  runPrefix: string;
  engine: Engine;
  requestTimeoutMs: number;
  dailyComparisonLimitPerTier: number;
  publishProgress: boolean;
  publication: {
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
  const keys = ["id", "sourceUrl", "fromDate", "throughDate", "completedDates", "hostConfigs", "stateDirectory",
    "sourceDirectory", "runPrefix", "engine", "pollMs", "refreshMs", "retryMs", "maxEvaluationAttempts",
    "requestTimeoutMs", "dailyComparisonLimitPerTier", "publishProgress", "publication"];
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
  const source = new URL(string("sourceUrl"));
  if (!["http:", "https:"].includes(source.protocol) || source.username || source.password || source.search || source.hash)
    throw new Error("sourceUrl must be an HTTP(S) service URL without credentials/query/fragment");
  const fromDate = string("fromDate"), throughDate = raw.throughDate === undefined ? undefined : string("throughDate");
  const completedDates = strings("completedDates");
  if (![fromDate, ...(throughDate ? [throughDate] : []), ...completedDates].every(validInputDate) ||
      (throughDate && throughDate < fromDate)) throw new Error("Invalid automation date range");
  const engine = string("engine");
  if (engine !== "pi" && engine !== "prime") throw new Error("Invalid automation engine");
  if (typeof raw.publishProgress !== "boolean") throw new Error("Invalid automations.publishProgress");
  const hostConfigs = strings("hostConfigs").map((entry) => path.resolve(directory, entry));
  if (!hostConfigs.length) throw new Error("hostConfigs must not be empty");
  const publication = raw.publication as AutomationConfig["publication"];
  const publicationKeys = ["logFile", "logUrl", "mongoUriEnv", "mongoDatabase", "mongoCollection", "mongoTlsCAFileEnv"];
  if (!publication || typeof publication !== "object" || Array.isArray(publication) ||
      Object.keys(publication).some((key) => !publicationKeys.includes(key)) ||
      publicationKeys.some((key) => typeof (publication as Record<string, unknown>)[key] !== "string" || !(publication as Record<string, unknown>)[key]))
    throw new Error("Invalid automations.publication");
  const logUrl = new URL(publication.logUrl);
  if (!["http:", "https:"].includes(logUrl.protocol) || logUrl.username || logUrl.password || logUrl.hash)
    throw new Error("publication.logUrl must be an HTTP(S) URL without credentials/fragment");
  for (const key of [publication.mongoUriEnv, publication.mongoTlsCAFileEnv])
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error("Invalid publication environment variable name");
  return {
    id: safeId(string("id")), sourceUrl: source.href.replace(/\/$/, ""), fromDate, throughDate, completedDates,
    hostConfigs, engine, stateDirectory: path.resolve(directory, string("stateDirectory")),
    sourceDirectory: path.resolve(directory, string("sourceDirectory")), runPrefix: safeId(string("runPrefix")),
    pollMs: number("pollMs"), refreshMs: number("refreshMs"), retryMs: number("retryMs"),
    maxEvaluationAttempts: number("maxEvaluationAttempts"), requestTimeoutMs: number("requestTimeoutMs"),
    dailyComparisonLimitPerTier: number("dailyComparisonLimitPerTier"),
    publishProgress: raw.publishProgress,
    publication: { ...publication, logFile: path.resolve(directory, publication.logFile), logUrl: logUrl.href },
  };
}

/** Finish evaluations and their rewrites continuously; build the problem library separately. */
export function automationEvaluationConfig(base: EvalConfig, sourceDirectory: string, date: string): EvalConfig {
  for (const id of REMOTE_MODELS)
    if (!base.inputs.versions.some((version) => version.id === id)) throw new Error(`Missing automation model: ${id}`);
  return {
    ...base,
    inputs: {
      timing_unit: base.inputs.timing_unit, default_batch_id: date,
      versions: base.inputs.versions.map((version) => ({
        ...version, sources: (REMOTE_MODELS as readonly string[]).includes(version.id)
          ? [{ kind: "file", path: path.join(sourceDirectory, date, version.id + ".jsonl") }] : version.sources,
      })),
      batches: [date],
    },
    comparisons: base.comparisons,
    rewrite: { comparison: true, comparisonItems: true, attribution: true, clustering: true },
    clustering: { ...base.clustering, enabled: false },
  };
}
