import test from "node:test";
import assert from "node:assert/strict";
import { PublicationStatistics } from "@eval/workflows/comparison";
import { uploadStatisticsReport } from "../../../apps/host/src/report-upload.js";

const record = new PublicationStatistics([]).record("relay-test", Date.now());

test("statistics relay accepts only an explicit written receipt", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ written: true, requestId: "req-1" }), { status: 201 }));
  assert.deepEqual(await uploadStatisticsReport("http://reports.test", record), { status: "uploaded", requestId: "req-1" });
  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ written: true }), { status: 201 }));
  assert.equal((await uploadStatisticsReport("http://reports.test", record)).status, "uncertain", "a malformed success response is ambiguous");
});

test("statistics relay retries only explicit request rejections and marks transport or 5xx failures uncertain", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: "invalid" }), { status: 422 }));
  assert.deepEqual(await uploadStatisticsReport("http://reports.test", record), { status: "pending", error: "HTTP 422: invalid" });
  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: "unavailable" }), { status: 503 }));
  assert.equal((await uploadStatisticsReport("http://reports.test", record)).status, "uncertain");
  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", async () => { throw new Error("socket closed after write"); });
  const transport = await uploadStatisticsReport("http://reports.test", record);
  assert.equal(transport.status, "uncertain");
  assert.match(transport.error, /socket closed after write/);
});
