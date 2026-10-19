import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { RemoteInputs } from "./remote-inputs.js";
import { RemoteInputNotReadyError } from "@eval/contracts";

test("six remote models preserve the GPT prefix for discovery, dotted IDs and progress", async () => {
  const ids = ["a_fast", "b_fast", "6_luna", "a_expert", "b_expert", "6.1sol"];
  let ready = false;
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url!);
    if (req.url === "/gpt/dashboard-data") res.end(JSON.stringify({ dates: [{ date: "2026-10-19", ready: true,
      models: Object.fromEntries(ids.map(id => [id, { ready: id !== "6.1sol" || ready, row_count: 1 }])) }] }));
    else if (req.url === "/gpt/data/2026-10-19/6.1sol.jsonl") {
      const body = Buffer.from('{"case_id":"one"}\n');
      res.setHeader("content-length", body.length); res.end(body);
    } else if (req.url === "/gpt/evaluation-progress" && req.method === "POST") {
      req.resume(); res.end(JSON.stringify({ saved: true }));
    } else { res.statusCode = 404; res.end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const client = new RemoteInputs(`http://127.0.0.1:${(server.address() as { port: number }).port}/gpt`, 1000, ids);
    const signal = AbortSignal.timeout(3000);
    assert.deepEqual(await client.discover(signal), []);
    ready = true;
    const [day] = await client.discover(signal);
    assert.deepEqual(Object.keys(day.rows), ids);
    const file = await client.download(day, "6.1sol", signal);
    const chunks = [];
    try { for await (const chunk of file.chunks) chunks.push(Buffer.from(chunk)); }
    finally { await file.close(); }
    assert.equal(file.name, "6.1sol.jsonl");
    assert.equal(Buffer.concat(chunks).toString(), '{"case_id":"one"}\n');
    await client.publish({ dates: [] }, signal);
    assert.deepEqual(requests, ["/gpt/dashboard-data", "/gpt/dashboard-data", "/gpt/data/2026-10-19/6.1sol.jsonl", "/gpt/evaluation-progress"]);
    await assert.rejects(client.download(day, "../other", signal), /Invalid remote/);
    assert.throws(() => new RemoteInputs(client.url, 1000, ["../other"]), /identifier/);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

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
    } else if (req.url === "/data/2026-09-29/a_fast.jsonl") { res.statusCode = 404; res.end(JSON.stringify({ error: "data not ready" })); }
    else if (req.url === "/evaluation-progress") { res.statusCode = 409; res.end(JSON.stringify({ error: "stale progress update" })); }
    else { res.statusCode = 404; res.end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const client = new RemoteInputs(`http://127.0.0.1:${(server.address() as { port: number }).port}`, 1000, ["a_fast", "b_fast", "a_expert", "b_expert"]);
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
    await assert.rejects(client.download(days[0], "a_fast", signal), RemoteInputNotReadyError);
    await assert.rejects(client.download(days[0], "a_expert", signal), (error) => error instanceof Error && !(error instanceof RemoteInputNotReadyError));
    malformed = true;
    await assert.rejects(client.discover(signal), /row count/);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("large downloads time out on inactivity rather than total transfer duration", async () => {
  let stalled = false;
  const server = createServer(async (_req, res) => {
    res.setHeader("content-length", 20);
    res.write("x");
    for (let i = 1; i < 20 && !res.destroyed; i++) {
      await delay(stalled ? 400 : 40);
      if (!res.destroyed) res.write("x");
    }
    res.end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const client = new RemoteInputs(`http://127.0.0.1:${(server.address() as { port: number }).port}`, 250, ["a_fast"]);
    const day = { date: "2026-09-30", rows: { a_fast: 1, b_fast: 1, a_expert: 1, b_expert: 1 } };
    const first = await client.download(day, "a_fast", AbortSignal.timeout(3000));
    let bytes = 0;
    try { for await (const chunk of first.chunks) bytes += chunk.length; }
    finally { await first.close(); }
    assert.equal(bytes, 20, "a progressing stream can outlive the request timeout");
    stalled = true;
    const second = await client.download(day, "a_fast", AbortSignal.timeout(3000));
    try { await assert.rejects(async () => { for await (const _chunk of second.chunks) { /* Consume the stalled stream. */ } }); }
    finally { await second.close(); }
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
