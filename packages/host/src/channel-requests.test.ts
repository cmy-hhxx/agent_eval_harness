import assert from "node:assert/strict";
import test from "node:test";
import { createChannelRequests } from "./channel-requests.js";
import type { ModelRequestContext } from "./model-requests.js";

const context = (channel: string, callId: string, runId = "one") => ({
  callId, runId, taskId: "task", stage: "attribution-compact", model: { provider: channel },
}) as ModelRequestContext;

test("capacity grows beyond its initial ceiling and shrinks without revoking active calls", async () => {
  const gate = createChannelRequests({ first: 1, second: 1 }, undefined, undefined, undefined, 1);
  const signal = new AbortController().signal;
  const first = await gate.acquire(context("first", "one"), signal);
  let admitted = false;
  const waiting = gate.acquire(context("second", "two"), signal).then(permit => { admitted = true; return permit; });
  await Promise.resolve(); assert.equal(admitted, false);
  gate.setCapacity({ first: 2, second: 2 }, 3);
  const second = await waiting;
  const third = await gate.acquire(context("first", "three"), signal);
  assert.equal(gate.snapshot().active, 3);
  gate.setCapacity({ first: 1, second: 1 }, 1);
  assert.equal(gate.snapshot().active, 3);
  let nextAdmitted = false;
  const next = gate.acquire(context("second", "four"), signal).then(permit => { nextAdmitted = true; return permit; });
  first.release(); second.release(); await Promise.resolve(); assert.equal(nextAdmitted, false);
  third.release(); (await next).release();
  assert.throws(() => gate.setCapacity({ unknown: 1 }, 1), /existing channels/);
  assert.equal(gate.snapshot().active, 0);
});

test("two channels enforce 200 live requests each across runs and release exactly once", async () => {
  const control = createChannelRequests({ first: 200, second: 200 }), signal = new AbortController().signal;
  const first = await Promise.all(Array.from({ length: 200 }, (_, i) => control.acquire(context("first", String(i)), signal)));
  const second = await Promise.all(Array.from({ length: 200 }, (_, i) => control.acquire(context("second", String(i), "two"), signal)));
  let firstGranted = false, secondGranted = false;
  const a = control.acquire(context("first", "overflow", "three"), signal).then(release => { firstGranted = true; return release; });
  const b = control.acquire(context("second", "overflow", "four"), signal).then(release => { secondGranted = true; return release; });
  await Promise.resolve();
  assert.equal(firstGranted, false); assert.equal(secondGranted, false);
  first[0].release(); first[0].release();
  const releaseA = await a;
  assert.equal(secondGranted, false);
  second[0].release(); const releaseB = await b;
  releaseA.release(); releaseB.release(); first.forEach(permit => permit.release()); second.forEach(permit => permit.release());
});

test("cancelled queued calls cannot take a permit; unknown channels and duplicate calls fail", async () => {
  const control = createChannelRequests({ channel: 1 }), signal = new AbortController().signal;
  const release = await control.acquire(context("channel", "active"), signal);
  await assert.rejects(control.acquire(context("channel", "active"), signal), /Duplicate/);
  await assert.rejects(control.acquire(context("unknown", "other"), signal), /Unallocated/);
  const controller = new AbortController();
  const queued = control.acquire(context("channel", "queued"), controller.signal);
  controller.abort(new Error("cancel queued"));
  await assert.rejects(queued, /cancel queued/);
  release.release();
  const next = await control.acquire(context("channel", "next"), signal); next.release();
});

test("downstream priority applies within the weighted lane and preserves FIFO ties", async () => {
  const control = createChannelRequests({ channel: 1 }, { wencai: 7, aime: 1 },
    value => value.stage === "attribution-session" ? 0 : 1);
  const signal = new AbortController().signal, order: string[] = [];
  const call = (id: string, group: string, stage: string) => control.acquire({
    ...context("channel", id), trafficGroup: group, stage,
  }, signal).then(release => { order.push(id); return release; });
  const release = await call("active", "wencai", "attribution-compact");
  const component = call("component", "wencai", "attribution-compact");
  const first = call("first", "wencai", "attribution-session");
  const second = call("second", "wencai", "attribution-session");
  const other = call("other", "aime", "attribution-session");
  release.release();
  (await first).release();
  (await second).release();
  (await component).release();
  (await other).release();
  assert.deepEqual(order, ["active", "first", "second", "component", "other"]);
});


test("a queued equivalent request borrows the other gateway without moving an active request", async () => {
  const control = createChannelRequests({ first: 1, second: 1 });
  const signal = new AbortController().signal;
  const first = await control.acquire(context("first", "active-first"), signal);
  const second = await control.acquire(context("second", "active-second"), signal);
  const request = context("first", "waiting"); request.routes = [context("first", "").model, context("second", "").model];
  const waiting = control.acquire(request, signal);
  second.release();
  const borrowed = await waiting;
  assert.equal(borrowed.model.provider, "second");
  assert.equal(first.model.provider, "first");
  assert.equal(control.snapshot().channels.first.active, 1);
  borrowed.release(); first.release();
});

test("equivalent requests round-robin both gateways under one total limit", async () => {
  const control = createChannelRequests({ first: 4, second: 4 }, undefined, undefined, undefined, 4);
  const signal = new AbortController().signal, order: string[] = [];
  const call = async (id: string) => {
    const request = context("first", id); request.routes = [request.model, context("second", "").model];
    const permit = await control.acquire(request, signal); order.push(permit.model.provider); return permit;
  };
  const permits = [];
  for (let n = 0; n < 4; n++) permits.push(await call(String(n)));
  assert.deepEqual(order, ["first", "second", "first", "second"]);
  assert.equal(control.snapshot().channels.first.active, 2);
  assert.equal(control.snapshot().channels.second.active, 2);
  let granted = false;
  const waiting = call("queued").then(permit => { granted = true; return permit; });
  await Promise.resolve(); assert.equal(granted, false);
  permits[1].release(); const next = await waiting;
  assert.equal(next.model.provider, "first", "the rotation advances independently of the released channel");
  assert.equal(control.snapshot().active, 4);
  next.release(); permits.forEach(permit => permit.release());
});

test("priority lanes hand traffic over directly and total requests stay bounded", async () => {
  const control = createChannelRequests({ first: 2 }, { recovery: 1, daily: 1 }, undefined, { recovery: 0, daily: 1 }, 1);
  const signal = new AbortController().signal, order: string[] = [];
  const call = (id: string, group: string) => control.acquire({ ...context("first", id), trafficGroup: group }, signal)
    .then(permit => { order.push(id); return permit; });
  const active = await call("active", "daily");
  const daily = call("daily", "daily"), recovery = call("recovery", "recovery");
  active.release(); (await recovery).release(); (await daily).release();
  assert.deepEqual(order, ["active", "recovery", "daily"]);
  assert.equal(control.concurrency(), 1);
});


test("an unavailable gateway is isolated across runs without revoking its live streams", async () => {
  const control = createChannelRequests({ first: 1, second: 1 });
  const signal = new AbortController().signal;
  const first = await control.acquire(context("first", "active"), signal);
  const second = await control.acquire(context("second", "active", "two"), signal);
  const request = { ...context("first", "waiting", "three"), routes: [context("first", "").model, context("second", "").model] };
  const pending = control.acquire(request, signal);
  control.disable("first", "account quota exhausted");
  assert.equal(control.available(["first"]), false);
  assert.equal(control.snapshot().channels.first.active, 1, "disabling a channel does not move or revoke an active stream");
  second.release(); const moved = await pending;
  assert.equal(moved.model.provider, "second"); moved.release(); first.release();
  const active = await control.acquire(context("second", "last"), signal);
  const denied = control.acquire(context("second", "queued"), signal);
  control.disable("second", "invalid credential");
  await assert.rejects(denied, /Model capacity unavailable/);
  assert.equal(control.available(), false); active.release();
  assert.equal(control.snapshot().channels.second.groups.default.waiting, 0);
});


test("manual per-run model limits apply independently of the session and global request limits", async () => {
  const control = createChannelRequests({ gateway: 3 }), signal = new AbortController().signal;
  control.setRunLimit("one", 1);
  const active = await control.acquire(context("gateway", "first"), signal);
  let granted = false;
  const queued = control.acquire(context("gateway", "second"), signal).then(permit => { granted = true; return permit; });
  const independent = await control.acquire(context("gateway", "third", "two"), signal);
  assert.equal(granted, false);
  control.setRunLimit("one", 2);
  const second = await queued;
  assert.equal(control.snapshot().active, 3);
  control.setRunLimit("one", 1);
  assert.equal(control.snapshot().runs.one.active, 2, "lowering limits does not revoke in-flight streams");
  active.release(); second.release(); independent.release();
  control.setRunLimit("one", undefined);
});
