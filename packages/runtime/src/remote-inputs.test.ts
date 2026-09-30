import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { RemoteInputs } from "./remote-inputs.js";

test("remote client uses the live catalog contract, streams full inputs and rejects failed progress updates", async () => {
  let malformed = false;
  const body = Buffer.from('{"answer":"中文"}\n');
  const server = createServer((req, res) => {
    if (req.url === "/dashboard-data") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ dates: [{ date: "2026-09-29", ready: true,
        models: Object.fromEntries(["a_fast", "b_fast", "a_expert", "b_expert"].map((model) => [model, { ready: true, row_count: malformed ? -1 : 1 }])) }] }));
    } else if (["/data/2026-09-29/b_fast.jsonl", "/data/2026-09-29/b_expert.jsonl"].includes(req.url!)) {
      res.setHeader("content-length", body.length); res.end(body);
    } else if (req.url === "/evaluation-progress") { res.statusCode = 409; res.end(JSON.stringify({ error: "stale progress update" })); }
    else { res.statusCode = 404; res.end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const client = new RemoteInputs(`http://127.0.0.1:${(server.address() as { port: number }).port}`, 1000);
    const signal = AbortSignal.timeout(3000), days = await client.discover(signal);
    assert.deepEqual(days[0].rows, { a_fast: 1, b_fast: 1, a_expert: 1, b_expert: 1 });
    for (const model of ["b_fast", "b_expert"] as const) {
      const download = await client.download(days[0], model, signal);
      assert.equal(download.name, model + ".jsonl");
      const chunks = [];
      for await (const chunk of download.chunks) chunks.push(Buffer.from(chunk));
      await download.close();
      assert.equal(Buffer.concat(chunks).toString(), body.toString());
    }
    await assert.rejects(client.publish({}, signal), /HTTP 409: stale progress update/);
    malformed = true;
    await assert.rejects(client.discover(signal), /row count/);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
