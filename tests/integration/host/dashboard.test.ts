import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, readFile, rm } from "node:fs/promises";
import { startDashboard } from "../../../apps/host/src/dashboard.js";
import { loadConfig, editableDashboardSettings } from "@eval/host-app/config";
import { emptyUsage, type RunState, type SubmissionReceipt } from "@eval/contracts";
import { exists, writeJson, writeJsonl } from "@eval/data";
import { json, listen } from "@eval/runtime/http";
import {
  attributionRow, buildPlan, listInputInventory, listRunCases, readCaseDetail, readRegisteredInput, writeRunState,
} from "@eval/workflows/comparison";
import { attributionResult, emptyAudit, fakeIdentity, fixtureConfig, raw } from "../../fixtures/comparison.js";

const gateway = "https://private-gateway.example/v1";

async function setup(rewrite = false) {
  const { directory, config } = await fixtureConfig([
    [raw("q1"), raw("q2")], [], [raw("q1"), raw("q2")], [],
  ], rewrite);
  const configFile = path.join(directory, "dashboard-config.json");
  await writeJson(configFile, {
    inputs: config.inputs,
    comparisons: config.comparisons,
    rewrite: config.rewrite,
    execution: config.execution,
    output: config.output,
    attribution: config.attribution,
    models: {
      judge: {
        provider: "test-gateway", baseUrlEnv: "EVAL_BASE_URL", apiKeyEnv: "EVAL_API_KEY",
        api: "openai-completions", model: "fixture-model", thinking: "off",
        contextWindow: 8192, maxOutputTokens: 2048,
      },
    },
    bindings: { attribution: { profile: "judge" }, comparison: { profile: "judge" }, rewrite: { profile: "judge" } },
  });
  const plan = await buildPlan(config);
  const run = path.join(config.output.path, "run-one");
  await mkdir(path.join(run, "results"), { recursive: true });
  const task = plan.tasks.find((item) => item.stage === "attribution")!;
  const receipt: SubmissionReceipt = {
    taskId: task.id, attemptId: "attempt-1", submissionId: "submission-1",
    evaluation: attributionResult(), audit: emptyAudit(), usage: emptyUsage(),
    acceptedAt: Date.now(), status: "succeeded",
  };
  const row = attributionRow(task, receipt);
  receipt.exported = { id: task.id, file: "attribution.jsonl", row };
  const state: RunState = {
    manifest: {
      format: "evaluation-run", runId: "run-one", status: "interrupted", engine: fakeIdentity,
      config, debug: false, tasks: plan.tasks, inputCatalog: plan.catalog,
      inputs: Object.fromEntries(Object.keys(plan.inputs).map((id) => [id, { id, name: id }])),
      states: Object.fromEntries(plan.tasks.map((item) => [item.id, {
        status: item.id === task.id ? "succeeded" : "pending", attempts: item.id === task.id ? 1 : 0,
      }])),
      preflight: plan.summary, startedAt: Date.now(), concurrency: 2,
    },
    receipts: { [task.id]: receipt }, usage: emptyUsage(), recordedAttempts: 1,
  };
  await writeJsonl(path.join(run, "results", "attribution.jsonl"), [row]);
  await writeRunState(run, state);
  return { directory, config, configFile, task, run, row };
}

test("dashboard workflow view pages cases, resolves moved inputs, and reads authoritative results", async () => {
  const fixture = await setup();
  try {
    const page = await listRunCases(fixture.run, { page: 1, pageSize: 1, status: "succeeded" });
    assert.equal(page.total, 1);
    assert.equal(page.cases[0].case_id, "q1");
    assert.equal((await listRunCases(fixture.run, { page: 2, pageSize: 1 })).cases[0].case_id, "q2");
    const detail = (await readCaseDetail(fixture.run, "b1", "q1"))!;
    assert.equal(detail.tasks.find((item) => item.id === fixture.task.id)?.result?.evaluation_type, "attribution");
    assert.match(JSON.stringify(detail.tasks.find((item) => item.id === fixture.task.id)?.result), /正确给出结果/);
    const inputId = fixture.task.inputIds.A;
    const source = fixture.config.inputs.versions.find((version) => version.id === fixture.row.version)!.sources[0].path;
    await writeJsonl(source, [raw("new-case"), raw("q1"), raw("q2")]);
    const input = (await readRegisteredInput(fixture.run, inputId))!;
    assert.equal(input.line, 2);
    assert.equal(input.recorded_line, 1);
    assert.deepEqual(input.raw.messages, raw("q1").messages);
    assert.equal(await readRegisteredInput(fixture.run, "not-registered"), undefined);
    await rm(path.join(fixture.run, "results", "attribution.jsonl"));
    await assert.rejects(readCaseDetail(fixture.run, "b1", "q1"), /结果文件缺失/);
    assert.equal((await readRegisteredInput(fixture.run, inputId))?.case_id, "q1");
    await rm(source);
    await assert.rejects(readRegisteredInput(fixture.run, inputId), /ENOENT/);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("input inventory lists dates and cases from the configured sources", async () => {
  const { directory, config } = await fixtureConfig([
    [{ ...raw("q1"), batch_id: "b1" }, { ...raw("q2"), batch_id: "b2" }], [], [raw("q1")], [],
  ]);
  try {
    const inventory = await listInputInventory(config);
    assert.equal(inventory.dates.length, 1);
    const day = inventory.dates[0]!;
    assert.equal(day.folder, path.basename(directory));
    assert.deepEqual(day.batches, ["b1", "b2"]);
    assert.deepEqual(day.versions, ["a_fast", "aa_fast"]);
    assert.deepEqual(day.cases.map((item) => item.id), ["q1", "q2"]);
    assert.deepEqual(day.cases.find((item) => item.id === "q1")!.versions, ["a_fast", "aa_fast"]);
    assert.deepEqual(day.cases.find((item) => item.id === "q1")!.batches, ["b1"]);
    assert.deepEqual(day.cases.find((item) => item.id === "q2")!.batches, ["b2"]);
    assert.equal(inventory.issues, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("dashboard view projects rewrite tasks onto their source sample", async () => {
  const fixture = await setup(true);
  try {
    const page = await listRunCases(fixture.run, { page: 1, pageSize: 40 });
    assert.equal(page.total, 2);
    const q1 = page.cases.find((item) => item.case_id === "q1")!;
    assert.deepEqual(Object.keys(q1.stages).sort(), ["attribution", "comparison", "rewrite"]);
    const detail = (await readCaseDetail(fixture.run, "b1", "q1"))!;
    const attributionIds = new Set(detail.tasks.filter((task) => task.stage === "attribution").map((task) => task.id));
    const comparison = detail.tasks.find((task) => task.stage === "comparison")!;
    assert.deepEqual(comparison.versions, ["a_fast", "aa_fast"]);
    const rewrites = detail.tasks.filter((task) => task.stage === "rewrite");
    assert.equal(rewrites.length, 3);
    for (const task of rewrites) {
      assert.deepEqual(task.versions, []);
      assert(task.rewrite_of && detail.tasks.some((item) => item.id === task.rewrite_of!.taskId));
    }
    assert(rewrites.some((task) => task.rewrite_of!.stage === "attribution" && task.rewrite_of!.taskId === fixture.task.id));
    assert(rewrites.some((task) => task.rewrite_of!.stage === "comparison" && task.rewrite_of!.taskId === comparison.id));
    assert(attributionIds.has(fixture.task.id));
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("dashboard HTTP keeps secrets out, previews without writing a run, and rejects unsafe changes", async () => {
  const fixture = await setup();
  const previousUrl = process.env.EVAL_BASE_URL;
  const previousKey = process.env.EVAL_API_KEY;
  process.env.EVAL_BASE_URL = gateway;
  process.env.EVAL_API_KEY = "private-key-do-not-expose";
  const server = await startDashboard({ configPaths: [fixture.configFile], port: 0 });
  const get = async (route: string) => fetch(server.url + route);
  const post = async (route: string, payload: unknown, origin = server.url) => fetch(server.url + route, {
    method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(payload),
  });
  try {
    const config = await get("/api/dashboard/config");
    assert.equal(config.headers.get("cache-control"), "no-store");
    assert.match(config.headers.get("content-security-policy") || "", /script-src 'self'/);
    const text = await config.text();
    assert(!text.includes("private-key-do-not-expose"));
    assert(!text.includes(gateway));
    assert.equal(JSON.parse(text).settings.bindings.attribution.model, "fixture-model");
    const inventory = await (await get("/api/dashboard/inputs")).json();
    assert.equal(inventory.dates.length, 1);
    assert.deepEqual(inventory.dates[0].cases.map((item: { id: string }) => item.id), ["q1", "q2"]);
    const list = await (await get("/api/dashboard/runs/run-one/cases?status=succeeded")).json();
    assert.equal(list.total, 1);
    const detail = await (await get("/api/dashboard/runs/run-one/cases/detail?batch=b1&case=q1")).json();
    assert.equal(detail.tasks.find((item: { id: string }) => item.id === fixture.task.id).status, "succeeded");
    const input = await get(`/api/dashboard/runs/run-one/inputs/${fixture.task.inputIds.A}`);
    assert.equal((await input.json()).raw.messages[1].content, "2+2=4");
    assert.equal((await get("/api/dashboard/runs/run-one/inputs/unknown")).status, 404);
    assert.equal((await post("/api/dashboard/preview", { runId: "new-run" }, "http://untrusted.example")).status, 403);
    const preview = await post("/api/dashboard/preview", {
      runId: "new-run", batch: ["b1"], settings: { execution: { concurrency: 1 }, bindings: { comparison: { model: "other-model" } } },
    });
    assert.equal(preview.status, 200);
    assert.equal((await preview.json()).summary.cases, 2);
    assert.equal(await exists(path.join(fixture.config.output.path, "new-run")), false);
    const checkpoint = await readFile(path.join(fixture.run, "state.json"), "utf8");
    const resumed = await (await post("/api/dashboard/preview", { runId: "run-one", batch: ["unrelated"] })).json();
    assert.equal(resumed.resuming, true);
    assert.match(resumed.selection_note, /原批次/);
    assert(resumed.remaining > 0);
    assert.equal(resumed.summary.cases, 2);
    assert.equal(await readFile(path.join(fixture.run, "state.json"), "utf8"), checkpoint);
    assert.equal((await post("/api/dashboard/preview", { runId: "new-run", settings: { output: { path: "/tmp" } } })).status, 400);
    assert.equal((await post("/api/dashboard/runs", { runId: "new-run", settings: { bindings: { comparison: { apiKeyEnv: "X" } } } })).status, 400);
    assert.equal((await post("/api/dashboard/runs", { runId: "../escape" })).status, 400);
    assert.equal((await get("/api/dashboard/runs/run-one/cases?page=-1")).status, 400);
    await rm(path.join(fixture.run, "results", "attribution.jsonl"));
    const missing = await get("/api/dashboard/runs/run-one/cases/detail?batch=b1&case=q1");
    assert.equal(missing.status, 500);
    assert.match((await missing.json()).error, /结果文件缺失/);
  } finally {
    await server.close();
    if (previousUrl === undefined) delete process.env.EVAL_BASE_URL; else process.env.EVAL_BASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.EVAL_API_KEY; else process.env.EVAL_API_KEY = previousKey;
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("dashboard forwards controls to the locked Host without exposing its token", async () => {
  const fixture = await setup();
  const previousUrl = process.env.EVAL_BASE_URL;
  process.env.EVAL_BASE_URL = gateway;
  const calls: unknown[] = [];
  const host = await listen(async (req, res, url) => {
    if (url.pathname === "/api/progress") return json(res, {
      queued: 2, running: 1, accepted: 1, repairing: 0, failures: {}, concurrency: 3,
      recent_completed_per_minute: 1, longest_without_progress: null, eta: null, eta_status: "insufficient_samples",
    });
    calls.push({ path: url.pathname, token: req.headers["x-run-token"] });
    return json(res, { accepted: true });
  });
  await writeJson(path.join(fixture.run, ".run-lock"), { pid: process.pid, token: "local-token", url: host.url });
  const dashboard = await startDashboard({ configPaths: [fixture.configFile], port: 0 });
  try {
    const listing = await (await fetch(`${dashboard.url}/api/dashboard/runs`)).json();
    assert.equal(listing.runs[0].status, "running");
    assert.equal(listing.runs[0].progress.concurrency, 3);
    assert.equal(listing.runs[0].live, true);
    assert(!JSON.stringify(listing).includes("local-token"));
    const control = await fetch(`${dashboard.url}/api/dashboard/runs/run-one/concurrency`, {
      method: "POST", headers: { origin: dashboard.url, "content-type": "application/json" },
      body: JSON.stringify({ value: 5 }),
    });
    assert.equal(control.status, 200);
    assert.deepEqual(calls, [{ path: "/api/control/concurrency", token: "local-token" }]);
  } finally {
    await dashboard.close();
    await host.close();
    if (previousUrl === undefined) delete process.env.EVAL_BASE_URL; else process.env.EVAL_BASE_URL = previousUrl;
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("run-scoped settings are validated with the same model and execution configuration as CLI", async () => {
  const fixture = await setup();
  try {
    const host = await loadConfig([fixture.configFile], { EVAL_BASE_URL: gateway }, {
      bindings: { comparison: { model: "one-run-only", thinking: "high" } },
      execution: { concurrency: 3, retries: 0 },
      rewrite: { attribution: true },
    });
    assert.equal(host.models.bindings.comparison.model, "one-run-only");
    assert.equal(host.models.bindings.attribution.model, undefined);
    assert.equal(host.evaluation.execution.concurrency, 3);
    assert.equal(host.evaluation.rewrite.attribution, true);
    const original = await loadConfig(fixture.configFile, { EVAL_BASE_URL: gateway });
    assert.equal(original.evaluation.execution.concurrency, 2);
    await assert.rejects(loadConfig(fixture.configFile, { EVAL_BASE_URL: gateway }, { execution: { concurrency: 0 } }), /execution.concurrency/);
    await assert.rejects(loadConfig(fixture.configFile, { EVAL_BASE_URL: gateway }, { bindings: { unknown: { model: "x" } } }), /未知阶段/);
    const settings = editableDashboardSettings({
      models: { judge: { model: "fixture-model", thinking: "low" } },
      bindings: { comparison: { profile: "judge" }, mystery: { profile: "judge" } },
    });
    assert.deepEqual(Object.keys(settings.bindings), ["comparison"]);
    assert.deepEqual(settings.bindings.comparison, { model: "fixture-model", thinking: "low" });
    const selected = await loadConfig([fixture.configFile], { EVAL_BASE_URL: gateway }, {
      versions: ["a_fast", "aa_fast"],
    });
    assert.deepEqual(selected.evaluation.inputs.versions.map((version) => version.id), ["a_fast", "aa_fast"]);
    assert.deepEqual(selected.evaluation.comparisons, [["a_fast", "aa_fast"]]);
    await assert.rejects(
      loadConfig([fixture.configFile], { EVAL_BASE_URL: gateway }, { versions: ["a_fast"] }),
      /至少选择两个模型/,
    );
    await assert.rejects(
      loadConfig([fixture.configFile], { EVAL_BASE_URL: gateway }, { versions: ["a_fast", "ghost"] }),
      /未登记的模型/,
    );
    await assert.rejects(
      loadConfig([fixture.configFile], { EVAL_BASE_URL: gateway }, { versions: ["a_fast", "a_expert"] }),
      /没有可比较的组合/,
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
