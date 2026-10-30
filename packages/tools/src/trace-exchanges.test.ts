import test from "node:test";
import assert from "node:assert/strict";
import { traceExchanges, traceExecutionLinks } from "./trace-exchanges.js";

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

test("execution input navigation groups exact repeats but retains changes, recipients and every location", () => {
  const input = (content: string) => [{ role: "tool", name: "shell", tool_call_id: "c", content }];
  const messages = [
    { type: "llm_turn", parent_span: "p", output: [{ tool_calls: [{ id: "c", function: { name: "shell", arguments: "{}" } }] }] },
    { type: "tool_call", name: "shell", call_id: "c", parent_span: "p", input: {} },
    { type: "tool_result", name: "shell", tool_call_id: "c", output: "returned" },
    { type: "llm_turn", name: "llm-call-1", model: "M", input_messages: { messages: input("A") } },
    { type: "llm_turn", name: "llm-call-2", model: "M", input_messages: { messages: input("A") } },
    { type: "llm_turn", name: "llm-call-3", model: "M", input_messages: { messages: input("B") } },
    { type: "llm_turn", name: "llm-call-4", agent_name: "delegated", model: "M", input_messages: input("A") },
  ];
  const locations = traceExecutionLinks(messages)[0]!.model_inputs as Record<string, unknown>[];
  assert.equal(locations.length, 3);
  assert.deepEqual(locations[0], { message_index: 3, path: "/input_messages/messages/0/content",
    additional_input_locations: [{ message_index: 4, path: "/input_messages/messages/0/content" }] });
  assert.deepEqual(locations[1], { message_index: 5, path: "/input_messages/messages/0/content" });
  assert.deepEqual(locations[2], { message_index: 6, path: "/input_messages/0/content" });
});
