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

test("Score pre-registers only displayed original spans, preserving Unicode coordinates and unseen suffixes", () => {
  const raw: RawInput = { batch_id: "b1", case_id: "visible", messages: [
    { role: "system", content: "SECRET_PRIVATE_POLICY" },
    { role: "user", content: "核对🧪对应的日期和单位。" },
    { type: "function_call_output", output: "原始返回🧪".repeat(1000) },
    { role: "assistant", content: "🧪".repeat(12001) },
  ] };
  const candidate = adapt(raw, { id: "model", name: "model", adapter: "a", sources: [] }, "fixture", 1);
  const { material, shown } = answerReviewMaterial(candidate, raw, candidate.input_id);
  assert(material.review_seed, "visible original material needs program-bound evidence references");
  const seed = material.review_seed;
  assert.deepEqual(seed.actions, [], "displayed evidence must not invent tool execution or independent verification");
  assert(Array.isArray((shown as Record<string, unknown>).shared_quotes));
  assert.equal(seed.quotes.find(row => row.source_id === "Q")!.quote, candidate.question);
  const answer = seed.quotes.find(row => row.source_id === "A")!;
  assert.equal(answer.end, 12000);
  assert.equal(Array.from(answer.quote).length, 12000);
  assert.equal(shown.answer_requires_more, true);
  for (const quote of seed.quotes) {
    assert.equal(Array.from(material.evidence[quote.source_id]).slice(quote.start, quote.end).join(""), quote.quote);
    if (!["Q", "A"].includes(quote.source_id)) assert(quote.end <= shown.initial_sources.find(row => row.source_id === quote.source_id)!.end);
  }
  assert(!JSON.stringify(seed).includes("SECRET_PRIVATE_POLICY"));
  assert.equal(new Set(seed.quotes.map(row => row.evidence_id)).size, seed.quotes.length);
});
