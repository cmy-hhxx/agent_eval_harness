import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { PlannedTask, RunState } from "@eval/contracts";
import { instructionReviewFollowup } from "./instruction-review.js";

test("each accepted attribution schedules exactly one separate instruction session without joining comparison dependencies", () => {
  const inputId = randomUUID();
  const parent: PlannedTask = { id: randomUUID(), stage: "attribution", inputIds: { answer: inputId }, dependencies: {},
    data: { candidates: { A: { input_id: inputId } } } };
  const state = { manifest: { tasks: [parent] } } as RunState;
  const [check] = instructionReviewFollowup(parent, state);
  assert.equal(check.stage, "instruction-review");
  assert.notEqual(check.id, parent.id);
  assert.deepEqual(check.dependencies, { source: parent.id });
  assert.deepEqual(parent.dependencies, {});
  state.manifest.tasks.push(check);
  assert.deepEqual(instructionReviewFollowup(parent, state), []);
  assert.deepEqual(instructionReviewFollowup(check, state), []);
});
