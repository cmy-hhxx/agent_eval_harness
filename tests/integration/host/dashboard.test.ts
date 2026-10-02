import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { attributionProfile } from "@eval/agents/attribution";
import { criteriaProfile } from "@eval/agents/criteria";
import { comparisonProfile } from "@eval/agents/comparison";
import { startDashboard } from "../../../apps/host/src/dashboard.js";
import { toDashboardModels } from "../../../apps/host/src/dashboard-models.js";
import { loadConfig, editableDashboardSettings } from "@eval/host-app/config";
import { emptyUsage, type ProblemLibrary, type RunState, type SubmissionReceipt } from "@eval/contracts";
import { exists, fileSourceReader, readJson, runLock, writeJson, writeJsonl } from "@eval/data";
import { json, listen } from "@eval/runtime/http";
import {
  attributionRow, buildPlan, caseResultView, listInputInventory, listRunCases, readCaseDetail,
  readRegisteredInput, readRunTasks, readTaskResult, writeRunState,
  type Candidate, type TaskData,
} from "@eval/workflows/comparison";
import { attributionResult, emptyAudit, fakeEvaluatorVersion, fakeIdentity, fixtureConfig, raw } from "../../fixtures/comparison.js";
import { ROOT } from "../../fixtures/services.js";

const gateway = "https://private-gateway.example/v1";

async function setup(rewrite = false, clustering = false) {
  const { directory, config } = await fixtureConfig([
    [raw("q1", "4", clustering ? "2+2=5" : "2+2=4"), raw("q2")], [], [raw("q1"), raw("q2")], [],
  ], rewrite, clustering);
  const configFile = path.join(directory, "dashboard-config.json");
  await writeJson(configFile, {
    evaluatorVersion: fakeEvaluatorVersion,
    inputs: config.inputs,
    comparisons: config.comparisons,
    rewrite: config.rewrite,
    execution: config.execution,
    output: config.output,
    problemLibrary: config.problemLibrary,
    clustering: config.clustering,
    models: {
      judge: {
        provider: "test-gateway", baseUrlEnv: "EVAL_BASE_URL", apiKeyEnv: "EVAL_API_KEY",
        api: "openai-completions", model: "fixture-model", thinking: "off",
        contextWindow: 8192, maxOutputTokens: 2048,
      },
    },
    bindings: {
      criteria: { profile: "judge" },
      attribution: { profile: "judge" },
      comparison: { profile: "judge" },
      rewrite: { profile: "judge" },
      clustering: { profile: "judge" },
    },
  });
  const plan = await buildPlan(config);
  const run = path.join(config.output.path, "run-one");
  await mkdir(path.join(run, "results"), { recursive: true });
  const task = plan.tasks.find((item) => item.stage === "attribution" &&
    (item.data as TaskData).candidates.A.version === "a_fast" &&
    (item.data as TaskData).candidates.A.case_id === "q1")!;
  const receipt: SubmissionReceipt = {
    taskId: task.id, attemptId: "attempt-1", submissionId: "submission-1",
    evaluation: clustering ? attributionResult(false, "2+2=5") : attributionResult(), audit: emptyAudit(), usage: emptyUsage(),
    evaluatorVersion: fakeEvaluatorVersion,
    judge: "fixture-model",
    acceptedAt: Date.now(), status: "succeeded",
  };
  const row = attributionRow(task, receipt);
  receipt.exported = { id: task.id, file: "attribution.jsonl", row };
  const state: RunState = {
    manifest: {
      format: "evaluation-run", runId: "run-one", status: "interrupted", engine: fakeIdentity,
      evaluatorVersion: fakeEvaluatorVersion,
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
  if (clustering) {
    const firstInput = (plan.catalog as Candidate[]).find((candidate) => candidate.input_id === task.inputIds.answer)!;
    const secondInput = (plan.catalog as Candidate[]).find((candidate) => candidate.version === "a_fast" && candidate.case_id === "q2")!;
    const clusteringTask = plan.tasks.find((item) => item.stage === "clustering" && (item.data as TaskData).scope?.version === "a_fast")!;
    await writeJson(path.join(run, "stats.json"), {
      problem_library: {
        a_fast: {
          components: 1,
          classes: 1,
          occurrences: 2,
          assigned: 2,
          proposed_new_classes: 1,
          merged_classes: 1,
        },
      },
    });
    await writeJson(path.join(config.problemLibrary.path, "a_fast.json"), {
      model: "a_fast",
      updated_at: "2026-01-02T00:00:00.000Z",
      components: {
        c1: {
          id: "c1",
          label: "模型自身推理",
          definition: "",
          aliases: [],
          first_seen: null,
        },
      },
      classes: {
        k1: {
          id: "k1",
          component_id: "c1",
          label: "算术错误",
          definition: "数值计算与事实不符。",
          aliases: ["计算错误"],
          status: "active",
          merged_into: null,
          first_seen: {
            run_id: "run-one",
            evaluator_version: fakeEvaluatorVersion,
            batch_id: "b1",
            case_id: "q1",
            input_id: firstInput.input_id,
            at: "2026-01-01T00:00:00.000Z",
          },
        },
        k2: {
          id: "k2",
          component_id: "c1",
          label: "计算笔误",
          definition: "笔误。",
          aliases: [],
          status: "merged",
          merged_into: "k1",
          first_seen: null,
        },
      },
      occurrences: [
        {
          id: "o1",
          class_id: "k1",
          version: "a_fast",
          evaluator_version: fakeEvaluatorVersion,
          batch_id: "b1",
          case_id: "q1",
          input_id: firstInput.input_id,
          run_id: "run-one",
          task_id: clusteringTask.id,
          submission_id: "s1",
          finding_id: "f0",
          evidence_status: "established",
          message_index: 1,
          quote: "2+2=5",
          source: { file: firstInput.source, line: firstInput.line },
          classification: "created",
          previous_class_id: null,
          at: "2026-01-02T00:00:00.000Z",
        },
        {
          id: "o2",
          class_id: "k1",
          version: "a_fast",
          evaluator_version: fakeEvaluatorVersion,
          batch_id: "b1",
          case_id: "q2",
          input_id: secondInput.input_id,
          run_id: "run-one",
          task_id: clusteringTask.id,
          submission_id: "s2",
          finding_id: "f0",
          evidence_status: "uncertain",
          message_index: 1,
          quote: "3+3=7",
          source: { file: secondInput.source, line: secondInput.line },
          classification: "assigned",
          previous_class_id: "k2",
          at: "2026-01-01T00:00:00.000Z",
        },
      ],
      events: [
        {
          id: "e1",
          type: "class_merged",
          at: "2026-01-02T00:00:00.000Z",
          detail: { from: "k2", into: "k1", reason: "同一现象。" },
        },
      ],
    });
  }
  await writeRunState(run, state);
  return { directory, config, configFile, task, run, row };
}

test("dashboard exposes every gateway model's public identity", () => {
  const catalog = [
    { id: "gpt-5.6-luna", name: "GPT 5.6 Luna" },
    { id: "claude-4", name: "Claude 4" },
    { id: "GEMINI-3", name: "Gemini 3" },
    { id: "gpt4o", name: "GPT-4o" },
  ];
  assert.deepEqual(toDashboardModels(catalog), catalog);
  assert.deepEqual(toDashboardModels([{ id: "claude-4", name: "Claude 4", contextWindow: 64000, maxTokens: 4096 }]),
    [{ id: "claude-4", name: "Claude 4" }]);
});

test("dashboard fallback separates execution failures, dependency blocks and cancellations", async () => {
  const fixture = await setup();
  const file = path.join(fixture.run, "state.json");
  const checkpoint = await readJson<{ tasks: Record<string, { status: string; attempts: number }> }>(file);
  const tasks = Object.values(checkpoint.tasks).filter(task => task.status !== "succeeded");
  for (const [index, status] of ["failed", "timed_out", "blocked", "cancelled"].entries())
    Object.assign(tasks[index], { status, attempts: status === "blocked" ? 0 : 1 });
  await writeJson(file, checkpoint);
  const server = await startDashboard({ configPaths: [fixture.configFile], port: 0 });
  try {
    const listing = await (await fetch(`${server.url}/api/dashboard/runs`)).json();
    const run = listing.runs[0];
    assert.equal(run.live, false);
    assert.deepEqual(run.progress.failures, { interruption: 2 });
    assert.equal(run.progress.blocked, 1);
    assert.equal(run.progress.cancelled, 1);
    assert.equal(run.progress.accepted, 1);
    assert.equal(run.progress.queued, tasks.length - 4);
    assert.deepEqual(await readJson(file), checkpoint);
  } finally {
    await server.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("dashboard discovers all models from the .env gateway without leaking credentials", async () => {
  const fixture = await setup();
  const previousUrl = process.env.EVAL_BASE_URL, previousKey = process.env.EVAL_API_KEY;
  const gatewayServer = await listen(async (req, res, url) => {
    assert.equal(url.pathname, "/v1/models");
    assert.equal(req.headers.authorization, "Bearer private-gateway-key");
    return json(res, { data: [{ id: "claude-4", name: "Claude 4" }, { id: "gemini-3" }] });
  });
  process.env.EVAL_BASE_URL = gatewayServer.url + "/v1";
  process.env.EVAL_API_KEY = "private-gateway-key";
  const dashboard = await startDashboard({ configPaths: [fixture.configFile], port: 0 });
  const launch = (model: string) => fetch(dashboard.url + "/api/dashboard/runs", {
    method: "POST", headers: { "content-type": "application/json", origin: dashboard.url },
    body: JSON.stringify({ runId: "new", batch: ["absent"], settings: { bindings: Object.fromEntries(
      ["criteria", "attribution", "comparison", "rewrite", "clustering"].map((stage) => [stage, { model }]),
    ) } }),
  });
  try {
    const config = await (await fetch(dashboard.url + "/api/dashboard/config")).text();
    assert(!config.includes("private-gateway-key"));
    assert(!config.includes(gatewayServer.url));
    assert.deepEqual(JSON.parse(config).model_catalog, [
      { id: "claude-4", name: "Claude 4" }, { id: "gemini-3", name: "gemini-3" },
    ]);
    assert.deepEqual(JSON.parse(config).environment, { base_url_configured: true, api_key_configured: true });
    const unavailable = await launch("unlisted");
    assert.equal(unavailable.status, 400);
    assert.match((await unavailable.json()).error, /不在 \.env 网关模型列表/);
    const available = await launch("claude-4");
    assert.equal(available.status, 400);
    assert.match((await available.json()).error, /没有可评对比组/);
  } finally {
    await dashboard.close();
    await gatewayServer.close();
    if (previousUrl === undefined) delete process.env.EVAL_BASE_URL; else process.env.EVAL_BASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.EVAL_API_KEY; else process.env.EVAL_API_KEY = previousKey;
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("dashboard workflow view pages cases, resolves moved inputs, and reads authoritative results", async () => {
  const fixture = await setup();
  try {
    const page = await listRunCases(fixture.run, { page: 1, pageSize: 1, status: "succeeded" });
    assert.equal(page.total, 1);
    assert.equal(page.cases[0].case_id, "q1");
    assert.equal((await listRunCases(fixture.run, { page: 2, pageSize: 1 })).cases[0].case_id, "q2");
    const detail = (await readCaseDetail(fixture.run, "b1", "q1"))!;
    assert.deepEqual(detail.ground_truth, { available: true, value: "4" });
    assert.equal("result" in detail.tasks.find((item) => item.id === fixture.task.id)!, false);
    const attribution = (await readTaskResult(fixture.run, fixture.task.id))!.result;
    assert.deepEqual(Object.keys(attribution!), ["evaluation"]);
    assert.match(JSON.stringify(attribution), /正确给出结果/);
    const inputId = fixture.task.inputIds.answer;
    const source = fixture.config.inputs.versions.find((version) => version.id === fixture.row.version)!.sources[0].path;
    const registered = (await readRegisteredInput(fixture.run, inputId))!;
    assert.equal(registered.line, 1);
    assert.equal(registered.recorded_line, 1);
    assert.equal(registered.question, "计算2+2");
    assert.equal(registered.answer, "2+2=4");
    await writeJsonl(source, [raw("new-case"), raw("q1"), raw("q2")]);
    const shifted = (await readRegisteredInput(fixture.run, inputId))!;
    assert.equal(shifted.line, 2);
    assert.equal(shifted.recorded_line, 1);
    assert.equal(shifted.question, "计算2+2");
    assert.equal(shifted.answer, "2+2=4");
    assert.equal(Object.hasOwn(shifted, "raw"), false);
    assert.equal(await readRegisteredInput(fixture.run, "not-registered"), undefined);
    await rm(path.join(fixture.run, "results", "attribution.jsonl"));
    assert.equal((await readCaseDetail(fixture.run, "b1", "q1"))?.case_id, "q1");
    await assert.rejects(readTaskResult(fixture.run, fixture.task.id), /结果文件缺失/);
    const comparisonTask = detail.tasks.find((item) => item.stage === "comparison")!;
    const targeted = await readRunTasks(fixture.run, [comparisonTask.id]);
    assert.deepEqual(Object.keys(targeted.receipts), [], "unrelated result rows stay on disk");
    assert.equal((await readRegisteredInput(fixture.run, inputId))?.case_id, "q1");
    await rm(source);
    await assert.rejects(readRegisteredInput(fixture.run, inputId), /ENOENT/);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("dashboard case results include comparison evaluations and preserve attribution Schema fields", () => {
  const comparison = caseResultView("comparison", {
    evaluation_type: "group_model_comparison",
    evaluator_version: "r1",
    evaluations: { a_fast: attributionResult() },
    models: { a_fast: { version: "A组Fast", llm: "x", trace_id: null } },
    ground_truth: { available: false, value: null },
    ranking: [["a_fast"]],
    task_analysis: { goal: "g" },
    decision_basis: { tradeoff: "t", decisive_findings: [], comparisons: [{ aspect: "结果", importance: "high", better_candidates: [], assessments: {
      a_fast: { summary: "给出结果。", finding_indices: [0] },
    } }] },
    assessments: { a_fast: { meets_core: true, summary: "s" } },
    verdicts: { a_fast__vs__b_fast: { result: "win" } },
  })!;
  assert.deepEqual(comparison.evaluations, { a_fast: attributionResult() });
  assert.equal(Object.hasOwn(comparison, "evaluator_version"), false);
  assert.deepEqual(Object.keys(comparison).sort(), [
    "assessments", "decision_basis", "evaluations", "ground_truth", "models", "ranking", "task_analysis", "verdicts",
  ]);
  const source = attributionResult();
  source.findings[0]!.evidence[0]!.quote = "q".repeat(5000);
  const attribution = caseResultView("attribution", { evaluation: source })!;
  const expected = structuredClone(source);
  expected.findings[0]!.evidence[0]!.quote = `${"q".repeat(4000)}…`;
  assert.deepEqual(attribution, { evaluation: expected }, "every current Schema field reaches the view, including assessment, problem, dimension and importance");
  assert.equal(caseResultView("attribution", undefined), null);
});

test("dashboard dates respond while source scanning is blocked", async () => {
  const fixture = await setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const original = fileSourceReader.lines;
  fileSourceReader.lines = async function* (...args) { await gate; yield* original(...args); };
  const server = await startDashboard({ configPaths: [fixture.configFile], port: 0 });
  try {
    const response = await fetch(server.url + "/api/dashboard/inputs", { signal: AbortSignal.timeout(1000) });
    const pending = await response.json();
    assert.equal(pending.status, "loading");
    assert.equal(pending.dates[0].date, path.basename(fixture.directory));
    assert.equal(pending.dates[0].cases, null, "unscanned files must not claim zero valid samples");
    release();
    const inventory = await readyInventory(server.url);
    assert.deepEqual(inventory.dates[0].cases.map((item: { id: string }) => item.id), ["q1", "q2"]);
  } finally {
    release();
    fileSourceReader.lines = original;
    await server.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("dashboard start reuses preview planning and invalidates changed sources", async () => {
  const fixture = await setup();
  const previousUrl = process.env.EVAL_BASE_URL, previousKey = process.env.EVAL_API_KEY;
  process.env.EVAL_BASE_URL = gateway;
  process.env.EVAL_API_KEY = "fixture";
  const original = fileSourceReader.lines;
  let scans = 0;
  fileSourceReader.lines = async function* (...args) { scans++; yield* original(...args); };
  const server = await startDashboard({ configPaths: [fixture.configFile], port: 0,
    modelCatalog: async () => [{ id: "gpt-fixture", name: "GPT fixture" }] });
  const payload = { runId: "empty-preview", batch: ["absent"], settings: {
    bindings: Object.fromEntries(["criteria", "attribution", "comparison", "rewrite", "clustering"].map((stage) => [stage, { model: "gpt-fixture" }])),
  } };
  const post = (route: string) => fetch(server.url + route, { method: "POST",
    headers: { "content-type": "application/json", origin: server.url }, body: JSON.stringify(payload) });
  try {
    assert.equal((await post("/api/dashboard/preview")).status, 200);
    const previewScans = scans;
    assert(previewScans > 0);
    const rejected = await post("/api/dashboard/runs");
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /没有可评/);
    assert.equal(scans, previewScans, "start must not parse all sources a second time");
    payload.batch = ["another-absent-batch"];
    assert.equal((await post("/api/dashboard/preview")).status, 200);
    assert.equal(scans, previewScans, "selection changes rebuild the plan without rereading source bodies");
    const selectionScans = scans;
    await writeJsonl(fixture.config.inputs.versions[0]!.sources[0]!.path, [raw("changed")]);
    assert.equal((await post("/api/dashboard/preview")).status, 200);
    assert.equal(scans, selectionScans + 1, "only the changed source needs reparsing");
  } finally {
    fileSourceReader.lines = original;
    if (previousUrl === undefined) delete process.env.EVAL_BASE_URL; else process.env.EVAL_BASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.EVAL_API_KEY; else process.env.EVAL_API_KEY = previousKey;
    await server.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("dashboard preflight reuses date inventory across sample counts", async () => {
  const fixture = await setup();
  const previousUrl = process.env.EVAL_BASE_URL;
  process.env.EVAL_BASE_URL = gateway;
  const original = fileSourceReader.lines;
  let scans = 0;
  fileSourceReader.lines = async function* (...args) { scans++; yield* original(...args); };
  const server = await startDashboard({ configPaths: [fixture.configFile], port: 0 });
  try {
    await readyInventory(server.url);
    const inventoryScans = scans;
    const preview = async (limitCases: number) => {
      const response = await fetch(server.url + "/api/dashboard/preview", {
        method: "POST", headers: { "content-type": "application/json", origin: server.url },
        body: JSON.stringify({ runId: "new-preview", limitCases }),
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    const one = await preview(1);
    assert.equal(one.summary.cases, 1);
    assert.equal(scans, inventoryScans, "preflight must reuse the source scan already needed for dates");
    const two = await preview(2);
    assert.equal(two.summary.cases, 2);
    assert.equal(scans, inventoryScans, "changing sample count must not rescan unchanged files");
  } finally {
    fileSourceReader.lines = original;
    if (previousUrl === undefined) delete process.env.EVAL_BASE_URL; else process.env.EVAL_BASE_URL = previousUrl;
    await server.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

async function readyInventory(url: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(url + "/api/dashboard/inputs");
    assert.equal(response.status, 200);
    const inventory = await response.json();
    if (inventory.status === "ready") return inventory;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Input inventory did not finish");
}

test("input inventory lists dates and cases from the configured sources", async () => {
  const { directory, config } = await fixtureConfig([
    [{ ...raw("q1"), batch_id: "b1" }, { ...raw("q2"), batch_id: "b2" }], [], [raw("q1")], [],
  ]);
  try {
    const inventory = await listInputInventory(config);
    assert.equal(inventory.dates.length, 1);
    const day = inventory.dates[0]!;
    assert.equal(day.date, path.basename(directory));
    assert.deepEqual(day.batches, ["b1", "b2"]);
    assert.deepEqual(day.versions, ["a_fast", "b_fast"]);
    assert.deepEqual(day.cases.map((item) => item.id), ["q1", "q2"]);
    assert.deepEqual(day.cases.find((item) => item.id === "q1")!.versions, ["a_fast", "b_fast"]);
    assert.deepEqual(day.cases.find((item) => item.id === "q1")!.batches, ["b1"]);
    assert.deepEqual(day.cases.find((item) => item.id === "q2")!.batches, ["b2"]);
    assert.equal(inventory.issues, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("dashboard input inventory scans large source files under a bounded heap", async () => {
  const { directory, config } = await fixtureConfig();
  try {
    const largeAnswer = "x".repeat(14 * 1024 * 1024);
    for (const version of config.inputs.versions)
      await writeJsonl(version.sources[0]!.path, [raw("q1", null, largeAnswer)]);
    const file = path.join(directory, "inventory-config.json");
    await writeJson(file, config);
    const script = `import { readFile } from "node:fs/promises";
      import { listInputInventory } from "@eval/workflows/comparison";
      const config = JSON.parse(await readFile(process.argv[1], "utf8"));
      const inventory = await listInputInventory(config);
      console.log(JSON.stringify({ cases: inventory.dates[0]?.cases.length, versions: inventory.dates[0]?.versions.length, issues: inventory.issues }));`;
    const { stdout } = await promisify(execFile)(process.execPath,
      ["--max-old-space-size=80", "--input-type=module", "-e", script, file],
      { cwd: ROOT, timeout: 20000 });
    assert.deepEqual(JSON.parse(stdout), { cases: 1, versions: 4, issues: 0 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("dashboard reads one input record without retaining its source file", async () => {
  const fixture = await setup();
  try {
    const inputId = fixture.task.inputIds.answer;
    const source = fixture.config.inputs.versions.find((version) => version.id === fixture.row.version)!.sources[0]!;
    const answer = "x".repeat(14 * 1024 * 1024);
    await writeJsonl(source.path, [raw("q1", null, answer)]);
    const script = `import { readRegisteredInput } from "@eval/workflows/comparison";
      const input = await readRegisteredInput(process.argv[1], process.argv[2]);
      console.log(JSON.stringify({ question: input?.question, answer_length: input?.answer.length }));`;
    const { stdout } = await promisify(execFile)(process.execPath,
      ["--max-old-space-size=80", "--input-type=module", "-e", script, fixture.run, inputId],
      { cwd: ROOT, timeout: 20000 });
    assert.deepEqual(JSON.parse(stdout), { question: "计算2+2", answer_length: answer.length });
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("dashboard keeps rewrite progress but does not list separate rewrite outputs", async () => {
  const fixture = await setup(true);
  try {
    const page = await listRunCases(fixture.run, { page: 1, pageSize: 40 });
    assert.equal(page.total, 2);
    const q1 = page.cases.find((item) => item.case_id === "q1")!;
    assert.deepEqual(Object.keys(q1.stages).sort(), ["attribution", "comparison", "criteria", "rewrite"]);
    const detail = (await readCaseDetail(fixture.run, "b1", "q1"))!;
    const attributionIds = new Set(detail.tasks.filter((task) => task.stage === "attribution").map((task) => task.id));
    const comparison = detail.tasks.find((task) => task.stage === "comparison")!;
    assert.deepEqual(new Set(comparison.versions), new Set(["a_fast", "b_fast"]));
    const rewrites = detail.tasks.filter((task) => task.stage === "rewrite");
    assert.equal(rewrites.length, 0);
    assert(attributionIds.has(fixture.task.id));
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("dashboard keeps clustering tasks run-level and never mixes them into cases", async () => {
  const fixture = await setup(true, true);
  const server = await startDashboard({ configPaths: [fixture.configFile], port: 0 });
  try {
    const page = await (await fetch(`${server.url}/api/dashboard/runs/run-one/cases`)).json();
    assert.equal(page.total, 2, "clustering tasks must not break the case projection");
    const q1 = page.cases.find((item: { case_id: string }) => item.case_id === "q1");
    assert(!("clustering" in q1.stages), "clustering is not a per-case stage");
    const clusteringTasks = await (await fetch(`${server.url}/api/dashboard/runs/run-one/clustering`)).json();
    assert.equal(clusteringTasks.length, 2);
    assert(clusteringTasks.every((task: { stage: string; batch_id: string }) => task.stage === "clustering" && task.batch_id === "b1"));
    const detail = await (
      await fetch(`${server.url}/api/dashboard/runs/run-one/cases/detail?batch=b1&case=q1`)
    ).json();
    assert.equal(detail.tasks.filter((task: { stage: string }) => task.stage === "clustering").length, 0);
    const listing = await (await fetch(`${server.url}/api/dashboard/runs`)).json();
    assert.equal(listing.runs[0].stages.clustering.pending, 2, "one clustering task per model");
    assert.equal(listing.runs[0].evaluator_version, fakeEvaluatorVersion);
    assert.equal(listing.runs[0].problem_library.a_fast.classes, 1, "library growth rides the run overview");
    const settings = await (await fetch(`${server.url}/api/dashboard/config`)).json();
    assert.equal(settings.settings.clustering.enabled, true);
    assert(settings.settings.bindings.clustering, "clustering binding stays editable");
  } finally {
    await server.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("dashboard problem library lists every configured model and recalls intact samples across runs", async () => {
  const fixture = await setup(false, true);
  await writeJson(fixture.configFile, {
    ...(await readJson(fixture.configFile)), clustering: { ...fixture.config.clustering, enabled: false },
  });
  const otherRun = path.join(fixture.config.output.path, "run-two");
  await writeJson(path.join(otherRun, "state.json"), { ...(await readJson(path.join(fixture.run, "state.json"))), runId: "run-two" });
  await writeJsonl(path.join(otherRun, "results", "attribution.jsonl"), [fixture.row]);
  const libraryFile = path.join(fixture.config.problemLibrary.path, "a_fast.json");
  const stored = await readJson<ProblemLibrary>(libraryFile);
  stored.occurrences.push({ ...stored.occurrences[0], id: "o3", run_id: "run-two", at: "2025-12-31T00:00:00.000Z" });
  await writeJson(libraryFile, stored);
  const server = await startDashboard({ configPaths: [fixture.configFile], port: 0 });
  try {
    const library = await (await fetch(`${server.url}/api/dashboard/library`)).json();
    assert.deepEqual(library.map((item: { model: string }) => item.model), fixture.config.inputs.versions.map((version) => version.id));
    assert.deepEqual(library.map((item: { name: string }) => item.name), fixture.config.inputs.versions.map((version) => version.display_name || version.name));
    assert.equal(library[0].model, "a_fast");
    assert.equal(library[0].updated_at, "2026-01-02T00:00:00.000Z");
    assert.equal(library[0].totals.classes, 1);
    assert.equal(library[0].totals.occurrences, 3);
    assert.equal(library[0].components[0].classes[0].label, "算术错误");
    assert.equal(library[0].components[0].classes[0].first_seen.evaluator_version, fakeEvaluatorVersion);
    assert.deepEqual(library[0].merged, [
      { id: "k2", label: "计算笔误", into: "k1", into_label: "算术错误", reason: "同一现象。" },
    ]);
    for (const empty of library.slice(1)) {
      assert.equal(empty.updated_at, null);
      assert.deepEqual(empty.components, []);
      assert.deepEqual(empty.merged, []);
      assert.deepEqual(empty.totals, { components: 0, classes: 0, occurrences: 0 });
    }
    const classDetail = await (
      await fetch(`${server.url}/api/dashboard/library/a_fast/classes/k1`)
    ).json();
    assert.equal(classDetail.total, 3);
    assert.equal(classDetail.occurrences[0].case_id, "q1", "newest occurrence first");
    assert.equal(classDetail.occurrences[0].evaluator_version, fakeEvaluatorVersion);
    assert.equal(classDetail.occurrences[0].quote, "2+2=5");
    assert.equal(classDetail.occurrences[1].previous_class_id, "k2");
    assert.equal(classDetail.class.aliases[0], "计算错误");
    assert.deepEqual(classDetail.lineage, library[0].merged);
    assert.equal(classDetail.occurrences[0].run_id, "run-one");
    assert.equal(classDetail.occurrences[0].input_id, fixture.task.inputIds.answer);
    assert.equal(classDetail.occurrences[0].evidence_status, "established");
    const recall = classDetail.occurrences[0].recall;
    assert.equal(recall.available, true);
    assert.equal(recall.reason, null);
    assert.equal(recall.attribution_task_id, fixture.task.id);
    const recalled = new URL(recall.url, server.url);
    assert.deepEqual(Object.fromEntries(recalled.searchParams), {
      run: "run-one", batch: "b1", case: "q1", model: "a_fast", task: fixture.task.id, finding: "f0",
    });
    assert.deepEqual(classDetail.occurrences[1].recall,
      { available: false, reason: "result_missing", attribution_task_id: null, url: null });
    assert.equal(classDetail.occurrences[2].recall.available, true);
    assert.equal(new URL(classDetail.occurrences[2].recall.url, server.url).searchParams.get("run"), "run-two");
    assert(!("evaluation" in classDetail.occurrences[0]), "library projection retains coordinates, never formal result bodies");
    // Undeclared model files must not become browseable from the current configuration.
    await writeJson(path.join(fixture.config.problemLibrary.path, "unrelated.json"), {
      ...(await readJson(path.join(fixture.config.problemLibrary.path, "a_fast.json"))), model: "unrelated",
    });
    for (const target of ["unrelated/classes/k1", "nope/classes/k1", "a_fast/classes/k1/extra", "a_fast/classes/nope"])
      assert.equal((await fetch(`${server.url}/api/dashboard/library/${target}`)).status, 404);
    for (const target of ["a%2Ffast/classes/k1", "a_fast/classes/k%2F1"])
      assert.equal((await fetch(`${server.url}/api/dashboard/library/${target}`)).status, 400);
  } finally {
    await server.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("dashboard problem recall names missing references and never emits unusable sample links", async () => {
  const fixture = await setup(false, true);
  const server = await startDashboard({ configPaths: [fixture.configFile], port: 0 });
  const libraryFile = path.join(fixture.config.problemLibrary.path, "a_fast.json");
  const library = await readJson<ProblemLibrary>(libraryFile);
  const occurrence = library.occurrences[0];
  const check = async (reason: string) => {
    const response = await fetch(`${server.url}/api/dashboard/library/a_fast/classes/k1`);
    assert.equal(response.status, 200, "the knowledge remains browseable when a sample reference is unavailable");
    const detail = await response.json();
    assert.deepEqual(detail.occurrences[0].recall,
      { available: false, reason, attribution_task_id: null, url: null });
  };
  try {
    await writeJsonl(fixture.config.inputs.versions[0].sources[0].path, [raw("q2")]);
    await check("input_unavailable");
    await writeJsonl(fixture.config.inputs.versions[0].sources[0].path, [raw("q1", "4", "2+2=5"), raw("q2")]);
    await writeJsonl(path.join(fixture.run, "results", "attribution.jsonl"), []);
    await check("result_missing");
    await writeJsonl(path.join(fixture.run, "results", "attribution.jsonl"), [fixture.row]);
    library.occurrences[0] = { ...occurrence, finding_id: "missing-finding" };
    await writeJson(libraryFile, library);
    await check("finding_missing");
    library.occurrences[0] = { ...occurrence, input_id: "missing-input" };
    await writeJson(libraryFile, library);
    await check("sample_missing");
    library.occurrences[0] = { ...occurrence, run_id: "removed-run" };
    await writeJson(libraryFile, library);
    await check("run_missing");
    await writeJson(path.join(fixture.config.output.path, "unreadable-run", "state.json"), { format: "invalid" });
    library.occurrences[0] = { ...occurrence, run_id: "unreadable-run" };
    await writeJson(libraryFile, library);
    await check("run_unavailable");
  } finally {
    await server.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("dashboard problem samples paginate in stable order and validate page numbers", async () => {
  const fixture = await setup(false, true);
  const libraryFile = path.join(fixture.config.problemLibrary.path, "a_fast.json");
  const library = await readJson<ProblemLibrary>(libraryFile);
  for (let index = 0; index < 50; index++) library.occurrences.push({
    ...library.occurrences[0], id: `o-extra-${String(index).padStart(2, "0")}`,
    run_id: "removed-run", at: "2025-12-31T00:00:00.000Z",
  });
  await writeJson(libraryFile, library);
  const server = await startDashboard({ configPaths: [fixture.configFile], port: 0 });
  const route = `${server.url}/api/dashboard/library/a_fast/classes/k1`;
  try {
    const first = await (await fetch(`${route}?page=1`)).json();
    const second = await (await fetch(`${route}?page=2`)).json();
    assert.equal(first.total, 52);
    assert.equal(first.page_size, 50);
    assert.equal(first.occurrences.length, 50);
    assert.deepEqual(second.occurrences.map((item: { id: string }) => item.id), ["o-extra-01", "o-extra-00"]);
    assert(second.occurrences.every((item: { recall: { available: boolean; reason: string } }) =>
      !item.recall.available && item.recall.reason === "run_missing"));
    assert.equal((await (await fetch(`${route}?page=3`)).json()).occurrences.length, 0);
    for (const value of ["0", "-1", "1.5", "NaN", "9007199254740992"])
      assert.equal((await fetch(`${route}?page=${value}`)).status, 400);
  } finally {
    await server.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("dashboard HTTP keeps secrets out, previews without writing a run, and rejects unsafe changes", async () => {
  const fixture = await setup();
  const previousUrl = process.env.EVAL_BASE_URL;
  const previousKey = process.env.EVAL_API_KEY;
  process.env.EVAL_BASE_URL = gateway;
  process.env.EVAL_API_KEY = "private-key-do-not-expose";
  const server = await startDashboard({
    configPaths: [fixture.configFile],
    port: 0,
    modelCatalog: async () => [
      { id: "gpt-5.6-luna", name: "GPT 5.6 Luna" },
      { id: "claude-4", name: "Claude 4" },
    ],
  });
  const get = async (route: string) => fetch(server.url + route);
  const post = async (route: string, payload: unknown, origin = server.url) => fetch(server.url + route, {
    method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(payload),
  });
  try {
    const config = await get("/api/dashboard/config");
    assert.equal(config.headers.get("cache-control"), "no-store");
    assert.equal(config.headers.get("content-security-policy"), null, "local overlays must be able to inject inline styles");
    assert.equal(config.headers.get("x-frame-options"), null, "local annotation tools may embed the page");
    const text = await config.text();
    assert(!text.includes("private-key-do-not-expose"));
    assert(!text.includes(gateway));
    const dashboardConfig = JSON.parse(text);
    assert.deepEqual(dashboardConfig.model_catalog, [
      { id: "gpt-5.6-luna", name: "GPT 5.6 Luna" }, { id: "claude-4", name: "Claude 4" },
    ]);
    assert.equal(dashboardConfig.settings.bindings.attribution.model, "");
    const referencePage = await get("/reference");
    assert.equal(referencePage.status, 200);
    assert.match(await referencePage.text(), /数据与流程/);
    assert.equal((await get("/reference.js")).status, 200);
    const reference = await (await get("/api/dashboard/reference")).json();
    assert.equal(reference.evaluator_version, fakeEvaluatorVersion);
    assert.deepEqual(reference.inputs.versions, fixture.config.inputs.versions);
    assert.deepEqual(reference.comparisons, fixture.config.comparisons);
    assert.deepEqual(reference.stages.map((stage: { id: string }) => stage.id), ["criteria", "attribution", "comparison", "rewrite", "clustering"]);
    assert.deepEqual(reference.stages[0].schemas.result, criteriaProfile.resultSchema);
    assert.deepEqual(reference.stages[1].schemas.result, attributionProfile.resultSchema);
    assert.deepEqual(reference.stages[1].schemas.submission, attributionProfile.submissionSchema);
    assert.equal(reference.stages[1].prompts.system, attributionProfile.systemPrompt);
    assert.equal(reference.stages[2].prompts.instructions, comparisonProfile.instructions);
    assert.equal(reference.stages[2].prompts.submissionNudge, comparisonProfile.submissionNudge);
    assert.deepEqual(reference.stages[1].toolDescriptions, attributionProfile.toolDescriptions);
    assert.deepEqual(reference.stages[2].schemas.submission, comparisonProfile.submissionSchema);
    assert.deepEqual(Object.keys(reference.exports), ["comparison", "clustering"]);
    assert(!JSON.stringify(reference).includes("private-key-do-not-expose"));
    assert(!JSON.stringify(reference).includes(gateway));
    const inventory = await readyInventory(server.url);
    assert.equal(inventory.dates.length, 1);
    assert.deepEqual(inventory.dates[0].cases.map((item: { id: string }) => item.id), ["q1", "q2"]);
    await writeJsonl(fixture.config.inputs.versions[0]!.sources[0]!.path, [raw("q1"), raw("q2"), { ...raw("q3"), batch_id: "b2" }]);
    const refreshed = await readyInventory(server.url);
    assert.deepEqual(refreshed.dates[0].cases.map((item: { id: string }) => item.id), ["q1", "q2", "q3"]);
    const list = await (await get("/api/dashboard/runs/run-one/cases?status=succeeded")).json();
    assert.equal(list.total, 1);
    const detail = await (await get("/api/dashboard/runs/run-one/cases/detail?batch=b1&case=q1")).json();
    assert.equal(detail.tasks.find((item: { id: string }) => item.id === fixture.task.id).status, "succeeded");
    const taskResult = await (await get(`/api/dashboard/runs/run-one/tasks/${fixture.task.id}/result`)).json();
    assert.match(JSON.stringify(taskResult.result), /正确给出结果/);
    assert.equal((await get("/api/dashboard/runs/run-one/tasks/unknown/result")).status, 404);
    const input = await (await get(`/api/dashboard/runs/run-one/inputs/${fixture.task.inputIds.answer}`)).json();
    assert.equal(input.question, "计算2+2");
    assert.equal(input.answer, "2+2=4");
    assert.equal(Object.hasOwn(input, "raw"), false);
    assert.equal((await get("/api/dashboard/runs/run-one/inputs/unknown")).status, 404);
    assert.equal((await post("/api/dashboard/preview", { runId: "new-run" }, "http://untrusted.example")).status, 403);
    const preview = await post("/api/dashboard/preview", {
      runId: "new-run", batch: ["b1"], settings: { execution: { concurrency: 1 }, bindings: { comparison: { model: "claude-4" } } },
    });
    assert.equal(preview.status, 200);
    const unavailable = await post("/api/dashboard/runs", {
      runId: "new-run", batch: ["absent"], settings: { bindings: { comparison: { model: "unlisted" } } },
    });
    assert.equal(unavailable.status, 400);
    assert.match((await unavailable.json()).error, /不在 \.env 网关模型列表/);
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
    const missing = await get(`/api/dashboard/runs/run-one/tasks/${fixture.task.id}/result`);
    assert.equal(missing.status, 500);
    assert.match((await missing.json()).error, /结果文件缺失/);
    assert.equal((await get("/api/dashboard/runs/run-one/cases/detail?batch=b1&case=q1")).status, 200);
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
      queued: 2, running: 1, accepted: 1, repairing: 0, failures: {}, blocked: 0, cancelled: 0, concurrency: 3,
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

test("dashboard deletion requires same origin and an idle run, then removes only its output and journal rows", async () => {
  const fixture = await setup(false, true);
  const logs = { directory: path.join(fixture.directory, "log"), lockDirectory: path.join(fixture.directory, ".runtime/log-writer") };
  const dashboard = await startDashboard({ configPaths: [fixture.configFile], port: 0, logs });
  const remove = (runId: string, origin: string | undefined = dashboard.url) => fetch(`${dashboard.url}/api/dashboard/runs/${runId}`, {
    method: "DELETE", headers: origin ? { origin } : {},
  });
  try {
    const source = fixture.config.inputs.versions[0]!.sources[0]!.path;
    const inputBefore = await readFile(source, "utf8");
    const libraryFile = path.join(fixture.config.problemLibrary.path, "a_fast.json");
    const libraryBefore = await readFile(libraryFile, "utf8");
    const otherRun = path.join(fixture.config.output.path, "keep-me");
    await writeJson(path.join(otherRun, "state.json"), { format: "evaluation-run", runId: "keep-me" });
    await writeJson(path.join(fixture.run, "_internal/tasks/t/debug.json"), { debug: true });
    for (const name of ["runtime.log", "evaluation.log"])
      await writeJsonl(path.join(logs.directory, name), [{ run_id: "run-one", result: "remove" }, { run_id: "keep-me", result: "retain" }]);
    const before = await readFile(path.join(fixture.run, "state.json"), "utf8");
    assert.equal((await remove("run-one", "http://untrusted.example")).status, 403);
    const noOrigin = await fetch(`${dashboard.url}/api/dashboard/runs/run-one`, { method: "DELETE" });
    assert.equal(noOrigin.status, 403);
    const release = await runLock(fixture.run);
    try {
      const busy = await remove("run-one");
      assert.equal(busy.status, 409);
      assert.match((await busy.json()).error, /停止运行/);
      assert.equal(await readFile(path.join(fixture.run, "state.json"), "utf8"), before);
    } finally { await release(); }
    const deleted = await remove("run-one");
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { run_id: "run-one", deleted: true, logs: { runtime: 1, evaluation: 1 } });
    assert.equal(await exists(fixture.run), false);
    assert.equal((await remove("run-one")).status, 404);
    assert.equal(await exists(fixture.run), false);
    assert.equal(await readFile(source, "utf8"), inputBefore);
    assert.equal(await readFile(libraryFile, "utf8"), libraryBefore);
    const retainedLibrary = await (await fetch(`${dashboard.url}/api/dashboard/library`)).json();
    assert.equal(retainedLibrary[0].totals.classes, 1);
    const retainedClass = await (await fetch(`${dashboard.url}/api/dashboard/library/a_fast/classes/k1`)).json();
    assert(retainedClass.occurrences.every((item: { recall: { available: boolean; reason: string; url: string | null } }) =>
      !item.recall.available && item.recall.reason === "run_missing" && item.recall.url === null));
    assert.equal(await exists(otherRun), true);
    for (const name of ["runtime.log", "evaluation.log"])
      assert.equal(await readFile(path.join(logs.directory, name), "utf8"), '{"run_id":"keep-me","result":"retain"}\n');
  } finally {
    await dashboard.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("dashboard blocks deletion throughout launch preparation and releases the reservation when launch fails", async () => {
  const fixture = await setup();
  const previousUrl = process.env.EVAL_BASE_URL, previousKey = process.env.EVAL_API_KEY;
  process.env.EVAL_BASE_URL = gateway;
  process.env.EVAL_API_KEY = "fixture-key";
  let modelRequestStarted!: () => void, finishModels!: () => void;
  const requested = new Promise<void>((resolve) => { modelRequestStarted = resolve; });
  const modelsReady = new Promise<void>((resolve) => { finishModels = resolve; });
  const dashboard = await startDashboard({ configPaths: [fixture.configFile], port: 0,
    logs: { directory: path.join(fixture.directory, "log"), lockDirectory: path.join(fixture.directory, "log-lock") },
    modelCatalog: async () => { modelRequestStarted(); await modelsReady; return []; },
  });
  try {
    const invalid = await fetch(`${dashboard.url}/api/dashboard/runs`, {
      method: "POST", headers: { origin: dashboard.url, "content-type": "application/json" },
      body: JSON.stringify({ runId: "../outside" }),
    });
    assert.equal(invalid.status, 400, "invalid identifiers are rejected before reserving a run");
    const launching = fetch(`${dashboard.url}/api/dashboard/runs`, {
      method: "POST", headers: { origin: dashboard.url, "content-type": "application/json" },
      body: JSON.stringify({ runId: "run-one" }),
    });
    await Promise.race([requested, launching.then(() => { throw new Error("Launch returned before requesting models"); })]);
    const busy = await fetch(`${dashboard.url}/api/dashboard/runs/run-one`, { method: "DELETE", headers: { origin: dashboard.url } });
    assert.equal(busy.status, 409);
    assert.match((await busy.json()).error, /启动/);
    assert.equal(await exists(path.join(fixture.run, "state.json")), true);
    finishModels();
    assert.equal((await launching).status, 400, "an unavailable model fails before spawning a child");
    const deleted = await fetch(`${dashboard.url}/api/dashboard/runs/run-one`, { method: "DELETE", headers: { origin: dashboard.url } });
    assert.equal(deleted.status, 200);
  } finally {
    finishModels();
    await dashboard.close();
    if (previousUrl === undefined) delete process.env.EVAL_BASE_URL; else process.env.EVAL_BASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.EVAL_API_KEY; else process.env.EVAL_API_KEY = previousKey;
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
    const defaultConfigFile = path.join(fixture.directory, "default-config.json");
    await writeJson(defaultConfigFile, {
      ...await readJson<Record<string, unknown>>(fixture.configFile),
      execution: {},
    });
    const defaultConfig = await loadConfig(defaultConfigFile, { EVAL_BASE_URL: gateway });
    assert.equal(defaultConfig.evaluation.execution.concurrency, 8);
    const withClustering = await loadConfig([fixture.configFile], { EVAL_BASE_URL: gateway }, {
      clustering: { enabled: false },
    });
    assert.equal(withClustering.evaluation.clustering.enabled, false);
    await assert.rejects(
      loadConfig([fixture.configFile], { EVAL_BASE_URL: gateway }, { clustering: { enabled: "yes" } }),
      /聚类设置/,
    );
    await assert.rejects(loadConfig(fixture.configFile, { EVAL_BASE_URL: gateway }, { execution: { concurrency: 0 } }), /execution.concurrency/);
    await assert.rejects(loadConfig(fixture.configFile, { EVAL_BASE_URL: gateway }, { bindings: { unknown: { model: "x" } } }), /未知阶段/);
    const settings = editableDashboardSettings({
      models: { judge: { model: "fixture-model", thinking: "low" } },
      bindings: { comparison: { profile: "judge" }, mystery: { profile: "judge" } },
    });
    assert.deepEqual(Object.keys(settings.bindings), ["comparison"]);
    assert.deepEqual(settings.bindings.comparison, { model: "fixture-model", thinking: "low" });
    assert.deepEqual(settings.rewrite, { attribution: true, comparison: true, clustering: true });
    const defaults = editableDashboardSettings({ bindings: { comparison: { profile: "judge" } }, models: { judge: {} } });
    assert.equal(defaults.execution.concurrency, 8);
    assert.equal(defaults.bindings.comparison.thinking, "high");
    assert.equal(editableDashboardSettings({
      models: { judge: { thinking: "low" } },
      bindings: { comparison: { profile: "judge", thinking: "medium" } },
    }).bindings.comparison.thinking, "medium", "explicit stage reasoning is preserved");
    assert.equal(editableDashboardSettings({ rewrite: { comparison: false } }).rewrite.comparison, false);
    const fairSettings = editableDashboardSettings(await readJson(path.join(ROOT, "configs/host.json")));
    assert.deepEqual(fairSettings.comparisons, [["a_fast", "b_fast"], ["a_expert", "b_expert"]]);
    const selected = await loadConfig([fixture.configFile], { EVAL_BASE_URL: gateway }, {
      versions: ["a_fast", "b_fast"],
    });
    assert.deepEqual(selected.evaluation.inputs.versions.map((version) => version.id), ["a_fast", "b_fast"]);
    assert.deepEqual(selected.evaluation.comparisons, [["a_fast", "b_fast"]]);
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
