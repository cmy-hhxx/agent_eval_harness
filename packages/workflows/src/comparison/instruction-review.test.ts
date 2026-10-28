import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { emptyUsage, type PlannedTask, type RunManifest, type RunState } from "@eval/contracts";
import { attributionDimensions, dimensionAttributionFollowup } from "../review/dimensions.js";
import { comparisonCodec } from "./codec.js";
import { encodeResult } from "./results.js";
import { bindTask } from "./binding.js";
import { emptyAudit } from "../../../../tests/fixtures/comparison.js";
import type { Candidate } from "../inputs/types.js";
import { comparisonWorkflow } from "./workflow.js";

test("each accepted attribution schedules exactly one separate instruction session without joining comparison dependencies", () => {
  const inputId = randomUUID();
  const parent: PlannedTask = { id: randomUUID(), stage: "attribution-session", inputIds: {}, dependencies: {},
    data: { candidate: { input_id: inputId }, candidates: { A: { input_id: inputId } } } };
  const state = { manifest: { tasks: [parent] } } as RunState;
  const [check] = dimensionAttributionFollowup(parent, state);
  assert.equal(check.stage, "instruction-review");
  assert.notEqual(check.id, parent.id);
  assert.deepEqual(check.dependencies, { source: parent.id });
  assert.deepEqual(check.inputIds, { case: inputId });
  assert.deepEqual(parent.dependencies, {});
  state.manifest.tasks.push(check);
  assert.deepEqual(dimensionAttributionFollowup(parent, state), []);
  assert.deepEqual(dimensionAttributionFollowup(check, state), []);
});

test("dimensions share only the source identity and neither consume nor depend on sibling judgments", () => {
  const parent: PlannedTask = { id: randomUUID(), stage: "attribution-session", inputIds: {}, dependencies: {},
    data: { candidate: { input_id: randomUUID() } } };
  const state = { manifest: { tasks: [parent], states: {} }, receipts: { [parent.id]: { evaluation: { secret: "primary verdict" } } } } as unknown as RunState;
  // A second definition exercises extension plumbing; it is not a KYC evaluation implementation.
  const dimensions = { ...attributionDimensions,
    "kyc-attribution": { ...attributionDimensions["instruction-review"], label: "用户 KYC 归因", resultKey: "kyc_attribution" } };
  const planned = dimensionAttributionFollowup(parent, state, dimensions);
  assert.deepEqual(planned.map(task => task.stage), ["instruction-review", "kyc-attribution"]);
  for (const task of planned) {
    assert.deepEqual(task.dependencies, { source: parent.id });
    assert.equal(JSON.stringify(task).includes("primary verdict"), false);
  }
  state.manifest.tasks.push(planned[0]);
  state.manifest.states[planned[0].id] = { status: "failed", attempts: 1 };
  assert.deepEqual(dimensionAttributionFollowup(parent, state, dimensions).map(task => task.stage), ["kyc-attribution"]);
  state.manifest.tasks.push(planned[1]);
  assert.deepEqual(dimensionAttributionFollowup(parent, state, dimensions), []);
});

test("dimension export and repeated recovery preserve its own result and original material binding", () => {
  const candidate = { input_id: randomUUID(), batch_id: "batch", case_id: "case", version: "model",
    trace_id: "trace", source: "/source.jsonl", line: 1, question: "计算2+2", final_index: 1 } as Candidate;
  const parent: PlannedTask = { id: randomUUID(), stage: "attribution-session", inputIds: {}, dependencies: {}, data: { candidate } };
  const state = { manifest: { format: "evaluation-run", runId: "dimensions", evaluatorVersion: "fixture",
    config: { inputs: {} }, preflight: { by_batch: {} }, inputCatalog: [candidate], tasks: [parent], states: {} },
    receipts: {}, usage: emptyUsage(), recordedAttempts: 1 } as unknown as RunState;
  const [task] = dimensionAttributionFollowup(parent, state);
  state.manifest.tasks.push(task);
  state.manifest.states[parent.id] = { status: "succeeded", attempts: 1 };
  state.manifest.states[task.id] = { status: "succeeded", attempts: 1 };
  const evaluation = { summary: "未采集内部规范。", checks: [], evidence: [] };
  state.receipts[task.id] = { taskId: task.id, submissionId: randomUUID(), attemptId: randomUUID(), status: "succeeded",
    acceptedAt: 1, evaluatorVersion: "fixture", judge: "fixture", evaluation, audit: emptyAudit(), usage: emptyUsage() };
  const exported = encodeResult(task, state, {})!;
  assert.equal(exported.file, "instruction_review.jsonl");
  assert.deepEqual(exported.row.instruction_review, evaluation);
  state.receipts[task.id].exported = exported;
  let restored = state;
  for (let round = 0; round < 2; round++) {
    restored = comparisonCodec.decode(comparisonCodec.encode(restored), reference => {
      assert.equal(reference.id, task.id);
      assert.equal(reference.file, exported.file);
      return exported.row;
    });
    assert.deepEqual(restored.receipts[task.id].evaluation, evaluation);
    assert.deepEqual(dimensionAttributionFollowup(restored.manifest.tasks[0], restored), []);
  }
  const binding = bindTask(restored.manifest.tasks[1], { [candidate.input_id]: { messages: [
    { role: "user", content: candidate.question }, { role: "assistant", content: "4" },
  ] } }, {}, { tasks: restored.manifest.tasks });
  assert.equal(binding.agent, "instruction-review");
  assert.equal(binding.request.input.candidate_response, "4");
  assert.equal(JSON.stringify(binding.request).includes(evaluation.summary), false);
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
