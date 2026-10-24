import type { Responsibility, ResponsibilitySubmission } from "@eval/agents/attribution";

/** Current-contract synthetic causes; callers supply the actual fixture's evidence coordinates. */
export function responsibilityFixture(component = "最终作答节点（原始名称未提供）", patch: Partial<Responsibility> = {}): Responsibility {
  const [technical_domain, functional_component] = component === "最终作答节点（原始名称未提供）"
    ? ["模型推断与生成", "事实关系推导"] : ["工具业务实现", "结果完整性"];
  return { role: "primary", technical_domain, functional_component, component, failure_stage: "信息使用与核验",
    mechanism: "当前步骤偏离了本题要求。", certainty: "inferred", reason: "实际交付与过程记录支持该组件最可能造成缺陷。",
    evidence_ids: [], evidence_gap: "未采集完整内部执行快照。", alternatives: ["其他过程环节也可能造成该缺陷。"], ...patch };
}
export function responsibilitySubmissionFixture(component = "最终作答节点（原始名称未提供）", evidence_indices: number[] = [1], patch: Partial<ResponsibilitySubmission> = {}): ResponsibilitySubmission {
  const { evidence_ids: _ids, ...cause } = responsibilityFixture(component);
  return { ...cause, evidence_indices, ...patch };
}
