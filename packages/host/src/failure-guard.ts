import type { FailureGuardPolicy, StagePause, ValidationIssue } from "@eval/contracts";

export const DEFAULT_FAILURE_GUARD: FailureGuardPolicy = { windowSize: 50, threshold: 5 };
export function validateFailureGuard(policy: FailureGuardPolicy): void {
  if (!policy || !Number.isInteger(policy.windowSize) || !Number.isInteger(policy.threshold) ||
    policy.threshold < 2 || policy.windowSize < policy.threshold)
    throw new Error("failureGuard requires windowSize >= threshold >= 2 (integers)");
}

type Outcome = { taskId: string; issues: Pick<ValidationIssue, "category" | "code" | "path">[] };
/** Bounded per-stage windows of distinct tasks, not repeated attempts of one bad sample. */
export class FailureGuard {
  private readonly windows = new Map<string, Outcome[]>();
  constructor(readonly pauses: StagePause[], readonly policy = DEFAULT_FAILURE_GUARD) {
    validateFailureGuard(policy);
  }
  paused(stage: string): boolean { return this.pauses.some((pause) => pause.stage === stage); }
  observe(stage: string, taskId: string, issues: Outcome["issues"], now = Date.now()): StagePause | undefined {
    if (this.paused(stage)) return;
    const normalized = issues.map(({ category, code, path }) => ({ category, code, path: path.replace(/\/\d+(?=\/|$)/g, "/*") }));
    const window = (this.windows.get(stage) ?? []).filter((entry) => entry.taskId !== taskId);
    window.push({ taskId, issues: normalized });
    if (window.length > this.policy.windowSize) window.shift();
    this.windows.set(stage, window);
    for (const issue of normalized) {
      const taskIds = window.filter((entry) => entry.issues.some((other) =>
        other.category === issue.category && other.code === issue.code && other.path === issue.path)).map((entry) => entry.taskId);
      const hostFault = issue.category === "interruption" &&
        ["host_submission_failed", "host_inspection_failed"].includes(issue.code);
      if (!hostFault && taskIds.length < this.policy.threshold) continue;
      const pause = { stage, ...issue, taskIds, at: now };
      this.pauses.push(pause);
      return pause;
    }
  }
}
