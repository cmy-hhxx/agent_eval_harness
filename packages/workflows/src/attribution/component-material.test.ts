import test from "node:test";
import assert from "node:assert/strict";
import { AgentRegistry } from "@eval/host";
import { attributionAgent } from "@eval/agents/attribution";
import { adapt } from "@eval/workflows/inputs";
import { bindAttribution } from "./index.js";
import { sourceCompactReceipt, componentTask } from "../../../../tests/fixtures/compact.js";

test("honest final disclosure receives the upstream successful-but-empty script receipt and its code", () => {
  const raw = { batch_id: "batch", case_id: "empty-sheet", messages: [
    { type: "user_question", content: "生成含120个月度行的工作簿并核对总计。" },
    { type: "tool_call", name: "shell", call_id: "build", input: { command: "python make.py" } },
    { type: "tool_result", name: "shell", call_id: "build", output: { exit_code: 0, stdout: "monthly_rows=0; monthly_total=0; CHECK variance=2248124.18" } },
    { type: "final_answer", content: "工作簿月度区块仍为空，未能交付。" },
  ] };
  const candidate = adapt(raw, { id: "answer", name: "Answer", adapter: "b", sources: [] }, "fixture", 1);
  const compact = sourceCompactReceipt(candidate, raw), task = componentTask(candidate, compact, "最终答复生成");
  const binding = bindAttribution(task, { [candidate.input_id]: raw }, { compact });
  const prepared = new AgentRegistry([attributionAgent]).prepare(binding);
  assert(prepared.prompt.includes("monthly_rows=0"), "the final review must see the actual upstream business failure even with exit 0 and no tool_errors");
  assert(prepared.prompt.includes("python make.py"), "the receipt must retain its real invocation");
  assert.equal((binding.modelInput!.tool_errors as unknown[]).length, 0);
});

test("a last planning call is not mistaken for the final generator when generation was not captured", () => {
  const raw = { batch_id: "batch", case_id: "missing-generation", messages: [
    { type: "user_question", content: "生成工作簿。" },
    { type: "llm_turn", name: "planner-excel", output: "运行 make.py。" },
    { type: "tool_call", name: "shell", call_id: "build", input: { command: "python make.py" } },
    { type: "tool_result", name: "shell", call_id: "build", output: { exit_code: 0, stdout: "monthly_rows=0; CHECK" } },
    { type: "final_answer", content: "月度表为空，未交付。" },
  ] };
  const candidate = adapt(raw, { id: "answer", name: "Answer", adapter: "b", sources: [] }, "fixture", 1);
  const compact = sourceCompactReceipt(candidate, raw);
  const planner = componentTask(candidate, compact, "planner-excel");
  const binding = bindAttribution(planner, { [candidate.input_id]: raw }, { compact });
  assert.equal((binding.modelInput!.current_component as { contains_final_generation: boolean }).contains_final_generation, false);
  assert(componentTask(candidate, compact, "最终答复生成"));
});

test("an empty planner sees the real alternative retrieval before deciding residual delivery impact", () => {
  const raw = { batch_id: "batch", case_id: "alternative", messages: [
    { type: "user_question", content: "查询今日金价。" },
    { type: "llm_turn", name: "planner-finquery", output: "[]" },
    { type: "llm_turn", name: "planner-search", parent_span: "search", output: "搜索今日金价。" },
    { type: "tool_call", name: "web_search", call_id: "price", parent_span: "search", input: { query: "今日金价" } },
    { type: "tool_result", name: "web_search", call_id: "price", output: "今日金价100元/克，交易所报价。" },
    { type: "final_answer", content: "今日金价100元/克，依据交易所报价。" },
  ] };
  const candidate = adapt(raw, { id: "answer", name: "Answer", adapter: "b", sources: [] }, "fixture", 1);
  const compact = sourceCompactReceipt(candidate, raw), task = componentTask(candidate, compact, "planner-finquery");
  const binding = bindAttribution(task, { [candidate.input_id]: raw }, { compact });
  const context = binding.modelInput!.context_invocations as { return_evidence: { message_index: number; quote: string }[]; executed_components: string[] }[];
  assert(context.some(item => item.return_evidence.some(proof => proof.message_index === 4 && proof.quote.includes("交易所报价"))));
  assert(context.some(link => link.executed_components.includes("web_search")));
});

test("component investigation keeps loaded skill contracts, prior user constraints and actual tool arguments without envelope noise", () => {
  const raw = { batch_id: "batch", case_id: "contracts", messages: [
    { type: "user_question", content: "只筛选50美元以下的股票，必须返回季度营收。" },
    { type: "user_question", content: "继续查这几个。" },
    { type: "tool_call", name: "view_skill", call_id: "skill", input: { name: "finance" } },
    { type: "tool_result", name: "view_skill", call_id: "skill", output: '<skill_content name="finance">季度营收必须使用指定报告期，不得用TTM替代。</skill_content>' },
    { type: "llm_turn", name: "planner-finquery", parent_span: "planner", input_messages: {
      messages: [{ role: "system", content: "PRIVATE_SYSTEM_SENTINEL" }],
      tools: [{ type: "function", function: { name: "finquery", description: "按指定股票及报告期查询财务字段。", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } }],
    }, output: [{ role: "assistant", tool_calls: [{ id: "ENVELOPE_ID_SENTINEL", type: "function", function: { name: "finquery", arguments: '{"query":"股票A，2026Q1营收，股价<50美元"}' } }] }] },
    { type: "tool_call", name: "finquery", call_id: "data", parent_span: "planner", input: { query: "股票A，2026Q1营收，股价<50美元" } },
    { type: "tool_result", name: "finquery", call_id: "data", output: "股票A，2026Q1营收10亿美元，股价49美元。" },
    { type: "final_answer", content: "股票A，2026Q1营收10亿美元，股价49美元。" },
  ] };
  const candidate = adapt(raw, { id: "answer", name: "Answer", adapter: "b", sources: [] }, "fixture", 1);
  const compact = sourceCompactReceipt(candidate, raw), task = componentTask(candidate, compact, "planner-finquery");
  const binding = bindAttribution(task, { [candidate.input_id]: raw }, { compact });
  const text = new AgentRegistry([attributionAgent]).prepare(binding).prompt;
  assert(text.includes("季度营收必须使用指定报告期"), "the actual skill body must be inspectable, not an omitted marker");
  assert(text.includes("按指定股票及报告期查询财务字段"), "the request generator needs its actual callable contract");
  assert(text.includes("只筛选50美元以下"), "earlier user constraints remain available to upstream components");
  assert(text.includes("股票A，2026Q1营收，股价<50美元"));
  assert(!text.includes("ENVELOPE_ID_SENTINEL"), "tool-call envelope ids must not spend the evidence budget");
  assert(!text.includes("PRIVATE_SYSTEM_SENTINEL"));
  assert(!text.includes("additional_input_locations"));
});

test("each earlier request stays paired with its own receipt instead of only showing the last calls", () => {
  const raw = { batch_id: "batch", case_id: "request-result", messages: [
    { type: "user_question", content: "查询OCGN的TTM营收和估值。" },
    ...Array.from({ length: 4 }, (_, i) => [
      { type: "tool_call", name: "finquery", call_id: `q${i}`, input: { query: i === 0 ? "OCGN Total Revenue TTM" : `OCGN metric ${i}` } },
      { type: "tool_result", name: "finquery", call_id: `q${i}`, output: i === 0 ? { status_code: 0, columns: [{ field: "Total Revenue (MRQ)", unit: "USD" }], datas: [{ ticker: "OCGN", period: "2026Q1", "Total Revenue (MRQ)": 1488000 }] } : { result: i } },
    ]).flat(),
    { type: "final_answer", content: "OCGN TTM revenue about $1.5M。" },
  ] };
  const candidate = adapt(raw, { id: "answer", name: "Answer", adapter: "b", sources: [] }, "fixture", 1);
  const compact = sourceCompactReceipt(candidate, raw), task = componentTask(candidate, compact, "finquery");
  const binding = bindAttribution(task, { [candidate.input_id]: raw }, { compact });
  const invocations = binding.modelInput!.invocations as { request_message_index: number; return_message_indices: number[]; request_evidence: { quote: string }[]; return_evidence: { quote: string }[] }[];
  assert.equal(invocations.length, 4);
  assert.equal(invocations[0]!.request_message_index, 1);
  assert.deepEqual(invocations[0]!.return_message_indices, [2]);
  assert(JSON.stringify(invocations[0]!.request_evidence).includes("Revenue TTM"));
  for (const value of ["Revenue (MRQ)", "USD", "2026Q1", "1488000"])
    assert(JSON.stringify(invocations[0]!.return_evidence).includes(value), `the mismatching receipt must preserve ${value}`);
  assert.deepEqual(binding.modelInput!.tool_errors, []);
});
