import test from "node:test";
import assert from "node:assert/strict";
import type { PlannedTask, RunManifest } from "@eval/contracts";
import { attributionScheduling } from "@eval/workflows/attribution";
import { createScopeMembership, dependencyReady, scheduleTasks, sessionAdmissionSnapshot } from "./scheduling.js";

test("settled dependencies release aggregation after failure but never consume pending work or a pause", () => {
  const task: PlannedTask = { id: "aggregate", stage: "aggregate", inputIds: {}, data: {},
    dependencies: { component: "component", criteria: "criteria" }, settledDependencies: ["component"] };
  const states: RunManifest["states"] = { criteria: { status: "succeeded", attempts: 1 },
    component: { status: "failed", attempts: 1 }, aggregate: { status: "pending", attempts: 0 } };
  for (const status of ["failed", "timed_out", "succeeded"] as const) {
    states.component.status = status;
    assert(dependencyReady(task, "component", states));
    assert.equal(scheduleTasks([task], states)[0], task);
  }
  for (const status of ["pending", "running", "cancelled", "blocked"] as const) {
    states.component.status = status;
    assert(!dependencyReady(task, "component", states));
  }
  states.criteria.status = "failed";
  assert(!dependencyReady(task, "criteria", states), "ordinary required inputs remain strict");
  states.component.status = "failed";
  assert(!dependencyReady(task, "component", states, new Set(["component"])), "a failed attempt may still be arranging its bounded retry");
  states.component.status = "succeeded";
  assert(dependencyReady(task, "component", states, new Set(["component"])), "accepted results do not wait for slow worker cleanup");
});

function attributionSessionTasks(session: string): PlannedTask[] {
  const fields = ["plan", "key_data"].map(field => ({ id: session + "-field-" + field,
    stage: "attribution-compact-field", inputIds: {}, dependencies: {},
    data: { candidate: { input_id: session }, compactField: field } }));
  const compact = { id: session + "-compact", stage: "attribution-compact", inputIds: {},
    dependencies: Object.fromEntries(fields.map(task => [(task.data as {compactField: string}).compactField, task.id])),
    data: { candidate: { input_id: session } } };
  const trace = { id: session + "-trace", stage: "attribution-trace", inputIds: {},
    dependencies: { compact: compact.id }, data: { candidate: { input_id: session } } };
  const summary = { id: session + "-session", stage: "attribution-session", inputIds: {},
    dependencies: { compact: compact.id, trace: trace.id }, data: { candidate: { input_id: session } } };
  return [...fields, compact, trace, summary] as PlannedTask[];
}

test("a ready attribution does not wait behind other sessions' compact fields", () => {
  const tasks = [...attributionSessionTasks("ready"), ...attributionSessionTasks("new")];
  const states: RunManifest["states"] = Object.fromEntries(tasks.map(task => [task.id, { status: "pending", attempts: 0 }]));
  states["ready-field-plan"]!.status = states["ready-field-key_data"]!.status = states["ready-compact"]!.status = "succeeded";
  const ordered = scheduleTasks(tasks, states, attributionScheduling.stagePriority);
  assert.equal(ordered[0]!.id, "ready-trace");
  states["ready-trace"]!.status = "succeeded";
  assert.equal(scheduleTasks(tasks, states, attributionScheduling.stagePriority)[0]!.id, "ready-session");
});

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

test("a finite session window advances only when a foreground session completes or fails", () => {
  const tasks = Array.from({ length: 10 }, (_, index) => attributionSessionTasks(`session-${index + 1}`)).flat();
  const states: RunManifest["states"] = Object.fromEntries(tasks.map(task => [task.id, { status: "pending", attempts: 0 }]));
  const policy = attributionScheduling.sessionAdmission!;
  const manifest = { config: { execution: { sessionWindow: 8 } } };
  let snapshot = sessionAdmissionSnapshot(tasks, states, policy, manifest);
  assert.deepEqual({ total: snapshot.total_sessions, active: snapshot.active_sessions, completed: snapshot.completed_sessions,
    waiting: snapshot.waiting_sessions, failed: snapshot.failed_sessions, blocked: snapshot.blocked_sessions },
  { total: 10, active: 8, completed: 0, waiting: 2, failed: 0, blocked: 0 });
  assert.equal(snapshot.admitted.has("session-9"), false);

  states["session-1-session"]!.status = "succeeded";
  snapshot = sessionAdmissionSnapshot(tasks, states, policy, manifest);
  assert.equal(snapshot.completed_sessions, 1);
  assert.equal(snapshot.active_sessions, 8);
  assert.equal(snapshot.waiting_sessions, 1);
  assert.equal(snapshot.admitted.has("session-9"), true);

  states["session-2-field-plan"]!.status = "failed";
  snapshot = sessionAdmissionSnapshot(tasks, states, policy, manifest);
  assert.equal(snapshot.failed_sessions, 1);
  assert.equal(snapshot.active_sessions, 8);
  assert.equal(snapshot.waiting_sessions, 0);
  assert.equal(snapshot.admitted.has("session-2"), true, "failed sessions drain without holding an open window slot");
  assert.equal(snapshot.admitted.has("session-10"), true);
});

test("session admission and foreground selection resume from durable task states", () => {
  const tasks = Array.from({ length: 5 }, (_, index) => attributionSessionTasks(`session-${index + 1}`)).flat();
  const states: RunManifest["states"] = Object.fromEntries(tasks.map(task => [task.id, { status: "pending", attempts: 0 }]));
  states["session-1-field-plan"] = { status: "succeeded", attempts: 1 };
  states["session-2-field-plan"] = { status: "running", attempts: 1 };
  const policy = { ...attributionScheduling.sessionAdmission!, window: 2 };
  const snapshot = sessionAdmissionSnapshot(tasks, states, policy);
  assert.deepEqual([...snapshot.admitted].sort(), ["session-1", "session-2"]);
  assert.equal(snapshot.active_sessions, 2);
  assert.equal(snapshot.waiting_sessions, 3);

  states["session-1-session"] = { status: "succeeded", attempts: 1 };
  states["session-2-field-key_data"] = { status: "blocked", attempts: 1 };
  const resumed = sessionAdmissionSnapshot(tasks, states, policy);
  assert.equal(resumed.completed_sessions, 1);
  assert.equal(resumed.blocked_sessions, 1);
  assert.equal(resumed.active_sessions, 2);
  assert.equal(resumed.waiting_sessions, 1);
  assert.deepEqual([...resumed.admitted].sort(), ["session-1", "session-2", "session-3", "session-4"]);
});

test("resume bounds a partially started backlog back to the foreground window", () => {
  const tasks = Array.from({ length: 10 }, (_, index) => attributionSessionTasks(`session-${index + 1}`)).flat();
  const states: RunManifest["states"] = Object.fromEntries(tasks.map(task => [task.id, { status: "pending", attempts: 0 }]));
  for (let index = 1; index <= 10; index++) states[`session-${index}-field-plan`] = { status: "succeeded", attempts: 1 };
  const snapshot = sessionAdmissionSnapshot(tasks, states, { ...attributionScheduling.sessionAdmission!, window: 3 });
  assert.equal(snapshot.active_sessions, 3);
  assert.equal(snapshot.waiting_sessions, 7);
  assert.deepEqual([...snapshot.admitted].sort(), ["session-1", "session-2", "session-3"]);
});

test("session window rejects non-positive or fractional execution configuration", () => {
  const tasks = attributionSessionTasks("session-1");
  const states: RunManifest["states"] = Object.fromEntries(tasks.map(task => [task.id, { status: "pending", attempts: 0 }]));
  for (const sessionWindow of [0, -1, 1.5]) assert.throws(() =>
    sessionAdmissionSnapshot(tasks, states, attributionScheduling.sessionAdmission!, { config: { execution: { sessionWindow } } }),
  /positive integer/u);
});

test("computed compact assembly releases ready attribution before new field work", () => {
  const tasks = [...attributionSessionTasks("session-1"), ...attributionSessionTasks("session-2")];
  const states: RunManifest["states"] = Object.fromEntries(tasks.map(task => [task.id, { status: "pending", attempts: 0 }]));
  states["session-1-field-plan"]!.status = "succeeded";
  states["session-1-field-key_data"]!.status = "succeeded";
  assert.equal(scheduleTasks(tasks, states, attributionScheduling.stagePriority)[0]!.id, "session-1-compact");
  states["session-1-compact"]!.status = "succeeded";
  assert.equal(scheduleTasks(tasks, states, attributionScheduling.stagePriority)[0]!.id, "session-1-trace");
  for (const id of ["session-2-field-plan", "session-2-field-key_data", "session-2-compact", "session-1-trace"]) states[id]!.status = "succeeded";
  assert.equal(scheduleTasks(tasks, states, attributionScheduling.stagePriority)[0]!.id, "session-1-session");
});
