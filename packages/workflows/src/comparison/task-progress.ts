import type { TaskState } from "@eval/contracts";

/** Preparing unfinished work never refunds calls already charged to its UUID. */
export function pendingTaskProgress(previous?: TaskState, materialChanged = false): TaskState {
  const next: TaskState = { ...previous, status: "pending", attempts: previous?.attempts ?? 0 };
  delete next.attemptId;
  delete next.reason;
  delete next.nextRetryAt;
  if (materialChanged && next.failure) {
    const { draft: _draft, evidenceBank: _bank, inspection: _inspection, ...paid } = next.failure;
    next.failure = { ...paid,
      errors: paid.errors.filter(issue => issue.code === "submission_ledger_unavailable"),
      repeatedErrors: 0, stopped: false };
  }
  return next;
}
