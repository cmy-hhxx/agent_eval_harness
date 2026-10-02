import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { emptyUsage, type RunState } from "@eval/contracts";
import { runLock, writeJson } from "@eval/data";
import type { AutomationJob, AutomationState } from "@eval/automations";
import { comparisonCodec, buildPlan } from "@eval/workflows/comparison";
import { completionTimeline, automationSnapshot, startAutomationDashboard } from "../../../apps/host/src/automation-dashboard.js";
import { loadAutomationConfig } from "../../../apps/host/src/automation-config.js";
import { fixtureConfig, fakeIdentity, fakeEvaluatorVersion } from "../../fixtures/comparison.js";
import { ROOT } from "../../fixtures/services.js";

const { JSDOM } = createRequire(import.meta.url)("jsdom");
const hour = 3600000, at = Date.parse("2026-09-30T01:00:00Z");
const settings = { evaluatorVersion: "current-fixture", concurrency: 32 };
const execution = () => ({ ...settings, runningTasks: 0, runningCases: 0,
  stages: { criteria: 0, attribution: 0, comparison: 0, rewrite: 0 }, retryingStages: { attribution: 0, comparison: 0, rewrite: 0 },
  readyTasks: 0, waitingDependencies: 0, retryingTasks: 0, nextRetryAt: undefined as number | undefined });
const state = (): AutomationState => ({ id: "fixture", sourceUrl: "http://fixture", status: "stopped", startedAt: at, updatedAt: at, jobs: {} });
const job = (date: string): AutomationJob => ({ date, runIds: ["fixture"], observed: { a_fast: 1, b_fast: 1, a_expert: 1, b_expert: 1 },
  adopted: false, download: "ready", evaluation: "completed", checkedAt: at, downloadAttempts: 0,
  evaluationAttempts: 0, nextDownloadAt: 0, nextEvaluationAt: 0 });

test("monitor counts accepted evaluations and rewrites without waiting for deferred clustering", async () => {
  const { directory, config } = await fixtureConfig(undefined, true, true);
  try {
    config.rewrite = { attribution: true, comparison: true, comparisonItems: true, clustering: true };
    config.comparisons = [["a_fast", "b_fast"], ["a_expert", "b_expert"]];
    const plan = await buildPlan(config);
    const run: RunState = { usage: emptyUsage(), receipts: {}, recordedAttempts: 0, manifest: {
      format: "evaluation-run", debug: false, runId: "fixture", status: "running", evaluatorVersion: fakeEvaluatorVersion,
      engine: fakeIdentity, config, tasks: plan.tasks, inputCatalog: plan.catalog, inputs: {},
      states: Object.fromEntries(plan.tasks.map((task) => [task.id, { status: "pending", attempts: 0 }])),
      preflight: plan.summary, startedAt: at,
    } };
    const saved = comparisonCodec.encode(run);
    for (const task of Object.values(saved.tasks)) {
      task.status = "succeeded";
      task.receipt = { acceptedAt: at + 1000, exported: {} } as NonNullable<typeof task.receipt>;
    }
    const lastRewrite = Object.values(saved.tasks).find((task) => task.data.rewriteOf?.stage === "clustering")!;
    lastRewrite.status = "pending";
    assert.equal(completionTimeline([saved]).reduce((n, row) => n + row.completed, 0), 2);
    lastRewrite.status = "succeeded";
    lastRewrite.receipt!.acceptedAt = at + hour;
    assert.deepEqual(completionTimeline([saved]).map((row) => [row.start, row.completed]), [[at, 2]]);
    const current = state(); current.jobs["2026-09-30"] = job("2026-09-30");
    await writeJson(path.join(directory, "fixture/state.json"), saved);
    const automation = await loadAutomationConfig(path.join(ROOT, "configs/automations.json"));
    const first = await automationSnapshot(automation, directory, current, settings);
    assert.equal(first.cache.hitRate, null, "no token usage is unknown, not a zero hit rate");
    const second = await automationSnapshot(automation, directory, JSON.parse(JSON.stringify(current)), settings);
    assert.deepEqual(first.jobs[0].hours, second.jobs[0].hours);
    assert.equal(first.jobs[0].summary!.stages.rewrite.completed, plan.tasks.filter((task) => task.stage === "rewrite" && (task.data as { rewriteOf: { stage: string } }).rewriteOf.stage !== "clustering").length);
    assert.equal(first.jobs[0].summary!.stages.clustering, undefined);
    assert.equal(current.jobs["2026-09-30"].summary, undefined, "read-only projection cannot mutate scheduler state");
    const server = await startAutomationDashboard({ config: automation, output: directory, state: () => current, port: 0, settings });
    try {
      const response = await fetch(server.url + "/api/status");
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual((await response.json() as typeof first).jobs[0].hours, first.jobs[0].hours);
      assert.equal((await fetch(server.url + "/api/status", { method: "POST" })).status, 405);
      assert.equal((await fetch(server.url + "/.env")).status, 404);
      assert.match(await (await fetch(server.url)).text(), /完成对比 · 含改写/);
      assert.match(await (await fetch(server.url + "/automations.js")).text(), /api\/status/);
    } finally { await server.close(); }
    await assert.rejects(fetch(server.url), /fetch failed/);
    current.status = "running"; current.jobs["2026-09-30"].evaluation = "evaluating";
    for (const task of Object.values(saved.tasks)) { task.status = "pending"; delete task.receipt; }
    const tasks = Object.values(saved.tasks);
    for (const task of tasks.filter((task) => task.stage === "attribution").slice(0, 2)) task.status = "running";
    tasks.find((task) => task.stage === "comparison")!.status = "running";
    const retry = tasks.find((task) => task.stage === "rewrite" && task.data.rewriteOf?.stage !== "clustering")!;
    retry.status = "pending"; retry.nextRetryAt = at + hour;
    lastRewrite.status = "running"; lastRewrite.nextRetryAt = at;
    saved.concurrency = 16;
    await writeJson(path.join(directory, "fixture/state.json"), saved);
    const release = await runLock(path.join(directory, "fixture"));
    const live = (await automationSnapshot(automation, directory, current, settings)).execution;
    assert.equal(live.evaluatorVersion, fakeEvaluatorVersion, "use the active Host version, not old receipts or newly edited config");
    assert.equal(live.concurrency, 16);
    assert.equal(live.runningTasks, 3);
    assert.equal(live.runningCases, 1, "parallel stages/versions of one question count as one case");
    assert.deepEqual(live.stages, { criteria: 0, attribution: 2, comparison: 1, rewrite: 0 });
    assert.equal(live.retryingTasks, 1);
    assert.deepEqual(live.retryingStages, { criteria: 0, attribution: 0, comparison: 0, rewrite: 1 });
    assert.equal(live.readyTasks, 1, "only the shared criteria is ready before its downstream dependencies");
    assert(live.waitingDependencies > 0);
    assert.equal(live.nextRetryAt, at + hour, "deferred clustering must not set the next retry");
    current.status = "stopped";
    assert.equal((await automationSnapshot(automation, directory, current, settings)).execution.runningTasks, 0);
    current.status = "running";
    await release();
    const stale = (await automationSnapshot(automation, directory, current, settings)).execution;
    assert.equal(stale.runningTasks, 0, "stale running tasks without a live owner are not real concurrency");
    assert.equal(stale.evaluatorVersion, settings.evaluatorVersion);
    saved.usage = { ...emptyUsage(), input: 20, cacheRead: 70, cacheWrite: 10 };
    await writeJson(path.join(directory, "fixture/state.json"), saved);
    await writeJson(path.join(directory, "fixture2/state.json"), { ...saved, runId: "fixture2",
      usage: { ...emptyUsage(), input: 200, cacheRead: 30, cacheWrite: 70 } });
    current.jobs["2026-09-29"] = { ...job("2026-09-29"), runIds: ["fixture2"] };
    const cached = await automationSnapshot(automation, directory, current, settings);
    assert.deepEqual(cached.cache, { readTokens: 100, inputTokens: 400, hitRate: .25 });
    assert.equal(cached.jobs.find((job) => job.date === "2026-09-30")!.cache.hitRate, .7);
    assert.equal(cached.jobs.find((job) => job.date === "2026-09-29")!.cache.hitRate, .1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("monitor renders receipts, preserves filters on polling and marks stale data after disconnect", async () => {
  const html = await readFile(path.join(ROOT, "apps/host/dashboard/automations.html"), "utf8");
  const script = await readFile(path.join(ROOT, "apps/host/dashboard/automations.js"), "utf8");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://fixture/" });
  const payload = { ...state(), execution: execution(), publication: {
      status: "completed", traceId: "trace", window: at, startedAt: at, completedAt: at + 5000,
      counts: { cases: 4, comparisons: 4 },
      log: { status: "uploaded", writtenAt: at + 3000, uploadedAt: at + 5000, requestId: "receipt<one>" },
    }, sampledAt: at + hour, logFile: "/fixture/statistics.jsonl", mongoCollection: "fixture_collection", jobs: [
    { ...job("2026-09-30"), hours: [{ start: at, completed: 4, stages: { rewrite: 12 } }], mongo: { status: "completed", startedAt: at, completedAt: at + 2000,
      counts: { inputs: 8, comparisons: 4, inserted: 12, updated: 0 } },
      mongoHistory: [{ startedAt: at - 1000, completedAt: at - 500, counts: { inputs: 8, comparisons: 0, inserted: 8, updated: 0 } }],
    },
    { ...job("2026-09-29"), hours: [], evaluation: "blocked", evaluationError: '<img src=x onerror="alert(1)">',
      summary: { stages: {
        attribution: { total: 810, completed: 94, cancelled: 716, failed: 0 },
        rewrite: { total: 1225, completed: 118, blocked: 1107, failed: 0 },
      } },
    },
  ] };
  let next: () => Promise<void> = async () => {}, failed = false;
  dom.window.setTimeout = (fn: () => Promise<void>) => { next = fn; return 1; };
  dom.window.clearTimeout = () => {};
  dom.window.fetch = async () => { if (failed) throw new Error("offline"); return { ok: true, json: async () => payload }; };
  try {
    dom.window.eval(script);
    await new Promise((resolve) => setImmediate(resolve));
    const document = dom.window.document;
    assert.match(document.getElementById("delivery-rows").textContent, /receipt<one>/);
    assert.match(document.getElementById("mongo-rows").textContent, /09:00:02/);
    assert.match(document.getElementById("mongo-rows").textContent, /新增 12/);
    assert.equal(document.querySelectorAll("#mongo-rows tr").length, 2);
    assert.equal(document.querySelector("#mongo-progress-rows .mongo-inputs").textContent, "8");
    assert.equal(document.querySelector("#mongo-progress-rows .mongo-outputs").textContent, "4");
    assert.match(document.getElementById("mongo-total").textContent, /已确认输入 8 条 · 已确认评测输出 4 条/);
    assert.match(document.getElementById("mongo-total").textContent, /1 个日期未登记/);
    const historical = payload.jobs[1] as any;
    historical.mongo = { status: "completed", verified: { at: at + 2500, inputs: 6, comparisons: 3 } };
    await next();
    assert.match(document.getElementById("mongo-total").textContent, /已确认输入 14 条 · 已确认评测输出 7 条/);
    assert.match(document.querySelectorAll("#mongo-progress-rows tr")[1].textContent, /核验/);
    assert.equal(document.querySelectorAll("#mongo-rows tr").length, 2, "verification must not invent an upload event or time");
    const uploading = payload.jobs[0] as any;
    uploading.mongoHistory.push({ ...uploading.mongo });
    uploading.mongo = { status: "running", startedAt: at + 6000 };
    await next();
    assert.equal(document.querySelector("#mongo-progress-rows .mongo-inputs").textContent, "8");
    assert.equal(document.querySelector("#mongo-progress-rows .mongo-outputs").textContent, "4", "an active upload retains the last confirmed totals");
    assert.match(document.getElementById("delivery-rows").textContent, /09:00:03/);
    assert.match(document.getElementById("delivery-rows").textContent, /09:00:05/);
    assert.equal(document.querySelector("tbody img"), null);
    assert.match(document.getElementById("date-rows").textContent, /已中断 716/);
    assert.match(document.getElementById("date-rows").textContent, /依赖阻塞 1,107/);
    assert.doesNotMatch(document.getElementById("date-rows").textContent, /失败 (716|1,107)/);
    document.getElementById("date-filter").value = "2026-09-29";
    document.getElementById("date-filter").dispatchEvent(new dom.window.Event("change"));
    assert.match(document.getElementById("activity-rows").textContent, /暂无完成记录/);
    assert.match(document.getElementById("mongo-rows").textContent, /暂无 MongoDB 同步记录/);
    await next();
    assert.equal(document.getElementById("date-filter").value, "2026-09-29");
    assert.equal(document.querySelectorAll("#date-rows tr").length, 1);
    payload.jobs[1].evaluation = "waiting_inputs";
    payload.jobs[1].evaluationError = "Input gaps or invalid records remain; waiting for source updates";
    await next();
    assert.match(document.getElementById("date-rows").textContent, /等待新增输入/);
    assert.doesNotMatch(document.getElementById("date-rows").textContent, /Input gaps/);
    failed = true; await next();
    assert.equal(document.getElementById("pipeline-status").textContent, "连接中断");
    assert.match(document.getElementById("connection-error").textContent, /保留/);
    assert.equal(document.querySelectorAll("#date-rows tr").length, 1);
    for (const [id, value] of [["date-filter", "2026-09-30"], ["time-filter", "all"]]) {
      document.getElementById(id).value = value;
      document.getElementById(id).dispatchEvent(new dom.window.Event("change"));
      assert.equal(document.getElementById("pipeline-status").textContent, "连接中断");
    }
    failed = false; await next();
    assert.equal(document.getElementById("pipeline-status").textContent, "已停止");
    assert.equal(document.getElementById("connection-error").hidden, true);
  } finally { dom.window.close(); }
});

test("date table separates remote/local input rows, refresh state, completed comparisons and retryable task counts", async () => {
  const html = await readFile(path.join(ROOT, "apps/host/dashboard/automations.html"), "utf8");
  const script = await readFile(path.join(ROOT, "apps/host/dashboard/automations.js"), "utf8");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://fixture/" });
  const observed = { a_fast: 239, b_fast: 218, a_expert: 237, b_expert: 196 };
  const stage = (total: number, completed: number, pending: number, failed = 0, blocked = 0) =>
    ({ total, completed, pending, failed, blocked, cancelled: 0, running: 0 });
  const payload = { ...state(), execution: execution(), status: "running", sampledAt: at, jobs: [{ ...job("2026-09-28"), observed, downloaded: observed,
    download: "downloading", evaluation: "retry", nextEvaluationAt: at + 1000, hours: [],
    summary: { readyComparisons: 139, skipped: 83, stages: {
      attribution: stage(810, 290, 505, 15), comparison: stage(405, 139, 252, 0, 14),
      rewrite: stage(1225, 429, 763, 0, 33), clustering: stage(10, 0, 6, 0, 4),
    } },
    mongo: { status: "completed", completedAt: at, counts: { inputs: 890, comparisons: 138 } },
  }] };
  dom.window.setTimeout = () => 1;
  dom.window.fetch = async () => ({ ok: true, json: async () => payload });
  try {
    dom.window.eval(script); await new Promise((resolve) => setImmediate(resolve));
    const document = dom.window.document;
    assert.equal(document.querySelector(".remote-inputs").textContent, "890");
    assert.match(document.querySelector(".local-inputs").textContent, /^890/);
    assert.match(document.getElementById("date-rows").textContent, /核对更新中/);
    assert.match(document.querySelector(".completed-comparisons").textContent, /139 \/ 405/);
    assert.match(document.querySelector(".task-pool").textContent, /待执行 1,520待重试 15依赖阻塞 47/);
    assert.match(document.querySelector(".mongo-outputs").textContent, /^138待上传 1$/);
    assert.match(document.getElementById("mongo-progress-rows").textContent, /等待同步新输出/);
  } finally { dom.window.close(); }
});

test("monitor paginates each record list, preserves pages during polling and resets scoped filters", async () => {
  const html = await readFile(path.join(ROOT, "apps/host/dashboard/automations.html"), "utf8");
  const script = await readFile(path.join(ROOT, "apps/host/dashboard/automations.js"), "utf8");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://fixture/#mongo-deliveries" });
  const payload = { ...state(), execution: execution(), sampledAt: at + hour, jobs: Array.from({ length: 23 }, (_, index) => ({
    ...job(`2026-09-${String(23 - index).padStart(2, "0")}`),
    hours: [{ start: at - index * hour, completed: 1, stages: { comparison: 1 } }],
    mongoHistory: index ? [] : Array.from({ length: 25 }, (_, i) => ({ startedAt: at - i * 1000,
      completedAt: at - i * 1000 + 50, counts: { inputs: 25 - i, comparisons: 25 - i, inserted: 1, updated: 0 } })),
  })), publicationHistory: Array.from({ length: 23 }, (_, index) => ({
    traceId: `trace-${index}`, status: "completed", window: at - index * 1000,
    log: { status: "uploaded", requestId: `receipt-${index}`, uploadedAt: at - index * 1000 },
  })) };
  let poll = async () => {};
  dom.window.setTimeout = (callback: () => Promise<void>) => { poll = callback; return 1; };
  dom.window.clearTimeout = () => {};
  dom.window.fetch = async () => ({ ok: true, json: async () => payload });
  try {
    dom.window.eval(script); await new Promise((resolve) => setImmediate(resolve));
    const document = dom.window.document, el = (id: string) => document.getElementById(id);
    assert.deepEqual([...document.querySelectorAll('section:not([hidden])')].map((item: any) => item.id), ["mongo-deliveries"]);
    for (const id of ["date", "activity", "mongo-progress", "mongo", "delivery"])
      assert.equal(document.querySelectorAll(`#${id}-rows tr`).length, 10);
    assert.match(el("mongo-total").textContent, /输入 25 条/);
    document.querySelector('#mongo-pagination [data-step="1"]').click();
    document.querySelector('#mongo-progress-pagination [data-step="1"]').click();
    assert.match(el("mongo-pagination").textContent, /11–20 \/ 25 条/);
    await poll();
    assert.match(el("mongo-pagination").textContent, /2 \/ 3 页/);
    assert.match(el("mongo-progress-pagination").textContent, /2 \/ 3 页/);
    el("tab-deliveries").click();
    assert.equal(el("date-filter-label").hidden, true);
    assert.equal(el("time-filter-label").hidden, false);
    document.querySelector('#delivery-pagination [data-step="1"]').click();
    assert.match(el("delivery-rows").textContent, /receipt-10/);
    assert.doesNotMatch(el("delivery-rows").textContent, /receipt-0\b/);
    el("tab-mongo-deliveries").click();
    assert.match(el("mongo-pagination").textContent, /2 \/ 3 页/, "switching tabs preserves each table page");
    document.querySelector('#mongo-pagination [data-step="1"]').click();
    assert.equal(document.querySelectorAll("#mongo-rows tr").length, 5);
    assert.equal(document.querySelector('#mongo-pagination [data-step="1"]').disabled, true);
    payload.jobs[0].mongoHistory.splice(12);
    await poll();
    assert.match(el("mongo-pagination").textContent, /2 \/ 2 页/, "shrinking results clamp to the last valid page");
    assert.equal(document.querySelectorAll("#mongo-rows tr").length, 2);
    el("date-filter").value = "2026-09-22";
    el("date-filter").dispatchEvent(new dom.window.Event("change"));
    assert.match(el("mongo-rows").textContent, /暂无 MongoDB 同步记录/);
    assert.equal(el("mongo-pagination").hidden, true);
    assert.equal(el("reset-filters").disabled, false);
    el("time-filter").value = "all";
    el("time-filter").dispatchEvent(new dom.window.Event("change"));
    el("reset-filters").click();
    assert.equal(el("date-filter").value, "");
    assert.equal(el("time-filter").value, "24");
    assert.match(el("mongo-pagination").textContent, /1 \/ 2 页/);
    el("tab-dates").click();
    assert.equal(el("time-filter-label").hidden, true);
    document.querySelector('#date-pagination [data-step="1"]').click();
    assert.equal(el("date-rows").rows[0].cells[0].textContent, "2026-09-13");
    assert.match(el("date-total").textContent, /23 个日期/, "totals describe all filtered results, not just the current page");
    el("tab-dates").dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    assert.equal(document.activeElement.id, "tab-activity");
    assert.equal(el("tab-activity").getAttribute("aria-selected"), "true");
    el("tab-activity").dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "End", bubbles: true }));
    assert.equal(document.activeElement.id, "tab-deliveries");
    assert.equal(document.querySelectorAll('section:not([hidden])').length, 1);
  } finally { dom.window.close(); }
});

test("download status distinguishes stale counts, active attempts, source readiness and real retry errors", async () => {
  const html = await readFile(path.join(ROOT, "apps/host/dashboard/automations.html"), "utf8");
  const script = await readFile(path.join(ROOT, "apps/host/dashboard/automations.js"), "utf8");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://fixture/" });
  const current: any = { ...job("2026-09-29"), sourceReady: true, hours: [],
    observed: { a_fast: 188, b_fast: 172, a_expert: 191, b_expert: 186 },
    downloaded: { a_fast: 135, b_fast: 119, a_expert: 136, b_expert: 132 } };
  const payload = { ...state(), execution: execution(), status: "running", sampledAt: at, jobs: [current],
    cache: { readTokens: 75, inputTokens: 100, hitRate: .75 } };
  let poll = async () => {};
  dom.window.setTimeout = (callback: () => Promise<void>) => { poll = callback; return 1; };
  dom.window.clearTimeout = () => {};
  dom.window.fetch = async () => ({ ok: true, json: async () => payload });
  try {
    dom.window.eval(script); await new Promise((resolve) => setImmediate(resolve));
    const doc = dom.window.document, text = () => doc.querySelector("#date-rows tr").cells[3].textContent;
    assert.match(text(), /待更新输入.*远端多 215 条.*等待下载/);
    assert.doesNotMatch(text(), /本地已就绪/);
    assert.equal(doc.getElementById("cache-hit-rate").textContent, "75%");
    assert.match(doc.getElementById("cache-tokens").textContent, /命中 75 \/ 输入 100 Token/);
    assert.equal(doc.querySelector(".cache-rate").textContent, "暂无用量");
    current.cache = { hitRate: 0 }; current.evaluation = "evaluating"; await poll();
    assert.match(text(), /等待当前评测结束/);
    assert.equal(doc.querySelector(".cache-rate").textContent, "0%");
    current.download = "downloading"; current.downloadError = "old timeout"; current.nextDownloadAt = at;
    await poll(); assert.match(text(), /下载更新中/); assert.doesNotMatch(text(), /old timeout|等待调度/);
    current.download = "ready"; current.sourceReady = false; await poll();
    assert.match(text(), /远端准备中/); assert.doesNotMatch(text(), /old timeout/);
    current.sourceReady = true; await poll(); assert.match(text(), /更新输入待重试.*old timeout/);
    delete current.downloadError; current.evaluation = "completed"; current.downloaded = { ...current.observed };
    current.downloaded.a_fast--; current.downloaded.b_fast++;
    await poll(); assert.match(text(), /模型数量不一致/); assert.doesNotMatch(text(), /本地已就绪/);
    current.downloaded = { ...current.observed }; await poll(); assert.equal(text(), "本地已就绪");
  } finally { dom.window.close(); }
});

test("live overview counts retries, ticks deadlines and freezes predictions on disconnect or stop", async () => {
  const html = await readFile(path.join(ROOT, "apps/host/dashboard/automations.html"), "utf8");
  const script = await readFile(path.join(ROOT, "apps/host/dashboard/automations.js"), "utf8");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://fixture/" });
  const payload = { ...state(), status: "running", sampledAt: at, execution: { ...execution(), runningTasks: 5,
    runningCases: 2, stages: { attribution: 2, comparison: 1, rewrite: 2 }, readyTasks: 12, waitingDependencies: 7,
    retryingTasks: 2, nextRetryAt: at + 45_000 }, jobs: [
    { ...job("2026-09-30"), evaluation: "evaluating", hours: [],
      summary: { stages: { attribution: { pending: 14, failed: 0 } } },
      execution: { retryingTasks: 2, retryingStages: { attribution: 2 }, nextRetryAt: at + 45_000 } },
    { ...job("2026-09-29"), evaluation: "retry", evaluationAttempts: 2, nextEvaluationAt: at + 90_000, hours: [],
      summary: { stages: { attribution: { failed: 3 } } }, downloadError: "network", nextDownloadAt: at + 60_000,
      mongo: { status: "retry", nextAt: at + 120_000, startedAt: at, error: "network" } },
    { ...job("2026-09-28"), evaluation: "blocked", hours: [], summary: { stages: { attribution: { failed: 99 } } } },
  ], publication: { status: "retry", traceId: "log-retry", nextAt: at + 180_000, window: at } };
  let now = at, failed = false, tick = () => {}, poll = async () => {};
  dom.window.Date.now = () => now;
  dom.window.setInterval = (callback: () => void) => { tick = callback; return 1; };
  dom.window.setTimeout = (callback: () => Promise<void>) => { poll = callback; return 2; };
  dom.window.clearTimeout = () => {};
  dom.window.fetch = async () => { if (failed) throw new Error("offline"); return { ok: true, json: async () => payload }; };
  try {
    dom.window.eval(script); await new Promise((resolve) => setImmediate(resolve));
    const doc = dom.window.document, text = (id: string) => doc.getElementById(id).textContent;
    assert.equal(text("evaluator-version"), settings.evaluatorVersion);
    assert.equal(text("live-concurrency"), "5 / 32 任务");
    assert.equal(text("slot-utilization"), "槽位利用率 15.6% · 空闲 27");
    assert.equal(text("lane-evaluation"), "2026-09-30 · 评测中");
    assert.equal(text("lane-evaluation-queue"), "可执行 12 · 等依赖 7");
    assert.equal(text("lane-mongo"), "等待重试");
    assert.equal(text("lane-log"), "等待重试");
    assert.match(doc.querySelector(".task-pool").textContent, /待执行 12.*待重试 2/);
    assert.match(text("live-stages"), /^2 题 · 标准 0 · 归因 2 · 对比 1 · 改写 2$/);
    assert.equal(text("retry-count"), "5 任务 · 2 日期");
    assert.equal(text("paused-count"), "已暂停 1 日期");
    assert.equal(text("next-retry"), "45 秒后");
    assert.match(text("date-rows"), /连续失败 2 轮/);
    assert.match(text("mongo-progress-rows"), /2 分 0 秒后/);
    assert.match(text("delivery-rows"), /3 分 0 秒后/);
    now += 10_000; tick(); assert.equal(text("next-retry"), "35 秒后");
    doc.getElementById("date-filter").value = "2026-09-28";
    doc.getElementById("date-filter").dispatchEvent(new dom.window.Event("change"));
    assert.equal(text("live-concurrency"), "5 / 32 任务", "global live totals do not change with table filters");
    failed = true; await poll();
    assert.equal(text("concurrency-label"), "并发快照");
    assert.equal(text("lane-evaluation"), "连接中断");
    now += 100_000; tick(); assert.equal(text("next-retry"), "待恢复连接");
    failed = false; await poll(); assert.equal(text("next-retry"), "等待调度");
    payload.status = "stopped"; payload.execution.runningTasks = 0; await poll();
    assert.equal(text("next-retry"), "启动后重试");
    assert.equal(text("live-concurrency"), "0 / 32 任务");
    assert.equal(text("lane-evaluation"), "已停止");
  } finally { dom.window.close(); }
});

test("root launcher prepares then execs one dashboard pipeline; preparation failure never starts it", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "automation-launcher-"));
  try {
    await writeFile(path.join(directory, "automation.sh"), await readFile(path.join(ROOT, "automation.sh")));
    const bin = path.join(directory, "bin"); await mkdir(bin);
    const trace = path.join(directory, "trace");
    const mock = '#!/bin/bash\nprintf "%s\\n" "$*" >> "$AUTOMATION_TEST_TRACE"\nif [[ "$*" == *scripts/build.mjs* && "$AUTOMATION_TEST_FAIL" == 1 ]]; then exit 9; fi\n';
    for (const name of ["node", "npm"]) { await writeFile(path.join(bin, name), mock); await chmod(path.join(bin, name), 0o755); }
    const env = { ...process.env, PATH: bin + ":" + process.env.PATH, AUTOMATION_TEST_TRACE: trace };
    const exec = promisify(execFile);
    await exec("bash", [path.join(directory, "automation.sh"), "--help"], { cwd: tmpdir(), env });
    await assert.rejects(readFile(trace), /ENOENT/);
    await exec("bash", [path.join(directory, "automation.sh"), "--port", "4199", "--config", "settings with spaces.json"], { cwd: tmpdir(), env });
    const commands = (await readFile(trace, "utf8")).trim().split("\n");
    assert(commands.includes("scripts/bootstrap.mjs"));
    assert(commands.includes("scripts/build.mjs"));
    assert.match(commands.at(-1)!, /automations.js run --dashboard --port 4199 --config settings with spaces.json$/);
    await writeFile(trace, "");
    await assert.rejects(exec("bash", [path.join(directory, "automation.sh")], { env: { ...env, AUTOMATION_TEST_FAIL: "1" } }));
    assert.doesNotMatch(await readFile(trace, "utf8"), /automations.js/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
