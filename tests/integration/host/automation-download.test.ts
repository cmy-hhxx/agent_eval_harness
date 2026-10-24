import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { replaceInputSnapshot, runLock } from "@eval/data";
import { RemoteInputs } from "@eval/runtime/client";
import { RemoteInputNotReadyError } from "@eval/contracts";
import type { AutomationJob } from "@eval/automations";
import { syncRemoteInputs } from "../../../apps/host/src/automation-download.js";

test("a disconnected input retries only that file before committing the complete date", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "automation-download-"));
  const body = Buffer.from('{"answer":"中文🙂"}\n'), old = '{"answer":"old"}\n';
  const requests: Record<string, number> = {};
  const server = createServer(async (req, res) => {
    const model = req.url!.includes("a_fast") ? "a_fast" : "b_fast";
    requests[model] = (requests[model] ?? 0) + 1;
    res.setHeader("content-length", body.length);
    if (model === "b_fast" && requests[model] === 1) {
      res.write(body.subarray(0, 13));
      await delay(30);
      res.destroy();
    } else res.end(body);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    for (const model of ["a_fast", "b_fast"]) await writeFile(path.join(directory, model + ".jsonl"), old);
    const client = new RemoteInputs(`http://127.0.0.1:${(server.address() as { port: number }).port}`, 1000, ["a_fast", "b_fast"]);
    const signal = AbortSignal.timeout(5000), day = { date: "2026-10-18", rows: { a_fast: 1, b_fast: 1 } };
    async function* files() {
      for (const model of client.models) yield () => client.download(day, model, signal);
    }
    let commits = 0;
    const result = await replaceInputSnapshot(directory, files(), signal, async () => {
      commits++;
      for (const model of client.models) assert.equal(await readFile(path.join(directory, model + ".jsonl"), "utf8"), old);
    });
    assert.deepEqual(result, { changed: true, bytes: body.length * 2, rows: { a_fast: 1, b_fast: 1 } });
    assert.equal(commits, 1);
    assert.deepEqual(requests, { a_fast: 1, b_fast: 2 });
    for (const model of client.models) assert.deepEqual(await readFile(path.join(directory, model + ".jsonl")), body);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

for (const mode of ["headers", "persistent", "not-ready", "unauthorized", "invalid-json", "row-regression", "cancel"] as const) {
  test(`download recovery handles ${mode} without replacing an incomplete date`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "automation-download-"));
    const body = Buffer.from('{"answer":"new"}\n'), old = '{"answer":"old"}\n';
    const controller = new AbortController(), requests: Record<string, number> = {};
    let disconnect: (() => void) | undefined;
    const server = createServer(async (req, res) => {
      const model = req.url!.includes("a_fast") ? "a_fast" : "b_fast";
      requests[model] = (requests[model] ?? 0) + 1;
      if (model === "b_fast") {
        if (mode === "headers" && requests[model] === 1) {
          res.statusCode = 503; res.end(JSON.stringify({ error: "temporarily unavailable" })); return;
        }
        if (mode === "not-ready" || mode === "unauthorized") {
          res.statusCode = mode === "not-ready" ? 404 : 401;
          res.end(JSON.stringify({ error: mode === "not-ready" ? "data not ready" : "unauthorized" })); return;
        }
        if (mode === "persistent" || mode === "cancel") {
          res.setHeader("content-length", body.length);
          if (mode === "persistent") disconnect = () => res.destroy();
          res.write(body.subarray(0, 8));
          if (mode === "persistent") return;
          await delay(30); res.destroy();
          if (mode === "cancel") setTimeout(() => controller.abort(new Error("stopped")), 100);
          return;
        }
      }
      const value = model !== "b_fast" ? body : mode === "invalid-json" ? Buffer.from('{"broken":\n')
        : mode === "row-regression" ? Buffer.alloc(0) : body;
      res.setHeader("content-length", value.length); res.end(value);
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    try {
      for (const model of ["a_fast", "b_fast"]) await writeFile(path.join(directory, model + ".jsonl"), old);
      const client = new RemoteInputs(`http://127.0.0.1:${(server.address() as { port: number }).port}`, 1000, ["a_fast", "b_fast"]);
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(6000)]);
      const day = { date: "2026-10-18", rows: { a_fast: 1, b_fast: 1 } };
      async function* files() {
        for (const model of client.models) yield async () => {
          const input = await client.download(day, model, signal);
          if (mode !== "persistent" || model !== "b_fast") return input;
          const end = disconnect!;
          return { ...input, chunks: (async function* () {
            for await (const chunk of input.chunks) {
              yield chunk;
              // Disconnect only after the client has consumed the partial response.
              end();
            }
          })() };
        };
      }
      let commits = 0;
      const download = replaceInputSnapshot(directory, files(), signal, async () => { commits++; });
      if (mode === "headers") {
        await download;
        assert.equal(commits, 1);
      } else {
        await assert.rejects(download, mode === "persistent"
          ? /after 3 attempts: Remote \/data\/2026-10-18\/b_fast.jsonl:.*UND_ERR_SOCKET.*received 8\/\d+ bytes/
          : mode === "not-ready" ? RemoteInputNotReadyError : mode === "unauthorized" ? /HTTP 401/
          : mode === "invalid-json" ? SyntaxError : mode === "row-regression" ? /rows 0\/1/ : /stopped|abort/i);
        assert.equal(commits, 0);
      }
      assert.deepEqual(requests, { a_fast: 1, b_fast: mode === "headers" ? 2 : mode === "persistent" ? 3 : 1 });
      for (const model of client.models)
        assert.equal(await readFile(path.join(directory, model + ".jsonl"), "utf8"), mode === "headers" ? body.toString() : old);
    } finally {
      controller.abort();
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("a growing three-model source promotes after evaluation while Mongo continues its pinned delivery", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "automation-growing-download-"));
  const models = ["a_fast", "b_fast", "b_post_train_fast"];
  const old = '{"id":"one"}\n', body = Buffer.from(old + '{"id":"two"}\n');
  const day = { date: "2026-10-19", rows: Object.fromEntries(models.map(model => [model, 1])) };
  const job: AutomationJob = { ...day, runIds: ["daily-post-training-2026-10-19"], observed: day.rows,
    adopted: false, download: "downloading", evaluation: "evaluating", checkedAt: 0,
    downloadAttempts: 1, evaluationAttempts: 1, nextDownloadAt: 0, nextEvaluationAt: 0,
    mongo: { status: "running", attempts: 1, nextAt: 0 } };
  let requests = 0, promoted = false;
  const server = createServer((_req, res) => {
    requests++;
    job.observed = Object.fromEntries(models.map(model => [model, requests + 2]));
    res.setHeader("content-length", body.length); res.end(body);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const controller = new AbortController();
  let work: ReturnType<typeof syncRemoteInputs> | undefined;
  try {
    await mkdir(path.join(directory, job.runIds[0]));
    for (const model of models) await writeFile(path.join(directory, model + ".jsonl"), old);
    const remote = new RemoteInputs(`http://127.0.0.1:${(server.address() as { port: number }).port}`, 1000, models);
    work = syncRemoteInputs(remote, directory, directory, job, day,
      AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]), async () => { promoted = true; });
    while (requests < 3) await delay(5);
    await delay(50);
    assert.equal(promoted, false);
    for (const model of models) assert.equal(await readFile(path.join(directory, model + ".jsonl"), "utf8"), old);
    job.evaluation = "completed";
    const result = await work;
    assert.equal(promoted, true);
    assert.equal(job.mongo!.status, "running", "delivery does not hold the input promotion lock");
    assert.equal(requests, 3, "catalog growth does not discard or redownload validated files");
    assert.deepEqual(result.rows, Object.fromEntries(models.map(model => [model, 2])));
    for (const model of models) assert.deepEqual(await readFile(path.join(directory, model + ".jsonl")), body);
  } finally {
    controller.abort(); await work?.catch(() => {});
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("promotion retries a short publication capture lock instead of failing the input download", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "automation-promotion-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const old = '{"id":"old"}\n', body = Buffer.from('{"id":"new"}\n');
  await writeFile(path.join(directory, "a_fast.jsonl"), old);
  const release = await runLock(path.join(directory, ".snapshot"));
  const remote = new RemoteInputs("http://127.0.0.1:1", 1000, ["a_fast"]);
  t.mock.method(remote, "download", async () => ({ name: "a_fast.jsonl", size: body.length, rows: 1,
    chunks: (async function* () { yield body; })(), close: async () => {} }));
  const day = { date: "2026-10-24", rows: { a_fast: 1 } };
  const job = { runIds: [], evaluation: "completed" } as unknown as AutomationJob;
  const work = syncRemoteInputs(remote, directory, directory, job, day, t.signal, async () => {});
  await Promise.all([work, (async () => {
    await delay(75);
    try { assert.equal(await readFile(path.join(directory, "a_fast.jsonl"), "utf8"), old); }
    finally { await release(); }
  })()]);
  assert.deepEqual(await readFile(path.join(directory, "a_fast.jsonl")), body);
});
