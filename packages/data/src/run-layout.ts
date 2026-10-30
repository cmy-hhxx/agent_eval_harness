import path from "node:path";
import { safeId, type OutputTarget } from "@eval/contracts";

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
  const directory = path.join(target.path, ...(target.layout === "business" ? [".runs"] : []), safeId(runId));
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

/** Arbitrary nested path under `_internal`, shared by debug writers. */
export function internalPath(run: string, ...parts: string[]): string {
  return path.join(run, "_internal", ...parts);
}
