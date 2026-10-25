import test from 'node:test';
import assert from 'node:assert/strict';
import {evidenceId,evidenceSources,selectEvidenceSource} from '@eval/tools';
import {actualAnswerEvidenceShares} from './proof-matching.js';
import type {ComparisonInput} from './types.js';
const ID = "11111111-1111-4111-8111-111111111111", PEER = "22222222-2222-4222-8222-222222222222";
const BODY = '先减一半。\n条件："短线超买"。';
function pair() {
  const raw = { messages: [{ role: "user", content: "判断风险" },
    { type: "llm_turn", input_messages: [{ role: "user", content: "判断风险" }],
      output: [{ role: "assistant", content: BODY }], metadata: BODY },
    { type: "final_answer", role: "assistant", content: BODY, metadata: BODY }] };
  const material: ComparisonInput["candidates"][string] = { candidate_id: ID, final_message_index: 2,
    answer_generation: { available: true, message_type: "llm_turn", matches_captured_final: true, message_index: 1, captured_final_message_index: 2,
      input_contexts: [{ message_index: 1, path: "/input_messages",
        total_chars: (() => { const range = selectEvidenceSource(evidenceSources(raw.messages[1]), "/input_messages")!; return range.end - range.start; })(),
        read_request: { message_index: 1, path: "/input_messages", offset: 0, max_chars: 16000 } }],
      blocks: [{ path: "/output/0/content", total_chars: BODY.length }] },
    deferred_final_material: [], original_answer_timing: { finish_seconds: null }, original_answer_usage: { total_tokens: null, issues: [] } };
  const generation = evidenceId(ID, 1, "text", "/output/0/content", 0, BODY.length),
    captured = evidenceId(ID, 2, "text", "/content", 0, BODY.length);
  return { raw, material, generation, captured };
}

test("actual captured answer and confirmed complete generation share mapped ranges without rewriting either physical ID", () => {
  const { raw, material, generation, captured } = pair(), before = structuredClone(raw);
  assert(actualAnswerEvidenceShares(raw, ID, material, generation, captured));
  assert(actualAnswerEvidenceShares(raw, ID, material, captured, generation));
  const end = BODY.indexOf("。") + 1;
  assert(actualAnswerEvidenceShares(raw, ID, material, generation, evidenceId(ID, 2, "text", "/content", 0, end)));
  assert(!actualAnswerEvidenceShares(raw, ID, material, evidenceId(ID, 1, "text", "/output/0/content", 0, end),
    evidenceId(ID, 2, "text", "/content", end, BODY.length)));
  assert.deepEqual(raw, before);
});

test("metadata, peer, arbitrary earlier assistant and unconfirmed generation never alias the actual answer", () => {
  const { raw, material, generation, captured } = pair();
  for (const wrong of [evidenceId(ID, 1, "text", "/metadata", 0, BODY.length),
    evidenceId(ID, 2, "text", "/metadata", 0, BODY.length), evidenceId(PEER, 2, "text", "/content", 0, BODY.length),
    evidenceId(ID, 2, "image")]) assert(!actualAnswerEvidenceShares(raw, ID, material, wrong, captured));
  assert(!actualAnswerEvidenceShares(raw, ID, { ...material, answer_generation: null }, generation, captured));
  for (const matches_captured_final of [false, null]) assert(!actualAnswerEvidenceShares(raw, ID,
    { ...material, answer_generation: { ...material.answer_generation!, matches_captured_final } }, generation, captured));
  const unconfirmed = structuredClone(raw); unconfirmed.messages[2]!.type = "message";
  assert(!actualAnswerEvidenceShares(unconfirmed, ID, material, generation, captured));
  const newUser = structuredClone(raw); newUser.messages.splice(2, 0, { role: "user", content: "另一个任务" });
  assert(!actualAnswerEvidenceShares(newUser, ID, { ...material, final_message_index: 3,
    answer_generation: { ...material.answer_generation!, captured_final_message_index: 3 } }, generation,
    evidenceId(ID, 3, "text", "/content", 0, BODY.length)));
  assert(!actualAnswerEvidenceShares(raw, ID, { ...material, answer_generation: { ...material.answer_generation!, captured_final_message_index: 0 } }, generation, captured));
  raw.messages.splice(1, 0, { role: "assistant", content: BODY });
  material.final_message_index = 3; material.answer_generation = { ...material.answer_generation!, message_index: 2, captured_final_message_index: 3 };
  assert(!actualAnswerEvidenceShares(raw, ID, material, evidenceId(ID, 1, "text", "/content", 0, BODY.length),
    evidenceId(ID, 3, "text", "/content", 0, BODY.length)));
});

test("normalized equality, independent later planner and incomplete ordered generation do not establish identity", () => {
  for (const changed of [BODY.replace("\n", " "), BODY + '\n<visual>{"id":"chart"}</visual>', BODY + " "]) {
    const { raw, material, generation, captured } = pair();
    raw.messages[1]!.output![0]!.content = changed;
    material.answer_generation!.blocks[0]!.total_chars = changed.length;
    assert(!actualAnswerEvidenceShares(raw, ID, material, generation, captured));
  }
  const { raw, material, generation } = pair();
  raw.messages.splice(2, 0, { type: "llm_turn", input_messages: [{ role: "user", content: "独立规划" }], output: [{ role: "assistant", content: BODY }], metadata: "独立规划" });
  material.final_message_index = 3; material.answer_generation!.captured_final_message_index = 3;
  assert(!actualAnswerEvidenceShares(raw, ID, material, generation, evidenceId(ID, 3, "text", "/content", 0, BODY.length)));
});

test("JSON physical container maps only a complete actual answer leaf, excluding unrelated and partial JSON", () => {
  const { raw, material, captured } = pair(), json = evidenceSources(raw.messages[1]).find(source => source.kind === "json")!,
    leaf = selectEvidenceSource([json], "/output/0/content")!;
  assert(actualAnswerEvidenceShares(raw, ID, material, evidenceId(ID, 1, "json", "", 0, json.text.length), captured));
  assert(!actualAnswerEvidenceShares(raw, ID, material, evidenceId(ID, 1, "json", "", leaf.start + 1, leaf.end), captured));
  const meta = selectEvidenceSource([json], "/metadata")!;
  assert(!actualAnswerEvidenceShares(raw, ID, material, evidenceId(ID, 1, "json", "", meta.start, meta.end), captured));
});

test("ordered complete typed leaves map independently; missing leaves, tool calls and images cannot establish aliases", () => {
  const blocks = [{ type: "text", text: "先减一半。" }, { type: "output_text", text: "短线超买时。" }], raw = { messages: [
    { role: "user", content: "判断风险" }, { type: "llm_turn", input_messages: [{ role: "user", content: "判断风险" }],
      output: [{ role: "assistant", content: structuredClone(blocks) }] }, { type: "final_answer", role: "assistant", content: structuredClone(blocks) }] };
  const material = pair().material;
  material.answer_generation!.blocks = blocks.map((block, index) => ({ path: `/output/0/content/${index}/text`, total_chars: block.text.length }));
  const generation = evidenceId(ID, 1, "text", "/output/0/content/0/text", 0, blocks[0]!.text.length),
    captured = evidenceId(ID, 2, "text", "/content/0/text", 0, blocks[0]!.text.length);
  assert(actualAnswerEvidenceShares(raw, ID, material, generation, captured));
  assert(!actualAnswerEvidenceShares(raw, ID, material, generation, evidenceId(ID, 2, "text", "/content/1/text", 0, blocks[1]!.text.length)));
  const incomplete = { ...material, answer_generation: { ...material.answer_generation!, blocks: material.answer_generation!.blocks.slice(0, 1) } };
  assert(!actualAnswerEvidenceShares(raw, ID, incomplete, generation, captured));
  const withCall = structuredClone(raw);
  Object.assign(withCall.messages[1]!.output![0]!, { tool_calls: [{ name: "plan" }] });
  assert(!actualAnswerEvidenceShares(withCall, ID, material, generation, captured));
  const withImage = structuredClone(raw);
  (withImage.messages[2]!.content as unknown[]).push({ type: "image", mimeType: "image/png", data: "AA==" });
  assert(!actualAnswerEvidenceShares(withImage, ID, material, generation, captured));
  assert(actualAnswerEvidenceShares(withImage, ID, material, captured, captured), "physical text remains usable alongside a separately audited image");
  const reordered = structuredClone(raw); (reordered.messages[2]!.content as typeof blocks).reverse();
  assert(!actualAnswerEvidenceShares(reordered, ID, material, generation, evidenceId(ID, 2, "text", "/content/1/text", 0, blocks[0]!.text.length)));
});
