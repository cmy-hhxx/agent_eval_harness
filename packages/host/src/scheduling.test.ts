import test from "node:test";
import assert from "node:assert/strict";
import type { PlannedTask, RunManifest } from "@eval/contracts";
import { createScopeMembership, scheduleTasks } from "./scheduling.js";

test("large execution scopes are indexed once and track follow-ups and rollback", () => {
  let reads = 0;
  const original = Array.from({ length: 20000 }, (_, index) => `task-${index}`);
  const scope = new Proxy(original, { get(target, key, receiver) {
    if (typeof key === "string" && /^\d+$/.test(key)) reads++;
    return Reflect.get(target, key, receiver);
  } });
  const manifest: Pick<RunManifest, "executionScope"> = { executionScope: scope };
  const includes = createScopeMembership(manifest);
  for (const id of original) assert(includes(id));
  assert(!includes("retired"));
  assert.equal(reads, original.length, "dispatch must not rescan the full scope for every task");
  scope.push("follow-up");
  assert(includes("follow-up"));
  manifest.executionScope = ["replacement"];
  assert(includes("replacement"));
  assert(!includes("task-0"));
  manifest.executionScope = ["rollback"];
  assert(!includes("replacement"));
  assert(includes("rollback"));
  delete manifest.executionScope;
  assert(includes("unrestricted"));
});

test("ready downstream stages share slots with an unfinished attribution backlog", () => {
  const tasks = [
    { id: "a0", stage: "attribution", dependencies: {} },
    ...Array.from({ length: 6 }, (_, i) => ({ id: `a${i + 1}`, stage: "attribution", dependencies: {} })),
    { id: "c0", stage: "comparison", dependencies: { answer: "a0" } },
    { id: "c1", stage: "comparison", dependencies: { answer: "a0" } },
    { id: "c2", stage: "comparison", dependencies: { answer: "a0" } },
    { id: "r0", stage: "rewrite", dependencies: { verdict: "c0" } },
    { id: "r1", stage: "rewrite", dependencies: { verdict: "c0" } },
    { id: "blocked", stage: "rewrite", dependencies: { verdict: "c2" } },
  ] as PlannedTask[];
  const states: RunManifest["states"] = Object.fromEntries(tasks.map((task) => [task.id, { status: "pending", attempts: 0 }]));
  states.a0!.status = states.c0!.status = "succeeded";
  states.a1!.status = "running";
  const ordered = scheduleTasks(tasks, states);
  assert.deepEqual(ordered.slice(0, 5).map((task) => task.id), ["c1", "c2", "a2", "a3", "a4"]);
  assert.equal(ordered.length, tasks.length);
  assert.equal(new Set(ordered).size, tasks.length);
  assert.deepEqual(tasks.slice(0, 2).map((task) => task.id), ["a0", "a1"]);
  assert.equal(states.r0!.status, "pending", "ordering never activates or retries work");
  states.c2!.status = "failed";
  assert(!scheduleTasks(tasks, states).slice(0, 4).some((task) => task.id === "blocked"));
});

test("ready continuations within a stage finish existing work before opening new independent tasks", () => {
  const tasks = [
    { id: "new-1", stage: "score", dependencies: {} },
    { id: "new-2", stage: "score", dependencies: {} },
    { id: "evidence", stage: "score", dependencies: {} },
    { id: "axes", stage: "score", dependencies: { evidence: "evidence" } },
    { id: "final", stage: "score", dependencies: { axes: "axes" } },
    { id: "next-axes", stage: "score", dependencies: { evidence: "evidence" } },
  ] as PlannedTask[];
  const states: RunManifest["states"] = Object.fromEntries(tasks.map(task => [task.id, { status: "pending", attempts: 0 }]));
  states.evidence.status = states.axes.status = "succeeded";
  assert.deepEqual(scheduleTasks(tasks, states).slice(0, 4).map(task => task.id), ["final", "next-axes", "new-1", "new-2"]);
});
