import assert from "node:assert/strict";
import { test } from "node:test";
import { evidenceSources, resolveEvidence, selectEvidenceSource } from "@eval/tools";
import { answerGenerationPresentation, getAnswerGeneration } from "./answer-generation.js";
import type { RawInput } from "./types.js";

const evidenceInputId = "7ebfa07b-55d4-4e19-80d0-545eb576289a";

function fixture(generated: unknown = '回答\n<visual>{"id":"resource"}</visual>', captured: unknown = "回答\n") {
  return { messages: [
    { type: "user_question", role: "user", content: "原问" },
    { type: "llm_turn", input_messages: [{ role: "system", content: "长规范" }],
      output: [{ role: "assistant", content: generated }] },
    { type: "final_answer", role: "assistant", content: captured },
  ] } as RawInput;
}

test("original assistant output has full independent text and directly resolvable source evidence", () => {
  const raw = fixture(), generation = getAnswerGeneration(raw, evidenceInputId)!;
  assert.equal(generation.message_index, 1);
  assert.equal(generation.captured_final_message_index, 2);
  assert.equal(generation.message_type, "llm_turn");
  assert.equal(generation.matches_captured_final, false);
  assert.equal(generation.blocks[0]!.text, '回答\n<visual>{"id":"resource"}</visual>');
  assert.equal(generation.blocks[0]!.path, "/output/0/content");
  const resolved = resolveEvidence(raw, generation.blocks[0]!.reference, "answer", { traceReads: [], viewedImages: [] }, "/evidence", evidenceInputId);
  assert.equal(resolved.quote, generation.blocks[0]!.text);
  assert.deepEqual(generation.blocks[0]!.read_request, { message_index: 1, path: "/output/0/content", offset: 0, max_chars: 16000 });
  assert.equal(JSON.stringify(generation).includes("长规范"), false);
  assert.equal(Object.hasOwn(generation, "ui_visible"), false);
});

test("strictly equal presentation avoids duplicated original text and retains exact readable evidence", () => {
  const raw = fixture("原文\n", "原文\n"), generation = getAnswerGeneration(raw, evidenceInputId)!;
  assert.equal(generation.matches_captured_final, true);
  const view = answerGenerationPresentation(generation, "A")!;
  assert.equal(Object.hasOwn(view.blocks[0]!, "text"), false);
  assert.equal(Object.hasOwn(view.blocks[0]!, "read_request"), false);
  assert.deepEqual(view.blocks[0]!.reference, generation.blocks[0]!.reference);
  assert.equal(generation.blocks[0]!.text, "原文\n", "presentation must not mutate full trusted generation");
});

test("confirmed answer-chain differences are exact text facts without inferring cause", () => {
  for (const [generated, captured] of [["x\n", "x"], ['x<visual>{"id":"resource"}</visual>', "x"]]) {
    const generation = getAnswerGeneration(fixture(generated, captured), evidenceInputId)!;
    assert.equal(generation.matches_captured_final, false);
    assert.equal(answerGenerationPresentation(generation, "answer")!.blocks[0]!.text, generated);
  }
  assert.equal(getAnswerGeneration(fixture("é", "e\u0301"), evidenceInputId), null, "no unproved Unicode transform relation");
  assert.equal(getAnswerGeneration(fixture("<render>x</render>", "x"), evidenceInputId), null, "no arbitrary resource transform relation");
});

test("typed text blocks retain their original individual paths and original byte content", () => {
  const content = [{ type: "text", text: "第一段" }, { type: "output_text", text: "第二段\n" }];
  const raw = fixture(content, structuredClone(content)), generation = getAnswerGeneration(raw, evidenceInputId)!;
  assert.equal(generation.matches_captured_final, true);
  assert.deepEqual(generation.blocks.map(block => block.path), ["/output/0/content/0/text", "/output/0/content/1/text"]);
  assert.deepEqual(generation.blocks.map(block => block.text), ["第一段", "第二段\n"]);
  for (const block of generation.blocks) assert.equal(resolveEvidence(raw, block.reference, "answer", { traceReads: [], viewedImages: [] }, "/evidence", evidenceInputId).quote, block.text);
});

test("an output outside the confirmed answer-chain shape remains unknown", () => {
  const raw = fixture("原文", "原文");
  raw.messages[1]!.output = { role: "assistant", content: "原文", diagnostic: "不是正文" };
  assert.equal(getAnswerGeneration(raw, evidenceInputId), null);
});

test("missing, untyped or ambiguous generation is unknown rather than replaced by an earlier output", () => {
  const cases: RawInput[] = [
    { messages: [{ type: "final_answer", role: "assistant", content: "正文" }] },
    { messages: [{ role: "assistant", content: "正文" }, { type: "final_answer", content: "正文" }] },
    fixture(), fixture(), fixture(), fixture(),
  ];
  cases[2]!.messages[1]!.output = [{ role: "assistant", content: "一" }, { role: "assistant", content: "二" }];
  cases[3]!.messages[1]!.output = [{ role: "tool", content: "工具返回" }];
  cases[4]!.messages[1]!.output = "没有生成角色";
  cases[5]!.messages[1]!.input_messages = undefined;
  for (const raw of cases) assert.equal(getAnswerGeneration(raw, evidenceInputId), null);
});

test("tool-call or function-call outputs cannot masquerade as the final model prose", () => {
  for (const extra of [{ tool_calls: [{ name: "工具" }] }, { tool_calls: {} }, { function_call: { name: "工具" } }]) {
    const raw = fixture(); raw.messages[1]!.output = [{ role: "assistant", content: "我要查询", ...extra }];
    assert.equal(getAnswerGeneration(raw, evidenceInputId), null);
  }
  const raw = fixture("回答", "回答"); raw.messages[1]!.output = [{ role: "assistant", content: "回答", tool_calls: [] }];
  assert.equal(getAnswerGeneration(raw, evidenceInputId)!.blocks[0]!.text, "回答");
});

test("explicit collected final index scopes the corresponding last model turn", () => {
  const raw = fixture("早一轮", "早一轮");
  raw.messages.push({ type: "user_question", role: "user", content: "下一轮" },
    { type: "llm_turn", input_messages: [{ role: "user", content: "下一轮" }], output: [{ role: "assistant", content: "后一轮" }] },
    { type: "final_answer", role: "assistant", content: "后一轮" });
  assert.equal(getAnswerGeneration(raw, evidenceInputId, 2)!.blocks[0]!.text, "早一轮");
  assert.equal(getAnswerGeneration(raw, evidenceInputId)!.blocks[0]!.text, "后一轮");
  for (const index of [-1, 1, 2.5, 99, NaN]) assert.equal(getAnswerGeneration(raw, evidenceInputId, index), null);
  raw.messages.splice(4, 1);
  assert.equal(getAnswerGeneration(raw, evidenceInputId), null, "a prior user turn generation cannot substitute for missing current generation");
});

test("empty or nontext output does not invent text evidence; unavailable collected text leaves equality unknown", () => {
  for (const generated of ["", [], [{ type: "text", text: "" }], [{ type: "image", data: "pixels" }], [{ type: "text", text: "文字" }, { type: "image", data: "pixels" }]])
    assert.equal(getAnswerGeneration(fixture(generated), evidenceInputId), null);
  const generation = getAnswerGeneration(fixture("确证生成", [{ type: "text", text: "确证生成" }, { type: "image", data: "pixels" }]), evidenceInputId)!;
  assert.equal(generation.matches_captured_final, null);
  assert.equal(answerGenerationPresentation(generation, "B")!.blocks[0]!.text, "确证生成");
});

test("a later independent planner cannot replace the actual answer generation", () => {
  const raw = fixture("实际回答", "实际回答");
  raw.messages.splice(2, 0, { type: "llm_turn", name: "independent-planner", input_messages: [{ role: "user", content: "独立规划" }],
    output: [{ role: "assistant", content: "规划文本" }] });
  const generation = getAnswerGeneration(raw, evidenceInputId)!;
  assert.equal(generation.message_index, 1);
  assert.equal(generation.blocks[0]!.text, "实际回答");
  assert.deepEqual(generation.input_contexts.map(context => context.message_index), [1]);
  raw.messages[1]!.input_messages = undefined;
  assert.equal(getAnswerGeneration(raw, evidenceInputId), null, "cannot confirm a generation with only unrelated planner material");
});

test("actual model input directory preserves answer history and nested input paths without copying text", () => {
  const raw = fixture("第一步", "最终回答");
  raw.messages.splice(2, 0, { type: "llm_turn", input_messages: { messages: [
    { role: "assistant", content: "第一步" }, { role: "tool", content: "部分返回" },
  ] }, output: [{ role: "assistant", content: "最终回答" }] });
  const generation = getAnswerGeneration(raw, evidenceInputId)!;
  assert.deepEqual(generation.input_contexts.map(context => [context.message_index, context.path]),
    [[1, "/input_messages"], [2, "/input_messages/messages"]]);
  const view = answerGenerationPresentation(generation, "B")!;
  for (const context of view.input_contexts) {
    const range = selectEvidenceSource(evidenceSources(raw.messages[context.message_index]), context.path)!;
    assert.equal(context.total_chars, range.end - range.start);
    assert.equal(Object.hasOwn(context, "read_request"), false);
    assert.deepEqual((context as any).search_scope, { candidate: "B", message_index: context.message_index, path: context.path });
    assert.equal(Object.hasOwn(context, "text"), false);
  }
});

test("full generation remains unchanged by projection and unknown presentation stays null", () => {
  const raw = fixture(), original = structuredClone(raw);
  const generation = getAnswerGeneration(raw, evidenceInputId)!;
  answerGenerationPresentation(generation, "answer");
  assert.deepEqual(raw, original);
  assert.equal(answerGenerationPresentation(null, "answer"), null);
});
