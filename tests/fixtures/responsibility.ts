import assert from "node:assert/strict";
import type { AgentRequest } from "@eval/contracts";
import { evidenceCovers } from "@eval/tools";
import type { AttributionTransition, Evidence, ProblemProposal } from "@eval/agents/attribution";
import type { Responsibility, ResponsibilitySubmission } from "@eval/agents/attribution";
import { responsibilityFunctions } from "@eval/agents/attribution";

/** Current-contract synthetic causes; callers supply the actual fixture's evidence coordinates. */
export function responsibilityFixture(component = "最终回答组织", patch: Partial<Responsibility> = {}): Responsibility {
  const [technical_domain, functional_component] = component === "最终回答组织"
    ? ["模型推断与生成", "事实关系推导"] : ["工具业务实现", "结果完整性"];
  return { transition_index:1, basis:"input_deviation", actor_index:1, role: "primary", technical_domain, functional_component,
    component:component==='最终回答组织'?'回答生成：本题事实关系推导与结果使用（消息 1）':component, failure_stage: "信息使用与核验",
    business_component: "本题事实关系推导与结果使用", chain_index: null, chain_step: "数据解释与计算", field_names: [], mechanism_source: patch.certainty === "confirmed" ? "explicit_process" : "boundary_comparison",
    mechanism: "当前步骤偏离了本题要求。", certainty: "inferred", reason: "实际交付与过程记录支持该组件最可能造成缺陷。",
    evidence_ids: [], evidence_gap: "未采集完整内部执行快照。", alternatives: ["其他过程环节也可能造成该缺陷。"], ...patch };
}
export function responsibilitySubmissionFixture(cause: Responsibility): ResponsibilitySubmission {
  return {transition_index:cause.transition_index,basis:cause.basis,
    function_index:responsibilityFunctions.findIndex(row=>row.technical_domain===cause.technical_domain&&row.functional_component===cause.functional_component)+1,
    business_component:cause.business_component,mechanism_source:cause.mechanism_source,mechanism:cause.mechanism,certainty:cause.certainty,
    ...(cause.certainty === "inferred" ? {evidence_gap:cause.evidence_gap!,alternatives:cause.alternatives} : {})};
}

/** Missing process is explicit in these fixtures; it never establishes a generation actor. */
export function unknownFormationFixture(request: AgentRequest, evidence: Evidence[]): Pick<ProblemProposal,"component"|"investigation"|"calculations"> {
  const edges=(request.input.answer as {transitions:AttributionTransition[]}).transitions;
  const edge=edges.find(edge=>edge.kind==="delivery");
  assert(edge && edge.before.length===0 && edge.actor_index===null,"unknown formation requires an actually missing generation record");
  const selected=evidence.filter(item=>edge.after.some(boundary=>evidenceCovers(request.sources.answer.value as {messages:unknown[]},request.sources.answer.id,boundary.evidence_id,item.evidence_id)));
  assert(selected.length,"unknown formation requires selected actual delivered content");
  const ids=selected.map(item=>item.evidence_id);
  return {calculations:[],investigation:[{transition_index:edge.transition_index,kind:edge.kind,outcome:"unresolved",
    observation:"已读取交付内容，但生成输入、处理过程与生成输出记录未采集，缺陷形成位置尚无法区分。",
    before_evidence_ids:[],after_evidence_ids:ids}],component:[responsibilityFixture("未采集处理者",{
      transition_index:edge.transition_index,basis:"unknown_transition",actor_index:null,chain_index:edge.chain_index,
      chain_step:"核验与最终交付",failure_stage:"结果组织与交付",component:"处理者未采集：已交付事实的形成边界调查",
      business_component:"已交付事实的形成边界调查",evidence_ids:ids,
      mechanism:"交付内容可见缺陷，推测形成于未采集的生成或交付边界，现有证据无法区分。",
      evidence_gap:"未采集实际生成输入与输出以及中间处理者。",alternatives:["生成之前的材料已偏离。","生成或交付时新增偏离。"]})]};
}
