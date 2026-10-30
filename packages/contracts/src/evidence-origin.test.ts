import test from "node:test";
import assert from "node:assert/strict";
import { evidenceOrigin } from "./evidence.js";

test("source origin distinguishes a model's claim from tool observations in its actual input", () => {
  const message = { type: "llm_turn", name: "call-4", model: "model-A", input_messages: { messages: [
    { role: "system", content: "PRIVATE_SENTINEL" }, { role: "tool", name: "shell", content: "execution forbidden" },
  ] }, output: [{ role: "assistant", content: "文件已经生成。" }] };
  const before = structuredClone(message);
  assert.deepEqual(evidenceOrigin(message, "/output/0/content"), {
    type: "llm_turn", name: "call-4", model: "model-A", field_path: "/output/0/content", enclosing_role: "assistant",
  });
  assert.deepEqual(evidenceOrigin(message, "/input_messages/messages/1/content"), {
    type: "llm_turn", name: "call-4", model: "model-A", field_path: "/input_messages/messages/1/content", enclosing_role: "tool", enclosing_name: "shell",
  });
  assert(!JSON.stringify(evidenceOrigin(message, "/input_messages/messages/0/content")).includes("PRIVATE_SENTINEL"));
  assert.deepEqual(message, before);
});
