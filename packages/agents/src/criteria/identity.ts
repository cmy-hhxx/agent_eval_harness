import { canonical, type TaskAnalysis, type TaskCriterion, type ValidationIssue } from "@eval/contracts";

export const criteriaGroups = ["requirements", "red_flags", "scoring_points"] as const;

/** Exact generated identity; scope and acceptance rules are never merged by meaning. */
export function criterionIdentity(criterion: TaskCriterion): string {
  return canonical({ text: criterion.text, applies_to: [...criterion.applies_to].sort(), acceptance_rule: criterion.acceptance_rule });
}

export function commonCriteriaBudget(value: TaskAnalysis): ValidationIssue[] {
  const count = new Set(criteriaGroups.flatMap(group => value[group])
    .filter(criterion => !criterion.applies_to.length).map(criterionIdentity)).size;
  return count >= 5 && count <= 12 ? [] : [{
    category: "decision", code: "criteria_common_budget", path: "/",
    message: "三个数组去重后的共同检查项合计须为5–12项；私有项不计入。按本题的任务、范围、事实、依据和表达设置不同核查角度，不新增交付或重复同一要求。",
    actual: count, expected: { min: 5, max: 12 },
  }];
}
