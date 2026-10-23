import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { emptyUsage, type RunState } from "@eval/contracts";
import { fileSourceReader, runLock, writeJson } from "@eval/data";
import type { AutomationJob, AutomationState } from "@eval/automations";
import { comparisonCodec, buildPlan, type Checkpoint } from "@eval/workflows/comparison";
import { automationSnapshot, startAutomationDashboard, type AutomationDashboardSource } from "../../../apps/host/src/automation-dashboard.js";
import { completionTimeline, createAutomationMonitor } from "../../../apps/host/src/automation-monitor.js";
import { checkpoint } from "../../../apps/host/src/automation-evaluation.js";
import { loadAutomationConfig } from "../../../apps/host/src/automation-config.js";
import { automationMongoTarget } from "../../../apps/host/src/automation-sources.js";
import { createAutomationLlm } from "../../../apps/host/src/automation-llm.js";
import { fixtureConfig, fakeIdentity, fakeEvaluatorVersion } from "../../fixtures/comparison.js";
import { ROOT } from "../../fixtures/services.js";

const { JSDOM } = createRequire(import.meta.url)("jsdom");
const hour = 3600000, at = Date.parse("2026-09-30T01:00:00Z");
const settings = { evaluatorVersion: "current-fixture", concurrency: 32 };
const execution = () => ({ ...settings, runningTasks: 0, runningCases: 0,
  stages: { criteria: 0, attribution: 0, comparison: 0, rewrite: 0 }, retryingStages: { attribution: 0, comparison: 0, rewrite: 0 },
  readyTasks: 0, waitingDependencies: 0, retryingTasks: 0, nextRetryAt: undefined as number | undefined });
const state = (): AutomationState => ({ id: "fixture", sourceUrl: "http://fixture", status: "stopped", startedAt: at, updatedAt: at, jobs: {} });
const scheduling = (ids = ["fixture"]) => createAutomationLlm(ids,
  { sources: Object.fromEntries(ids.map(id => [id, { concurrency: 32 }])) }, async () => {});
const dashboard = () => ({ ...state(), status: "running", sourceName: "fixture", publishMongo: true, publishStatisticsLog: true,
  llm: scheduling().snapshot(), statistics: { attempts: 0, nextAt: at + hour }, statisticsDeliveries: [],
  sources: [{ id: "fixture", name: "fixture", status: "running", dateCount: 0 }] });
const job = (date: string): AutomationJob => ({ date, runIds: ["fixture"], observed: { a_fast: 1, b_fast: 1, a_expert: 1, b_expert: 1 },
  adopted: false, download: "ready", evaluation: "completed", checkedAt: at, downloadAttempts: 0,
  evaluationAttempts: 0, nextDownloadAt: 0, nextEvaluationAt: 0 });

test("dashboard delivery counts exclude receipts from another Mongo destination without deleting them", async () => {
  const config = await loadAutomationConfig(path.join(ROOT, "configs/automations.json"));
  const target = automationMongoTarget(config), current = state(), date = "2026-10-16";
  const receipt = { startedAt: at, completedAt: at + 1000,
    counts: { inputs: 4, comparisons: 2, inserted: 6, updated: 0 } };
  current.jobs[date] = { ...job(date), runIds: [],
    mongo: { ...receipt, target: "another-target", status: "completed", nextAt: 0, attempts: 0 },
    mongoHistory: [{ ...receipt, target: "another-target" }, { ...receipt, target }],
  };
  const before = structuredClone(current);
  const snapshot = await automationSnapshot(config, ROOT, current, settings);
  assert.equal(snapshot.jobs[0].mongo, undefined);
  assert.deepEqual(snapshot.jobs[0].mongoHistory, [{ ...receipt, target }]);
  assert.deepEqual(current, before);
  current.jobs[date].mongo!.target = target;
  assert.equal((await automationSnapshot(config, ROOT, current, settings)).jobs[0].mongo?.counts?.comparisons, 2);
});

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
    let reads = 0;
    const monitor = createAutomationMonitor(directory, automation.dailyComparisonLimitPerTier, {
      revision: fileSourceReader.revision,
      checkpoint: async (output, id) => { reads++; return checkpoint(output, id); },
    });
    const [first, progress] = await Promise.all([
      automationSnapshot(automation, directory, current, settings, monitor), monitor(current.jobs["2026-09-30"]),
    ]);
    assert.equal(reads, 1, "simultaneous dashboard and progress reads share one parse");
    assert.equal(progress.summary!.readyComparisons, first.jobs[0].summary!.readyComparisons);
    assert.equal(Object.hasOwn(progress.runs[0], "tasks"), false, "monitor retains no task bodies or drafts");
    progress.summary!.readyComparisons = -1;
    assert.equal(first.cache.hitRate, null, "no token usage is unknown, not a zero hit rate");
    const second = await automationSnapshot(automation, directory, JSON.parse(JSON.stringify(current)), settings, monitor);
    assert.equal(reads, 1, "unchanged historical checkpoints are not reloaded");
    assert.equal(second.jobs[0].summary!.readyComparisons, 2, "callers cannot mutate the stored projection");
    assert.deepEqual(first.jobs[0].hours, second.jobs[0].hours);
    assert.equal(first.jobs[0].summary!.stages.rewrite.completed, plan.tasks.filter((task) => task.stage === "rewrite" && (task.data as { rewriteOf: { stage: string } }).rewriteOf.stage !== "clustering").length);
    assert.equal(first.jobs[0].summary!.stages.clustering, undefined);
    assert.equal(current.jobs["2026-09-30"].summary, undefined, "read-only projection cannot mutate scheduler state");
    const source = { name: "普通四路", config: automation, output: directory, state: () => current, settings, monitor };
    const server = await startAutomationDashboard({ sources: () => [source], llm: scheduling(), port: 0 });
    try {
      const response = await fetch(server.url + "/api/status");
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual((await response.json() as typeof first).jobs[0].hours, first.jobs[0].hours);
      assert.equal(reads, 1, "HTTP monitoring shares the progress projection");
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
    const live = (await automationSnapshot(automation, directory, current, settings, monitor)).execution;
    assert.equal(reads, 2, "atomic replacement invalidates the prior projection");
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
    assert.equal((await automationSnapshot(automation, directory, current, settings, monitor)).execution.runningTasks, 0);
    current.status = "running";
    await release();
    const stale = (await automationSnapshot(automation, directory, current, settings, monitor)).execution;
    assert.equal(stale.runningTasks, 0, "stale running tasks without a live owner are not real concurrency");
    assert.equal(stale.evaluatorVersion, settings.evaluatorVersion);
    assert.equal(reads, 2, "owner liveness is rechecked without parsing unchanged task state");
    saved.usage = { ...emptyUsage(), input: 20, cacheRead: 70, cacheWrite: 10 };
    await writeJson(path.join(directory, "fixture/state.json"), saved);
    await writeJson(path.join(directory, "fixture2/state.json"), { ...saved, runId: "fixture2",
      usage: { ...emptyUsage(), input: 200, cacheRead: 30, cacheWrite: 70 } });
    current.jobs["2026-09-29"] = { ...job("2026-09-29"), runIds: ["fixture2"] };
    const cached = await automationSnapshot(automation, directory, current, settings, monitor);
    assert.deepEqual(cached.cache, { readTokens: 100, inputTokens: 400, hitRate: .25 });
    assert.equal(cached.jobs.find((job) => job.date === "2026-09-30")!.cache.hitRate, .7);
    assert.equal(cached.jobs.find((job) => job.date === "2026-09-29")!.cache.hitRate, .1);
    const file = path.join(directory, "fixture/state.json");
    await writeFile(file, "invalid JSON");
    assert.match((await automationSnapshot(automation, directory, current, settings, monitor)).jobs[0].monitorError!, /JSON|Unexpected/);
    await rm(file);
    current.jobs["2026-09-30"].evaluation = "completed";
    assert.match((await automationSnapshot(automation, directory, current, settings, monitor)).jobs[0].monitorError!, /状态文件缺失/);
    await writeJson(file, saved);
    assert.equal((await automationSnapshot(automation, directory, current, settings, monitor)).jobs[0].monitorError, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a checkpoint replaced during projection is reread on the next observation", async () => {
  const saved = { runId: "fixture", tasks: {}, preflight: { skipped: [], issues: [] },
    usage: emptyUsage(), config: { comparisons: [] } } as unknown as Checkpoint;
  let revision = "first", reads = 0;
  const monitor = createAutomationMonitor("unused", 300, {
    revision: async () => revision,
    checkpoint: async () => { reads++; revision = "replaced"; return saved; },
  });
  const current = job("2026-10-01");
  await monitor(current);
  await monitor(current);
  await monitor(current);
  assert.equal(reads, 2, "a raced projection is not retained under either file identity");
});

test("one dashboard isolates source snapshots, publication settings and error logs on one port", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "automation-dashboard-sources-"));
  const template = await loadAutomationConfig(path.join(ROOT, "configs/automations.json"));
  const ids = ["remote-evaluation", "remote-six-model-evaluation", "remote-post-training-evaluation", "prediction-evaluation"];
  const names = ["普通四路", "GPT 六路", "后训练双模型", "预测类自动评测"];
  const calls = ids.map(() => 0), date = "2026-10-16", runtimeLogFile = path.join(directory, "runtime.log");
  const sources: AutomationDashboardSource[] = ids.map((id, index) => {
    const current: AutomationState = { ...state(), id, jobs: index < 2 ? { [date]: { ...job(date), runIds: [], evaluation: "pending" } } : {} };
    const monitor = createAutomationMonitor(directory, 300);
    return { name: names[index], config: { ...template, id, publishStatisticsLog: index === 0,
      publication: { ...template.publication, mongoCollection: `collection-${index}` } },
      output: directory, settings, state: () => current,
      monitor: async job => { calls[index]++; return monitor(job); } };
  });
  await writeFile(runtimeLogFile, ids.map(id => JSON.stringify({
    time: new Date().toISOString(), level: "error", component: "automations", automation_id: id, date, message: `${id} error`,
  })).join("\n") + "\n");
  let available: AutomationDashboardSource[] = [];
  const scheduler = scheduling(ids);
  const server = await startAutomationDashboard({ sources: () => available, llm: scheduler, runtimeLogFile, port: 0 });
  try {
    assert.equal((await fetch(server.url + "/api/status")).status, 503);
    available = sources;
    const get = async (route: string) => (await fetch(server.url + route)).json() as Promise<any>;
    const [four, gpt, post, prediction] = await Promise.all(ids.map(id => get(`/api/status?source=${id}`)));
    assert.deepEqual([four.id, gpt.id, post.id, prediction.id], ids);
    assert.deepEqual(four.sources.map((source: any) => [source.name, source.dateCount]),
      names.map((name, index) => [name, index < 2 ? 1 : 0]));
    assert.deepEqual([four.publishStatisticsLog, gpt.publishStatisticsLog, post.publishStatisticsLog, prediction.publishStatisticsLog], [true, false, false, false]);
    assert.deepEqual([four.mongoCollection, gpt.mongoCollection], ["collection-0", "collection-1"]);
    assert.deepEqual(post.jobs, []);
    assert.equal((await get("/api/status")).id, ids[0]);
    assert.deepEqual(calls, [1, 1, 0, 0], "each source has an independent snapshot cache");
    for (const id of ids) {
      const errors = await get(`/api/errors?source=${id}`);
      assert.equal(errors.sourceId, id);
      assert.deepEqual(errors.records.map((entry: any) => entry.record.message), [`${id} error`]);
    }
    assert.equal((await fetch(server.url + "/api/status?source=unknown")).status, 404);
    assert.equal((await fetch(server.url + "/api/errors?source=unknown")).status, 404);
    const allocate = (sourceId: unknown, concurrency: unknown, origin = server.url) => fetch(server.url + "/api/llm-concurrency", {
      method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ sourceId, concurrency }),
    });
    assert.equal((await allocate(ids[3], 16, "https://other.example")).status, 403);
    assert.equal((await allocate("unknown", 16)).status, 404);
    for (const value of [-1, 1.5, "16", null]) assert.equal((await allocate(ids[3], value)).status, 400);
    assert.equal((await allocate(123, 16)).status, 400);
    assert.equal((await allocate(ids[3], 16)).status, 200);
    assert.equal((await get("/api/status")).llm.sources[3].concurrency, 16);
    assert.equal((await get(`/api/status?source=${ids[1]}`)).llm.sources[3].concurrency, 16);
    assert.equal((await allocate(ids[0], 0)).status, 200);
    assert.equal(scheduler.concurrency(ids[0]), 0);
    available = [sources[1]];
    assert.equal((await get("/api/status")).id, ids[1], "a single explicitly configured source is the default");
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("LLM allocations preserve drafts, control each source and show actual provider calls", async () => {
  const html = await readFile(path.join(ROOT, "apps/host/dashboard/automations.html"), "utf8");
  const script = await readFile(path.join(ROOT, "apps/host/dashboard/automations.js"), "utf8");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://fixture/?source=fixture" });
  const controller = scheduling(["fixture", "prediction-evaluation"]);
  await controller.setConcurrency("fixture", 0);
  await controller.setConcurrency("prediction-evaluation", 16);
  const release = await controller.acquire("prediction-evaluation", "2026-10-01", {
    callId: "call", runId: "prediction-date", taskId: "task<one>", stage: "attribution",
    model: { provider: "fixture", model: "judge" },
  } as any, new AbortController().signal);
  const payload = { ...dashboard(), execution: execution(), sampledAt: at, jobs: [],
    sources: [...dashboard().sources, { id: "prediction-evaluation", name: "预测类自动评测", status: "running", dateCount: 13 }] };
  let poll = async () => {}, failWrite = false, offline = false;
  const writes: unknown[] = [];
  dom.window.setTimeout = (callback: () => Promise<void>) => { poll = callback; return 1; };
  dom.window.clearTimeout = () => {};
  dom.window.fetch = async (url: string, options: RequestInit) => {
    if (offline) throw new Error("offline");
    if (url === "/runtime/api/llm-concurrency") {
      assert.equal(options.method, "POST");
      const { sourceId, concurrency } = JSON.parse(String(options.body));
      writes.push([sourceId, concurrency]);
      if (failWrite) return { ok: false, json: async () => ({ error: "allocation write failed" }) };
      await controller.setConcurrency(sourceId, concurrency);
      return { ok: true, json: async () => controller.snapshot() };
    }
    return { ok: true, json: async () => ({ ...payload, llm: controller.snapshot() }) };
  };
  const flush = () => new Promise(resolve => setImmediate(resolve));
  try {
    dom.window.eval(script.replace(/^export /gm, "")); await flush();
    const doc = dom.window.document, input = doc.getElementById("llm-limit-fixture"), form = input.closest("form");
    const submit = (value: string) => { input.value = value; input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); };
    assert.equal(input.value, "0");
    assert.match(form.textContent, /LLM 已暂停/);
    assert.match(doc.getElementById("llm-requests").textContent, /预测类自动评测.*归因任务.*judge.*task<one>/);
    assert.equal(doc.querySelector("#llm-requests one"), null);
    input.value = "7"; input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await poll(); assert.equal(input.value, "7", "polls preserve unsaved allocation drafts");
    submit("4"); assert.equal(input.disabled, true); await flush();
    assert.deepEqual(writes, [["fixture", 4]]);
    assert.equal(input.disabled, false); assert.equal(input.value, "4");
    assert.equal(new URL(dom.window.location.href).searchParams.get("source"), "fixture");
    submit("0"); await flush(); assert.equal(controller.concurrency("fixture"), 0);
    failWrite = true; submit("8"); await flush();
    assert.equal(controller.concurrency("fixture"), 0);
    assert.equal(input.value, "8");
    assert.match(doc.getElementById("llm-error").textContent, /allocation write failed/);
    assert.equal(doc.getElementById("llm-error").hidden, false);
    offline = true; await poll(); assert.equal(input.disabled, true);
  } finally { release(); dom.window.close(); }
});

test("monitor renders receipts, preserves filters on polling and marks stale data after disconnect", async () => {
  const html = await readFile(path.join(ROOT, "apps/host/dashboard/automations.html"), "utf8");
  const script = await readFile(path.join(ROOT, "apps/host/dashboard/automations.js"), "utf8");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://fixture/" });
  const payload = { ...dashboard(), execution: execution(), statisticsDeliveries: [{
      traceId: "trace", automationId: "fixture", status: "uploaded", writtenAt: at + 3000, updatedAt: at + 5000,
      uploadedAt: at + 5000, requestId: "receipt<one>", attempts: 1, logFile: "/fixture/statistics.jsonl",
      logUrl: "http://fixture/upload", record: { logtime: "2026-09-30 09:00:03.000", data: { totalCaseCount: 4,
        progress: { completedBattleCount: 4 } } },
    }], sampledAt: at + hour, logFile: "/fixture/statistics.jsonl", mongoCollection: "fixture_collection", jobs: [
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
    dom.window.eval(script.replace(/^export /gm, ""));
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
    assert.equal(document.querySelectorAll("#date-rows .date-row").length, 1);
    payload.jobs[1].evaluation = "waiting_inputs";
    payload.jobs[1].evaluationError = "Input gaps or invalid records remain; waiting for source updates";
    await next();
    assert.match(document.getElementById("date-rows").textContent, /等待新增输入/);
    assert.doesNotMatch(document.getElementById("date-rows").textContent, /Input gaps/);
    failed = true; await next();
    assert.equal(document.getElementById("pipeline-status").textContent, "连接中断");
    assert.match(document.getElementById("connection-error").textContent, /保留/);
    assert.equal(document.querySelectorAll("#date-rows .date-row").length, 1);
    for (const [id, value] of [["date-filter", "2026-09-30"], ["time-filter", "all"]]) {
      document.getElementById(id).value = value;
      document.getElementById(id).dispatchEvent(new dom.window.Event("change"));
      assert.equal(document.getElementById("pipeline-status").textContent, "连接中断");
    }
    failed = false; payload.status = "stopped"; payload.sources[0].status = "stopped"; await next();
    assert.equal(document.getElementById("pipeline-status").textContent, "已停止");
    assert.equal(document.getElementById("connection-error").hidden, true);
  } finally { dom.window.close(); }
});

test("monitor identifies its source and retains all dates across pagination, filtering and refresh", async () => {
  const html = await readFile(path.join(ROOT, "apps/host/dashboard/automations.html"), "utf8");
  const script = await readFile(path.join(ROOT, "apps/host/dashboard/automations.js"), "utf8");
  const sources = [
    { id: "remote-evaluation", name: "普通四路", sourceUrl: "http://fixture", dates: Array.from({ length: 19 }, (_, i) => `2026-10-${String(19 - i).padStart(2, "0")}`) },
    { id: "remote-six-model-evaluation", name: "GPT 六路", sourceUrl: "http://fixture/gpt", dates: ["2026-10-16"] },
    { id: "remote-post-training-evaluation", name: "后训练双模型", sourceUrl: "http://fixture/post_training_model", dates: [] },
  ];
  for (const source of sources) {
    const dom = new JSDOM(html, { runScripts: "outside-only", url: `http://fixture/?source=${source.id}` });
    const payload = { ...dashboard(), ...source, sourceName: source.name, execution: execution(), sampledAt: at,
      sources: sources.map(source => ({ id: source.id, name: source.name, status: "running", dateCount: source.dates.length })),
      publishStatisticsLog: source === sources[0], publishMongo: source !== sources[2],
      statistics: { attempts: 0, nextAt: at + hour }, statisticsDeliveries: [],
      jobs: source.dates.map(date => ({ ...job(date), hours: [] })) };
    let poll = async () => {};
    dom.window.setTimeout = (callback: () => Promise<void>) => { poll = callback; return 1; };
    dom.window.clearTimeout = () => {};
    dom.window.fetch = async (url: string) => {
      assert.equal(new URL(url, dom.window.location.href).searchParams.get("source"), source.id);
      return { ok: true, json: async () => payload };
    };
    try {
      dom.window.eval(script.replace(/^export /gm, "")); await new Promise(resolve => setImmediate(resolve));
      const doc = dom.window.document;
      assert.equal(doc.getElementById("mongo-deliveries").hidden, !payload.publishMongo);
      if (!payload.publishMongo) {
        assert.equal(doc.getElementById("lane-mongo").textContent, "本地保存");
        assert.equal(doc.getElementById("lane-mongo-queue").textContent, "");
      }
      assert.equal(doc.getElementById("source-url")?.textContent, source.sourceUrl);
      assert.equal(doc.title, "自动化评测");
      assert.equal(doc.querySelector('#source-nav [aria-current="page"]').dataset.source, source.id);
      assert.deepEqual([...doc.querySelectorAll("#source-nav button")].map((link: any) => link.dataset.source), sources.map(source => source.id));
      assert.match(doc.querySelector('#source-nav button:last-child').textContent, /后训练双模型等待数据 · 0 个日期/);
      if (!payload.publishStatisticsLog) {
        assert.equal(doc.getElementById("lane-log").textContent, "已关闭");
        assert.equal(doc.getElementById("delivery-rows").textContent, "统计日志已关闭");
      }
      assert.deepEqual([...doc.querySelectorAll("#date-filter option")].map((option: any) => option.value), ["", ...source.dates]);
      const visible = () => [...doc.querySelectorAll("#date-rows strong")].map((cell: any) => cell.textContent);
      const rendered = [...visible()];
      const next = doc.querySelector('#date-pagination [data-step="1"]');
      while (!next.disabled) { next.click(); rendered.push(...visible()); }
      assert.deepEqual(rendered, source.dates);
      if (source.dates.length) {
        doc.getElementById("date-filter").value = "2026-10-16";
        doc.getElementById("date-filter").dispatchEvent(new dom.window.Event("change"));
        await poll();
        assert.deepEqual(visible(), ["2026-10-16"]);
        doc.getElementById("reset-filters").click();
        assert.deepEqual(visible(), source.dates.slice(0, 10));
        assert.equal(doc.getElementById("date-total").textContent, `${source.dates.length} 个日期`);
      }
    } finally { dom.window.close(); }
  }
});

test("review errors show complete task IDs and preserve scroll on polling", async () => {
  const html = await readFile(path.join(ROOT, "apps/host/dashboard/automations.html"), "utf8");
  const script = await readFile(path.join(ROOT, "apps/host/dashboard/automations.js"), "utf8");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://fixture/" });
  const ids = Array.from({ length: 21 }, (_, i) => `d6092ecc-cec5-4dfd-9ec9-${String(i).padStart(12, "0")}`);
  const payload = { ...dashboard(), execution: execution(), sampledAt: at, jobs: [{
    ...job("2026-10-16"), hours: [], evaluation: "blocked", evaluationError: `Comparison remains unresolved: ${ids.join(", ")}`,
    downloadError: "<img src=x onerror=alert(1)>" + "timeout ".repeat(100), nextDownloadAt: at,
  }] };
  let poll = async () => {};
  dom.window.setTimeout = (callback: () => Promise<void>) => { poll = callback; return 1; };
  dom.window.clearTimeout = () => {};
  dom.window.fetch = async () => ({ ok: true, json: async () => payload });
  try {
    dom.window.eval(script.replace(/^export /gm, "")); await new Promise(resolve => setImmediate(resolve));
    const doc = dom.window.document, review = () => doc.querySelector('[data-error-key="evaluation:2026-10-16"]');
    assert.equal(review().querySelector("header").textContent, "对比待复核 · 21 项");
    assert.deepEqual(review().querySelector("pre").textContent.split("\n").slice(1), ids);
    assert.equal(doc.querySelector(".row-error img"), null);
    const download = doc.querySelector('[data-error-key="download:2026-10-16"]');
    assert.equal(download.querySelector("header").textContent, "下载错误");
    assert.equal(download.querySelector("pre").textContent, payload.jobs[0].downloadError);
    review().querySelector("pre").scrollTop = 72;
    review().querySelector("pre").scrollLeft = 50;
    review().querySelector("pre").focus();
    await poll();
    assert.equal(review().querySelector("pre").scrollTop, 72);
    assert.equal(review().querySelector("pre").scrollLeft, 50);
    assert.equal(doc.activeElement, review().querySelector("pre"));
  } finally { dom.window.close(); }
});

test("date table separates remote/local input rows, refresh state, completed comparisons and retryable task counts", async () => {
  const html = await readFile(path.join(ROOT, "apps/host/dashboard/automations.html"), "utf8");
  const script = await readFile(path.join(ROOT, "apps/host/dashboard/automations.js"), "utf8");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://fixture/" });
  const observed = { a_fast: 239, b_fast: 218, a_expert: 237, b_expert: 196 };
  const stage = (total: number, completed: number, pending: number, failed = 0, blocked = 0) =>
    ({ total, completed, pending, failed, blocked, cancelled: 0, running: 0 });
  const payload = { ...dashboard(), execution: execution(), status: "running", sampledAt: at, jobs: [{ ...job("2026-09-28"), observed, downloaded: observed,
    download: "downloading", evaluation: "retry", nextEvaluationAt: at + 1000, hours: [],
    summary: { readyComparisons: 139, skipped: 83, stages: {
      attribution: stage(810, 290, 505, 15), comparison: stage(405, 280, 111, 0, 14),
      rewrite: stage(1225, 429, 763, 0, 33), clustering: stage(10, 0, 6, 0, 4),
    } },
    mongo: { status: "completed", completedAt: at, counts: { inputs: 890, comparisons: 138 } },
  }] };
  let poll = async () => {};
  dom.window.setTimeout = (callback: () => Promise<void>) => { poll = callback; return 1; };
  dom.window.clearTimeout = () => {};
  dom.window.fetch = async () => ({ ok: true, json: async () => payload });
  try {
    dom.window.eval(script.replace(/^export /gm, "")); await new Promise((resolve) => setImmediate(resolve));
    const document = dom.window.document;
    assert.equal(document.querySelector(".remote-inputs").textContent, "890");
    assert.match(document.querySelector(".local-inputs").textContent, /^890/);
    assert.match(document.getElementById("date-rows").textContent, /核对更新中/);
    assert.equal(document.querySelector(".completed-comparisons").textContent, "139", "publishable result count is independent of comparison task totals and accepted receipts");
    assert.match(document.querySelector('.stage-tasks[data-stage="comparison"]').textContent, /^280 \/ 405待执行 111依赖阻塞 14$/);
    assert.equal(document.querySelector(".date-table th:nth-child(6)").textContent, "完成对比（含改写）");
    assert.equal(document.querySelectorAll(".date-table th").length, 6);
    assert.match(document.querySelector(".task-pool").textContent, /待执行 1,379待重试 15依赖阻塞 47/);
    assert.match(document.querySelector(".mongo-outputs").textContent, /^138待上传 1$/);
    assert.match(document.getElementById("mongo-progress-rows").textContent, /等待同步新输出/);
    assert.equal(document.getElementById("tasks-2026-09-28").hidden, false);
    await poll();
    assert.equal(document.getElementById("tasks-2026-09-28").hidden, false);
    assert.equal(document.querySelector("details"), null);
  } finally { dom.window.close(); }
});

test("monitor paginates each record list, preserves pages during polling and resets scoped filters", async () => {
  const html = await readFile(path.join(ROOT, "apps/host/dashboard/automations.html"), "utf8");
  const script = await readFile(path.join(ROOT, "apps/host/dashboard/automations.js"), "utf8");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://fixture/#mongo-deliveries" });
  const payload = { ...dashboard(), execution: execution(), sampledAt: at + hour, jobs: Array.from({ length: 23 }, (_, index) => ({
    ...job(`2026-09-${String(23 - index).padStart(2, "0")}`),
    hours: [{ start: at - index * hour, completed: 1, stages: { comparison: 1 } }],
    mongoHistory: index ? [] : Array.from({ length: 25 }, (_, i) => ({ startedAt: at - i * 1000,
      completedAt: at - i * 1000 + 50, counts: { inputs: 25 - i, comparisons: 25 - i, inserted: 1, updated: 0 } })),
  })), statisticsDeliveries: Array.from({ length: 23 }, (_, index) => ({
    traceId: `trace-${index}`, automationId: "fixture", status: "uploaded", writtenAt: at - index * 1000,
    updatedAt: at - index * 1000, requestId: `receipt-${index}`, uploadedAt: at - index * 1000,
    attempts: 1, logFile: "/fixture/statistics.jsonl", logUrl: "http://fixture/upload",
    record: { logtime: "2026-09-30 09:00:00.000", data: { totalCaseCount: 1, progress: { completedBattleCount: 1 } } },
  })) };
  let poll = async () => {};
  dom.window.setTimeout = (callback: () => Promise<void>) => { poll = callback; return 1; };
  dom.window.clearTimeout = () => {};
  dom.window.fetch = async () => ({ ok: true, json: async () => payload });
  try {
    dom.window.eval(script.replace(/^export /gm, "")); await new Promise((resolve) => setImmediate(resolve));
    const document = dom.window.document, el = (id: string) => document.getElementById(id);
    for (const id of ["dates", "activity", "mongo-deliveries", "deliveries"]) assert.equal(el(id).hidden, false);
    for (const id of ["date", "activity", "mongo-progress", "mongo", "delivery"])
      assert.equal(document.querySelectorAll(`#${id}-rows tr:not(.date-detail-row)`).length, 10);
    assert.match(el("mongo-total").textContent, /输入 25 条/);
    document.querySelector('#mongo-pagination [data-step="1"]').click();
    document.querySelector('#mongo-progress-pagination [data-step="1"]').click();
    assert.match(el("mongo-pagination").textContent, /11–20 \/ 25 条/);
    await poll();
    assert.match(el("mongo-pagination").textContent, /2 \/ 3 页/);
    assert.match(el("mongo-progress-pagination").textContent, /2 \/ 3 页/);
    assert.equal(el("date-filter-label").hidden, false);
    assert.equal(el("time-filter-label").hidden, false);
    document.querySelector('#delivery-pagination [data-step="1"]').click();
    assert.match(el("delivery-rows").textContent, /receipt-10/);
    assert.doesNotMatch(el("delivery-rows").textContent, /receipt-0\b/);
    assert.match(el("mongo-pagination").textContent, /2 \/ 3 页/, "each table retains its page");
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
    assert.equal(el("time-filter-label").hidden, false);
    document.querySelector('#date-pagination [data-step="1"]').click();
    assert.equal(el("date-rows").rows[0].cells[0].textContent, "2026-09-13");
    assert.match(el("date-total").textContent, /23 个日期/, "totals describe all filtered results, not just the current page");
    assert.equal(document.querySelector('[role="tabpanel"]'), null);
  } finally { dom.window.close(); }
});

test("download status distinguishes stale counts, active attempts, source readiness and real retry errors", async () => {
  const html = await readFile(path.join(ROOT, "apps/host/dashboard/automations.html"), "utf8");
  const script = await readFile(path.join(ROOT, "apps/host/dashboard/automations.js"), "utf8");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://fixture/" });
  const current: any = { ...job("2026-09-29"), sourceReady: true, hours: [],
    observed: { a_fast: 188, b_fast: 172, a_expert: 191, b_expert: 186 },
    downloaded: { a_fast: 135, b_fast: 119, a_expert: 136, b_expert: 132 } };
  const payload = { ...dashboard(), execution: execution(), status: "running", sampledAt: at, jobs: [current],
    cache: { readTokens: 75, inputTokens: 100, hitRate: .75 } };
  let poll = async () => {};
  dom.window.setTimeout = (callback: () => Promise<void>) => { poll = callback; return 1; };
  dom.window.clearTimeout = () => {};
  dom.window.fetch = async () => ({ ok: true, json: async () => payload });
  try {
    dom.window.eval(script.replace(/^export /gm, "")); await new Promise((resolve) => setImmediate(resolve));
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
  const payload = { ...dashboard(), status: "running", sampledAt: at, execution: { ...execution(), runningTasks: 5,
    runningCases: 2, stages: { attribution: 2, comparison: 1, rewrite: 2 }, readyTasks: 12, waitingDependencies: 7,
    retryingTasks: 2, nextRetryAt: at + 45_000 }, jobs: [
    { ...job("2026-09-30"), evaluation: "evaluating", hours: [],
      summary: { stages: { attribution: { pending: 14, failed: 0 } } },
      execution: { retryingTasks: 2, retryingStages: { attribution: 2 }, nextRetryAt: at + 45_000 } },
    { ...job("2026-09-29"), evaluation: "retry", evaluationAttempts: 2, nextEvaluationAt: at + 90_000, hours: [],
      summary: { stages: { attribution: { failed: 3 } } }, downloadError: "network", nextDownloadAt: at + 60_000,
      mongo: { status: "retry", nextAt: at + 120_000, startedAt: at, error: "network" } },
    { ...job("2026-09-28"), evaluation: "blocked", hours: [], summary: { stages: { attribution: { failed: 99 } } } },
  ], statistics: { attempts: 1, nextAt: at + 180_000, error: "relay pending" },
    statisticsDeliveries: [{ traceId: "log-retry", automationId: "fixture", status: "pending", writtenAt: at,
      updatedAt: at, attempts: 1, logFile: "/fixture/statistics.jsonl", logUrl: "http://fixture/upload",
      record: { logtime: "2026-09-30 09:00:00.000", data: { totalCaseCount: 1, progress: { completedBattleCount: 1 } } } }] };
  let now = at, failed = false, tick = () => {}, poll = async () => {};
  dom.window.Date.now = () => now;
  dom.window.setInterval = (callback: () => void) => { tick = callback; return 1; };
  dom.window.setTimeout = (callback: () => Promise<void>) => { poll = callback; return 2; };
  dom.window.clearTimeout = () => {};
  dom.window.fetch = async () => { if (failed) throw new Error("offline"); return { ok: true, json: async () => payload }; };
  try {
    payload.llm.sources[0].active = 2;
    dom.window.eval(script.replace(/^export /gm, "")); await new Promise((resolve) => setImmediate(resolve));
    const doc = dom.window.document, text = (id: string) => doc.getElementById(id).textContent;
    assert.equal(text("evaluator-version"), settings.evaluatorVersion);
    assert.equal(text("live-concurrency"), "2 / 32 请求");
    assert.equal(text("slot-utilization"), "LLM 2 · 运行任务 5");
    assert.equal(text("lane-evaluation"), "2026-09-30 · 评测中");
    assert.equal(text("lane-evaluation-queue"), "可执行 12 · 等依赖 7");
    assert.equal(text("lane-mongo"), "等待重试");
    assert.equal(text("lane-log"), "待上传 1 条");
    assert.match(doc.querySelector(".task-pool").textContent, /待执行 12.*待重试 2/);
    assert.match(text("live-stages"), /^2 题 · 标准 0 · 归因 2 · 对比 1 · 改写 2$/);
    assert.equal(text("retry-count"), "5 任务 · 2 日期");
    assert.equal(text("paused-count"), "已暂停 1 日期");
    assert.equal(text("next-retry"), "45 秒后");
    assert.match(text("date-rows"), /连续失败 2 轮/);
    assert.match(text("mongo-progress-rows"), /2 分 0 秒后/);
    assert.match(text("delivery-rows"), /log-retry/);
    assert.match(text("delivery-rows"), /等待中/);
    now += 10_000; tick(); assert.equal(text("next-retry"), "35 秒后");
    doc.getElementById("date-filter").value = "2026-09-28";
    doc.getElementById("date-filter").dispatchEvent(new dom.window.Event("change"));
    assert.equal(text("live-concurrency"), "2 / 32 请求", "global live totals do not change with table filters");
    failed = true; await poll();
    assert.equal(text("concurrency-label"), "LLM 并发快照");
    assert.equal(text("lane-evaluation"), "连接中断");
    now += 100_000; tick(); assert.equal(text("next-retry"), "待恢复连接");
    failed = false; await poll(); assert.equal(text("next-retry"), "等待调度");
    payload.status = "stopped"; payload.execution.runningTasks = 0; payload.llm.sources[0].active = 0; await poll();
    assert.equal(text("next-retry"), "启动后重试");
    assert.equal(text("live-concurrency"), "0 / 32 请求");
    assert.equal(text("lane-evaluation"), "已停止");
  } finally { dom.window.close(); }
});

test("workbench is the only production launcher", async () => {
  const script = await readFile(path.join(ROOT, "workbench.sh"), "utf8");
  assert.match(script, /dist\/apps\/host\/src\/workbench\.js/);
  assert.match(script, /npm run bootstrap/);
  assert.match(script, /npm run build:app/);
});

test("manual monitor does not poll or run until clicked, and stops polling after stop", async () => {
  const html = await readFile(path.join(ROOT, "apps/host/dashboard/automations.html"), "utf8");
  const script = await readFile(path.join(ROOT, "apps/host/dashboard/automations.js"), "utf8");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://fixture/" });
  const control = { status: "idle" };
  const payload = { ...dashboard(), status: "stopped", control, sources: [{ id: "fixture", name: "fixture", status: "stopped", control, dateCount: 0 }], sampledAt: at, jobs: [] };
  const calls: { url: string; method: string; body?: string }[] = [];
  let scheduled = false, poll = async () => {};
  dom.window.setTimeout = (callback: () => Promise<void>, delay: number) => {
    if (delay === 5000) { scheduled = true; poll = callback; }
    return 1;
  };
  dom.window.clearTimeout = () => { scheduled = false; };
  dom.window.setInterval = () => 0;
  dom.window.fetch = async (url: string, options: RequestInit = {}) => {
    calls.push({ url, method: options.method ?? "GET", body: options.body as string | undefined });
    if (url.endsWith("/control")) {
      control.status = JSON.parse(options.body as string).action === "run" ? "running" : "idle";
      payload.status = control.status === "running" ? "running" : "stopped";
      return { ok: true, json: async () => structuredClone(control) };
    }
    return { ok: true, json: async () => structuredClone(payload) };
  };
  try {
    dom.window.eval(script.replace(/^export /gm, "")); await new Promise(setImmediate);
    const doc = dom.window.document;
    assert.equal(calls.length, 1);
    assert.equal(scheduled, false);
    assert.equal(doc.getElementById("pipeline-status").textContent, "待运行");
    assert.equal(doc.getElementById("source-run").disabled, false);
    assert.equal(doc.getElementById("source-stop").disabled, true);
    doc.getElementById("source-run").click(); await new Promise(setImmediate);
    assert.deepEqual(JSON.parse(calls.find(call => call.method === "POST")!.body!), { sourceId: "fixture", action: "run" });
    assert.equal(doc.getElementById("source-run").disabled, true);
    assert.equal(doc.getElementById("source-stop").disabled, false);
    assert.equal(scheduled, true);
    await poll();
    doc.getElementById("source-stop").click(); await new Promise(setImmediate);
    assert.equal(scheduled, false);
    assert.equal(doc.getElementById("pipeline-status").textContent, "待运行");
    assert.equal(calls.filter(call => call.method === "POST").length, 2);
  } finally { dom.window.close(); }
});
