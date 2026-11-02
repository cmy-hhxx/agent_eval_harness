import { canonical, type TaskAnalysis, type TaskCriterion, type ValidationIssue } from "@eval/contracts";

export const criteriaGroups = ["requirements", "red_flags", "scoring_points"] as const;

/** Exact generated identity; scope and acceptance rules are never merged by meaning. */
export function criterionIdentity(criterion: TaskCriterion): string {
  return canonical({ text: criterion.text, applies_to: [...criterion.applies_to].sort(), acceptance_rule: criterion.acceptance_rule });
}

export function commonCriteriaBudget(value: TaskAnalysis): ValidationIssue[] {
  const count = new Set(criteriaGroups.flatMap(group => value[group])
    .filter(criterion => !criterion.applies_to.length).map(criterionIdentity)).size;
  return count >= 1 && count <= 12 ? [] : [{
    category: "decision", code: "criteria_common_budget", path: "/",
    message: "三个数组去重后的共同检查项合计须为1–12项；私有项不计入。仅保留真实独立要求，不凑数、不新增交付或重复同一要求。",
    actual: count, expected: { min: 1, max: 12 },
  }];
}
