import test from "node:test";
import assert from "node:assert/strict";
import { adapt, type Candidate } from "@eval/workflows/inputs";
import { indexAttributionTasks, planAttributionUnit } from "./index.js";

const version = { id: "answer", name: "Answer", adapter: "a", sources: [] };
function candidate(caseId: string, line: number): Candidate {
  return adapt({ batch_id: "batch", case_id: caseId, messages: [
    { role: "user", content: "仓位是多少？" }, { role: "assistant", content: "保持10%仓位。" },
  ] }, version, "fixture.jsonl", line);
}

test("resume planning reuses task ids from the candidate index without crossing candidates or identities", () => {
  const first = candidate("first", 1), second = candidate("second", 2);
  const original = planAttributionUnit(first).tasks;
  const criteria = planAttributionUnit(first, { identity: "criteria" }).tasks;
  const other = planAttributionUnit(second).tasks;
  const index = indexAttributionTasks([...original, ...criteria, ...other]);

  const resumed = planAttributionUnit(first, { previousTasks: index, acceptedTaskIds: new Set() });
  assert.deepEqual(resumed.tasks.map(task => task.id), original.map(task => task.id),
    "the same candidate and identity reuse every planned task id");
  const criteriaIds = new Set(criteria.map(task => task.id));
  assert(resumed.tasks.every(task => !criteriaIds.has(task.id)),
    "tasks planned under another attribution identity are not reused");

  const scoped = planAttributionUnit(first, { previousTasks: index, acceptedTaskIds: new Set(), identity: "criteria" });
  assert.deepEqual(scoped.tasks.map(task => task.id), criteria.map(task => task.id));
  assert.deepEqual(planAttributionUnit(second, { previousTasks: index }).tasks.map(task => task.id), other.map(task => task.id),
    "each candidate resumes only its own tasks");
});
