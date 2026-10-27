import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { PlannedTask, RunManifest, RunState } from "@eval/contracts";
import { instructionReviewFollowup } from "./instruction-review.js";
import { comparisonWorkflow } from "./workflow.js";

test("each accepted attribution schedules exactly one separate instruction session without joining comparison dependencies", () => {
  const inputId = randomUUID();
  const parent: PlannedTask = { id: randomUUID(), stage: "attribution-session", inputIds: {}, dependencies: {},
    data: { candidate: { input_id: inputId }, candidates: { A: { input_id: inputId } } } };
  const state = { manifest: { tasks: [parent] } } as RunState;
  const [check] = instructionReviewFollowup(parent, state);
  assert.equal(check.stage, "instruction-review");
  assert.notEqual(check.id, parent.id);
  assert.deepEqual(check.dependencies, { source: parent.id });
  assert.deepEqual(check.inputIds, { case: inputId });
  assert.deepEqual(parent.dependencies, {});
  state.manifest.tasks.push(check);
  assert.deepEqual(instructionReviewFollowup(parent, state), []);
  assert.deepEqual(instructionReviewFollowup(check, state), []);
});

test("the selected primary battles finish before independent reviews and polish start", () => {
  const tasks = [
    { id: "a", stage: "attribution-session", dependencies: {} },
    { id: "c", stage: "comparison", dependencies: { answer: "a" } },
    { id: "i", stage: "instruction-review", dependencies: { source: "a" } },
    { id: "r", stage: "rewrite", dependencies: { source: "a" } },
    { id: "unselected", stage: "attribution-session", dependencies: {} },
  ] as PlannedTask[];
  const manifest = { tasks, executionScope: ["a", "c", "i", "r"], states: Object.fromEntries(tasks.map(task =>
    [task.id, { status: "pending", attempts: 0 }])) } as RunManifest;
  manifest.states.a.status = "succeeded";
  for (const task of tasks.slice(2, 4)) assert.equal(comparisonWorkflow.canStart!(task, manifest), false);
  assert.equal(comparisonWorkflow.canStart!(tasks[1], manifest), true);
  manifest.states.c.status = "succeeded";
  for (const task of tasks.slice(2, 4)) assert.equal(comparisonWorkflow.canStart!(task, manifest), true);
  manifest.states.c.status = "failed";
  assert.equal(comparisonWorkflow.canStart!(tasks[3], manifest), true, "a failed battle does not strand healthy polish");
});
