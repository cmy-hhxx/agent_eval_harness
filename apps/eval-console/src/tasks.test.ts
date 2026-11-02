import { createChannelRequests } from "@eval/host";
import { consoleLog } from "./files.js";
import { executeConsoleTask } from "./evaluation.js";
import { loadInputSchedule } from "./rounds.js";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { realpath, rm } from "node:fs/promises";
import { exists, fileSourceReader, InputDirectoryStats, readJson, runLayout, writeJson, writeJsonl } from "@eval/data";
import { ConsoleTasks, type ConsoleConfig } from "./tasks.js";
import { serveConsole } from "./server.js";
import { initializeServices } from "@eval/host-app/composition";
import { emptyUsage, type RunState } from "@eval/contracts";
import { buildPlan, comparisonRepository } from "@eval/workflows/comparison";
import { fakeIdentity, fixtureConfig, raw } from "../../../tests/fixtures/comparison.js";

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
  const inputDirectory = path.join(f.directory, "eval_input");
  for (const version of f.config.inputs.versions) await writeJsonl(path.join(inputDirectory, version.id + ".jsonl"), [raw()]);
  const models = { judge: { channel: "evaluation-gateway", model: "fixture", thinking: "off" } };
  await writeJson(source, { ...f.config, inputs: { ...f.config.inputs, default_batch_id: "preset_batch", limit: 1, case_ids: ["not-in-parent"] },
    evaluatorVersion: "fixture", models, bindings: f.models.bindings });
  const config: ConsoleConfig = { hostname: "127.0.0.1", port: 0, stateDirectory: path.join(f.directory, "console"),
    inputStatsFile: path.join(f.directory, "eval_input_stats.json"), directoryRoot: f.directory,
    logDirectory: process.env.EVAL_LOG_DIR, passwordFile: "unused", channels: ["evaluation-gateway"],
    presets: [{ id: "wencai", source: "wencai", name: "问财对比", concurrency: 2, configs: [source] }] };
  let starts = 0, release: (() => void) | undefined, execution: Parameters<typeof executeConsoleTask>[0] | undefined;
  const manager = new ConsoleTasks(config, { preflight: async () => [], execute: async value => {
    execution = value; starts++;
    value.progress('progress {"complete":1,"queued":2,"running":1,"failed":0}');
    await new Promise<void>(resolve => { release = resolve; });
    return { execution_task_statuses: { succeeded: 1 }, paused_stages: [] };
  } });
  await manager.initialize();
  const directories = new InputDirectoryStats(config.inputStatsFile, config.directoryRoot);
  await directories.initialize(); await directories.refresh();
  t.after(() => directories.close());
  const password = "test-console-password-1234", server = await serveConsole(manager, password, directories);
  t.after(async () => { release?.(); await manager.close(); await server.close(); });
  const request = async (route: string, value?: unknown, authenticated = true) => {
    const response = await fetch(server.url + route, { method: value === undefined ? "GET" : "POST",
      headers: { ...(authenticated ? { authorization: "Bearer " + password } : {}), "content-type": "application/json" },
      body: value === undefined ? undefined : JSON.stringify(value) });
    return { status: response.status, data: await response.json() as Record<string, unknown> };
  };
  assert.equal((await request("/api/tasks", undefined, false)).status, 401);
  assert.equal((await request("/api/tasks", {}, false)).status, 403);
  const folder = await request("/api/directories?kind=input&path=" + encodeURIComponent(inputDirectory));
  assert.equal(folder.status, 200);
  assert.equal((folder.data.stats as { records: number }).records, 4);
  assert.equal((await request("/api/directories?kind=input&path=/")).status, 403);
  const created = await request("/api/directories", { kind: "output", parent: f.directory, name: "评测结果" });
  assert.equal(created.status, 201);
  assert.equal((await request("/api/directories?kind=output&path=" + encodeURIComponent(String(created.data.path)))).status, 200);
  assert.equal((await request("/api/directories", { kind: "output", parent: f.directory, name: "评测结果" })).status, 409);
  for (const name of [undefined, "", "   ", 123, "长".repeat(101)]) {
    const invalid = await request("/api/previews", { preset: "wencai", name, concurrency: 2, inputDirectory, output: f.config.output.path, batchId: "search_eval" });
    assert.equal(invalid.status, 400); assert.match(String(invalid.data.error), /任务名称/);
  }
  for (const batchId of [undefined, "", "   "]) {
    const invalid = await request("/api/previews", { preset: "wencai", name: "搜索评测", concurrency: 2, inputDirectory, output: f.config.output.path, batchId });
    assert.equal(invalid.status, 400); assert.match(String(invalid.data.error), /请填写缺省批次/);
  }
  const preview = await request("/api/previews", { preset: "wencai", name: "搜索评测", concurrency: 2, output: f.config.output.path,
    inputDirectory, batchId: "search_eval" });
  assert.equal(preview.status, 201, JSON.stringify(preview.data));
  assert.equal(starts, 0);
  const id = String(preview.data.id);
  assert.equal(preview.data.name, "搜索评测");
  const visible = (await request("/api/tasks")).data as unknown as { id: string }[];
  assert(visible.some(task => task.id === id), "Check data must immediately create a visible task");
  for (let n = 0; n < 100 && manager.get(id).dataCheck?.status === "checking"; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(manager.get(id).dataCheck?.status, "ready");
  const frozen = await readJson<{ models: unknown; bindings: unknown; inputs: Record<string, unknown> }>(path.join(config.stateDirectory, id, "config.json"));
  assert.deepEqual(frozen.models, models); assert.deepEqual(frozen.bindings, JSON.parse(JSON.stringify(f.models.bindings)));
  assert.equal(frozen.inputs.limit, undefined); assert.equal(frozen.inputs.case_ids, undefined);
  assert.equal(frozen.inputs.default_batch_id, "search_eval");
  assert.equal(manager.get(id).batchId, "search_eval");
  assert.deepEqual(Object.keys((await request(`/api/tasks/${id}/configuration`)).data).sort(), ["batchId", "concurrency", "inputDirectory", "logs", "name", "output", "preset"]);
  assert.equal(manager.get(id).inputDirectory, await realpath(inputDirectory));
  assert.equal(manager.get(id).dataCheck?.total, 1);
  // A fresh manager restores the checked draft; no browser-local state is required.
  const restoredDraft = new ConsoleTasks(config);
  for (let n = 0; n < 100 && (await readJson<{ dataCheck: { status: string } }>(path.join(config.stateDirectory, id, "task.json"))).dataCheck.status !== "ready"; n++) await new Promise(resolve => setTimeout(resolve, 10));
  await restoredDraft.initialize();
  assert.equal(restoredDraft.get(id).status, "draft");
  assert.equal(restoredDraft.get(id).dataCheck?.total, 1);
  assert.equal(restoredDraft.get(id).name, "搜索评测");

  await Promise.all([request("/api/tasks", { previewId: id }), request("/api/tasks", { previewId: id })]);
  for (let n = 0; n < 100 && starts === 0; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(starts, 1);
  for (const name of [undefined, "", "   ", 123, "长".repeat(101)]) {
    assert.equal((await request(`/api/tasks/${id}/name`, { name })).status, 400);
    assert.equal(manager.get(id).name, "搜索评测");
  }
  const renamed = await request(`/api/tasks/${id}/name`, { name: "  搜索评测 · 第一次对比  " });
  assert.equal(renamed.status, 200); assert.equal(renamed.data.name, "搜索评测 · 第一次对比");
  assert.equal(renamed.data.status, "running"); assert.equal(starts, 1);
  assert.equal((await request(`/api/tasks/${id}/configuration`)).data.name, "搜索评测 · 第一次对比");
  assert.equal((await request(`/api/tasks/${id}/delete`, {})).status, 409);
  assert.equal((await request(`/api/tasks/${id}/check`, {})).status, 409);
  assert.deepEqual(manager.get(id).progress, { completed: 1, total: 4, failed: 0 });
  await request(`/api/tasks/${id}/concurrency`, { concurrency: 5 });
  assert.equal(execution!.gate.concurrency(), 5);
  await request(`/api/tasks/${id}/concurrency`, { concurrency: 1 });
  assert.equal(execution!.gate.concurrency(), 1);
  const paused = await request(`/api/tasks/${id}/pause`, {});
  assert.equal(paused.data.status, "pausing"); assert.equal(execution!.pause.aborted, true);
  assert.equal((await request(`/api/tasks/${id}/delete`, {})).status, 409);
  release!();
  for (let n = 0; n < 100 && manager.get(id).status === "pausing"; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(manager.get(id).status, "paused");
  await request(`/api/tasks/${id}/resume`, {});
  for (let n = 0; n < 100 && starts < 2; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(starts, 2); assert.equal(execution!.id, id);
  const restored = new ConsoleTasks(config);
  await restored.initialize(); assert.equal(restored.get(id).status, "paused");
  assert.equal(restored.get(id).name, "搜索评测 · 第一次对比");
  release!();
  for (let n = 0; n < 100 && manager.get(id).status === "running"; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(manager.get(id).status, "finished");
  assert.equal((await request(`/api/tasks/${id}/name`, { name: "搜索评测 · 已完成" })).data.name, "搜索评测 · 已完成");
  const overlap = await request("/api/previews", { preset: "wencai", name: "搜索评测", concurrency: 2, batchId: "search_eval", output: path.join(inputDirectory, "output"), inputDirectory });
  assert.equal(overlap.status, 400); assert.match(String(overlap.data.error), /重叠/);
  for (const version of f.config.inputs.versions) await writeJsonl(version.sources[0].path, [{ ...raw("invalid"), messages: [] }]);
  for (const version of f.config.inputs.versions) await writeJsonl(path.join(inputDirectory, version.id + ".jsonl"), [{ ...raw("invalid"), messages: [] }]);
  const empty = await request("/api/previews", { preset: "wencai", name: "搜索评测", concurrency: 2, batchId: "search_eval", output: f.config.output.path, inputDirectory });
  assert.equal(empty.status, 201);
  for (let n = 0; n < 100 && manager.get(String(empty.data.id)).dataCheck?.status === "checking"; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await request("/api/tasks", { previewId: empty.data.id })).status, 409);
  assert.equal(starts, 2, "checking invalid inputs must never start evaluation");
  for (const version of f.config.inputs.versions) await writeJsonl(path.join(inputDirectory, version.id + ".jsonl"), [raw()]);
  const retry = await request(`/api/tasks/${empty.data.id}/check`, {});
  assert.equal(retry.status, 202); assert.equal(retry.data.id, empty.data.id);
  for (let n = 0; n < 100 && manager.get(String(empty.data.id)).dataCheck?.status === "checking"; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(manager.get(String(empty.data.id)).dataCheck?.total, 1);

  const invalid = await executeConsoleTask({ host: { workflow: "comparison", evaluation: f.config, models: f.models, evaluatorVersion: "fixture" },
    id: "console-invalid-input", gate: createChannelRequests({ "evaluation-gateway": 1 }), pause: new AbortController().signal,
    inputSchedule: path.join(f.directory, "invalid-schedule.json"), channels: ["evaluation-gateway"], progress() {} });
  assert.equal(invalid.outcome, "partial");
  assert.deepEqual(invalid.execution_task_statuses, {});
  const errors = await consoleLog(path.join(config.logDirectory, "runtime.log"), "console-invalid-input", true);
  assert(errors.rows.some(row => String(row.message).includes(f.config.inputs.versions[0].sources[0].path + ":1 ") &&
    String(row.detail).includes("[cause]")), "invalid input keeps its file, line and diagnostic details in the log");

  const resultFile = path.join(f.config.output.path, "keep-result.json"), runState = path.join(f.config.output.path, ".runs", id, "state.json");
  await writeJson(resultFile, { result: "preserved" }); await writeJson(runState, { progress: "preserved" });
  assert.equal((await request(`/api/tasks/${id}/delete`, {}, false)).status, 403);
  assert.equal((await request(`/api/tasks/${id}/delete`, {})).status, 200);
  assert.equal((await request(`/api/tasks/${id}`)).status, 404);
  assert.equal(await exists(path.join(config.stateDirectory, id)), false);
  assert.equal(await exists(f.config.inputs.versions[0].sources[0].path), true);
  assert.deepEqual(await readJson(resultFile), { result: "preserved" });
  assert.deepEqual(await readJson(runState), { progress: "preserved" });
  assert.equal(await exists(path.join(config.logDirectory, "runtime.log")), true);

  // Delete while a check is still reading: its completion must never recreate the task.
  let releaseCheck!: () => void;
  const allowCheck = new Promise<void>(resolve => { releaseCheck = resolve; });
  t.after(() => releaseCheck());
  const files = fileSourceReader.files;
  t.mock.method(fileSourceReader, "files", async (...args: Parameters<typeof files>) => { await allowCheck; return files(...args); });
  const checking = await request("/api/previews", { preset: "wencai", name: "搜索评测", concurrency: 2, batchId: "search_eval", output: f.config.output.path, inputDirectory });
  assert.equal(checking.status, 201);
  const checkingId = String(checking.data.id);
  assert.equal(manager.get(checkingId).dataCheck?.status, "checking");
  assert.equal((await request(`/api/tasks/${checkingId}/delete`, {})).status, 200);
  releaseCheck(); await manager.close();
  const afterDeletion = new ConsoleTasks(config); await afterDeletion.initialize();
  for (const deleted of [id, checkingId]) {
    assert.equal(afterDeletion.tasks.has(deleted), false);
    assert.equal(await exists(path.join(config.stateDirectory, deleted)), false);
    assert.equal((await request(`/api/tasks/${deleted}/delete`, {})).status, 404);
  }
});

test("console resume retries unfinished failures and clears stage pauses within the remaining budget", async t => {
  const f = await fixtureConfig([[raw()], [], [raw()], []]);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const plan = await buildPlan(f.config), id = "console-resume-failures";
  const statuses = ["failed", "timed_out", "blocked"] as const;
  const state: RunState = { manifest: { format: "evaluation-run", debug: false, runId: id, status: "interrupted",
    engine: fakeIdentity, evaluatorVersion: "fixture", config: f.config, tasks: plan.tasks, inputCatalog: plan.catalog,
    inputs: {}, states: Object.fromEntries(plan.tasks.map((task, index) => [task.id, { status: statuses[index % statuses.length], attempts: 0 }])),
    preflight: plan.summary, startedAt: Date.now(), pausedStages: [{ stage: "criteria", category: "interruption",
      code: "attempt_interrupted", path: "/", taskIds: [], at: Date.now() }] },
    receipts: {}, usage: emptyUsage(), recordedAttempts: 0 };
  const run = runLayout(f.config.output, id).directory;
  await comparisonRepository.writeRun(run, state);
  // Stop before dispatch so the checkpoint exposes resume admission without starting a Worker.
  const pause = new AbortController(); pause.abort();
  const inputSchedule = path.join(f.directory, "resume-schedule.json");
  await loadInputSchedule({ workflow: "comparison", evaluation: f.config, models: f.models, evaluatorVersion: "fixture" }, inputSchedule, new AbortController().signal);
  await executeConsoleTask({ host: { workflow: "comparison", evaluation: f.config, models: f.models, evaluatorVersion: "fixture" },
    id, gate: createChannelRequests({ "evaluation-gateway": 1 }), pause: pause.signal,
    inputSchedule, channels: ["evaluation-gateway"], progress() {} });
  const restored = await comparisonRepository.readRun(run);
  assert.deepEqual(restored.manifest.pausedStages, []);
  assert(restored.manifest.tasks.length > 0);
  for (const task of restored.manifest.tasks) {
    assert.equal(restored.manifest.states[task.id].status, "pending");
    assert.equal(restored.manifest.states[task.id].attempts, 0);
  }
});

test("a queued data check publishes its schedule before exposing ready or allowing a start", { timeout: 10000 }, async t => {
  const f = await fixtureConfig([[raw()], [], [raw()], []]);
  const source = path.join(f.directory, "source.json");
  await writeJson(source, { ...f.config, evaluatorVersion: "fixture",
    models: { judge: { channel: "evaluation-gateway", model: "fixture", thinking: "off" } }, bindings: f.models.bindings });
  const config: ConsoleConfig = { hostname: "127.0.0.1", port: 0, stateDirectory: path.join(f.directory, "console"),
    inputStatsFile: path.join(f.directory, "eval_input_stats.json"), directoryRoot: f.directory,
    logDirectory: path.join(f.directory, "log"), passwordFile: "unused", channels: ["evaluation-gateway"],
    presets: [{ id: "wencai", source: "wencai", name: "问财对比", concurrency: 1, configs: [source] }] };
  let enterPreflight!: () => void, releasePreflight!: () => void, releaseCheck!: () => void;
  const preflightEntered = new Promise<void>(resolve => { enterPreflight = resolve; });
  const allowPreflight = new Promise<void>(resolve => { releasePreflight = resolve; });
  const allowCheck = new Promise<void>(resolve => { releaseCheck = resolve; });
  let heldTask: string | undefined, holdCheck = false;
  const manager = new ConsoleTasks(config, {
    preflight: async (_host, runId) => {
      if (runId === heldTask && heldTask) { enterPreflight(); await allowPreflight; }
      return [];
    },
    execute: async ({ pause }) => {
      if (!pause.aborted) await new Promise<void>(resolve => pause.addEventListener("abort", () => resolve(), { once: true }));
      return { execution_task_statuses: { succeeded: 1 }, paused_stages: [] };
    },
  });
  t.after(async () => {
    releaseCheck(); releasePreflight();
    try { await manager.close(); } finally { await rm(f.directory, { recursive: true, force: true }); }
  });
  const files = fileSourceReader.files;
  t.mock.method(fileSourceReader, "files", async (...args: Parameters<typeof files>) => {
    if (holdCheck) await allowCheck;
    return files(...args);
  });
  await manager.initialize();
  const inputs = Object.fromEntries(f.config.inputs.versions.map(version => [version.id, version.sources.map(item => item.path)]));
  const first = await manager.preview({ preset: "wencai", name: "搜索评测", concurrency: 1, batchId: "search_eval", inputs, output: f.config.output.path });
  for (let n = 0; n < 100 && manager.get(first.id).dataCheck?.status === "checking"; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(manager.get(first.id).dataCheck?.status, "ready");
  // Flush the first check's queued save before preparing the next task.
  await manager.concurrency(first.id, 1);
  holdCheck = true;
  const second = await manager.preview({ preset: "wencai", name: "搜索评测", concurrency: 1, batchId: "search_eval", inputs, output: path.join(f.directory, "other-output") });
  assert.equal(manager.get(second.id).dataCheck?.status, "checking");
  heldTask = first.id;
  const startingFirst = manager.start(first.id);
  await preflightEntered;
  const startingSecond = assert.rejects(manager.start(second.id), /请先完成 Check data/);
  releaseCheck();
  for (let n = 0; n < 100 && manager.get(second.id).dataCheck?.checkedFiles !== 4; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(manager.get(second.id).dataCheck?.status, "checking");
  releasePreflight();
  await Promise.all([startingFirst, startingSecond]);
  for (let n = 0; n < 100 && manager.get(second.id).dataCheck?.status !== "ready"; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(await exists(path.join(config.stateDirectory, second.id, "input-schedule.json")), true);
  await manager.start(second.id);
  // This serial mutation waits for the check-completion save queued after start.
  await manager.concurrency(second.id, 2);
  assert.equal(manager.get(second.id).status, "running");
  const saved = await readJson<{ status: string; concurrency: number }>(path.join(config.stateDirectory, second.id, "task.json"));
  assert.equal(saved.status, "running"); assert.equal(saved.concurrency, 2);
});
