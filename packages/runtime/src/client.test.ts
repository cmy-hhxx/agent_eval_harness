import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";
import { spawnWorker } from "./client.js";
import { waitForTestState } from "../../../tests/fixtures/wait.js";

const workerScript = (body: string, beforeReady = "") => `import { createServer } from "node:http";
import { writeFileSync, writeSync } from "node:fs";
import { spawn } from "node:child_process";
const server = createServer((request, response) => {
  response.end("ok");
  if (request.url === "/exit") setImmediate(() => { ${body} });
});
server.listen(0, "127.0.0.1", () => { ${beforeReady} process.send({ type: "ready", url: "http://127.0.0.1:" + server.address().port }); });
process.once("SIGTERM", () => {
  process.send({ type: "shutdown", reason: "SIGTERM" }, () => server.close(() => process.exit(0)));
});
process.once("disconnect", () => server.close(() => process.exit(0)));
`;

async function fixture(body: string) {
  const root = await mkdtemp(path.join(tmpdir(), "worker-lifecycle-test-"));
  const workerEntry = path.join(root, "worker.mjs");
  await writeFile(workerEntry, workerScript(body));
  const worker = await spawnWorker("pi", path.join(root, "workspace"), { root, workerEntry });
  return { worker, async close() { await worker.close(); await rm(root, { recursive: true, force: true }); } };
}

test("a managed Worker retains a ready-then-crashed process's identity and final stderr", async () => {
  const f = await fixture('writeSync(2, "x".repeat(13000) + "last fatal diagnostic"); process.exit(7);');
  try {
    assert(Number.isSafeInteger(f.worker.pid));
    assert(f.worker.exited instanceof Promise, "ready must not discard the process exit observer");
    await fetch(f.worker.url + "/exit");
    const exit = await f.worker.exited;
    assert.equal(exit.pid, f.worker.pid);
    assert.equal(exit.url, f.worker.url);
    assert.equal(exit.exitCode, 7);
    assert.equal(exit.signal, null);
    assert.equal(exit.expectedClose, false);
    assert.equal(exit.stderr.length, 12000);
    assert(exit.stderr.endsWith("last fatal diagnostic"));
    assert(Number.isFinite(exit.exitedAt));
    assert(Object.isFrozen(exit));
    await f.worker.close();
    assert.equal((await f.worker.exited).expectedClose, false, "cleanup cannot relabel an earlier crash as expected");
  } finally { await f.close(); }
});

test("close records an expected graceful shutdown and its child-reported signal", async () => {
  const f = await fixture('process.exit(9);');
  try {
    await f.worker.close();
    const exit = await f.worker.exited;
    assert.equal(exit.exitCode, 0);
    assert.equal(exit.signal, null, "the CLI handles SIGTERM and exits normally");
    assert.equal(exit.expectedClose, true);
    assert.equal(exit.shutdownReason, "SIGTERM");
    assert.equal(typeof exit.disconnectedAt, "number");
    await f.worker.close();
    assert.equal(await f.worker.exited, exit);
  } finally { await f.close(); }
});

test("cleanup preserves an already reported unexpected shutdown and its first reason", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "worker-shutdown-test-"));
  const workerEntry = path.join(root, "worker.mjs");
  // IPC is ordered: observing ready guarantees the prior shutdown was observed.
  await writeFile(workerEntry, workerScript('process.exit(9);', 'process.send({ type: "shutdown", reason: "SIGINT" });'));
  const worker = await spawnWorker("pi", path.join(root, "workspace"), { root, workerEntry });
  try {
    await worker.close();
    const exit = await worker.exited;
    assert.equal(exit.expectedClose, false, "cleanup did not initiate the reported shutdown");
    assert.equal(exit.shutdownReason, "SIGINT", "cleanup must not overwrite the first observed shutdown reason");
  } finally { await worker.close(); await rm(root, { recursive: true, force: true }); }
});

test("unexpected IPC disconnect is observed without inventing its cause or hanging cleanup", async () => {
  const f = await fixture('process.disconnect(); server.close(() => process.exit(3));');
  try {
    await fetch(f.worker.url + "/exit");
    const exit = await f.worker.exited;
    assert.equal(exit.exitCode, 3);
    assert.equal(exit.expectedClose, false);
    assert.equal(typeof exit.disconnectedAt, "number");
    assert.equal(exit.shutdownReason, undefined);
    await f.worker.close();
  } finally { await f.close(); }
});

test("an externally killed ready Worker retains its actual signal without stopping its parent", async () => {
  const f = await fixture('process.exit(9);');
  try {
    process.kill(f.worker.pid, "SIGKILL");
    const exit = await f.worker.exited;
    assert.equal(exit.exitCode, null);
    assert.equal(exit.signal, "SIGKILL");
    assert.equal(exit.expectedClose, false);
    assert.equal(exit.shutdownReason, undefined);
  } finally { await f.close(); }
});

test("an exited Worker's inherited stderr cannot keep its parent waiting for cleanup", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "worker-stderr-test-"));
  const workerEntry = path.join(root, "worker.mjs"), release = path.join(root, "release"), pidFile = path.join(root, "pid");
  const leaf = `const fs = require("node:fs"); setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) process.exit(0); }, 10); process.send("ready");`;
  await writeFile(workerEntry, workerScript(`const child = spawn(process.execPath, ["-e", ${JSON.stringify(leaf)}], { detached: true, stdio: ["ignore", "ignore", "inherit", "ipc"] }); child.once("message", () => { writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); writeSync(2, "final stderr before exit"); process.exit(7); });`));
  const worker = await spawnWorker("pi", path.join(root, "workspace"), { root, workerEntry });
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    await fetch(worker.url + "/exit");
    await waitForTestState(async () => alive(worker.pid), value => !value, "fixture Worker must exit");
    const exit = await Promise.race([worker.exited, new Promise<undefined>(resolve => setTimeout(resolve, 100))]);
    assert(exit, "a grandchild's open stderr must not hold the managed Worker's exit observation");
    assert.equal(exit.exitCode, 7);
    assert.equal(exit.stderr, "final stderr before exit");
    await worker.close();
  } finally {
    await writeFile(release, "release");
    const pid = Number(await readFile(pidFile, "utf8"));
    await waitForTestState(async () => alive(pid), value => !value, "fixture descendant must stop after release");
    await worker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("startup failure still reports its original stderr and exit code", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "worker-startup-test-"));
  const workerEntry = path.join(root, "worker.mjs");
  try {
    await writeFile(workerEntry, 'import { writeSync } from "node:fs"; writeSync(2, "fixture startup failed"); process.exit(9);');
    await assert.rejects(spawnWorker("pi", path.join(root, "workspace"), { root, workerEntry }), /Worker exited 9: fixture startup failed/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const shutdown of ["close", "disconnect"] as const) test(`six Workers survive their parent's group signal and leave no orphans after ${shutdown}`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "worker-group-test-"));
  const workerEntry = path.join(root, "worker.mjs"), hostEntry = path.join(root, "host.mjs");
  await writeFile(workerEntry, workerScript('process.exit(9);'));
  await writeFile(hostEntry, `import { spawnWorker } from ${JSON.stringify(new URL("./client.js", import.meta.url).href)};
process.on("SIGTERM", () => process.send({ type: "signal" }));
const workers = await Promise.all(Array.from({ length: 6 }, () => spawnWorker("pi", ${JSON.stringify(path.join(root, "workspace"))}, ${JSON.stringify({ root, workerEntry })})));
process.send({ type: "ready", pids: workers.map(worker => worker.pid) });
process.on("message", async message => {
  if (message === "check") {
    await new Promise(resolve => setTimeout(resolve, 50));
    const alive = await Promise.all(workers.map(async worker => { try { return (await fetch(worker.url)).ok; } catch { return false; } }));
    process.send({ type: "checked", alive });
  } else if (message === "close") {
    await Promise.all(workers.map(worker => worker.close()));
    const exits = await Promise.all(workers.map(worker => worker.exited));
    process.send({ type: "closed", expected: exits.map(exit => exit.expectedClose) }, () => process.exit(0));
  } else if (message === "disconnect") process.exit(0);
});`);
  // Only the fixture Host owns this group. Never signal the test runner's group.
  const host = fork(hostEntry, [], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  let pids: number[] = [];
  try {
    const [ready] = await once(host, "message") as [{ type: string; pids: number[] }];
    assert.equal(ready.type, "ready");
    pids = ready.pids;
    const signalled = once(host, "message");
    process.kill(-host.pid!, "SIGTERM");
    assert.equal((await signalled)[0].type, "signal", "the fixture parent must survive the group signal");
    const checked = once(host, "message");
    host.send("check");
    assert.deepEqual((await checked)[0].alive, Array(6).fill(true), "the parent's group signal must not reach managed Workers");
    const exited = once(host, "exit");
    const closed = shutdown === "close" ? once(host, "message") : undefined;
    host.send(shutdown);
    if (closed) assert.deepEqual((await closed)[0].expected, Array(6).fill(true));
    assert.equal((await exited)[0], 0);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (pids.every(pid => { try { process.kill(pid, 0); return false; } catch { return true; } })) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail("managed Workers must exit when their parent closes or loses IPC");
  } finally {
    if (host.exitCode === null && host.signalCode === null) {
      const exited = once(host, "exit");
      host.kill("SIGKILL");
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
});
