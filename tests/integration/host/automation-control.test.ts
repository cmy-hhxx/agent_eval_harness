import test from "node:test";
import assert from "node:assert/strict";
import { createAutomationControl } from "../../../apps/host/src/automation-control.js";

test("sources remain idle until clicked; stop drains before rerun and restart never resumes", async () => {
  const calls: string[] = [], signals: AbortSignal[] = [], finish: (() => void)[] = [];
  const execute = async (id: string, signal: AbortSignal) => {
    calls.push(id); signals.push(signal);
    await new Promise<void>(resolve => finish.push(resolve));
  };
  const control = createAutomationControl(["a", "b"], execute);
  await new Promise(setImmediate);
  assert.deepEqual(calls, []);
  assert.equal(control.snapshot("a").status, "idle");
  assert.equal(control.run("a").status, "running");
  assert.throws(() => control.run("a"), /正在运行/);
  await new Promise(setImmediate);
  assert.deepEqual(calls, ["a"]);
  assert.equal(control.snapshot("b").status, "idle");
  assert.equal(control.stop("a").status, "stopping");
  assert(signals[0].aborted);
  assert.throws(() => control.run("a"), /正在运行或停止中/);
  finish[0](); await new Promise(setImmediate);
  assert.equal(control.snapshot("a").status, "idle");
  control.run("b"); await new Promise(setImmediate);
  const closing = control.close();
  assert(signals[1].aborted);
  assert.throws(() => control.run("a"), /正在停止/);
  finish[1](); await closing;
  const restarted = createAutomationControl(["a", "b"], execute);
  await new Promise(setImmediate);
  assert.equal(restarted.snapshot("b").status, "idle");
  assert.deepEqual(calls, ["a", "b"]);
  await restarted.close();
});

test("failure stays visible without automatic retry or stopping another source", async () => {
  let calls = 0;
  const control = createAutomationControl(["a", "b"], async () => { calls++; throw new Error("source unavailable"); });
  control.run("a"); await new Promise(setImmediate);
  assert.deepEqual(control.snapshot("a"), { status: "failed", error: "source unavailable" });
  assert.equal(control.snapshot("b").status, "idle");
  await new Promise(setImmediate);
  assert.equal(calls, 1);
  control.run("a"); await new Promise(setImmediate);
  assert.equal(calls, 2);
  assert.throws(() => control.run("unknown"), /Unknown automation source/);
  await control.close();
});
