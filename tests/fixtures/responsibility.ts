import type { Responsibility, ResponsibilitySubmission } from "@eval/agents/attribution";
import { responsibilityFunctions } from "@eval/agents/attribution";
import { attributionTaxonomy } from "@eval/prompts";
import type { AgentRequest } from "@eval/contracts";

/** Current-contract synthetic causes; callers supply the actual fixture's evidence coordinates. */
export function responsibilityFixture(component = "最终回答组织", patch: Partial<Responsibility> = {}): Responsibility {
  const [technical_domain, functional_component] = component === "最终回答组织"
    ? ["模型推断与生成", "事实关系推导"] : ["工具业务实现", "结果完整性"];
  return { actor_index:1, role: "primary", technical_domain, functional_component,
    component:component==='最终回答组织'?'回答生成：本题事实关系推导与结果使用（消息 1）':component, failure_stage: "信息使用与核验",
    business_component: "本题事实关系推导与结果使用", chain_index: null, chain_step: "数据解释与计算", field_names: [], mechanism_source: patch.certainty === "confirmed" ? "explicit_process" : "boundary_comparison",
    mechanism: "当前步骤偏离了本题要求。", certainty: "inferred", reason: "实际交付与过程记录支持该组件最可能造成缺陷。",
    evidence_ids: [], evidence_gap: "未采集完整内部执行快照。", alternatives: ["其他过程环节也可能造成该缺陷。"], ...patch };
}
export function responsibilitySubmissionFixture(request: AgentRequest, component = "最终回答组织", evidence_indices: number[] = [1], patch: Partial<Responsibility> = {}): ResponsibilitySubmission {
  const cause = responsibilityFixture(component, patch);
  const actors = (request.input.answer as {component_catalog:{component:string}[]}).component_catalog;
  return {actor_index:cause.actor_index===null?null:actors.findIndex(actor=>actor.component===component)+1||cause.actor_index,
    function_index:responsibilityFunctions.findIndex(row=>row.technical_domain===cause.technical_domain&&row.functional_component===cause.functional_component)+1,
    step_index:attributionTaxonomy.investigation_steps.indexOf(cause.chain_step)+1,
    failure_stage_index:attributionTaxonomy.stages.indexOf(cause.failure_stage)+1,
    business_component:cause.business_component,chain_index:cause.chain_index,field_names:cause.field_names,
    mechanism_source:cause.mechanism_source,mechanism:cause.mechanism,certainty:cause.certainty,evidence_indices,
    ...(cause.certainty === "inferred" ? {evidence_gap:cause.evidence_gap!,alternatives:cause.alternatives} : {})};
}
