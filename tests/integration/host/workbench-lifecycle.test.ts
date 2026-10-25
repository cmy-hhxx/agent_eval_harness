import test from "node:test";
import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { WorkbenchServices, type ServiceName } from "../../../apps/host/src/workbench-services.js";

function fixture(options: { limit?: number; pending?: boolean; stubborn?: boolean } = {}) {
  const children: { name: ServiceName; child: ChildProcess }[] = [], signals: { name: ServiceName; signal: NodeJS.Signals }[] = [];
  const probes: { name: ServiceName; signal: AbortSignal; resolve: () => void }[] = [];
  const services = new WorkbenchServices({ restart: { limit: options.limit ?? 2, windowMs: 1000, baseDelayMs: 5, maxDelayMs: 10 },
    launch: name => {
      const child = new ChildProcess();
      Object.defineProperty(child, "pid", { value: children.length + 100 });
      children.push({ name, child }); return child;
    },
    probe: (name, signal) => options.pending ? new Promise<void>(resolve => { probes.push({ name, signal, resolve }); }) : Promise.resolve(),
    report: () => {},
    signalChild: (child, signal) => {
      const name = children.find(item => item.child === child)!.name;
      signals.push({ name, signal });
      if (child.exitCode === null && child.signalCode === null && (!options.stubborn || signal === "SIGKILL")) {
        Object.defineProperty(child, "signalCode", { value: signal });
        queueMicrotask(() => { child.emit("exit", null, signal); child.emit("close", null, signal); });
      }
    },
  });
  const exit = (name: ServiceName, code: number) => {
    const child = children.findLast(item => item.name === name)!.child;
    Object.defineProperty(child, "exitCode", { value: code }); child.emit("exit", code, null); child.emit("close", code, null);
  };
  return { services, children, signals, probes, exit };
}

test("child restart restores health and zero restart budget fails immediately", async () => {
  const f = fixture();
  try {
    await f.services.start();
    assert.deepEqual(f.services.health, { data: true, automation: true, runs: true });
    f.exit("data", 1);
    assert.equal(f.services.health.data, false);
    await delay(25);
    assert.equal(f.children.filter(item => item.name === "data").length, 2);
    assert.equal(f.services.health.data, true);
    f.exit("data", 1); await delay(25); f.exit("data", 1);
    await assert.rejects(f.services.failed, /exceeded 2 restarts/);
  } finally { await f.services.stop(Date.now() + 100); }

  const disabled = fixture({ limit: 0 });
  try {
    await disabled.services.start(); disabled.exit("automation", 1);
    await assert.rejects(disabled.services.failed, /exceeded 0 restarts/);
    assert.equal(disabled.children.length, 3);
  } finally { await disabled.services.stop(Date.now() + 100); }
});

test("stop during startup cancels probes and kills only owned children in dependency order", async () => {
  const f = fixture({ pending: true });
  void f.services.start();
  await f.services.stop(Date.now() + 100);
  assert.equal(f.probes.every(probe => probe.signal.aborted), true);
  for (const probe of f.probes) probe.resolve();
  await delay(0);
  assert.deepEqual(f.services.health, { data: false, automation: false, runs: false });
  assert.deepEqual(f.signals.filter(item => item.signal === "SIGTERM").map(item => item.name), ["automation", "runs", "data"]);
});

test("stop cancels a pending restart and configuration errors never restart", async () => {
  const f = fixture();
  await f.services.start(); f.exit("data", 1);
  await f.services.stop(Date.now() + 100); await delay(20);
  assert.equal(f.children.length, 3);
  const broken = fixture();
  try {
    await broken.services.start(); broken.exit("automation", 2);
    await assert.rejects(broken.services.failed, /configuration or startup error/);
    assert.equal(broken.children.length, 3);
  } finally { await broken.services.stop(Date.now() + 100); }
});

test("all children share one shutdown deadline, including unresponsive hosts", async () => {
  const f = fixture({ stubborn: true });
  await f.services.start();
  const start = Date.now();
  await f.services.stop(start + 30);
  assert.ok(Date.now() - start < 150);
  assert.deepEqual(new Set(f.signals.filter(item => item.signal === "SIGKILL").map(item => item.name)), new Set(["data", "automation", "runs"]));
});

test("spawn and readiness failures reach the supervisor instead of hanging startup", async () => {
  const f = fixture({ pending: true }), starting = f.services.start();
  f.children[0].child.emit("error", new Error("spawn failed"));
  await assert.rejects(starting, /spawn failed/);
  await f.services.stop(Date.now() + 100);
  const services = new WorkbenchServices({ restart: { limit: 1, windowMs: 10, baseDelayMs: 1, maxDelayMs: 1 },
    launch: () => new ChildProcess(), probe: async () => { throw new Error("health failed"); }, report: () => {} });
  await assert.rejects(services.start(), /health failed/);
  await services.stop(Date.now() + 100);
});
