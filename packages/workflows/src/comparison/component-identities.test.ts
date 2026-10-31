import test from "node:test";
import assert from "node:assert/strict";
import { componentAttributionProfile } from "@eval/agents/attribution";
import { planAttributionUnit } from "../attribution/index.js";
import { adapt } from "../inputs/records.js";

test("planning has no fabricated owner and attribution binds fixed Compact component slots", () => {
  const raw = { batch_id: "batch", case_id: "identity", messages: [
    { type: "user_question", content: "分析黄金。" }, { type: "llm_turn", name: "llm-call-7", output: "制定计划。" },
    { type: "final_answer", content: "黄金分析。" }] };
  const candidate = adapt(raw, { id: "answer", name: "Answer", adapter: "b", sources: [] }, "fixture", 1);
  const tasks = planAttributionUnit(candidate).tasks;
  assert.equal(tasks.filter(task => task.stage === "attribution-compact-field").length, 9);
  assert.deepEqual(tasks.filter(task => task.stage !== "attribution-compact-field").map(task => task.stage), ["attribution-compact", "attribution-trace", "attribution-session"]);
  assert(tasks.every(task => !("component" in (task.data as object))));
  const schema = componentAttributionProfile.submissionSchema as any;
  assert(!schema.properties.problems.items.required.includes("actor_index"));
  assert(!Object.hasOwn(schema.properties.problems.items.properties, "component"));
  assert(schema.required.includes("problems"));
});
