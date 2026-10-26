import { randomUUID } from "node:crypto";
import { bindAttributionMaterial } from "@eval/workflows/review";
import { type Candidate, type RawInput } from "@eval/workflows/inputs";
import type { BusinessChain, AttributionTransition } from "@eval/agents/attribution";

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
  return { binding, chains, chain: chains[0], transitions, generated, raw: { messages }, candidate };
}
