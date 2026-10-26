import path from "node:path";
import { safeId, type OutputTarget } from "@eval/contracts";
import { atomicWrite, exists, localFiles, writeJson } from "./files.js";

/** The single owner of the on-disk run directory structure. */
export interface RunLayout {
  readonly directory: string;
  readonly stateFile: string;
  readonly overviewFile: string;
  readonly lockFile: string;
  readonly results: string;
  readonly report: string;
  readonly summaries: string;
  readonly stats: string;
}

export function runLayout(target: OutputTarget, runId: string): RunLayout {
  const directory = path.join(target.path, safeId(runId));
  return {
    directory,
    stateFile: path.join(directory, "state.json"),
    overviewFile: path.join(directory, "overview.json"),
    lockFile: path.join(directory, ".run-lock"),
    results: path.join(directory, "results"),
    report: path.join(directory, "report.md"),
    summaries: path.join(directory, "task_summaries.md"),
    stats: path.join(directory, "stats.json"),
  };
}

/** Reconstruct a layout from an existing run directory, used by CLI and offline maintenance. */
export function locateRun(directory: string): RunLayout {
  return runLayout({ kind: "directory", path: path.dirname(directory) }, path.basename(directory));
}

/** Daily clustering output lives beside results; an empty tree/state marks work that has not started. */
export async function ensureClusterPlaceholder(run: string): Promise<void> {
  const directory = path.join(run, "cluster"), tree = path.join(directory, "cluster_tree.jsonl"), state = path.join(directory, "state.json");
  await localFiles.mkdir(directory, { recursive: true });
  if (!await exists(tree)) await atomicWrite(tree, "");
  if (!await exists(state)) await writeJson(state, {});
}

/** Arbitrary nested path under `_internal`, shared by debug writers. */
export function internalPath(run: string, ...parts: string[]): string {
  return path.join(run, "_internal", ...parts);
}
