import { randomUUID } from "node:crypto";
import { bindAttributionMaterial } from "@eval/workflows/review";
import { type Candidate, type RawInput } from "@eval/workflows/inputs";
import type { AttributionResult, BusinessChain, ProblemProposal, AttributionTransition, Evidence } from "@eval/agents/attribution";
import { responsibilityComponentName } from "@eval/agents/attribution";
import { parseEvidenceCoordinates } from "@eval/tools";
import { emptyAudit } from "./comparison.js";
import { responsibilityFixture } from "./responsibility.js";

/** Synthetic captured boundaries model the real ETF-to-spot failure without copying server data. */
export function businessChainFixture(loss = false, question = "Gold prediction for next 6 months", dropSource = false) {
  const id = randomUUID(), query = "ETF GLD: Closing Price; recent 6 months; daily";
  const columns = [{ key: "etf code" }, { key: "etf name" }, { key: "Closing Price[20261022]", unit: "$" }];
  const datas = [{ "etf code": "GLD.P", "etf name": "SPDR Gold Shares", "Closing Price[20261022]": 369 }];
  const full = { serial_number: "pfJtupL", query, columns, row_count: 1, datas };
  const shaped = loss ? { serial_number: "pfJtupL", query, row_count: 1, datas: [{ price: 369 }] } : full;
  const body = dropSource ? "source pfJtupL; price:369" : "Financial data you fetched:\n" + JSON.stringify(shaped) + "\nThe following is background metadata, provided only for your awareness:\nPRIVATE_NOT_A_SOURCE";
  const final = "XAU/USD现货黄金收于3,690美元。<trace ref=\"pfJtupL\"/>";
  const messages: RawInput["messages"] = [
    { type: "user_question", role: "user", content: question },
    { type: "llm_turn", name: "查询规划 Agent", parent_span: "plan", input_messages: [{ role: "user", content: question }], output: [{ role: "assistant", content: JSON.stringify({ query }) }] },
    { type: "tool_call", name: "finquery", call_id: "query-call", parent_span: "plan", input: { query } },
    { type: "tool_result", name: "finquery", call_id: "query-call", output: { query, columns, datas } },
  ];
  if (loss || dropSource) messages.push({ type: "llm_turn", name: "结果整理 Agent", input_messages: [{ role: "tool", content: JSON.stringify(full) }],
    output: [{ role: "assistant", content: body }] });
  messages.push({ type: "llm_turn", name: "llm-call-0", input_messages: [
    { role: "system", content: "SYS_PRIVATE" },
    ...(loss || dropSource ? [{ role: "assistant", content: body }] : []), { role: "user", content: dropSource ? question + "; use the preceding summary." : body },
  ], output: [{ role: "assistant", content: final }] }, { type: "final_answer", role: "assistant", content: final });
  const candidate = { input_id: id, version: "aime_fast", name: "aime_fast", llm: null, question, final_index: messages.length - 1, reference: null,
    answer_timing: { finish_seconds: null } } as Candidate;
  const binding = bindAttributionMaterial(candidate, { messages });
  const chains = (binding.request.input.answer as { business_chains: BusinessChain[] }).business_chains;
  const transitions = (binding.request.input.answer as {transitions: AttributionTransition[]}).transitions;
  const generated = transitions.find(edge=>edge.kind === "generation" && edge.after.some(item=>item.message_index===messages.length-2))!;
  const chain = chains[0], evidence = [...new Map([...chain.checkpoints.flatMap(point => point.evidence), ...chain.final_evidence, ...transitions.flatMap(edge=>[...edge.before,...edge.after])]
    .filter((item): item is Evidence => typeof item.quote === "string")
    .map(item => [item.evidence_id, item])).values()];
  const cause = responsibilityFixture(undefined, { transition_index:generated.transition_index,actor_index:(binding.request.input.answer as {component_catalog:{component:string}[]}).component_catalog.findIndex(actor=>actor.component==='最终回答组织')+1,
    business_component: "finquery 返回的价格口径解释与使用", chain_index: generated.chain_index,
    chain_step: "数据解释与计算", field_names: ["etf code", "etf name", "Closing Price[20261022]"],
    mechanism: "将ETF份额价格用于现货黄金报价构造，输入369与输出3690的十倍差异可见，具体转换动作未记录。",
    evidence_ids: [...generated.before,...generated.after].map(item => item.evidence_id), evidence_gap: "未记录中间换算或计算过程。",
    alternatives: ["小数点或零位误写。", "从其他价格记忆拼接现货报价。"] });
  const problem: ProblemProposal = { diagnosis: "entity_or_unit", calculations:[], investigation:transitions.map(edge=>({
    transition_index:edge.transition_index,kind:edge.kind,outcome:edge.transition_index===generated.transition_index?"changed":"preserved",
    observation:edge.transition_index===generated.transition_index?"输入保留ETF身份和369价格，生成文本却声明现货3690；具体转换动作未记录。":"该边界前后记录保持相同对象与价格，未发现本问题的新增偏离。",
    before_evidence_ids:edge.before.map(item=>item.evidence_id),after_evidence_ids:edge.after.map(item=>item.evidence_id),
  })), component: [cause], label: "ETF份额价错配现货报价", definition: "把GLD.P份额报价作为XAU/USD现货报价使用。" };
  const result: AttributionResult = { has_standard_answer: false, is_correct: null, correctness_reason: "", correctness_evidence: [], numeric_checks: [],
    task_analysis: binding.request.input.task_analysis as unknown as AttributionResult["task_analysis"],
    criterion_assessments: [{ criterion_id: "r1", status: "partial", evidence_status: "established", summary: "预测使用的基准标的和价格错配。", evidence }],
    core_assessment: { meets_core: false, reason: "预测基准错误，不能直接用于现货黄金决策。", criterion_ids: ["r1"] },
    summary: "引用的ETF价格被用于构造错误的现货基准。", findings: [{ finding_id: "f0", type: "problem", dimension: "correctness", stage: "reasoning", importance: "high",
      text: "ETF份额价格被写成现货黄金报价。", reason: "实际输入保留身份和369美元，最终回答引用同一来源却声明XAU/USD为3690美元。", evidence,
      assessment: { requirement_index: 0, observation: "标的及价格口径错配已确认。", evidence_status: "established", impact: "预测收益与阈值基准不可直接使用。" }, problem }] };
  const audit = emptyAudit();
  cause.component=responsibilityComponentName((binding.request.input.answer as {component_catalog:import('@eval/tools').TraceComponentIdentity[]})
    .component_catalog[Number(cause.actor_index)-1],cause.business_component);
  audit.traceReads = evidence.flatMap(item => {
    const point=parseEvidenceCoordinates(item.evidence_id)!;
    return point.kind==='image'?[]:[{candidate:'answer',message_index:point.message_index,kind:point.kind,path:point.path,start:point.start,end:point.end}];
  });
  return { binding, chains, chain, transitions, generated, problem, result, evidence, audit, cause, raw: { messages }, candidate };
}
