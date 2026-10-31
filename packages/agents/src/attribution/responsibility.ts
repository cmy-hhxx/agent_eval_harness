import { ValidationError, type JsonObject } from "@eval/contracts";
import { isComponentLocator } from "@eval/tools";
import type { SessionProblem } from "./types.js";

/** Responsibility always names the actual actor; the problem text identifies its failed step. */
export function attributionComponentLabel(index: number, components: JsonObject[]): string {
  const component = components.find(entry => entry.component_index === index);
  if (!component || typeof component.name !== "string" || !component.name.trim() || isComponentLocator(component.name))
    throw new ValidationError([{ category: "structure", code: "component_identity", path: "/components",
      message: "审查槽位必须绑定本轮 Compact 组件目录；组件名称由程序原样透传，不临时起名或退回 llm-call。", actual: index }]);
  return component.name;
}

export type SubmittedProblem = Omit<SessionProblem, "component" | "evidence"> & {
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

/** Coverage is structural; responsibility and causality still require original-source judgment. */
export function validateComponentReview(component: JsonObject, review: ComponentReview, errors: JsonObject[]) {
  const expected = errors.map(error => Number(error.tool_error_idx));
  const selected = review.tool_error_reviews.map(error => error.tool_error_idx);
  if (selected.length !== expected.length || new Set(selected).size !== selected.length || expected.some(index => !selected.includes(index)))
    throw new ValidationError([{ category: "decision", code: "tool_error_coverage", path: "/tool_error_reviews",
      message: "本组件分派的每条 tool_error 必须恰好处置一次；未知原因保留 uncertain，不遗漏或重复。", expected }]);
  const linked = review.problems.flatMap(problem => problem.tool_error_indices);
  const dispositions = new Map(review.tool_error_reviews.map(error => [error.tool_error_idx, error]));
  if (new Set(linked).size !== linked.length || linked.some(index => !dispositions.has(index)))
    throw new ValidationError([{ category: "decision", code: "tool_error_problem_link", path: "/problems",
      message: "问题只能关联本组件分派的 tool_error；同一故障及传播症状合并为一条问题，多个报错可关联同一问题。" }]);
  for (const [index, error] of review.tool_error_reviews.entries()) {
    const impact = error.status === "unresolved_impact" || error.status === "recovered_impact";
    if (impact !== linked.includes(error.tool_error_idx) || impact && component.name === "最终答复生成")
      throw new ValidationError([{ category: "decision", code: "tool_error_disposition", path: `/tool_error_reviews/${index}`,
        message: "未修复或恢复后仍影响交付的执行故障必须关联本组件的问题；无剩余影响或不确定不造问题。执行故障不能放到最终答复生成；终稿仅记录自身新增偏差。" }]);
  }
}
