import test from "node:test";
import assert from "node:assert/strict";
import { createAutomationControl } from "../../../apps/host/src/automation-control.js";
import type { AutomationConfig } from "../../../apps/host/src/automation-config.js";
import { sourceCatalog, stopSourceCleaning } from "../../../apps/host/src/daily-ingestion.js";

const config = { sourceUrl: "http://data.test/data/wencai", autoClean: true, requestTimeoutMs: 40 } as AutomationConfig;
const catalog = { tasks: [{ id: "task", dataset: "/data/wencai" }], batches: [], total: 0, page: 1, page_size: 50 };
const response = (value: object, status = 200) => new Response(JSON.stringify(value), { status });

test("catalog forwards the requested server page size and rejects invalid pagination before reading", async t => {
  const urls: URL[] = [];
  t.mock.method(globalThis, "fetch", async (url: URL) => { urls.push(url); return response(catalog); });
  await sourceCatalog(config, 3, 10);
  assert.equal(urls[0].searchParams.get("page_size"), "1");
  assert.equal(urls[1].searchParams.get("page"), "3");
  assert.equal(urls[1].searchParams.get("page_size"), "10");
  assert.equal(urls[1].searchParams.get("task"), "task");
  for (const [page, size] of [[0, 10], [1, 0], [1, 101], [1, 1.5]]) await assert.rejects(sourceCatalog(config, page, size), /分页参数无效/);
  assert.equal(urls.length, 2);
});

test("cleaning drain outlives one request deadline and gives each status read a fresh deadline", async t => {
  const signals: AbortSignal[] = [];
  t.mock.method(globalThis, "fetch", async (input: URL, init: RequestInit) => {
    if (input.pathname === "/data/workbench/catalog") return response(catalog);
    if (init.method === "POST") return response({ status: "stopping" });
    const signal = init.signal!;
    assert.equal(signal.aborted, false);
    signals.push(signal);
    return response({ status: signals.length < 3 ? "stopping" : "stopped" });
  });
  assert.equal((await stopSourceCleaning(config, false, true)).status, "stopped");
  assert.equal(signals.length, 3);
  assert.equal(new Set(signals).size, 3);
});

for (const failure of ["http", "timeout"]) test(`a ${failure} cleaning status failure cannot report a paused source`, async t => {
  t.mock.method(globalThis, "fetch", async (input: URL, init: RequestInit) => {
    if (input.pathname === "/data/workbench/catalog") return response(catalog);
    if (init.method === "POST") return response({ status: "stopping" });
    if (failure === "http") return response({ error: "cleaner status unavailable" }, 503);
    return new Promise<Response>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Request deadline did not abort")), 1000);
      init.signal!.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal!.reason); }, { once: true });
    });
  });
  let settled!: () => void;
  const drained = new Promise<void>(resolve => { settled = resolve; });
  const control = createAutomationControl(["wencai"], async (_id, _signal, pauseSignal) => {
    await new Promise<void>(resolve => pauseSignal.addEventListener("abort", () => resolve(), { once: true }));
    try { await stopSourceCleaning(config, false, true); }
    finally { settled(); }
  });
  try {
    control.run("wencai"); await new Promise(setImmediate);
    assert.equal(control.pause("wencai").status, "pausing");
    await drained; await new Promise(setImmediate);
    const state = control.snapshot("wencai");
    assert.equal(state.status, "failed");
    assert.match(state.error!, failure === "http" ? /cleaner status unavailable/ : /timeout/i);
  } finally { await control.close(); }
});
