import test from "node:test";
import assert from "node:assert/strict";
import { traceAttributionProfile } from "@eval/agents/attribution";
import { planAttributionUnit } from "../attribution/index.js";
import { adapt } from "../inputs/records.js";

test("planning has no fixed component owner and submissions select precise taxonomy IDs", () => {
  const raw = { batch_id: "batch", case_id: "identity", messages: [
    { type: "user_question", content: "分析黄金。" }, { type: "llm_turn", name: "llm-call-7", output: "制定计划。" },
    { type: "final_answer", content: "黄金分析。" }] };
  const candidate = adapt(raw, { id: "answer", name: "Answer", adapter: "b", sources: [] }, "fixture", 1);
  const tasks = planAttributionUnit(candidate).tasks;
  assert.equal(tasks.filter(task => task.stage === "attribution-compact-field").length, 11);
  assert.deepEqual(tasks.filter(task => task.stage !== "attribution-compact-field").map(task => task.stage), ["attribution-compact", "attribution-session"]);
  assert(tasks.every(task => !("component" in (task.data as object))));
  const schema = traceAttributionProfile.submissionSchema as any;
  assert(schema.properties.problems.items.required.includes("component"));
  assert(schema.properties.problems.items.properties.component.enum.includes("result-interpretation"));
  assert(!schema.properties.problems.items.properties.component.enum.includes("中间推理处理"));
});
