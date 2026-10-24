import test from "node:test";
import assert from "node:assert/strict";
import { attributionProfile } from "@eval/agents/attribution";
import { bindAttributionMaterial } from "./binding.js";
import { validateOriginalAttributionEvidence } from "./public-trace.js";
import type { Candidate, RawInput } from "./types.js";
import type { TraceComponentIdentity } from "@eval/tools";
import { emptyAudit } from "../../../../tests/fixtures/comparison.js";

test("workflow binds distinct named planners and an anonymous final actor without changing call navigation or identity evidence", () => {
  const id = "11111111-1111-4111-8111-111111111111", final = "现货黄金3690美元。";
  const raw: RawInput = { messages: [
    { type: "user_question", content: "分析黄金。" },
    { type: "llm_turn", name: "planner-search", parent_span: "search-span", input_messages: [], output: [] },
    { type: "llm_turn", name: "planner-finquery", parent_span: "query-span", input_messages: [], output: [] },
    { type: "tool_call", name: "finquery", parent_span: "query-span", call_id: "query-call", input: { query: "GLD" } },
    { type: "tool_result", name: "finquery", call_id: "query-call", output: "GLD369美元。" },
    { type: "llm_turn", name: "llm-call-0", parent_span: "answer-span", input_messages: [{ role: "tool", content: "GLD369美元。" }],
      output: [{ role: "assistant", content: final }] },
    { type: "final_answer", content: final },
  ] };
  const candidate = { input_id: id, question: "分析黄金。", final_index: 6, reference: null, answer_timing: { finish_seconds: null } } as Candidate;
  const bound = bindAttributionMaterial(candidate, raw), answer = bound.request.input.answer as {
    component_catalog: TraceComponentIdentity[]; catalog: { message_index: number; name?: string; invoking_model_message_index?: number }[];
  };
  assert.deepEqual(answer.component_catalog.map(actor => [actor.component, actor.message_indices]), [
    ["planner-search", [1]], ["planner-finquery", [2]], ["finquery", [3, 4]], ["最终作答节点（原始名称未提供）", [5, 6]],
  ]);
  const schema = attributionProfile.modelSubmissionSchema!(bound.request) as any;
  const choices = schema.properties.problems.items.properties.component.items.properties.component.enum;
  assert.deepEqual(choices, answer.component_catalog.map(actor => actor.component));
  assert(!choices.includes("llm-call-0"));
  assert(!choices.includes("回答模型"));
  assert.equal(answer.catalog[5].name, "llm-call-0");
  assert.equal(answer.catalog[3].invoking_model_message_index, 2);
  validateOriginalAttributionEvidence(answer.component_catalog, { [id]: raw }, emptyAudit());
});
