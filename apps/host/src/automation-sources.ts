import path from "node:path";
import { ROOT } from "./paths.js";
import type { AutomationConfig } from "./automation-config.js";

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

export function automationConfigFiles(command: string, configured?: string[]): string[] {
  const files = configured ?? [path.join(ROOT, "configs/automations.json")];
  const resolved = files.map(file => path.resolve(file));
  if (new Set(resolved).size !== resolved.length) throw new Error("Duplicate automation config");
  if (resolved.length > 1 && !["run", "check", "status"].includes(command))
    throw new Error("This automation command requires one --config");
  return resolved;
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
