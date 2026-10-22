import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomBytes, scrypt } from "node:crypto";
import { promisify } from "node:util";
import { appendStatisticsLog } from "@eval/data";
import { PublicationStatistics } from "@eval/workflows/comparison";
import { loadWorkbenchConfig } from "../../../apps/host/src/workbench-config.js";
import { bearerMatches, cookieValue, loadWorkbenchSecrets, SessionStore, sessionCookie, verifyPassword } from "../../../apps/host/src/workbench-auth.js";
import { StatisticsDeliveryStore } from "../../../apps/host/src/statistics-delivery.js";
import { workbenchProxyTarget } from "../../../apps/host/src/workbench-routes.js";

const passwordHash = async (password: string) => {
  const salt = randomBytes(16), hash = await promisify(scrypt)(password, salt, 64) as Buffer;
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
};

test("workbench config resolves every runtime path and rejects unknown settings", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "workbench-config-"));
  try {
    const runtime = path.join(root, "runtime"), data = path.join(root, "data");
    await mkdir(path.join(runtime, "config"), { recursive: true }); await mkdir(data);
    for (const name of ["host.json", "models.json", "automations.json", "config.ini", "secrets.env"])
      await writeFile(path.join(runtime, "config", name), name.endsWith(".json") ? "{}\n" : "");
    const config = { publicOrigin: "http://117.50.195.94:3309", listen: { host: "0.0.0.0", port: 5001 },
      secretsFile: "config/secrets.env", data: { host: "127.0.0.1", port: 8081, root: data,
        stateRoot: "state/data", pythonPackages: "python" }, runtime: { automationPort: 4174, runsPort: 4173,
        configDirectory: "config", evalConfigFile: "config/config.ini", manifest: "config/automations.json",
        schedulingFile: "state/scheduling.json", statisticsDeliveryFile: "state/delivery.json",
        hostConfigs: ["config/host.json", "config/models.json"], logDirectory: "log", logLockDirectory: "state/log-writer",
        instanceLockDirectory: "state/workbench" }, restart: { limit: 5, windowMs: 300000, baseDelayMs: 1000, maxDelayMs: 16000 },
      shutdownTimeoutMs: 90000 };
    const file = path.join(runtime, "workbench.json"); await writeFile(file, JSON.stringify(config));
    const loaded = await loadWorkbenchConfig(file);
    assert.equal(loaded.data.root, data);
    assert.equal(loaded.runtime.logDirectory, path.join(runtime, "log"));
    assert.equal(loaded.runtime.hostConfigs.length, 2);
    await writeFile(file, JSON.stringify({ ...config, version: 1 }));
    await assert.rejects(loadWorkbenchConfig(file), /unknown=\[version]/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("single-admin credentials, sessions and relay bearer tokens are validated without persisting sessions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "workbench-auth-"));
  try {
    const file = path.join(root, "secrets.env"), hash = await passwordHash("fixture-password");
    await writeFile(file, `WORKBENCH_ADMIN_USER=cmy\nWORKBENCH_PASSWORD_HASH=${hash}\nWORKBENCH_RELAY_TOKEN=relay-token\n`, { mode: 0o600 });
    await chmod(file, 0o600);
    const secrets = await loadWorkbenchSecrets(file);
    assert.equal(secrets.adminUser, "cmy");
    assert.equal(await verifyPassword("fixture-password", secrets.passwordHash), true);
    assert.equal(await verifyPassword("wrong", secrets.passwordHash), false);
    assert.equal(bearerMatches("Bearer relay-token", secrets.relayToken), true);
    assert.equal(bearerMatches("Bearer wrong", secrets.relayToken), false);
    const sessions = new SessionStore(), id = sessions.create("cmy");
    assert.equal(sessions.read(id)?.user, "cmy");
    assert.equal(cookieValue(`a=1; ${sessionCookie(id).split(";")[0]}`, "workbench_session"), id);
    sessions.delete(id); assert.equal(sessions.read(id), undefined);
    await chmod(file, 0o644);
    await assert.rejects(loadWorkbenchSecrets(file), /must not be accessible/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("statistics deliveries never resend uncertain records and require explicit resolution", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "statistics-delivery-"));
  try {
    const logFile = path.join(root, "statistics.jsonl"), stateFile = path.join(root, "delivery.json");
    const record = new PublicationStatistics([]).record("snapshot-one", Date.now());
    await appendStatisticsLog(logFile, record);
    const store = new StatisticsDeliveryStore(stateFile), source = { id: "remote-evaluation", logFile, logUrl: "http://reports.test/logs" };
    await store.register(source, record);
    assert.equal((await store.list([source]))[0].status, "pending");
    assert.equal((await store.claim("snapshot-one")).status, "sending");
    await assert.rejects(store.claim("snapshot-one"), /already claimed/);
    await store.receipt("snapshot-one", { status: "uncertain", error: "response lost" });
    await assert.rejects(store.claim("snapshot-one"), /not pending/);
    assert.equal((await store.list([source]))[0].status, "uncertain");
    await store.resolve("snapshot-one", { outcome: "retry" });
    assert.equal((await store.claim("snapshot-one")).status, "sending");
    await store.receipt("snapshot-one", { status: "uploaded", requestId: "req-1" });
    const uploaded = await store.receipt("snapshot-one", { status: "uploaded", requestId: "req-1" });
    assert.equal(uploaded.status, "uploaded");
    await assert.rejects(store.receipt("snapshot-one", { status: "uploaded", requestId: "req-2" }), /different receipt/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("public routing exposes only data and runtime regions and never forwards old top-level paths", () => {
  const ports = { data: 8081, automation: 4174, runs: 4173 };
  assert.deepEqual(workbenchProxyTarget("/data/wencai/dashboard-data", ports), { port: 8081, path: "/data/wencai/dashboard-data" });
  assert.deepEqual(workbenchProxyTarget("/runtime/", ports), { port: 4174, path: "/" });
  assert.deepEqual(workbenchProxyTarget("/runtime/api/status", ports), { port: 4174, path: "/api/status" });
  assert.deepEqual(workbenchProxyTarget("/runtime/api/relay/records", ports), { port: 4174, path: "/api/relay/records" });
  assert.deepEqual(workbenchProxyTarget("/runtime/api/dashboard/runs", ports), { port: 4173, path: "/api/dashboard/runs" });
  assert.deepEqual(workbenchProxyTarget("/runtime/runs/", ports), { port: 4173, path: "/" });
  assert.deepEqual(workbenchProxyTarget("/runtime/problems", ports), { port: 4173, path: "/problems" });
  assert.deepEqual(workbenchProxyTarget("/runtime/reference", ports), { port: 4173, path: "/reference" });
  for (const old of ["/aime/", "/ifind/", "/gpt/", "/post_training_model/", "/api/status", "/dashboard"])
    assert.equal(workbenchProxyTarget(old, ports), undefined, old);
});
