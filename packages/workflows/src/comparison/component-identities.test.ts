import test from "node:test";
import assert from "node:assert/strict";
import { componentAttributionProfile } from "@eval/agents/attribution";
import { bindAttribution, planAttributionUnit, type AttributionTaskData } from "../attribution/index.js";
import { adapt } from "../inputs/records.js";
import type { RawInput } from "../inputs/types.js";

test("workflow binds distinct named planners and an anonymous final actor without changing call navigation or identity evidence", () => {
  const final = "现货黄金3690美元。";
  const raw: RawInput = { batch_id: "batch", case_id: "identities", messages: [
    { type: "user_question", content: "分析黄金。" },
    { type: "llm_turn", name: "planner-search", parent_span: "search-span", input_messages: [], output: [] },
    { type: "llm_turn", name: "planner-finquery", parent_span: "query-span", input_messages: [], output: [] },
    { type: "tool_call", name: "finquery", parent_span: "query-span", call_id: "query-call", input: { query: "GLD" } },
    { type: "tool_result", name: "finquery", call_id: "query-call", output: "GLD369美元。" },
    { type: "llm_turn", name: "llm-call-0", parent_span: "answer-span", input_messages: [{ role: "tool", content: "GLD369美元。" }],
      output: [{ role: "assistant", content: final }] },
    { type: "final_answer", content: final },
  ] };
  const candidate = adapt(raw, { id: "answer", name: "Answer", adapter: "b", sources: [] }, "fixture", 1);
  const tasks = planAttributionUnit(candidate).tasks.filter(task => task.stage === "attribution-component");
  const scopes = tasks.map(task => (task.data as AttributionTaskData).reviewScope!);
  for (const [component, indices] of [["planner-search 检索规划子模型", [1]], ["planner-finquery 取数规划子模型", [2]], ["finquery 取数服务", [3, 4]]] as const)
    assert(scopes.some(scope => scope.component === component && JSON.stringify(scope.message_indices) === JSON.stringify(indices)));
  const tool = tasks.find(task => (task.data as AttributionTaskData).reviewScope!.message_indices.includes(3))!;
  const bound = bindAttribution(tool, { [candidate.input_id]: raw }, {});
  const answer = bound.modelInput!.answer as { component_scene: { entries: { message_index: number }[] } };
  assert(answer.component_scene.entries.some(entry => entry.message_index === 3));
  assert(answer.component_scene.entries.some(entry => entry.message_index === 4));
  const schema = componentAttributionProfile.submissionSchema as any;
  assert(!Object.hasOwn(schema.properties.problems.items.properties, "component"));
  assert(!Object.hasOwn(answer, "execution_overview"));
  assert(!Object.hasOwn(answer, "component_catalog"));
  const finalScope = scopes.find(scope => scope.message_indices.includes(6))!;
  assert.equal(finalScope.component, "终稿生成轮");
});
