import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { appendFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { writeJson } from "@eval/data";
import { json, listen } from "@eval/runtime/http";
import { createAutomationControl } from "../../../apps/host/src/automation-control.js";
import { automationLlm } from "../../../apps/host/src/automation-llm.js";
import { dailyWorkbench } from "../../../apps/host/src/daily-workbench.js";
import { loadAimeWorkbench } from "../../../apps/host/src/aime-workbench.js";
import { loadAutomationConfig } from "../../../apps/host/src/automation-config.js";
import { automationMongoTarget } from "../../../apps/host/src/automation-sources.js";
import type { AutomationDashboardSource } from "../../../apps/host/src/automation-dashboard.js";
import type { AutomationJob, AutomationState } from "@eval/automations";
import { writeTestSettings } from "../../fixtures/settings.js";
import { ROOT } from "../../fixtures/services.js";

test("daily HTTP exposes AIME stages and controls without starting evaluations on read", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "daily-http-"));
  const previous = process.env.EVAL_WORKBENCH_DATA_URL;
  const data = await listen(async (_req, res) => json(res, { tasks: [{ id: "task", source: "aime", dataset: "/data/aime", archive_dir: "/online_data" }],
    batches: [{ id: "package", name: "daily.7z", status: "ready", summary: null }], page: 1, page_size: 50, total: 1 }), 0);
  process.env.EVAL_WORKBENCH_DATA_URL = data.url;
  let calls = 0;
  const control = createAutomationControl(["aime"], async (_id, signal, pauseSignal) => {
    calls++;
    await new Promise<void>(resolve => { signal.addEventListener("abort", () => resolve(), { once: true }); pauseSignal.addEventListener("abort", () => resolve(), { once: true }); });
  });
  let server: Awaited<ReturnType<typeof listen>> | undefined;
  try {
    const ini = await writeTestSettings(directory), host = path.join(directory, "aime.json");
    const output = path.join(directory, "eval_output/0_daily_eval"); await mkdir(output, { recursive: true });
    await writeJson(host, { workflow: "answer-review", models: { judge: { model: "fixture" } },
      inputs: { versions: [{ id: "aime_fast", name: "aime_fast", adapter: "a", sources: [{ kind: "directory", path: path.join(directory, "inputs") }] }] },
      comparisons: [], bindings: { score: { profile: "judge" }, attribution: { profile: "judge" } }, output: { kind: "directory", path: output } });
    const file = path.join(directory, "source.json");
    await writeJson(file, { archiveDirectory: path.join(directory, "online_data"), inputDirectory: path.join(directory, "2_daily_eval_input"),
      outputDirectory: output, stateDirectory: path.join(directory, "state"), dataStateDirectory: path.join(directory, "data-state"),
      settingsFile: ini, hostConfigs: [path.join(ROOT, "configs/host.json"), host], logDirectory: path.join(directory, "log"),
      logLockDirectory: path.join(directory, "log-lock"), concurrency: 64 });
    const aime = await loadAimeWorkbench(file);
    const llm = await automationLlm(path.join(directory, "scheduling.json"), { aime: 64 });
    const daily = dailyWorkbench({ sources: () => [], aime, control, llm });
    server = await listen(async (req, res, url) => { if (!await daily(req, res, url)) json(res, {}, 404); }, 0);
    const get = async (route: string) => (await fetch(server!.url + route)).json() as Promise<any>;
    const post = (route: string, body: object, origin = server!.url) => fetch(server!.url + route, {
      method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
    const initial = await get("/api/daily");
    assert.equal(initial.sources[0].id, "aime"); assert.equal(initial.sources[0].status, "idle");
    assert.deepEqual(Object.keys(initial.sources[0].settings.bindings), ["score", "attribution"]);
    assert.equal(initial.sources[0].packages.total, 1); assert.equal(calls, 0);
    assert.equal((await post("/api/daily/aime/control", { action: "run" }, "http://other.test")).status, 403);
    assert.equal((await post("/api/daily/aime/control", { action: "run" })).status, 200);
    await new Promise(setImmediate); assert.equal(calls, 1);
    assert.equal((await post("/api/daily/aime/control", { action: "run" })).status, 409);
    await post("/api/daily/aime/control", { action: "pause" }); await new Promise(setImmediate);
    assert.equal(control.snapshot("aime").status, "paused");
    assert.equal((await post("/api/daily/aime/concurrency", { concurrency: 12 })).status, 200);
    assert.equal((await get("/api/daily")).sources[0].concurrency, 12);
    assert.equal((await post("/api/daily/aime/concurrency", { concurrency: 0 })).status, 400);
    assert.equal((await fetch(server.url + "/api/daily/aime/runs/missing/artifacts?file=../../config.ini")).status, 404);
  } finally {
    await control.close(); await server?.close(); await data.close();
    if (previous === undefined) delete process.env.EVAL_WORKBENCH_DATA_URL; else process.env.EVAL_WORKBENCH_DATA_URL = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("daily HTTP reports Mongo complete only when every date has a receipt for its current inputs and ready comparisons", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "daily-mongo-http-"));
  const previous = process.env.EVAL_CONFIG_FILE;
  const data = await listen(async (_req, res, url) => {
    const page = Number(url.searchParams.get("page") ?? 1), pageSize = Number(url.searchParams.get("page_size") ?? 50);
    const indexes = Array.from({ length: 25 }, (_, index) => index).slice((page - 1) * pageSize, page * pageSize);
    if (url.pathname.endsWith("/report")) json(res, { archive_path: "/daily-inputs/batch.7z", section: "records", page, page_size: pageSize, total: 25,
      items: indexes.map(index => ({ date: "2026-10-23", model: "a_fast", batch_id: "2026-10-23", case_id: "case-" + index,
        original_file: "batch.7z/answers.jsonl", original_line: index + 1 })) });
    else json(res, { tasks: [{ id: "task", source: "wencai", dataset: "/data/wencai", archive_dir: "/daily-inputs" }],
      batches: indexes.map(index => ({ id: "package-" + index, name: `batch-${index}.7z`, status: "cleaned" })), page, page_size: pageSize, total: 25 });
  }, 0);
  let server: Awaited<ReturnType<typeof listen>> | undefined;
  const control = createAutomationControl(["remote-evaluation"], async () => assert.fail("reading daily state cannot start a source"));
  try {
    process.env.EVAL_CONFIG_FILE = await writeTestSettings(directory);
    await appendFile(process.env.EVAL_CONFIG_FILE, "models = fixture\n");
    const host = path.join(directory, "host.json");
    await writeJson(host, { models: { judge: { model: "fixture" } }, output: { kind: "directory", path: path.join(directory, "runs") } });
    const config = await loadAutomationConfig(path.join(ROOT, "configs/automations.json"));
    config.sourceUrl = data.url + "/data/wencai";
    config.hostConfigs = [path.join(ROOT, "configs/host.json"), host];
    config.stateDirectory = path.join(directory, "state");
    config.sourceDirectory = path.join(directory, "inputs");
    const job = (date: string, updatedAt: number): AutomationJob => ({ date, runIds: [], adopted: false,
      observed: {}, downloaded: {}, download: "ready", evaluation: "completed", checkedAt: 0,
      downloadAttempts: 0, evaluationAttempts: 0, nextDownloadAt: 0, nextEvaluationAt: 0, inputsUpdatedAt: updatedAt,
      summary: { stages: {}, skipped: 0, issues: 0, readyComparisons: 1 } });
    const first = job("2026-10-23", 10), second = job("2026-10-24", 20);
    const receipt = (current: AutomationJob): NonNullable<AutomationJob["mongo"]> => ({
      target: automationMongoTarget(config), status: "completed", attempts: 0, nextAt: 0,
      synced: { inputsUpdatedAt: current.inputsUpdatedAt!, comparisons: current.summary!.readyComparisons },
      counts: { inputs: 4, comparisons: current.summary!.readyComparisons, inserted: 0, updated: 0 },
    });
    first.mongo = receipt(first);
    const state: AutomationState = { id: config.id, sourceUrl: config.sourceUrl, status: "stopped", startedAt: 0, updatedAt: 0,
      jobs: { [first.date]: first, [second.date]: second } };
    const source: AutomationDashboardSource = { name: "问财日常四路", config, output: path.join(directory, "runs"), state: () => state,
      settings: { evaluatorVersion: "fixture", concurrency: 4 },
      monitor: async current => ({ summary: current.summary, hours: [], progress: { date: current.date, pairs: {} }, runs: [] }) };
    const llm = await automationLlm(path.join(directory, "scheduling.json"), { [config.id]: 4 });
    const daily = dailyWorkbench({ sources: () => [source], control, llm });
    server = await listen(async (req, res, url) => { if (!await daily(req, res, url)) json(res, {}, 404); }, 0);
    const status = async () => {
      const response = await fetch(server!.url + "/api/daily");
      assert.equal(response.status, 200);
      const result = await response.json() as { sources: { id: string; readError?: boolean; mongo: { status: string } }[] };
      const current = result.sources.find(item => item.id === "wencai")!;
      assert.equal(current.readError, undefined, "a valid Wencai fixture must reach its real delivery projection");
      return current.mongo.status;
    };
    assert.equal(await status(), "pending", "a date without a receipt prevents source completion");
    second.mongo = receipt(second);
    assert.equal(await status(), "completed");
    const initial = await fetch(server.url + "/api/daily?page_size=10").then(response => response.json()) as any;
    assert.equal(initial.sources[0].packages.pageSize, 10);
    assert.equal(initial.sources[0].packages.items.length, 10);
    const next = await fetch(server.url + "/api/daily/wencai/packages?page=2&page_size=10").then(response => response.json()) as any;
    assert.equal(next.pageSize, 10); assert.equal(next.items[0].id, "package-10");
    const last = await fetch(server.url + "/api/daily/wencai/packages?page=3&page_size=10").then(response => response.json()) as any;
    assert.deepEqual([...initial.sources[0].packages.items, ...next.items, ...last.items].map(item => item.id),
      Array.from({ length: 25 }, (_, index) => "package-" + index), "server page offsets cover every package exactly once");
    const report = await fetch(server.url + "/api/daily/wencai/packages/package-1/report?section=records&page=2&page_size=10").then(response => response.json()) as any;
    assert.equal(report.page_size, 10); assert.equal(report.total, 25);
    assert.deepEqual(report.items.map((item: any) => item.original_line), Array.from({ length: 10 }, (_, index) => index + 11));
    assert.equal((await fetch(server.url + "/api/daily?page_size=0")).status, 400);
    first.inputsUpdatedAt!++;
    assert.equal(await status(), "pending", "a receipt for an earlier input snapshot is incomplete");
    first.mongo = receipt(first);
    assert.equal(await status(), "completed");
    second.summary!.readyComparisons++;
    assert.equal(await status(), "pending", "newly settled comparisons remain pending until acknowledged");
    second.mongo = receipt(second);
    assert.equal(await status(), "completed");
  } finally {
    await control.close(); await server?.close(); await data.close();
    if (previous === undefined) delete process.env.EVAL_CONFIG_FILE; else process.env.EVAL_CONFIG_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
