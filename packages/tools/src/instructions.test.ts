const INPUT_ID = "11111111-1111-4111-8111-111111111111";
import test from "node:test";
import assert from "node:assert/strict";
import { answerTurnContexts, instructionSources, normativeSources } from "./instructions.js";
import { resolveEvidence } from "./evidence.js";
import { emptyAudit } from "../../../tests/fixtures/comparison.js";

test("answer contexts exclude an independent planner after the actual final-output turn", () => {
  const raw = { messages: [
    { type: "llm_turn", input_messages: { messages: [{ role: "system", content: "真实回答规范" }] },
      output: [{ role: "assistant", content: "实际最终回答" }] },
    { type: "llm_turn", input_messages: [{ role: "system", content: "独立规划规范" }],
      output: [{ role: "assistant", content: "下一项规划" }] },
    { role: "assistant", content: "实际最终回答" },
  ] };
  assert.deepEqual(answerTurnContexts(raw, 2), [{ message_index: 0, path: "/input_messages/messages" }]);
  assert.deepEqual(instructionSources(raw, INPUT_ID, 2).map(source => source.message_index), [0]);
});

test("normative sources include real user context without widening the instruction catalogue", () => {
  const raw = { messages: [
    { role: "user", content: [{ type: "text", text: "整理清单" }, { type: "text", text: "投资建议请先说明风险。" }] },
    { type: "llm_turn", input_messages: [{ role: "developer", content: "完整作答" },
      { role: "user", content: "本轮请使用横版表格。" }], output: [{ role: "assistant", content: "实际回答" }] },
    { type: "llm_turn", input_messages: [{ role: "user", content: "内部任务请输出规划。" }],
      output: [{ role: "assistant", content: "独立规划" }] },
    { role: "assistant", content: "实际回答" },
  ] };
  const before = structuredClone(raw);
  assert.deepEqual(normativeSources(raw, INPUT_ID, 3).map(source => [source.message_index, source.path, source.role]), [
    [0, "/content", "user"], [1, "/input_messages/0/content", "developer"], [1, "/input_messages/1/content", "user"],
  ]);
  assert.deepEqual(instructionSources(raw, INPUT_ID, 3).map(source => [source.message_index, source.role]), [[1, "developer"]]);
  for (const source of normativeSources(raw, INPUT_ID, 3)) for (const evidence of source.evidence)
    assert.deepEqual(resolveEvidence(raw, evidence, "answer", emptyAudit(), "/evidence", INPUT_ID), {
      evidence_id: evidence.evidence_id, message_index: source.message_index, quote: evidence.quote,
    });
  assert.deepEqual(raw, before);
});

test("instruction sources retain exact top-level and final-answer context coordinates", () => {
  const raw = { messages: [
    { role: "system", content: [{ type: "input_text", text: "仅投资建议需前置风险。" }] },
    { type: "llm_turn", name: "planner-search", input_messages: [{ role: "system", content: "仅输出检索计划。" }],
      output: [{ role: "assistant", content: "搜索计划" }] },
    { type: "llm_turn", name: "answer", input_messages: [{ role: "developer", content: "结论后提示风险。" }],
      output: [{ role: "assistant", content: "实际最终回答" }] },
    { role: "assistant", content: "实际最终回答" },
    { role: "developer", content: "下一轮指令不属于此回答。" },
  ] };
  const before = structuredClone(raw);
  const sources = instructionSources(raw, INPUT_ID, 3);
  assert.deepEqual(sources.map(({ message_index, path, role }) => ({ message_index, path, role })), [
    { message_index: 0, path: "/content", role: "system" },
    { message_index: 2, path: "/input_messages/0/content", role: "developer" },
  ]);
  assert.deepEqual(sources[0]!.content, raw.messages[0]!.content);
  for (const source of sources) for (const evidence of source.evidence)
    assert.deepEqual(resolveEvidence(raw, evidence, "answer", emptyAudit(), "/evidence", INPUT_ID), {
      evidence_id: evidence.evidence_id, message_index: source.message_index, quote: evidence.quote,
    });
  assert(sources[0]!.evidence.some(evidence => evidence.quote === "仅投资建议需前置风险。"));
  assert.deepEqual(raw, before);
});

test("answer lineage keeps initial agent instructions and changed developer rules without importing planners", () => {
  const call = { id: "call-1", type: "function", function: { name: "query", arguments: "{}" } };
  const early = { role: "assistant", content: "先查数据", tool_calls: [call] };
  const raw = { messages: [
    { role: "user", content: "问题" },
    { type: "llm_turn", name: "agent-0", input_messages: { messages: [
      { role: "system", content: "代理原始规范：不要以风险开场。" }, { role: "user", content: "问题" },
    ] }, output: [early] },
    { type: "llm_turn", name: "internal-0", input_messages: { messages: [
      { role: "system", content: "工具内部只输出数字。" },
    ] }, output: [{ role: "assistant", content: "内部结果" }] },
    { type: "llm_turn", name: "agent-1", input_messages: { messages: [
      { role: "developer", content: "只用当前数据。" }, early, { role: "tool", content: "内部结果" },
    ] }, output: [{ role: "assistant", content: "最终结论" }] },
    { role: "assistant", content: "最终结论" },
  ] };
  const sources = instructionSources(raw, INPUT_ID);
  assert.deepEqual(sources.map(source => [source.message_index, source.path, source.content]), [
    [1, "/input_messages/messages/0/content", "代理原始规范：不要以风险开场。"],
    [3, "/input_messages/messages/0/content", "只用当前数据。"],
  ]);
});

test("repeated answer instructions use the earliest true origin and unlinked turns supply no inferred rules", () => {
  const raw = { messages: [
    { type: "llm_turn", input_messages: [{ role: "system", content: "真实规范" }],
      output: [{ role: "assistant", content: "先查" }] },
    { type: "llm_turn", input_messages: { messages: [
      { role: "system", content: "真实规范" }, { role: "assistant", content: "先查" },
    ] }, output: [{ role: "assistant", content: "结论" }] },
    { role: "assistant", content: "结论" },
  ] };
  assert.deepEqual(instructionSources(raw, INPUT_ID).map(source => source.message_index), [0]);
  (raw.messages[1] as { output: unknown }).output = [{ role: "assistant", content: "另一个任务" }];
  assert.deepEqual(instructionSources(raw, INPUT_ID), []);
});

test("a collected answer still links its actual context when visual resource tags were rendered out", () => {
  const raw = { messages: [
    { type: "llm_turn", name: "planner", input_messages: [{ role: "system", content: "内部规划规范" }],
      output: [{ role: "assistant", content: "计划" }] },
    { type: "llm_turn", input_messages: [{ role: "system", content: "真实回答规范" }],
      output: [{ role: "assistant", content: '结论\n\n<visual>{"id":"chart"}</visual>\n\n补充' }] },
    { role: "assistant", content: "结论\n\n\n\n补充" },
  ] };
  assert.deepEqual(instructionSources(raw, INPUT_ID).map(source => source.message_index), [1]);
});
