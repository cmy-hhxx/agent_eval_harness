import test from "node:test";
import assert from "node:assert/strict";
import { runBatch, type TaskLimit } from "./batch.js";

test("a terminal partial run directly hands its priority allocation to the remaining runs", async () => {
  let handoff!: () => void;
  const handed = new Promise<void>(resolve => { handoff = resolve; });
  let peersReady!: () => void, finish!: () => void, count = 0;
  const ready = new Promise<void>(resolve => { peersReady = resolve; });
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const allocations: Record<string, number[]> = {};
  const result = await runBatch([
    { id: "recovery", priority: 0, async run(control, slots) {
      const tasks = slots({ running: 0, ready: 1000 });
      allocations.recovery = [control.concurrency(), tasks];
      return { status: "finished", input_rejected: 1 };
    } },
    ...["daily-a", "daily-b"].map(id => ({ id, priority: 1, async run(control: import("./model-requests.js").ModelRequestControl, slots: TaskLimit) {
      await handed;
      slots({ running: 0, ready: 1000 });
      if (++count === 2) peersReady();
      await ready;
      const tasks = slots({ running: 0, ready: 1000 });
      allocations[id] = [control.concurrency(), tasks];
      if (--count === 0) finish();
      await finished;
      return { status: "finished" };
    } })),
  ], { first: 150, second: 150 }, 350, new AbortController().signal,
  event => { if (event.completed_run_id === "recovery") handoff(); });
  assert.deepEqual(allocations.recovery, [300, 350]);
  assert.deepEqual(allocations["daily-a"], [150, 175]);
  assert.deepEqual(allocations["daily-b"], [150, 175]);
  assert.equal(result.recovery.input_rejected, 1);
});

test("a run-level failure is explicit and does not stop independent runs", async () => {
  const events: Record<string, unknown>[] = [];
  const result = await runBatch([
    { id: "bad", priority: 0, async run() { throw new Error("storage unavailable"); } },
    { id: "good", priority: 0, async run() { return { status: "finished" }; } },
  ], { gateway: 2 }, 2, new AbortController().signal, event => events.push(event));
  assert.equal(result.bad.error, "storage unavailable");
  assert.equal(result.good.status, "finished");
  assert(events.some(event => event.event === "batch_run_failed" && event.run_id === "bad"));
});

test("paused runs and small tails return unused task capacity to healthy peers", async () => {
  let measured!: () => void, ready!: () => void;
  const measurement = new Promise<void>(resolve => { measured = resolve; });
  const prepared = new Promise<void>(resolve => { ready = resolve; });
  let healthy = 0;
  await runBatch([
    { id: "paused", priority: 0, async run(_control, slots) {
      slots({ running: 0, ready: 0 });
      await measurement; return { status: "finished" };
    } },
    { id: "tail", priority: 1, async run(_control, slots) {
      slots({ running: 1, ready: 0 });
      ready(); await measurement; return { status: "finished" };
    } },
    { id: "healthy", priority: 1, async run(_control, slots) {
      await prepared;
      healthy = slots({ running: 0, ready: 1000 });
      measured(); return { status: "finished" };
    } },
  ], { gateway: 300 }, 350, new AbortController().signal, () => {});
  assert.equal(healthy, 349);
});
