import test from "node:test";
import assert from "node:assert/strict";
import type { SessionAttributionResult } from "@eval/agents/attribution";
import { comparisonAttribution } from "./comparison-attribution.js";
import { sessionSource } from "../inputs/session.js";
import type { Candidate, RawInput } from "../inputs/types.js";

const result: SessionAttributionResult = {
  session_meta: { session_id: "session-1" },
  turns: [
    { meta: { trace_id: "t1" }, summary: "第一轮错误。", is_correct: 0, correct_reason: "与标准不符。",
      problem: [{ component: "finquery 取数服务", label: "零行", definition: "查询应返回数据但为空。",
        problem_phenomena: "第一问把零行当成有数据。", reason: "工具实际返回零行。",
        severity: "P1", severity_reason: "重要结论缺少数据支持，需要重新取数核对。",
        evidence: [{ position: "message 2 / output/0/text", component: "tool_call: finquery 取数服务",
          quote: "为您找到0条数据", reason: "证明零行。" }] }] },
    { meta: { trace_id: "t2" }, summary: "第二轮正常。", is_correct: null, correct_reason: "无标准。", problem: [] },
  ],
  session_summary: "第一轮的数据错误影响了后续整体判断。",
  session_problem: [],
};

test("Comparison consumes the whole session and maps its accepted problems without reviving boundary ids", () => {
  const projected = comparisonAttribution(result);
  assert.equal(projected.summary, result.session_summary);
  assert.equal(projected.Problem.length, 1);
  assert.equal(projected.Problem[0]!.text, "第一问把零行当成有数据。");
  assert(!JSON.stringify(projected).includes("boundary:"));
  const raw: RawInput = { batch_id: "batch", case_id: "session-1", messages: [],
    turns: [
      { meta: {}, messages: [{ type: "user_question", content: "Q1" }, { type: "final_answer", content: "A1" }] },
      { meta: {}, messages: [{ type: "user_question", content: "Q2" }, { type: "final_answer", content: "A2" }] },
    ] };
  const candidate: Candidate = { batch_id: "batch", case_id: "session-1", version: "a", name: "A", input_id: "id",
    trace_id: "session-1", source: "fixture", line: 1, question: "Q1", final_index: 1,
    answer_timing: { first_token_seconds: null, first_answer_seconds: null, finish_seconds: null,
      source_unit: "ms", source_values: {}, source_fields: {} }, reference: null, llm: null,
    turns: [{ trace_index: 0, trace_id: "t1", question: "Q1", final_index: 1 },
      { trace_index: 1, trace_id: "t2", question: "Q2", final_index: 1 }] };
  const material = sessionSource(raw);
  assert.equal(candidate.turns!.length, 2);
  assert.deepEqual(material.raw.messages.map(message => message.content), ["Q1", "A1", "Q2", "A2"]);
  assert.deepEqual(material.positions, [{trace_index:0,message_index:0},{trace_index:0,message_index:1},{trace_index:1,message_index:0},{trace_index:1,message_index:1}]);
});
