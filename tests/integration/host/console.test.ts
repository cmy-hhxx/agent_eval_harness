import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { rm } from "node:fs/promises";
import { readJson, writeJson } from "@eval/data";
import { ConsoleTasks, type ConsoleConfig, type executeConsoleTask } from "../../../apps/host/src/console-tasks.js";
import { serveConsole } from "../../../apps/host/src/console-server.js";
import { initializeServices } from "@eval/host-app/composition";
import { fixtureConfig } from "../../fixtures/comparison.js";

test("console API previews frozen defaults, starts idempotently, drains, resumes and restores interrupted state", { timeout: 15000 }, async t => {
  const f = await fixtureConfig();
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const previousLog = process.env.EVAL_LOG_DIR, previousLock = process.env.EVAL_LOG_LOCK_DIR;
  process.env.EVAL_LOG_DIR = path.join(f.directory, "log"); process.env.EVAL_LOG_LOCK_DIR = path.join(f.directory, "log-lock");
  t.after(() => {
    if (previousLog === undefined) delete process.env.EVAL_LOG_DIR; else process.env.EVAL_LOG_DIR = previousLog;
    if (previousLock === undefined) delete process.env.EVAL_LOG_LOCK_DIR; else process.env.EVAL_LOG_LOCK_DIR = previousLock;
  });
  await initializeServices();
  const source = path.join(f.directory, "source.json");
  const models = { judge: { channel: "evaluation-gateway", model: "fixture", thinking: "off" } };
  await writeJson(source, { ...f.config, evaluatorVersion: "fixture", models, bindings: f.models.bindings });
  const config: ConsoleConfig = { hostname: "127.0.0.1", port: 0, stateDirectory: path.join(f.directory, "console"),
    logDirectory: process.env.EVAL_LOG_DIR, passwordFile: "unused", channels: ["evaluation-gateway"],
    presets: [{ id: "wencai", source: "wencai", name: "问财对比", concurrency: 2, configs: [source], inputRoots: [f.directory] }] };
  let starts = 0, release: (() => void) | undefined, execution: Parameters<typeof executeConsoleTask>[0] | undefined;
  const manager = new ConsoleTasks(config, { preflight: async () => [], execute: async value => {
    execution = value; starts++;
    await new Promise<void>(resolve => { release = resolve; });
    return { execution_task_statuses: { succeeded: 1 }, paused_stages: [] };
  } });
  await manager.initialize();
  const password = "test-console-password-1234", server = await serveConsole(manager, password);
  t.after(async () => { release?.(); await manager.close(); await server.close(); });
  const request = async (route: string, value?: unknown, authenticated = true) => {
    const response = await fetch(server.url + route, { method: value === undefined ? "GET" : "POST",
      headers: { ...(authenticated ? { authorization: "Bearer " + password } : {}), "content-type": "application/json" },
      body: value === undefined ? undefined : JSON.stringify(value) });
    return { status: response.status, data: await response.json() as Record<string, unknown> };
  };
  assert.equal((await request("/api/tasks", undefined, false)).status, 401);
  assert.equal((await request("/api/tasks", {}, false)).status, 403);
  const preview = await request("/api/previews", { preset: "wencai", concurrency: 2, output: f.config.output.path,
    inputs: Object.fromEntries(f.config.inputs.versions.map(v => [v.id, v.sources.map(s => s.path)])) });
  assert.equal(preview.status, 201, JSON.stringify(preview.data));
  assert.equal(starts, 0);
  const id = String(preview.data.id);
  const frozen = await readJson<{ models: unknown; bindings: unknown }>(path.join(config.stateDirectory, id, "config.json"));
  assert.deepEqual(frozen.models, models); assert.deepEqual(frozen.bindings, JSON.parse(JSON.stringify(f.models.bindings)));
  assert.deepEqual(Object.keys((await request(`/api/tasks/${id}/configuration`)).data).sort(), ["concurrency", "inputs", "output", "preset"]);
  await Promise.all([request("/api/tasks", { previewId: id }), request("/api/tasks", { previewId: id })]);
  for (let n = 0; n < 100 && starts === 0; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(starts, 1);
  await request(`/api/tasks/${id}/concurrency`, { concurrency: 5 });
  assert.equal(execution!.gate.concurrency(), 5);
  await request(`/api/tasks/${id}/concurrency`, { concurrency: 1 });
  assert.equal(execution!.gate.concurrency(), 1);
  const paused = await request(`/api/tasks/${id}/pause`, {});
  assert.equal(paused.data.status, "pausing"); assert.equal(execution!.pause.aborted, true);
  release!();
  for (let n = 0; n < 100 && manager.get(id).status === "pausing"; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(manager.get(id).status, "paused");
  await request(`/api/tasks/${id}/resume`, {});
  for (let n = 0; n < 100 && starts < 2; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(starts, 2); assert.equal(execution!.id, id);
  const restored = new ConsoleTasks(config);
  await restored.initialize(); assert.equal(restored.get(id).status, "paused");
  release!();
  for (let n = 0; n < 100 && manager.get(id).status === "running"; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(manager.get(id).status, "finished");
});
