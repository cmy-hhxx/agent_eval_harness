import test from "node:test";
import assert from "node:assert/strict";
import { listen, json } from "@eval/runtime/http";
import { WorkerSupervisor } from "./worker-supervisor.js";
import { waitForTestState } from "../../../tests/fixtures/wait.js";
import { WorkerStartupError, type WorkerProcess, type WorkerExit } from "@eval/runtime/client";

const identity = { engine: "pi" as const, version: "test", commit: "test", buildId: "test" };

test("a pending or failed expansion leaves ready Worker capacity usable", async () => {
  const http = await listen(async (_req, res) => json(res, { identity, tools: [], activeAttempt: null }));
  let rejectExpansion!: (error: Error) => void, starts = 0;
  const supervisor = new WorkerSupervisor({ identity, runtime: { root: "unused", workerEntry: "unused" },
    directory: "unused", retries: 0, retryDelaySeconds: 0, wake() {}, event() {},
    spawn: async () => {
      if (++starts > 1) return new Promise<WorkerProcess>((_, reject) => { rejectExpansion = reject; });
      return { pid: 1, url: http.url, urls: [http.url], exited: new Promise(() => {}), async close() {} };
    } });
  try {
    supervisor.setTarget(1);
    await waitForTestState(async () => supervisor.slots.length, count => count === 1, "first capacity becomes ready");
    supervisor.setTarget(2);
    assert.equal(supervisor.slots.length, 1, "startup does not block or reserve the already ready slot");
    rejectExpansion(new Error("expansion timeout"));
    await waitForTestState(async () => supervisor.snapshot(), state => state.quarantined_slots === 1, "only failed capacity is quarantined");
    assert.equal(supervisor.exhausted(), false);
    assert.equal(supervisor.slots[0].url, http.url);
    assert.equal(starts, 2);
  } finally { await supervisor.close(); await http.close(); }
});

test("startup retry exhaustion belongs to capacity and has a finite launch count", async () => {
  let starts = 0;
  const supervisor = new WorkerSupervisor({ identity, runtime: { root: "unused", workerEntry: "unused" },
    directory: "unused", retries: 2, retryDelaySeconds: 0, wake() {}, event() {},
    spawn: async () => { starts++; throw new Error("startup timeout"); } });
  try {
    supervisor.setTarget(1);
    await waitForTestState(async () => supervisor.exhausted(), exhausted => exhausted, "startup retries exhaust");
    assert.equal(starts, 3);
    assert.equal(supervisor.slots.length, 0);
    supervisor.setTarget(1);
    assert.equal(starts, 3, "ordinary scheduler wakeups cannot reset the recovery budget");
  } finally { await supervisor.close(); }
});

test("an unconfirmed startup cleanup quarantines capacity without leaking replacements", async () => {
  const http = await listen(async (_req, res) => json(res, { identity: { ...identity, buildId: "wrong" } }));
  let starts = 0;
  const events: string[] = [];
  const supervisor = new WorkerSupervisor({ identity, runtime: { root: "unused", workerEntry: "unused" },
    directory: "unused", retries: 1, retryDelaySeconds: 0, wake() {}, event: name => events.push(name),
    spawn: async () => { starts++; return { pid: starts, url: http.url, urls: [http.url],
      exited: new Promise(() => {}), async close() { throw new Error("cleanup fixture failure"); } }; } });
  try {
    supervisor.setTarget(1);
    await waitForTestState(async () => supervisor.exhausted(), exhausted => exhausted, "startup cleanup failure quarantines capacity");
    supervisor.retryQuarantined();
    assert.equal(starts, 1);
    assert.equal(supervisor.snapshot().quarantined_slots, 1);
    assert(events.includes("worker_cleanup_failed"));
  } finally { await assert.rejects(supervisor.close(), /Worker shutdown failed/); await http.close(); }
});


test("capacity is not restarted after its final run has released demand", async () => {
  const http = await listen(async (_req, res) => json(res, { identity, tools: [], activeAttempt: null }));
  let starts = 0, exited!: (value: WorkerExit) => void;
  const owner: WorkerProcess = { pid: 1, url: http.url, urls: [http.url],
    exited: new Promise(resolve => { exited = resolve; }), async close() {} };
  const supervisor = new WorkerSupervisor({ identity, runtime: { root: "unused", workerEntry: "unused" },
    directory: "unused", retries: 0, retryDelaySeconds: 0, wake() {}, event() {}, spawn: async () => { starts++; return owner; } });
  try {
    supervisor.setDemand("finished-run", 1);
    await waitForTestState(async () => supervisor.slots.length, count => count === 1, "capacity is ready");
    supervisor.setDemand("finished-run", 0);
    exited({ pid: 1, url: http.url, exitCode: 1, signal: null, expectedClose: false, disconnectedAt: null, exitedAt: Date.now(), stderr: "" });
    await waitForTestState(async () => supervisor.slots.length, count => count === 0, "the departed capacity is removed");
    assert.equal(starts, 1, "completed records do not need a replacement Worker or another startup window");
  } finally { await supervisor.close(); await http.close(); }
});

test("an unconfirmed process exit after retirement becomes quarantined instead of waiting forever", async () => {
  const http = await listen(async (_req, res) => json(res, { identity, tools: [], activeAttempt: null }));
  let starts = 0;
  const supervisor = new WorkerSupervisor({ identity, runtime: { root: "unused", workerEntry: "unused" },
    directory: "unused", retries: 1, retryDelaySeconds: 0, wake() {}, event() {}, spawn: async () => {
      starts++; return { pid: starts, url: http.url, urls: [http.url], exited: new Promise(() => {}),
        async close() { throw new Error("exit observation fixture timeout"); } };
    } });
  try {
    supervisor.setTarget(1);
    await waitForTestState(async () => supervisor.slots.length, count => count === 1, "capacity becomes ready");
    supervisor.retire(supervisor.slots[0], "session cleanup failed");
    await waitForTestState(async () => supervisor.exhausted(), exhausted => exhausted, "unconfirmed exit quarantines capacity");
    supervisor.retryQuarantined();
    assert.equal(supervisor.exhausted(), true, "unconfirmed live processes cannot be reset as free capacity");
    assert.equal(starts, 1);
    assert.equal(supervisor.snapshot().quarantined_slots, 1);
    assert.equal(supervisor.slots.length, 0);
  } finally { await assert.rejects(supervisor.close(), /Worker shutdown failed/); await http.close(); }
});

test("IPC startup failures retain unconfirmed processes in quarantine across batch probes", async () => {
  let starts = 0;
  const owner: WorkerProcess = { pid: 123, url: "", urls: [], exited: new Promise(() => {}),
    async close() { throw new Error("exit not confirmed"); } };
  const supervisor = new WorkerSupervisor({ identity, runtime: { root: "unused", workerEntry: "unused" },
    directory: "unused", retries: 2, retryDelaySeconds: 0, wake() {}, event() {}, spawn: async () => {
      starts++; throw new WorkerStartupError(new Error("IPC startup cancelled"), new Error("exit not confirmed"), owner);
    } });
  try {
    supervisor.setTarget(1);
    await waitForTestState(async () => supervisor.exhausted(), exhausted => exhausted, "IPC cleanup failure quarantines the retained process");
    supervisor.retryQuarantined(); supervisor.setTarget(1);
    assert.equal(starts, 1);
    assert.equal(supervisor.snapshot().quarantined_slots, 1);
  } finally { await assert.rejects(supervisor.close(), /Worker shutdown failed/); }
});
