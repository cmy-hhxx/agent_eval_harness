import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeJson } from "@eval/data";
import { ROOT } from "../../fixtures/services.js";
import { writeTestSettings } from "../../fixtures/settings.js";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
test("serve starts no source work on startup or restart; only the selected run starts discovery", { timeout: 15000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "automation-serve-"));
  let discoveries = 0, child: ChildProcess | undefined, output = "";
  const remote = createServer((_req, res) => { discoveries++; res.setHeader("content-type", "application/json"); res.end('{"dates":[]}'); });
  await new Promise<void>(resolve => remote.listen(0, "127.0.0.1", resolve));
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const url = `http://127.0.0.1:${port}`;
  const wait = async (condition: () => Promise<boolean> | boolean) => {
    for (let i = 0; i < 250; i++) { if (await condition()) return; await delay(10); }
    assert.fail("automation did not reach expected state: " + output);
  };
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
  };
  try {
    const ini = await writeTestSettings(directory);
    const hostFile = path.join(directory, "host.json");
    await writeJson(hostFile, { output: { kind: "directory", path: path.join(directory, "runs") }, models: { judge: { model: "fixture" } } });
    const base = JSON.parse(await readFile(path.join(ROOT, "configs/automations.json"), "utf8"));
    const sourceUrl = `http://127.0.0.1:${(remote.address() as { port: number }).port}/data/wencai`;
    for (const id of ["a", "b"]) await writeJson(path.join(directory, id + ".json"), {
      ...base, id, sourceUrl, hostConfigs: [path.join(ROOT, "configs/host.json"), hostFile],
      stateDirectory: path.join(directory, id, "state"), sourceDirectory: path.join(directory, id, "input"),
      runPrefix: id + "-", channelConcurrency: {}, pollMs: 20, publishMongo: id === "b", publishProgress: false, publishStatisticsLog: false,
      publication: { ...base.publication, mongoUriEnv: "WORKBENCH_TEST_MONGO_MISSING" },
    });
    // A historical running flag must not auto-activate after a crash/restart.
    const stateFile = path.join(directory, "a/state/state.json");
    const historical = { id: "a", sourceUrl, status: "running", startedAt: 1, updatedAt: 1, jobs: {} };
    await writeJson(stateFile, historical);
    const launch = () => {
      child = spawn(process.execPath, [path.join(ROOT, "dist/apps/host/src/automations.js"), "serve", "--port", String(port),
        "--config", path.join(directory, "a.json"), "--config", path.join(directory, "b.json")], {
        cwd: ROOT, env: { ...process.env, EVAL_CONFIG_FILE: ini, EVAL_LOG_DIR: path.join(directory, "log"),
          EVAL_LOG_LOCK_DIR: path.join(directory, "log-lock"), EVAL_AUTOMATION_SCHEDULING_FILE: path.join(directory, "scheduling.json"),
          EVAL_STATISTICS_DELIVERY_FILE: path.join(directory, "delivery.json") }, stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout!.on("data", chunk => { output += chunk; }); child.stderr!.on("data", chunk => { output += chunk; });
    };
    const snapshot = async (id = "a") => await (await fetch(url + "/api/status?source=" + id)).json() as { status: string; control: { status: string; error?: string }; sources: { id: string; control: { status: string } }[] };
    const control = (sourceId: string, action: string, origin = url) => fetch(url + "/api/control", { method: "POST",
      headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ sourceId, action }) });
    const ready = () => wait(async () => { try { return (await fetch(url + "/api/health")).ok; } catch { return false; } });
    launch(); await ready(); await delay(150);
    assert.equal(discoveries, 0);
    assert.equal((await fetch(url + "/api/control", { method: "POST", headers: { origin: url, "content-type": "application/json" },
      body: JSON.stringify({ sourceId: "a", action: ["run"] }) })).status, 400);
    assert.deepEqual(JSON.parse(await readFile(stateFile, "utf8")), historical);
    assert.equal((await snapshot()).control.status, "idle");
    assert.equal((await snapshot()).status, "stopped");
    assert.equal((await control("a", "run", "http://other.test")).status, 403);
    assert.equal((await control("a", "invalid")).status, 400);
    assert.equal((await control("unknown", "run")).status, 404);
    assert.equal(discoveries, 0);
    assert.equal((await control("a", "run")).status, 200);
    assert.equal((await control("a", "run")).status, 409);
    await wait(() => discoveries > 0);
    assert.equal((await snapshot()).sources.find(source => source.id === "b")!.control.status, "idle");
    assert.equal((await control("a", "stop")).status, 200);
    await wait(async () => (await snapshot()).control.status === "idle");
    const stopped = discoveries;
    await delay(150); assert.equal(discoveries, stopped);
    assert.equal((await control("b", "run")).status, 200);
    await wait(async () => (await snapshot("b")).control.status === "failed");
    assert.match((await snapshot("b")).control.error!, /Missing WORKBENCH_TEST_MONGO_MISSING/);
    assert.equal((await snapshot()).control.status, "idle");
    assert.equal(discoveries, stopped);
    await stop(); launch(); await ready(); await delay(150);
    assert.equal((await snapshot()).control.status, "idle");
    assert.equal(discoveries, stopped);
    assert.equal((await control("a", "run")).status, 200);
    await wait(() => discoveries > stopped);
  } finally {
    await stop(); await new Promise<void>(resolve => remote.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
