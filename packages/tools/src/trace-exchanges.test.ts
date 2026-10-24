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
