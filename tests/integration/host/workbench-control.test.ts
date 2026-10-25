import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { runLock } from "@eval/data";
import type { WorkbenchConfig } from "../../../apps/host/src/workbench-config.js";
import { openWorkbenchControl, stopWorkbench, workbenchLogs, workbenchStatus } from "../../../apps/host/src/workbench-control.js";

async function fixture(t: test.TestContext): Promise<WorkbenchConfig> {
  const directory = await mkdtemp("/tmp/wb-control-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, "instance"));
  return { file: path.join(directory, "workbench.json"), root: directory, publicOrigin: "http://example.test", secretsFile: "unused",
    listen: { host: "127.0.0.1", port: 5001 }, data: { host: "127.0.0.1", port: 8081, root: directory, stateRoot: directory, pythonPackages: directory },
    runtime: { instanceLockDirectory: path.join(directory, "instance"), logDirectory: directory, automationPort: 4174, runsPort: 4173,
      configDirectory: directory, evalConfigFile: "unused", manifest: "unused", schedulingFile: "unused", statisticsDeliveryFile: "unused",
      hostConfigs: ["unused"], logLockDirectory: directory }, restart: { limit: 0, windowMs: 1000, baseDelayMs: 1, maxDelayMs: 1 }, shutdownTimeoutMs: 100 };
}

test("stopped status and stop never create state or start a process", async t => {
  const config = await fixture(t);
  assert.equal(await workbenchStatus(config), undefined);
  await stopWorkbench(config);
  assert.deepEqual(await readdir(config.runtime.instanceLockDirectory), []);
});

test("control socket reports starting state, verifies instance and configuration, and waits for stop", async t => {
  const config = await fixture(t), release = await runLock(config.runtime.instanceLockDirectory);
  let stopCalls = 0, stopped = false, close!: () => Promise<void>;
  close = await openWorkbenchControl(config, () => ({ phase: "starting", services: { data: false } }), () => {
    stopCalls++;
    void (async () => { await close(); await release(); stopped = true; })();
  });
  t.after(async () => { if (!stopped) { await close(); await release(); } });
  assert.equal((await stat(path.join(config.runtime.instanceLockDirectory, "control.sock"))).mode & 0o777, 0o600);
  const status = await workbenchStatus(config);
  assert.equal(status?.phase, "starting"); assert.equal(status?.pid, process.pid);
  await assert.rejects(workbenchStatus({ ...config, file: "another.json" }), /another Workbench configuration/);
  const rejected = await new Promise<number>(resolve => {
    const req = http.request({ socketPath: path.join(config.runtime.instanceLockDirectory, "control.sock"), path: "/stop", method: "POST",
      headers: { "x-workbench-instance": "stale-instance" } }, res => { res.resume(); res.once("end", () => resolve(res.statusCode!)); });
    req.end();
  });
  assert.equal(rejected, 409); assert.equal(stopCalls, 0);
  await stopWorkbench(config);
  assert.equal(stopCalls, 1); assert.equal(stopped, true);
});

test("an alive owner without control is reported explicitly and never signalled", async t => {
  const config = await fixture(t), release = await runLock(config.runtime.instanceLockDirectory);
  try {
    await assert.rejects(workbenchStatus(config), /owner is alive/);
    await assert.rejects(stopWorkbench(config), /owner is alive/);
  } finally { await release(); }
});

test("logs reject invalid names and counts before opening files", async t => {
  const config = await fixture(t);
  await assert.rejects(workbenchLogs(config, { log: "../secrets" }), /--log/);
  for (const lines of ["0", "-1", "1.5", "NaN", "999999999999999999999"])
    await assert.rejects(workbenchLogs(config, { lines }), /--lines/);
});

test("control CLI reads existing logs and stopped status without credentials or starting services", async t => {
  const config = await fixture(t), entry = fileURLToPath(new URL("../../../apps/host/src/workbench.js", import.meta.url));
  await writeFile(config.file, JSON.stringify({ ...config, file: undefined, root: undefined }));
  await writeFile(path.join(config.runtime.logDirectory, "evaluation.log"), "first\nsecond\nthird\n");
  const exec = promisify(execFile);
  const run = (...args: string[]) => exec(process.execPath, [entry, ...args, "--config", config.file], { cwd: config.root, timeout: 5000 });
  const { stdout } = await run("status");
  assert.deepEqual(JSON.parse(stdout), { phase: "stopped" });
  assert.match((await run("stop")).stdout, /stopped/);
  assert.equal((await run("logs", "--log", "evaluation", "--lines", "2")).stdout, "second\nthird\n");
  assert.deepEqual(await readdir(config.runtime.instanceLockDirectory), []);
  assert.equal((await readdir(config.runtime.logDirectory)).includes("runtime.log"), false);
});
