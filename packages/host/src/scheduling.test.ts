import test from "node:test";
import assert from "node:assert/strict";
import type { PlannedTask, RunManifest } from "@eval/contracts";
import { scheduleTasks } from "./scheduling.js";

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
  assert.deepEqual(ordered.slice(0, 5).map((task) => task.id), ["r0", "c1", "r1", "c2", "a2"]);
  assert.equal(ordered.length, tasks.length);
  assert.equal(new Set(ordered).size, tasks.length);
  assert.deepEqual(tasks.slice(0, 2).map((task) => task.id), ["a0", "a1"]);
  assert.equal(states.r0!.status, "pending", "ordering never activates or retries work");
  states.c2!.status = "failed";
  assert(!scheduleTasks(tasks, states).slice(0, 4).some((task) => task.id === "blocked"));
});
