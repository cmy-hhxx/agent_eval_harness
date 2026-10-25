import test from "node:test";
import assert from "node:assert/strict";
import { traceExchanges } from "./trace-exchanges.js";

test("unique returned query links an anonymous invocation and its actual planner, without pairing neighboring nodes", () => {
  const messages = [{ type: "llm_turn", name: "planner-finquery", parent_span: "p" },
    { type: "tool_call", name: "finquery", parent_span: "p", input: { query: "ETF GLD" } },
    { type: "tool_call", name: "finquery", parent_span: "another", input: { query: "Gold.com" } },
    { type: "tool_result", name: "finquery", output: { query: "ETF GLD", datas: [{ price: 369 }] } }];
  assert.deepEqual(traceExchanges(messages), [{ request_index: 1, return_indices: [3], planner_index: 0, link_basis: "returned_query" }]);
  messages.splice(2, 0, structuredClone(messages[1]));
  assert.deepEqual(traceExchanges(messages), []);
});
test("explicit IDs distinguish repeated same-tool queries; a conflicting ID cannot silently fall back to query or adjacency", () => {
  const messages = [{ type: "tool_call", name: "finquery", call_id: "a", input: { query: "ETF GLD" } },
    { type: "tool_call", name: "finquery", call_id: "b", input: { query: "ETF GLD" } },
    { type: "tool_result", name: "finquery", call_id: "a", output: { query: "ETF GLD" } }];
  assert.deepEqual(traceExchanges(messages)[0].request_index, 0);
  messages[2].call_id = "unknown";
  assert.deepEqual(traceExchanges(messages), []);
});
test("shell returns without IDs require a unique same-tool completion event", () => {
  const messages = [{type:"llm_turn",parent_span:"p"},
    {type:"tool_call",name:"shell",parent_span:"p",end:"2026-10-24T06:08:42.893Z",input:{command:"run"}},
    {type:"tool_result",name:"shell",end:"2026-10-24T06:08:42.893Z",output:{stdout:"done"}}];
  assert.deepEqual(traceExchanges(messages),[{request_index:1,return_indices:[2],planner_index:0,link_basis:"end_time"}]);
  assert.deepEqual(traceExchanges([...messages,structuredClone(messages[2])]),[]);
  for(const end of ['', ' '])assert.deepEqual(traceExchanges(messages.map(message=>({...message,end}))),[]);
  messages.splice(2,0,structuredClone(messages[1]));
  assert.deepEqual(traceExchanges(messages),[]);
});
