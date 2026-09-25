import path from "node:path";
import { DEFAULT_POLICY } from "@eval/contracts";
import { readJson } from "@eval/data";
import type { EvalConfig } from "@eval/workflows/pairwise";
export async function loadConfig(file: string, env = process.env): Promise<EvalConfig> {
  const source = await readJson<
    Omit<EvalConfig, "judge"> & {
      judge: Omit<EvalConfig["judge"], "baseUrl"> & { baseUrlEnv: string };
    }
  >(file);
  const { baseUrlEnv, ...judge } = source.judge;
  if (!baseUrlEnv || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(baseUrlEnv))
    throw new Error("Invalid judge.baseUrlEnv");
  const baseUrl = env[baseUrlEnv];
  if (!baseUrl) throw new Error(`Missing ${baseUrlEnv}; configure the shared model endpoint in .env`);
  const config: EvalConfig = { ...source, judge: { ...judge, baseUrl } };
  const directory = path.dirname(path.resolve(file));
  config.execution = {
    ...DEFAULT_POLICY,
    concurrency: 4,
    retries: 1,
    retryDelaySeconds: 10,
    initialContextChars: 16000,
    ...(config.execution as Partial<EvalConfig["execution"]>),
  };
  const versions = config.inputs?.versions;
  if (!Array.isArray(versions) || versions.length < 2) throw new Error("至少配置两个输入版本");
  for (const item of versions) {
    if (!/^[a-z][a-z0-9_]*$/.test(item.id) || !["a", "aa"].includes(item.adapter))
      throw new Error("Invalid input version");
    item.path = path.resolve(directory, item.path);
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
  if (
    config.execution.maxTokens !== undefined &&
    (!Number.isInteger(config.execution.maxTokens) || config.execution.maxTokens < 1)
  )
    throw new Error("Invalid execution.maxTokens");
  if (
    !config.judge ||
    !["openai-completions", "openai-responses"].includes(config.judge.api) ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.judge.apiKeyEnv)
  )
    throw new Error("Invalid model configuration");
  const base = new URL(config.judge.baseUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password)
    throw new Error("Invalid model baseUrl");
  for (const stage of ["correctness", "pairwise"] as const) {
    const model = config.judge[stage];
    if (!model?.model || !["off", "minimal", "low", "medium", "high", "xhigh"].includes(model.thinking))
      throw new Error(`Invalid judge.${stage}`);
    for (const key of ["contextWindow", "maxOutputTokens"] as const)
      if (!Number.isInteger(model[key]) || model[key] <= 0) throw new Error(`Invalid judge.${stage}.${key}`);
  }
  config.outputDir = path.resolve(directory, config.outputDir);
  return config;
}
