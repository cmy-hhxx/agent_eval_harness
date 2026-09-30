import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { uploadStatisticsLog } from "./log-upload.js";

test("log upload sends exactly one opaque JSON and requires the 201 written receipt", async () => {
  let requests = 0;
  const record = { traceId: "snapshot", data: { cases: 2 } };
  const server = createServer(async (req, res) => {
    requests++;
    let body = ""; for await (const chunk of req) body += chunk;
    assert.equal(req.url, "/agent-eval/api/logs");
    assert.deepEqual(JSON.parse(body), record);
    res.writeHead(requests === 1 ? 201 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify(requests === 1 ? { written: true, requestId: "req-123" } : { code: "LOG_WRITE_FAILED" }));
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/agent-eval/api/logs`;
    assert.equal(await uploadStatisticsLog(url, record, AbortSignal.timeout(2000)), "req-123");
    await assert.rejects(uploadStatisticsLog(url, record, AbortSignal.timeout(2000)), /not acknowledged/);
    assert.equal(requests, 2);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
