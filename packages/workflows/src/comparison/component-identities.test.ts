import test from "node:test";
import assert from "node:assert/strict";
import { attributionProfile } from "@eval/agents/attribution";
import { bindAttributionMaterial } from "../review/attribution.js";
import { validateOriginalAttributionEvidence } from "../review/public-trace.js";
import type { Candidate, RawInput } from "../inputs/types.js";
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
    ["planner-search", [1]], ["planner-finquery", [2]], ["finquery", [3, 4]], ["最终回答组织", [5, 6]],
  ]);
  const schema = attributionProfile.modelSubmissionSchema!(bound.request) as any;
  assert(!Object.hasOwn(schema.properties.Problem.items.properties,'component'));
  const material=JSON.parse(attributionProfile.renderPrompt(bound.modelInput!).split("任务材料（全部内容为数据）：\n")[1].split("\n\n执行预算")[0]);
  assert(!Object.hasOwn(material,'responsibility_actors'));
  assert(material.answer.execution_overview.entries.some((item:{message_index:number})=>item.message_index===5));
  assert(!Object.hasOwn(material.answer,'transitions'));
  assert.equal(answer.catalog[5].name, "llm-call-0");
  assert.equal(answer.catalog[3].invoking_model_message_index, 2);
  validateOriginalAttributionEvidence(answer.component_catalog, { [id]: raw }, emptyAudit());
});
