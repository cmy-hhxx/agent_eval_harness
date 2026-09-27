import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { attributionProfile } from "@eval/agents/attribution";
import { comparisonProfile } from "@eval/agents/comparison";
import { startDashboard } from "../../../apps/host/src/dashboard.js";
import { loadConfig, editableDashboardSettings } from "@eval/host-app/config";
import { emptyUsage, type RunState, type SubmissionReceipt } from "@eval/contracts";
import { exists, readJson, writeJson, writeJsonl } from "@eval/data";
import { json, listen } from "@eval/runtime/http";
import {
  attributionRow, buildPlan, caseResultView, listInputInventory, listRunCases, readCaseDetail,
  readRegisteredInput, readRunTasks, readTaskResult, writeRunState,
} from "@eval/workflows/comparison";
import { attributionResult, emptyAudit, fakeEvaluatorVersion, fakeIdentity, fixtureConfig, raw } from "../../fixtures/comparison.js";
import { ROOT } from "../../fixtures/services.js";

const gateway = "https://private-gateway.example/v1";

async function setup(rewrite = false, clustering = false) {
  const { directory, config } = await fixtureConfig([
    [raw("q1"), raw("q2")], [], [raw("q1"), raw("q2")], [],
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
      attribution: { profile: "judge" },
      comparison: { profile: "judge" },
      rewrite: { profile: "judge" },
      clustering: { profile: "judge" },
    },
  });
  const plan = await buildPlan(config);
  const run = path.join(config.output.path, "run-one");
  await mkdir(path.join(run, "results"), { recursive: true });
  const task = plan.tasks.find((item) => item.stage === "attribution")!;
  const receipt: SubmissionReceipt = {
    taskId: task.id, attemptId: "attempt-1", submissionId: "submission-1",
    evaluation: attributionResult(), audit: emptyAudit(), usage: emptyUsage(),
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
            input_id: "in-1",
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
          input_id: "in-1",
          run_id: "run-one",
          task_id: "t1",
          submission_id: "s1",
          finding_id: "f1",
          message_index: 1,
          quote: "2+2=5",
          source: { file: "f.jsonl", line: 1 },
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
          input_id: "in-2",
          run_id: "run-one",
          task_id: "t2",
          submission_id: "s2",
          finding_id: "f1",
          message_index: 1,
          quote: "3+3=7",
          source: { file: "f.jsonl", line: 2 },
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

test("dashboard workflow view pages cases, resolves moved inputs, and reads authoritative results", async () => {
  const fixture = await setup();
  try {
    const page = await listRunCases(fixture.run, { page: 1, pageSize: 1, status: "succeeded" });
    assert.equal(page.total, 1);
    assert.equal(page.cases[0].case_id, "q1");
    assert.equal((await listRunCases(fixture.run, { page: 2, pageSize: 1 })).cases[0].case_id, "q2");
    const detail = (await readCaseDetail(fixture.run, "b1", "q1"))!;
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

test("dashboard case results preserve Schema fields without duplicated comparison evaluations", () => {
  const comparison = caseResultView("comparison", {
    evaluation_type: "group_model_comparison",
    evaluator_version: "r1",
    evaluations: { a_fast: { findings: ["x"] } },
    models: { a_fast: { version: "A组Fast", llm: "x", trace_id: null } },
    ground_truth: { available: false, value: null },
    ranking: [["a_fast"]],
    task_analysis: { goal: "g" },
    decision_basis: { tradeoff: "t", decisive_findings: [] },
    assessments: { a_fast: { meets_core: true, summary: "s" } },
    verdicts: { a_fast__vs__aa_fast: { result: "win" } },
  })!;
  assert.equal(Object.hasOwn(comparison, "evaluations"), false);
  assert.equal(Object.hasOwn(comparison, "evaluator_version"), false);
  assert.deepEqual(Object.keys(comparison).sort(), [
    "assessments", "decision_basis", "ground_truth", "models", "ranking", "task_analysis", "verdicts",
  ]);
  assert.deepEqual(caseResultView("rewrite", { rewrites: [{ id: "summary", text: "t" }] }), {
    rewrites: [{ id: "summary", text: "t" }],
  });
  const source = attributionResult();
  source.findings[0]!.evidence[0]!.quote = "q".repeat(5000);
  const attribution = caseResultView("attribution", { evaluation: source })!;
  const expected = structuredClone(source);
  expected.findings[0]!.evidence[0]!.quote = `${"q".repeat(4000)}…`;
  assert.deepEqual(attribution, { evaluation: expected }, "every current Schema field reaches the view, including assessment, problem, dimension and importance");
  assert.equal(caseResultView("attribution", undefined), null);
});

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

test("dashboard keeps clustering tasks run-level and never mixes them into cases", async () => {
  const fixture = await setup(true, true);
  const server = await startDashboard({ configPaths: [fixture.configFile], port: 0 });
  try {
    const page = await (await fetch(`${server.url}/api/dashboard/runs/run-one/cases`)).json();
    assert.equal(page.total, 2, "clustering tasks must not break the case projection");
    const q1 = page.cases.find((item: { case_id: string }) => item.case_id === "q1");
    assert(!("clustering" in q1.stages), "clustering is not a per-case stage");
    const detail = await (
      await fetch(`${server.url}/api/dashboard/runs/run-one/cases/detail?batch=b1&case=q1`)
    ).json();
    assert.equal(detail.tasks.filter((task: { stage: string }) => task.stage === "clustering").length, 0);
    const listing = await (await fetch(`${server.url}/api/dashboard/runs`)).json();
    assert.equal(listing.runs[0].stages.clustering.pending, 2, "one clustering task per model");
    assert.equal(listing.runs[0].evaluator_version, fakeEvaluatorVersion);
    assert.equal(listing.runs[0].problem_library.a_fast.classes, 1, "library growth rides the run overview");
    const library = await (await fetch(`${server.url}/api/dashboard/runs/run-one/library`)).json();
    assert.equal(library.length, 1);
    assert.equal(library[0].model, "a_fast");
    assert.equal(library[0].totals.classes, 1);
    assert.equal(library[0].totals.occurrences, 2);
    assert.equal(library[0].components[0].classes[0].label, "算术错误");
    assert.equal(library[0].components[0].classes[0].first_seen.evaluator_version, fakeEvaluatorVersion);
    assert.deepEqual(library[0].merged, [
      { id: "k2", label: "计算笔误", into: "k1", into_label: "算术错误", reason: "同一现象。" },
    ]);
    const classDetail = await (
      await fetch(`${server.url}/api/dashboard/runs/run-one/library/a_fast/classes/k1`)
    ).json();
    assert.equal(classDetail.total, 2);
    assert.equal(classDetail.occurrences[0].case_id, "q1", "newest occurrence first");
    assert.equal(classDetail.occurrences[0].evaluator_version, fakeEvaluatorVersion);
    assert.equal(classDetail.occurrences[0].quote, "2+2=5");
    assert.equal(classDetail.occurrences[1].previous_class_id, "k2");
    assert.equal(classDetail.class.aliases[0], "计算错误");
    // A model file may exist in the shared library without belonging to this run.
    await writeJson(path.join(fixture.config.problemLibrary.path, "unrelated.json"), {
      ...(await readJson(path.join(fixture.config.problemLibrary.path, "a_fast.json"))), model: "unrelated",
    });
    assert.equal((await fetch(`${server.url}/api/dashboard/runs/run-one/library/unrelated/classes/k1`)).status, 404);
    assert.equal((await fetch(`${server.url}/api/dashboard/runs/run-one/library/nope/classes/k1`)).status, 404);
    assert.equal((await fetch(`${server.url}/api/dashboard/runs/run-one/library/a_fast/classes/k1/extra`)).status, 404);
    assert.equal((await fetch(`${server.url}/api/dashboard/runs/run-one/library/a_fast/classes/nope`)).status, 404);
    const settings = await (await fetch(`${server.url}/api/dashboard/config`)).json();
    assert.equal(settings.settings.clustering.enabled, true);
    assert(settings.settings.bindings.clustering, "clustering binding stays editable");
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
  const server = await startDashboard({ configPaths: [fixture.configFile], port: 0 });
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
    assert.equal(JSON.parse(text).settings.bindings.attribution.model, "fixture-model");
    const referencePage = await get("/reference");
    assert.equal(referencePage.status, 200);
    assert.match(await referencePage.text(), /数据与流程/);
    assert.equal((await get("/reference.js")).status, 200);
    const reference = await (await get("/api/dashboard/reference")).json();
    assert.equal(reference.evaluator_version, fakeEvaluatorVersion);
    assert.deepEqual(reference.inputs.versions, fixture.config.inputs.versions);
    assert.deepEqual(reference.comparisons, fixture.config.comparisons);
    assert.deepEqual(reference.stages.map((stage: { id: string }) => stage.id), ["attribution", "comparison", "rewrite", "clustering"]);
    assert.deepEqual(reference.stages[0].schemas.result, attributionProfile.resultSchema);
    assert.deepEqual(reference.stages[0].schemas.submission, attributionProfile.submissionSchema);
    assert.equal(reference.stages[0].prompts.system, attributionProfile.systemPrompt);
    assert.equal(reference.stages[1].prompts.instructions, comparisonProfile.instructions);
    assert.deepEqual(reference.stages[0].toolDescriptions, attributionProfile.toolDescriptions);
    assert.equal(Object.hasOwn(reference.stages[1].schemas, "submission"), false, "comparison has one shared submission/result definition");
    assert.deepEqual(Object.keys(reference.exports), ["comparison", "commentary", "clustering"]);
    assert(!JSON.stringify(reference).includes("private-key-do-not-expose"));
    assert(!JSON.stringify(reference).includes(gateway));
    const inventory = await (await get("/api/dashboard/inputs")).json();
    assert.equal(inventory.dates.length, 1);
    assert.deepEqual(inventory.dates[0].cases.map((item: { id: string }) => item.id), ["q1", "q2"]);
    await writeJsonl(fixture.config.inputs.versions[0]!.sources[0]!.path, [raw("q1"), raw("q2"), { ...raw("q3"), batch_id: "b2" }]);
    const refreshed = await (await get("/api/dashboard/inputs")).json();
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
