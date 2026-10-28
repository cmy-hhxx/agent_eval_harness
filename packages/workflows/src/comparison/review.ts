import type { RunState, WorkflowDefinition } from "@eval/contracts";
import type { TaskData } from "./types.js";
import { planAttributionRewriteGroups } from "./attribution-rewrite-planning.js";
import { attributionWorkflow } from "@eval/workflows/attribution";
import { dimensionAttributionFollowup } from "../review/dimensions.js";

/** Turning the opt-in off releases unfinished consumers back to their original accepted sources. */
export function configureStandardReview(state: RunState, enabled: boolean): void {
  for (const task of state.manifest.tasks) if (task.stage.startsWith("attribution-") && !state.receipts[task.id])
    (task.data as TaskData).standardAnswerReview = enabled;
}

/** Accepted formal comparisons and retrospective verification never reopen source results. */
export const advanceReview: NonNullable<WorkflowDefinition["advance"]> = (task, receipt, state, inputs) => {
  const canonical = task.stage.startsWith("attribution-")
    ? attributionWorkflow.advance!(task, receipt, state, inputs) : { tasks: [] };
  const grouped = planAttributionRewriteGroups(task, receipt, state);
  return { tasks: [...canonical.tasks, ...grouped.tasks, ...dimensionAttributionFollowup(task, state)],
    ...((canonical.replace?.length || grouped.replace?.length) ? { replace: [...canonical.replace ?? [], ...grouped.replace ?? []] } : {}) };
};
