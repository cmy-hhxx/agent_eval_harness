import assert from "node:assert/strict";
import test from "node:test";
import { createChannelRequests } from "./channel-requests.js";
import type { ModelRequestContext } from "./model-requests.js";

const context = (channel: string, callId: string, runId = "one") => ({
  callId, runId, taskId: "task", stage: "attribution-component", model: { provider: channel },
}) as ModelRequestContext;

test("two channels enforce 200 live requests each across runs and release exactly once", async () => {
  const control = createChannelRequests({ first: 200, second: 200 }), signal = new AbortController().signal;
  const first = await Promise.all(Array.from({ length: 200 }, (_, i) => control.acquire(context("first", String(i)), signal)));
  const second = await Promise.all(Array.from({ length: 200 }, (_, i) => control.acquire(context("second", String(i), "two"), signal)));
  let firstGranted = false, secondGranted = false;
  const a = control.acquire(context("first", "overflow", "three"), signal).then(release => { firstGranted = true; return release; });
  const b = control.acquire(context("second", "overflow", "four"), signal).then(release => { secondGranted = true; return release; });
  await Promise.resolve();
  assert.equal(firstGranted, false); assert.equal(secondGranted, false);
  first[0](); first[0]();
  const releaseA = await a;
  assert.equal(secondGranted, false);
  second[0](); const releaseB = await b;
  releaseA(); releaseB(); first.forEach(release => release()); second.forEach(release => release());
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
  release();
  const next = await control.acquire(context("channel", "next"), signal); next();
});

test("downstream priority applies within the weighted lane and preserves FIFO ties", async () => {
  const control = createChannelRequests({ channel: 1 }, { wencai: 7, aime: 1 },
    value => value.stage === "attribution-session" ? 0 : 1);
  const signal = new AbortController().signal, order: string[] = [];
  const call = (id: string, group: string, stage: string) => control.acquire({
    ...context("channel", id), trafficGroup: group, stage,
  }, signal).then(release => { order.push(id); return release; });
  const release = await call("active", "wencai", "attribution-component");
  const component = call("component", "wencai", "attribution-component");
  const first = call("first", "wencai", "attribution-session");
  const second = call("second", "wencai", "attribution-session");
  const other = call("other", "aime", "attribution-session");
  release();
  (await first)();
  (await second)();
  (await component)();
  (await other)();
  assert.deepEqual(order, ["active", "first", "second", "component", "other"]);
});
