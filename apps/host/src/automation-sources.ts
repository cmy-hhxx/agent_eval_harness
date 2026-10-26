import path from "node:path";
import { readJson } from "@eval/data";
import { ROOT } from "./paths.js";
import type { AutomationConfig } from "./automation-config.js";

export interface AutomationSourceFile {
  name: string;
  file: string;
  workflow?: "comparison" | "answer-review" | "attribution";
}

/** Bind delivery receipts to an evaluation task and destination without storing credentials. */
export function automationMongoTarget(config: AutomationConfig): string {
  const { mongoUriEnv, mongoDatabase, mongoCollection } = config.publication;
  return JSON.stringify([config.id, mongoUriEnv, mongoDatabase, mongoCollection]);
}

export function validateAutomationTasks(configs: readonly AutomationConfig[]): void {
  for (const key of ["id", "stateDirectory", "sourceDirectory", "runPrefix"] as const) {
    const owners = new Map<string, string>();
    for (const config of configs) {
      const previous = owners.get(config[key]);
      if (previous) throw new Error(`Automation tasks ${previous} and ${config.id} share ${key}; each task requires its own ${key}`);
      owners.set(config[key], config.id);
    }
  }
  const progressOwners = new Set<string>();
  for (const config of configs.filter(config => config.publishProgress)) {
    if (progressOwners.has(config.sourceUrl))
      throw new Error("Independent tasks sharing a source must disable shared progress publication: " + config.id);
    progressOwners.add(config.sourceUrl);
  }
}

export async function automationSourceFiles(options: {
  command: string;
  configured?: string[];
  manifestFile?: string;
  configDirectory?: string;
}): Promise<AutomationSourceFile[]> {
  const configured = options.configured?.map(file => ({ name: path.basename(file), file: path.resolve(file) }));
  const resolved = configured ?? await manifestSources(
    options.manifestFile ?? path.join(ROOT, "configs/automations.manifest.json"),
    options.configDirectory ?? path.join(ROOT, "configs"),
  );
  if (new Set(resolved.map(source => source.file)).size !== resolved.length) throw new Error("Duplicate automation config");
  if (resolved.length > 1 && !["serve", "run", "check", "status"].includes(options.command))
    throw new Error("This automation command requires one --config");
  return resolved;
}

async function manifestSources(manifestFile: string, configDirectory: string): Promise<AutomationSourceFile[]> {
  const value = await readJson<Record<string, unknown>>(manifestFile);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 ||
      !Array.isArray(value.sources) || !value.sources.length)
    throw new Error("Invalid automation manifest");
  const directory = path.resolve(configDirectory);
  return value.sources.map((entry): AutomationSourceFile => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
        Object.keys(entry).some(key => !["name", "config", "workflow"].includes(key)) ||
        entry.workflow !== undefined && entry.workflow !== "comparison" && entry.workflow !== "answer-review" && entry.workflow !== "attribution" ||
        typeof entry.name !== "string" || !entry.name.trim() ||
        typeof entry.config !== "string" || !entry.config.trim())
      throw new Error("Invalid automation manifest source");
    return { name: entry.name.trim(), file: path.resolve(directory, entry.config),
      ...(entry.workflow ? { workflow: entry.workflow as "comparison" | "answer-review" | "attribution" } : {}) };
  });
}

/** Only writes to the same destination task and date serialize; unrelated deliveries proceed independently. */
export function createAutomationMongoLane() {
  const tails = new Map<string, Promise<void>>();
  return <T>(operation: () => Promise<T>, signal: AbortSignal, key: string): Promise<T> => {
    const next = (tails.get(key) ?? Promise.resolve()).then(() => { signal.throwIfAborted(); return operation(); });
    const tail = next.then(() => {}, () => {});
    tails.set(key, tail);
    void tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
    return next;
  };
}
