import type { RunManifest } from "@eval/contracts";

/** Initialize before reconciliation can retire tasks from an existing run. */
export function cumulativeAttempts(manifest: RunManifest): number {
  return manifest.cumulativeAttempts ??= Object.values(manifest.states).reduce((sum, state) => sum + state.attempts, 0);
}

/** Admission is checked again immediately before the attempt counter is incremented. */
export function executionStopReason(manifest: RunManifest, now = Date.now()): RunManifest["executionStopReason"] {
  const limits = manifest.executionLimits;
  if (limits?.maxAttempts !== undefined &&
      cumulativeAttempts(manifest) >= limits.maxAttempts)
    return "attempt_limit";
  if (limits?.stopStartingAt !== undefined && now >= limits.stopStartingAt) return "dispatch_deadline";
  return undefined;
}
