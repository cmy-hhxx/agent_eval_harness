import { ValidationError, type JsonObject } from "@eval/contracts";
import { isComponentLocator } from "@eval/tools";
import type { SessionProblem } from "./types.js";

/** Responsibility always names the actual actor; the problem text identifies its failed step. */
export function attributionComponentLabel(index: number, components: JsonObject[], path = "/components"): string {
  const component = components.find(entry => entry.component_index === index);
  if (!component || typeof component.name !== "string" || !component.name.trim() || isComponentLocator(component.name))
    throw new ValidationError([{ category: "structure", code: "component_identity", path,
      message: "actor_index 只能选择本任务给出的组件编号；组件名称由程序原样透传，不临时起名或退回 llm-call。", actual: index,
      expected: components.map(entry => ({ actor_index: entry.component_index, name: entry.name })) }]);
  return component.name;
}

export type SubmittedProblem = Omit<SessionProblem, "component" | "evidence"> & {
  actor_index: number;
  evidence: { index: number; reason: string }[];
  tool_error_indices: number[];
};
export interface ToolErrorReview {
  tool_error_idx: number;
  status: "unresolved_impact" | "recovered_impact" | "recovered_no_impact" | "no_delivery_impact" | "uncertain";
  content: string;
  evidence: number[];
}
export interface ComponentReview {
  content: string;
  evidence: number[];
  tool_error_reviews: ToolErrorReview[];
  problems: SubmittedProblem[];
}

const deliveryImpact = new Set(["unresolved_impact", "recovered_impact"]);

/** Coverage is structural; responsibility and causality still require original-source judgment. */
export function validateComponentReview(members: JsonObject[], review: ComponentReview, errors: JsonObject[]) {
  const expected = errors.map(error => Number(error.tool_error_idx));
  const selected = review.tool_error_reviews.map(error => error.tool_error_idx);
  if (selected.length !== expected.length || new Set(selected).size !== selected.length || expected.some(index => !selected.includes(index)))
    throw new ValidationError([{ category: "decision", code: "tool_error_coverage", path: "/tool_error_reviews",
      message: "本组分派的每条 tool_error 必须恰好处置一次；未知原因保留 uncertain，不遗漏或重复。", expected }]);
  const linked = review.problems.flatMap(problem => problem.tool_error_indices);
  const dispositions = new Map(review.tool_error_reviews.map(error => [error.tool_error_idx, error]));
  if (new Set(linked).size !== linked.length || linked.some(index => !dispositions.has(index)))
    throw new ValidationError([{ category: "decision", code: "tool_error_problem_link", path: "/problems",
      message: "问题只能关联本组分派的 tool_error；同一根因的多次报错合并为一条问题并全部关联，同一报错不分到多条问题。" }]);
  for (const [index, error] of review.tool_error_reviews.entries())
    if ((error.status === "uncertain") === linked.includes(error.tool_error_idx))
      throw new ValidationError([{ category: "decision", code: "tool_error_disposition", path: `/tool_error_reviews/${index}`,
        message: "除 uncertain 外，每条已确定处置的 tool_error 都必须关联一条组内问题：unresolved_impact/recovered_impact 按剩余交付影响定 P0–P3；recovered_no_impact/no_delivery_impact 记 P4 过程缺陷；uncertain 不关联问题。" }]);
  for (const [index, problem] of review.problems.entries()) {
    const linkedStatuses = problem.tool_error_indices.map(id => ({ tool_error_idx: id,
      review_index: review.tool_error_reviews.findIndex(error => error.tool_error_idx === id), status: dispositions.get(id)!.status }));
    const requiresDelivery = linkedStatuses.some(error => deliveryImpact.has(error.status));
    if (linkedStatuses.length && requiresDelivery === (problem.severity === "P4"))
      throw new ValidationError([{ category: "decision", code: "tool_error_severity", path: `/problems/${index}/severity`,
        message: `问题 /problems/${index} 关联 ${linkedStatuses.map(item => `tool_error_reviews/${item.review_index}（tool_error_idx ${item.tool_error_idx}，${item.status}）`).join("、")}；${requiresDelivery ? "存在未消除的交付影响，按剩余交付影响定 P0–P3" : "均已恢复或交付不受影响，记 P4 过程缺陷"}。`,
        actual: problem.severity, expected: { reviews: linkedStatuses, required_severity: requiresDelivery ? "P0–P3" : "P4" } }]);
    if (problem.severity === "P4" && members.find(member => member.component_index === problem.actor_index)?.contains_final_generation === true)
      throw new ValidationError([{ category: "decision", code: "final_process_severity", path: `/problems/${index}/severity`,
        message: "终稿问题都影响交付，按 P0–P3 定级；P4 只用于已恢复或不影响交付的过程缺陷。" }]);
  }
}
