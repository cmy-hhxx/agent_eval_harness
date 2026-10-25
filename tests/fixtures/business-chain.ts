import { randomUUID } from "node:crypto";
import { bindAttributionMaterial } from "@eval/workflows/review";
import { type Candidate, type RawInput } from "@eval/workflows/inputs";
import type { AttributionResult, BusinessChain, ProblemProposal, AttributionTransition, Evidence } from "@eval/agents/attribution";
import { responsibilityComponentName } from "@eval/agents/attribution";
import { parseEvidenceCoordinates, resolveEvidence } from "@eval/tools";
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
  const chain = chains[0], evidence = [...new Map([...chain.checkpoints.flatMap(point => point.evidence), ...chain.final_evidence, ...transitions.flatMap(edge=>[...edge.before,...edge.after]).map(boundary=>resolveEvidence({messages},boundary,"answer",emptyAudit(),"/fixture",id))]
    .filter((item): item is Evidence => typeof item.quote === "string")
    .map(item => [item.evidence_id, item])).values()];
  const cause = responsibilityFixture(undefined,{transition_index:generated.transition_index,actor_index:generated.actor_index,kind:generated.kind,
    component:responsibilityComponentName((binding.request.input.answer as {component_catalog:import('@eval/tools').TraceComponentIdentity[]}).component_catalog[Number(generated.actor_index)-1]),
    reason:'将ETF份额价格用于现货报价，输入369与输出3690差异可见，内部转换仅属推断。',
    evidence_ids:[...generated.before,...generated.after].map(e=>e.evidence_id),uncertainty:{evidence_gap:'未记录中间换算过程。',alternatives:['零位误写。','拼接其他价格记忆。']}});
  const problem:ProblemProposal={text:'ETF份额价错配现货报价',reason:'将GLD.P份额369美元错误作为XAU/USD现货3690美元，预测基准不可用。',evidence_status:'established',
    checks:transitions.map(edge=>({transition_index:edge.transition_index,kind:edge.kind,outcome:edge.transition_index===generated.transition_index?'changed':'preserved',
      observation:edge.transition_index===generated.transition_index?'输入保留ETF身份与369价格，生成现货3690。':'该边界保持对象与价格。',
      before_evidence_ids:edge.before.map(e=>e.evidence_id),after_evidence_ids:edge.after.map(e=>e.evidence_id)})),causes:[cause]};
  const generationCheck=problem.checks.find(check=>check.transition_index===generated.transition_index)!;
  const incoming=transitions.filter(edge=>generated.predecessors.includes(edge.transition_index)).flatMap(edge=>edge.after);
  if(incoming.length){generationCheck.before_evidence_ids=incoming.map(e=>e.evidence_id);cause.evidence_ids=[...new Set([...generationCheck.before_evidence_ids,...generationCheck.after_evidence_ids])];}
  const result:AttributionResult={meta:{input_id:id},summary:problem.text,has_standard_answer:false,is_correct:null,correct_reason:null,
    Problem:[{...problem,problem_id:'p1',evidence}]};
  const audit=emptyAudit();
  audit.traceReads = evidence.flatMap(item => {
    const point=parseEvidenceCoordinates(item.evidence_id)!;
    return point.kind==='image'?[]:[{candidate:'answer',message_index:point.message_index,kind:point.kind,path:point.path,start:point.start,end:point.end}];
  });
  return { binding, chains, chain, transitions, generated, problem, result, evidence, audit, cause, raw: { messages }, candidate };
}
