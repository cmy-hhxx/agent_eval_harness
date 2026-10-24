import test from "node:test";
import assert from "node:assert/strict";
import { traceCatalog } from "./catalog.js";

test("tool catalog links interleaved unnamed returns by call id, never adjacency", () => {
  const catalog = traceCatalog({ messages: [
    { type: "function_call", name: "FinQuery", call_id: "finance", arguments: "{}" },
    { type: "tool_call", name: "Search", id: "search" },
    { type: "function_call_output", call_id: "finance", output: "21.87" },
    { type: "tool_result", call_id: "search", content: "公告" },
    { type: "function_call_output", call_id: "unknown", output: "未知" },
    { role: "tool", tool_call_id: "finance", content: "21.6256" },
    { type: "tool_result", call_id: "finance", name: "Other", content: "冲突" },
  ] });
  assert.equal(catalog[2]!.name, "FinQuery");
  assert.equal(catalog[2]!.call_message_index, 0);
  assert.equal(catalog[3]!.name, "Search");
  assert.equal(catalog[3]!.call_message_index, 1);
  assert.equal(catalog[4]!.name, undefined);
  assert.equal(catalog[4]!.call_message_index, undefined);
  assert.equal(catalog[5]!.name, "FinQuery");
  assert.equal(catalog[5]!.call_message_index, 0);
  assert.equal(catalog[6]!.name, "Other");
  assert.equal(catalog[6]!.call_message_index, undefined);
});

test("catalog distinguishes named model nodes from tools and links only an unambiguous invoking model span", () => {
  const catalog = traceCatalog({ messages: [
    { type: "llm_turn", name: "planner-finquery", parent_span: "planner" },
    { type: "tool_call", name: "finquery", parent_span: "planner", input: { query: "黄金价格" } },
    { type: "tool_result", name: "finquery", output: { code_count: 0 } },
    { type: "tool_call", name: "other", parent_span: "missing" },
    { type: "llm_turn", name: "answer", parent_span: "duplicate" },
    { type: "llm_turn", name: "answer-retry", parent_span: "duplicate" },
    { type: "tool_call", name: "finquery", parent_span: "duplicate" },
    { type: "final_answer", role: "assistant", content: "实际交付" },
  ] });
  assert.equal(catalog[0].semantic_role, "model_call");
  assert.equal(catalog[1].semantic_role, "tool_call");
  assert.equal(catalog[1].invoking_model_message_index, 0);
  assert.equal(catalog[2].semantic_role, "tool_return");
  assert.equal(catalog[2].call_message_index, undefined);
  assert.equal(catalog[3].invoking_model_message_index, undefined);
  assert.equal(catalog[6].invoking_model_message_index, undefined);
  assert.equal(catalog[7].semantic_role, "final_delivery");
});
