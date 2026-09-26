import type { AttributionLibrary, RunState } from "@eval/contracts";
import { attributionLibraryFile, readAttributionLibrary, writeAttributionLibrary } from "@eval/data";
import { applyAttribution, emptyLibrary } from "@eval/agents/attribution";
import type { AttributionResult, EvalConfig, TaskData } from "./types.js";

/**
 * Fold accepted attribution receipts into each model's tree. Append-only and idempotent, so
 * rebuilding a report (or resuming) never duplicates nodes or occurrences.
 */
export async function syncAttributionLibraries(state: RunState): Promise<void> {
  const config = state.manifest.config as EvalConfig;
  if (!config.attribution) return;
  const pending = new Map<string, { file: string; library: AttributionLibrary }>();
  for (const task of state.manifest.tasks) {
    if (task.stage !== "attribution") continue;
    const receipt = state.receipts[task.id];
    if (!receipt) continue;
    const candidate = (task.data as TaskData).candidates.A;
    const file = attributionLibraryFile(config.attribution, candidate.version);
    const entry = pending.get(file) ?? {
      file,
      library: (await readAttributionLibrary(file)) ?? emptyLibrary(candidate.version),
    };
    entry.library = applyAttribution(entry.library, {
      run_id: state.manifest.runId,
      task_id: task.id,
      submission_id: receipt.submissionId,
      version: candidate.version,
      batch_id: candidate.batch_id,
      case_id: candidate.case_id,
      input_id: candidate.input_id,
      source: { file: candidate.source, line: candidate.line },
      findings: (receipt.evaluation as AttributionResult).findings,
    });
    pending.set(file, entry);
  }
  for (const { file, library } of pending.values()) await writeAttributionLibrary(file, library);
}
