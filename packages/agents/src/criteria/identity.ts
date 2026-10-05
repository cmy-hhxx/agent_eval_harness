import { canonical, type TaskCriterion } from "@eval/contracts";

export const criteriaGroups = ["requirements", "red_flags", "scoring_points"] as const;

/** Exact generated identity; scope and acceptance rules are never merged by meaning. */
export function criterionIdentity(criterion: TaskCriterion): string {
  return canonical({ text: criterion.text, applies_to: [...criterion.applies_to].sort(), acceptance_rule: criterion.acceptance_rule });
}
