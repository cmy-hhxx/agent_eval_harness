import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { emptyUsage, type RunState } from "@eval/contracts";
import { writeJson } from "@eval/data";
import type { AutomationJob, AutomationState } from "@eval/automations";
import { comparisonCodec, buildPlan } from "@eval/workflows/comparison";
import { completionTimeline, automationSnapshot, startAutomationDashboard } from "../../../apps/host/src/automation-dashboard.js";
import { loadAutomationConfig } from "../../../apps/host/src/automation-config.js";
import { fixtureConfig, fakeIdentity, fakeEvaluatorVersion } from "../../fixtures/comparison.js";
import { ROOT } from "../../fixtures/services.js";

const { JSDOM } = createRequire(import.meta.url)("jsdom");
const hour = 3600000, at = Date.parse("2026-09-30T01:00:00Z");
const state = (): AutomationState => ({ id: "fixture", sourceUrl: "http://fixture", status: "stopped", startedAt: at, updatedAt: at, jobs: {} });
const job = (date: string): AutomationJob => ({ date, runIds: ["fixture"], observed: { a_fast: 1, b_fast: 1, a_expert: 1, b_expert: 1 },
  adopted: false, download: "ready", evaluation: "completed", checkedAt: at, downloadAttempts: 0,
  evaluationAttempts: 0, nextDownloadAt: 0, nextEvaluationAt: 0 });

test("monitor derives completion hours from all-stage receipts without recounting on refresh or restart", async () => {
  const { directory, config } = await fixtureConfig(undefined, true, true);
  try {
    config.rewrite = { attribution: true, comparison: true, clustering: true };
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
    assert.equal(completionTimeline([saved]).reduce((n, row) => n + row.completed, 0), 1);
    lastRewrite.status = "succeeded";
    lastRewrite.receipt!.acceptedAt = at + hour;
    assert.deepEqual(completionTimeline([saved]).map((row) => [row.start, row.completed]), [[at + hour, 1], [at, 1]]);
    const current = state(); current.jobs["2026-09-30"] = job("2026-09-30");
    await writeJson(path.join(directory, "fixture/state.json"), saved);
    const automation = await loadAutomationConfig(path.join(ROOT, "configs/automations.json"));
    const first = await automationSnapshot(automation, directory, current);
    const second = await automationSnapshot(automation, directory, JSON.parse(JSON.stringify(current)));
    assert.deepEqual(first.jobs[0].hours, second.jobs[0].hours);
    assert.equal(first.jobs[0].summary!.stages.rewrite.completed, plan.tasks.filter((task) => task.stage === "rewrite").length);
    assert.equal(current.jobs["2026-09-30"].summary, undefined, "read-only projection cannot mutate scheduler state");
    const server = await startAutomationDashboard({ config: automation, output: directory, state: () => current, port: 0 });
    try {
      const response = await fetch(server.url + "/api/status");
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual((await response.json() as typeof first).jobs[0].hours, first.jobs[0].hours);
      assert.equal((await fetch(server.url + "/api/status", { method: "POST" })).status, 405);
      assert.equal((await fetch(server.url + "/.env")).status, 404);
      assert.match(await (await fetch(server.url)).text(), /全阶段完成对比/);
      assert.match(await (await fetch(server.url + "/automations.js")).text(), /api\/status/);
    } finally { await server.close(); }
    await assert.rejects(fetch(server.url), /fetch failed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("monitor renders receipts, preserves filters on polling and marks stale data after disconnect", async () => {
  const html = await readFile(path.join(ROOT, "apps/host/dashboard/automations.html"), "utf8");
  const script = await readFile(path.join(ROOT, "apps/host/dashboard/automations.js"), "utf8");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://fixture/" });
  const payload = { ...state(), publication: {
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
  const payload = { ...state(), status: "running", sampledAt: at, jobs: [{ ...job("2026-09-28"), observed, downloaded: observed,
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
    assert.match(document.querySelector(".task-pool").textContent, /待执行 1,526待重试 15依赖阻塞 51/);
    assert.match(document.querySelector(".mongo-outputs").textContent, /^138待上传 1$/);
    assert.match(document.getElementById("mongo-progress-rows").textContent, /等待同步新输出/);
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
