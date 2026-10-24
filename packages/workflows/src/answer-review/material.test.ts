import test from "node:test";
import assert from "node:assert/strict";
import { adapt, type RawInput } from "@eval/workflows/inputs";
import { answerReviewMaterial } from "./material.js";

test("review availability recognizes reasoning in both current trace formats", () => {
  for (const [adapter, question, reasoning, answer] of [
    ["a", { role: "user", content: "计算2+2" }, { type: "reasoning", content: "计算加法。" }, { role: "assistant", content: "4" }],
    ["b", { type: "user_question", content: "计算2+2" }, { type: "llm_turn", content: "计算加法。" }, { type: "final_answer", content: "4" }],
    ["a", { role: "user", content: "计算2+2" }, { type: "span", name: "thinking", output: "计算加法。" }, { role: "assistant", content: "4" }],
  ] as const) {
    const raw: RawInput = { batch_id: "b1", case_id: "one", messages: [question, reasoning, answer] };
    const candidate = adapt(raw, { id: "model", name: "model", adapter, sources: [] }, "fixture", 1);
    const { material, shown } = answerReviewMaterial(candidate, raw, candidate.input_id);
    assert.equal(material.availability.analysis, "available", JSON.stringify(reasoning));
    assert.equal(material.availability.tool_trace, "not_collected");
    assert.deepEqual(shown.tool_names, []);
  }
});

test("a captured tool return without a name is still a collected tool trace", () => {
  const raw: RawInput = { batch_id: "b1", case_id: "one", messages: [
    { role: "user", content: "计算2+2" }, { type: "function_call_output", call_id: "calc", output: "4" },
    { role: "assistant", content: "4" },
  ] };
  const candidate = adapt(raw, { id: "model", name: "model", adapter: "a", sources: [] }, "fixture", 1);
  assert.equal(answerReviewMaterial(candidate, raw, candidate.input_id).material.availability.tool_trace, "partial");
});
