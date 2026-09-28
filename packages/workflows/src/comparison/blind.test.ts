import test from "node:test";
import assert from "node:assert/strict";
import { blindMaterials } from "./blind.js";
import type { AttributionResult, Candidate, RawInput } from "./types.js";

const identities = { A: { version: "a_fast", name: "A组Fast", llm: "secret-model" } } as unknown as Record<string, Candidate>;

test("comparison removes source identity from prompt text, trace, and attribution without changing receipts", () => {
  const trace: RawInput = {
    version: "a_fast",
    meta: { usage: { type: "secret-model" } },
    messages: [
      { type: "message", role: "user", content: "评估计算结果" },
      { type: "message", role: "assistant", model: "secret-model", content: "A组Fast 给出 4" },
      { type: "function_call_output", name: "Search", content: { model_id: "a_fast", value: "A组Fast" } },
    ],
  };
  const finding = {
    finding_id: "f1", type: "problem", dimension: "correctness", stage: "execution", importance: "medium",
    text: "A组Fast 的 Search 可能异常", reason: "secret-model 尚待核实", evidence: [{ message_index: 2, quote: "A组Fast" }],
    assessment: { requirement_index: null, observation: "疑似异常", evidence_status: "uncertain", impact: "若属实会影响结果" },
    problem: { component: ["Search"], label: "调用结果异常", definition: "结果不完整" },
  } as AttributionResult["findings"][number];
  const attribution: AttributionResult = {
    has_standard_answer: false, is_correct: null, correctness_reason: "", correctness_evidence: [], numeric_checks: [],
    task_analysis: { task_type: "计算", goal: "得到结果", requirements: ["给出结果"], scoring_points: [], red_flags: [] },
    summary: "A组Fast 给出可用答案", findings: [finding],
  };
  const blind = blindMaterials(identities);
  const view = blind.trace(trace);
  const result = blind.attribution(attribution);
  assert.deepEqual(Object.keys(view), ["messages"]);
  for (const name of ["a_fast", "A组Fast", "secret-model"]) {
    assert(!JSON.stringify(view).includes(name));
    assert(!JSON.stringify(result).includes(name));
  }
  assert.equal(view.messages[2]!.name, "Search");
  assert.match(String((view.messages[2]!.content as { model_id: string }).model_id), /^\[身份已隐去\d+\]$/);
  assert.equal(result.findings[0]!.evidence[0]!.quote, (view.messages[2]!.content as { value: string }).value);
  assert.equal(result.findings[0]!.assessment.evidence_status, "uncertain");
  assert.equal(attribution.summary, "A组Fast 给出可用答案");
  assert.equal(trace.messages[1]!.content, "A组Fast 给出 4");
});

test("blinding masks structured keys without collapsing fields and preserves image bytes", () => {
  const blind = blindMaterials({
    A: { version: "aaaaaa", name: "ModelOne", llm: null },
    B: { version: "bbbbbb", name: "ModelTwo", llm: null },
  } as unknown as Record<string, Candidate>);
  const image = "data:image/png;base64,aaaaaaBBBB";
  const original: RawInput = { messages: [{
    type: "message", role: "assistant", content: { aaaaaa: "one", bbbbbb: "two", image },
  }] };
  const view = blind.trace(original);
  const content = view.messages[0]!.content as Record<string, string>;
  assert.equal(Object.keys(content).length, 3);
  assert.equal(content.image, image);
  const { image: _image, ...text } = content;
  assert(!JSON.stringify(text).includes("aaaaaa"));
  assert(!JSON.stringify(text).includes("bbbbbb"));
  assert.deepEqual(Object.keys(original.messages[0]!.content as object), ["aaaaaa", "bbbbbb", "image"]);
});

test("standalone short version IDs are masked without changing longer business tokens", () => {
  const blind = blindMaterials({ A: { version: "v1", name: "ExampleModel", llm: null } } as unknown as Record<string, Candidate>);
  const text = blind.value("v1 的输出；保留 v10、v1stock、版本v1");
  assert.match(text, /^\[身份已隐去\d+\] 的输出；保留 v10、v1stock、版本v1$/);
});
