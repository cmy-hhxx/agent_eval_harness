import { createChannelRequests } from "@eval/host";
import { consoleLog } from "./files.js";
import { executeConsoleTask } from "./evaluation.js";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { realpath, rm } from "node:fs/promises";
import { readJson, writeJson, writeJsonl } from "@eval/data";
import { ConsoleTasks, type ConsoleConfig } from "./tasks.js";
import { serveConsole } from "./server.js";
import { initializeServices } from "@eval/host-app/composition";
import { fixtureConfig, raw } from "../../../tests/fixtures/comparison.js";

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
  const inputDirectory = path.join(f.directory, "input");
  for (const version of f.config.inputs.versions) await writeJsonl(path.join(inputDirectory, version.id + ".jsonl"), [raw()]);
  const models = { judge: { channel: "evaluation-gateway", model: "fixture", thinking: "off" } };
  await writeJson(source, { ...f.config, inputs: { ...f.config.inputs, limit: 1, case_ids: ["not-in-parent"] },
    evaluatorVersion: "fixture", models, bindings: f.models.bindings });
  const config: ConsoleConfig = { hostname: "127.0.0.1", port: 0, stateDirectory: path.join(f.directory, "console"),
    logDirectory: process.env.EVAL_LOG_DIR, passwordFile: "unused", channels: ["evaluation-gateway"],
    presets: [{ id: "wencai", source: "wencai", name: "问财对比", concurrency: 2, configs: [source], inputRoots: [f.directory] }] };
  let starts = 0, release: (() => void) | undefined, execution: Parameters<typeof executeConsoleTask>[0] | undefined;
  const manager = new ConsoleTasks(config, { preflight: async () => [], execute: async value => {
    execution = value; starts++;
    value.progress('progress {"complete":1,"queued":2,"running":1,"failed":0}');
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
    inputDirectory });
  assert.equal(preview.status, 201, JSON.stringify(preview.data));
  assert.equal(starts, 0);
  const id = String(preview.data.id);
  for (let n = 0; n < 100 && manager.get(id).dataCheck?.status === "checking"; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(manager.get(id).dataCheck?.status, "ready");
  const frozen = await readJson<{ models: unknown; bindings: unknown; inputs: Record<string, unknown> }>(path.join(config.stateDirectory, id, "config.json"));
  assert.deepEqual(frozen.models, models); assert.deepEqual(frozen.bindings, JSON.parse(JSON.stringify(f.models.bindings)));
  assert.equal(frozen.inputs.limit, undefined); assert.equal(frozen.inputs.case_ids, undefined);
  assert.deepEqual(Object.keys((await request(`/api/tasks/${id}/configuration`)).data).sort(), ["concurrency", "inputDirectory", "logs", "output", "preset"]);
  assert.equal(manager.get(id).inputDirectory, await realpath(inputDirectory));
  assert.equal(manager.get(id).dataCheck?.total, 1);
  await Promise.all([request("/api/tasks", { previewId: id }), request("/api/tasks", { previewId: id })]);
  for (let n = 0; n < 100 && starts === 0; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(starts, 1);
  assert.deepEqual(manager.get(id).progress, { completed: 1, total: 4, failed: 0 });
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
  const overlap = await request("/api/previews", { preset: "wencai", concurrency: 2, output: path.join(inputDirectory, "output"), inputDirectory });
  assert.equal(overlap.status, 400); assert.match(String(overlap.data.error), /重叠/);
  for (const version of f.config.inputs.versions) await writeJsonl(version.sources[0].path, [{ ...raw("invalid"), messages: [] }]);
  for (const version of f.config.inputs.versions) await writeJsonl(path.join(inputDirectory, version.id + ".jsonl"), [{ ...raw("invalid"), messages: [] }]);
  const empty = await request("/api/previews", { preset: "wencai", concurrency: 2, output: f.config.output.path, inputDirectory });
  assert.equal(empty.status, 201);
  for (let n = 0; n < 100 && manager.get(String(empty.data.id)).dataCheck?.status === "checking"; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await request("/api/tasks", { previewId: empty.data.id })).status, 409);
  assert.equal(starts, 2, "checking invalid inputs must never start evaluation");
  const invalid = await executeConsoleTask({ host: { workflow: "comparison", evaluation: f.config, models: f.models, evaluatorVersion: "fixture" },
    id: "console-invalid-input", gate: createChannelRequests({ "evaluation-gateway": 1 }), pause: new AbortController().signal,
    channels: ["evaluation-gateway"], progress() {} });
  assert.equal(invalid.outcome, "partial");
  assert.deepEqual(invalid.execution_task_statuses, {});
  const errors = await consoleLog(path.join(config.logDirectory, "runtime.log"), "console-invalid-input", true);
  assert(errors.rows.some(row => String(row.message).includes(f.config.inputs.versions[0].sources[0].path + ":1 ") &&
    String(row.detail).includes("[cause]")), "invalid input keeps its file, line and diagnostic details in the log");
});
