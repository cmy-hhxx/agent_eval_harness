import test from "node:test";
import assert from "node:assert/strict";
import { annotateFindings } from "./annotations.js";
import type { Finding } from "./types.js";
import type { RawInput } from "../inputs/types.js";

const evidenceInputId = "7ebfa07b-55d4-4e19-80d0-545eb576289a";

const finding = (quote: string, messageIndex: number) => ({
  evidence: [{ message_index: messageIndex, quote }],
}) as Finding;
test("source annotations reuse exact citation IDs without inferring responsibility", () => {
  const raw: RawInput = { messages: [
    { role: "user", content: "问题" },
    { type: "function_call", name: "Search", call_id: "search" },
    { type: "function_call_output", call_id: "search", output: "<referencable-result>\nID: 14\n来源\n</referencable-result>" },
    { type: "message", role: "assistant", content: "结论[^14]" },
  ] };
  const annotation = annotateFindings(raw, evidenceInputId, [finding("结论[^14]", 3)])[0];
  assert.deepEqual(annotation.tools, ["Search"]);
  assert.equal(annotation.confidence, "high");
  assert.equal(Object.hasOwn(annotation, "component"), false);
  raw.messages[2].output = { id: "WRONGID", title: "非引用ID", summary: "内容" };
  raw.messages[3].content = '结论<trace ref="WRONGID"/>';
  const unknown = annotateFindings(raw, evidenceInputId, [finding(String(raw.messages[3].content), 3)])[0];
  assert.deepEqual(unknown.tools, []);
  assert.equal(unknown.confidence, "medium");
});

test("a model-visible ID does not assign an original tool by renderer-message proximity", () => {
  const answer = '目标12<trace ref="RSTY3kK"/>';
  const raw: RawInput = { messages: [
    { role: "user", content: "问题" },
    { type: "tool_call", name: "finquery" },
    { type: "tool_result", name: "finquery", output: { datas: [{ value: 12 }] } },
    { type: "llm_turn", input_messages: [{ role: "user", content: '你取到的金融数据：\n{"serial_number":"RSTY3kK","query":"目标值","datas":[{"value":12}]}' }],
      output: [{ role: "assistant", content: answer }] },
    { type: "final_answer", role: "assistant", content: answer },
  ] };
  const annotation = annotateFindings(raw, evidenceInputId, [finding(String(raw.messages[4].content), 4)])[0];
  assert.deepEqual(annotation.tools, []);
  assert.equal(annotation.confidence, "medium");
  assert.deepEqual(annotation.candidate_tools, ["FinQuery"]);
});

test("equal ref and action IDs keep their own citation sources in annotations", () => {
  const answer = '事实<trace ref="SAME123"/> 计算<trace anchor="SAME123"/>';
  const raw: RawInput = { messages: [
    { role: "user", content: "核对事实与计算" },
    { type: "tool_result", name: "Search", output: { ref: "SAME123", title: "事实来源", content: "事实" } },
    { type: "tool_result", name: "CodeInterpreter", output: { action_id: "SAME123", traceability: 1, stdout: "计算结果" } },
    { type: "final_answer", role: "assistant", content: answer },
  ] };
  const annotations = annotateFindings(raw, evidenceInputId, [finding('事实<trace ref="SAME123"/>', 3), finding('计算<trace anchor="SAME123"/>', 3)]);
  assert.deepEqual(annotations[0].tools, ["Search"]);
  assert.deepEqual(annotations[1].tools, ["CodeInterpreter"]);
  assert.equal(annotations[0].confidence, "high");
  assert.equal(annotations[1].confidence, "high");
});

test("visual source annotations name the actual returning tool without claiming rendering or responsibility", () => {
  const answer = '<vis-html ref="html-chart"/>';
  const raw: RawInput = { messages: [
    { role: "user", content: "图表" },
    { type: "tool_result", name: "view_skill", output: 'Example:\n{"type":"vis-html","id":"html-chart"}' },
    { type: "tool_result", name: "shell", output: { stdout: '{"type":"vis-html","id":"html-chart"}', exit_code: 0 } },
    { type: "final_answer", role: "assistant", content: answer },
  ] };
  const annotation = annotateFindings(raw, evidenceInputId, [finding(answer, 3)])[0];
  assert.deepEqual(annotation.tools, ["shell"]);
  assert.equal(annotation.source, "quote_reference");
  assert.equal(annotation.confidence, "high");
  assert.deepEqual(annotation.locations, [{ message_index: 2, tool_name: "shell" }]);
  assert.equal(Object.hasOwn(annotation, "rendered"), false);
  assert.equal(Object.hasOwn(annotation, "component"), false);
});


test("foreign evidence annotates the peer physical input instead of the answer's coincident message index", () => {
  const inputId = "b6599ec8-0a1d-4e30-9294-3a9f5f94a4b5";
  const own = { messages: [{ role: "user", content: "查询。" },
    { type: "tool_result", name: "OwnLookup", content: "本方结果。" },
    { type: "final_answer", role: "assistant", content: "结论。" }] };
  const peer = { messages: [{ role: "user", content: "查询。" },
    { type: "tool_result", name: "PeerLookup", content: "对方真实核验事实。" },
    { type: "final_answer", role: "assistant", content: "对方结论。" }] };
  const finding = { evidence: [{ source: "peer_B", source_input_id: inputId, message_index: 1,
    quote: "对方真实核验事实。" }] } as unknown as Finding;
  const [annotation] = annotateFindings(own, evidenceInputId, [finding], { [inputId]: peer });
  assert.deepEqual(annotation.tools, ["PeerLookup"]);
  assert.deepEqual(annotation.locations, [{ message_index: 1, tool_name: "PeerLookup", source_input_id: inputId }]);
  assert.throws(() => annotateFindings(own, evidenceInputId, [finding]), /来源输入不可定位/);
});
