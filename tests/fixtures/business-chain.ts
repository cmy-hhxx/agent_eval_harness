import { randomUUID } from "node:crypto";
import { bindAttributionMaterial } from "@eval/workflows/review";
import { type Candidate, type RawInput } from "@eval/workflows/inputs";
import type { AttributionResult, BusinessChain, ProblemProposal, AttributionTransition, Evidence } from "@eval/agents/attribution";
import { responsibilityDisplay } from "@eval/agents/attribution";
import { parseEvidenceCoordinates, resolveEvidence, evidenceCovers } from "@eval/tools";
import { emptyAudit } from "./comparison.js";

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
  const problem:ProblemProposal={text:'ETF份额价错配现货报价',reason:'将GLD.P份额369美元错误作为XAU/USD现货3690美元，预测基准不可用。',evidence_status:'已确认',
    ...responsibilityDisplay(binding.request,generated.transition_index),
    attribution_reason:'实际输入保留基金代码和份额价格，生成输出改为现货及十倍价格。',uncertainties:['具体换算机制没有记录。']};
  const result:AttributionResult={meta:{input_id:id},summary:problem.text,has_standard_answer:false,is_correct:null,correct_reason:null,
    Problem:[{...problem,problem_id:'p1',evidence:evidence.filter(e=>!generated.before.some(b=>b.evidence_id===e.evidence_id) || !generated.predecessors.some(id=>transitions.find(t=>t.transition_index===id)!.after.some(b=>b.evidence_id!==e.evidence_id&&evidenceCovers({messages},candidate.input_id,e.evidence_id,b.evidence_id)))).map(e=>({...e,purposes:['问题','归因']}))}]};
  const audit=emptyAudit();
  audit.traceReads = evidence.flatMap(item => {
    const point=parseEvidenceCoordinates(item.evidence_id)!;
    return point.kind==='image'?[]:[{candidate:'answer',message_index:point.message_index,kind:point.kind,path:point.path,start:point.start,end:point.end}];
  });
  return { binding, chains, chain, transitions, generated, problem, result, evidence, audit, raw: { messages }, candidate };
}
