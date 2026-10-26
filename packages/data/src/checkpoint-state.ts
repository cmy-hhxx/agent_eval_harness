import type { FailureContext, RunState, TaskState, ValidationIssue } from "@eval/contracts";

const MAX_MESSAGE_CHARS = 2000;
const MAX_ISSUES = 3;

function shortText(value: string | undefined): string | undefined {
  return value === undefined ? undefined : value.length <= MAX_MESSAGE_CHARS ? value : value.slice(0, MAX_MESSAGE_CHARS) + "…";
}

function compactIssue(issue: ValidationIssue): ValidationIssue {
  return {
    category: issue.category,
    code: issue.code,
    path: issue.path,
    ...(issue.candidate === undefined ? {} : { candidate: issue.candidate }),
    message: shortText(issue.message) ?? "",
  };
}

function compactFailure(failure: FailureContext | undefined): FailureContext | undefined {
  if (!failure) return undefined;
  const { draft: _draft, inspection: _inspection,
    review: _review, evidenceBank: _bank, ...rest } = failure;
  return {
    ...rest,
    ...(Array.isArray(failure.errors) ? { errors: failure.errors.slice(-MAX_ISSUES).map(compactIssue) } : {}),
  } as FailureContext;
}

function compactTaskState(state: TaskState): TaskState {
  return {
    ...state,
    ...(state.reason === undefined ? {} : { reason: shortText(state.reason) }),
    ...(state.failure === undefined ? {} : { failure: compactFailure(state.failure) }),
    ...(state.artifactStatus?.error === undefined ? {} : {
      artifactStatus: { ...state.artifactStatus, error: shortText(state.artifactStatus.error) },
    }),
  };
}

/**
 * Durable checkpoints are summaries. Full repair context belongs to the hot journal;
 * these bounds prevent large validation/review payloads from recurring in every save.
 */
export function compactCheckpointState(state: RunState, clone = structuredClone): RunState {
  const { receipts, ...progress } = state;
  const snapshot = clone(progress) as RunState;
  snapshot.manifest.states = Object.fromEntries(
    Object.entries(snapshot.manifest.states).map(([id, taskState]) => [id, compactTaskState(taskState)]),
  );
  return {
    ...snapshot,
    receipts: Object.fromEntries(Object.entries(receipts).map(([id, receipt]) => [id, {
      ...receipt,
      audit: { ...receipt.audit, review: undefined, inspection: undefined },
    }])),
  };
}
