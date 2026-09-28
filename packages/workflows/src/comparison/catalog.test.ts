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
