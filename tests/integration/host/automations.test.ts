import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { REMOTE_MODELS, emptyUsage, type AgentBackend, type RemoteDay, type RunState } from "@eval/contracts";
import { writeJson, writeJsonl } from "@eval/data";
import { runEvaluation } from "@eval/host";
import { RemoteInputs } from "@eval/runtime/client";
import type { AutomationJob } from "@eval/automations";
import { startWorker } from "@eval/runtime/worker";
import { body, json, listen } from "@eval/runtime/http";
import { buildPlan, comparisonCodec, readRunState, reconcileRun, type Checkpoint, type TaskData } from "@eval/workflows/comparison";
import { automationEvaluationConfig, loadAutomationConfig } from "../../../apps/host/src/automation-config.js";
import { automaticResumeStages, automationWorkflow, checkpointRecovery, evaluationTargets, recoverEvaluation, summarize, remoteProgress } from "../../../apps/host/src/automation-evaluation.js";
import { attributionResult, draftFor, fixtureConfig, raw, fakeIdentity, fakeEvaluatorVersion, taskResult } from "../../fixtures/comparison.js";
import { ROOT, services, validateRun } from "../../fixtures/services.js";

test("automation plans all four stages and rewrites for attribution, comparison and clustering", async () => {
  const { directory, config } = await fixtureConfig();
  try {
    const date = "2026-09-29", source = path.join(directory, "source");
    for (const model of REMOTE_MODELS) await writeJsonl(path.join(source, date, model + ".jsonl"), [raw()]);
    const evaluation = automationEvaluationConfig(config, source, date);
    const plan = await buildPlan(evaluation);
    assert.deepEqual(new Set(plan.tasks.map((task) => task.stage)), new Set(["attribution", "comparison", "rewrite", "clustering"]));
    const rewrites = plan.tasks.filter((task) => task.stage === "rewrite");
    assert.deepEqual(new Set(rewrites.map((task) => (task.data as TaskData).rewriteOf!.stage)), new Set(["attribution", "comparison", "clustering"]));
    for (const task of plan.tasks.filter((task) => task.stage !== "rewrite"))
      assert.equal(rewrites.filter((rewrite) => (rewrite.data as TaskData).rewriteOf!.taskId === task.id).length, 1);

    const state: RunState = { usage: emptyUsage(), receipts: {}, recordedAttempts: 0, manifest: {
      format: "evaluation-run", debug: false, runId: "daily-" + date, status: "finished", evaluatorVersion: fakeEvaluatorVersion,
      engine: fakeIdentity, config: evaluation, tasks: plan.tasks, inputCatalog: plan.catalog, inputs: {},
      states: Object.fromEntries(plan.tasks.map((task) => [task.id, { status: "pending", attempts: 0 }])),
      preflight: plan.summary, startedAt: Date.now(),
    } };
    const accepted = plan.tasks.find((task) => task.stage === "attribution")!;
    state.receipts[accepted.id] = { taskId: accepted.id } as RunState["receipts"][string];
    state.manifest.states[accepted.id].status = "succeeded";
    for (const model of REMOTE_MODELS) await writeJsonl(path.join(source, date, model + ".jsonl"), [raw(), raw("new-case")]);
    await reconcileRun(directory, state, evaluation);
    assert.equal(state.manifest.tasks.find((task) => task.id === accepted.id), accepted);
    assert(state.manifest.tasks.some((task) => task.stage === "comparison" && Object.values((task.data as TaskData).candidates)[0].case_id === "new-case"));
    assert.equal(state.manifest.states[accepted.id].status, "succeeded");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("daily reconciliation covers retained and new attribution receipts with clustering and rewrite", async () => {
  const { directory, config } = await fixtureConfig();
  try {
    const date = "2026-09-29", source = path.join(directory, "source");
    for (const model of REMOTE_MODELS) await writeJsonl(path.join(source, date, model + ".jsonl"), [raw("old")]);
    const evaluation = automationEvaluationConfig(config, source, date), plan = await buildPlan(evaluation);
    const state: RunState = { usage: emptyUsage(), recordedAttempts: 0,
      receipts: Object.fromEntries(plan.tasks.map(task => [task.id, { taskId: task.id }])) as RunState["receipts"], manifest: {
        format: "evaluation-run", runId: "daily", debug: false, status: "finished", startedAt: 1,
        evaluatorVersion: fakeEvaluatorVersion, engine: fakeIdentity, config: evaluation,
        tasks: plan.tasks, inputCatalog: plan.catalog, inputs: {}, preflight: plan.summary,
        states: Object.fromEntries(plan.tasks.map(task => [task.id, { status: "succeeded", attempts: 1 }])),
      } };
    for (const model of REMOTE_MODELS) await writeJsonl(path.join(source, date, model + ".jsonl"), [raw("old"), raw("new")]);
    await automationWorkflow.reconcile!(directory, state, evaluation);
    const clusters = state.manifest.tasks.filter(task => task.stage === "clustering");
    for (const task of state.manifest.tasks.filter(task => task.stage === "attribution"))
      assert(clusters.some(cluster => Object.values(cluster.dependencies).includes(task.id)), "missing clustering for " + task.id);
    for (const cluster of clusters)
      assert(state.manifest.tasks.some(task => (task.data as TaskData).rewriteOf?.taskId === cluster.id));
    for (const task of plan.tasks) assert.equal(state.manifest.tasks.find(current => current.id === task.id), task);
    const ids = state.manifest.tasks.map(task => task.id);
    await automationWorkflow.reconcile!(directory, state, evaluation);
    assert.deepEqual(state.manifest.tasks.map(task => task.id).sort(), ids.sort(), "reconciliation must not duplicate supplemental tasks");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("all-stage automation resumes interrupted clustering and each rewrite without repeating accepted tasks", { timeout: 60_000 }, async (t) => {
  const { directory, config, modelForStage } = await fixtureConfig();
  let controller = new AbortController();
  const interrupted = new Set<string>(), interruptedTasks = new Set<string>(), calls = new Map<string, number>();
  const date = "2026-09-29", source = path.join(directory, "source");
  for (const model of REMOTE_MODELS)
    await writeJsonl(path.join(source, date, model + ".jsonl"), [raw("q1", "4", "2+2=5")]);
  const evaluation = automationEvaluationConfig(config, source, date);
  const plan = await buildPlan(evaluation);
  const backend: AgentBackend = {
    identity: fakeIdentity,
    async createSession(options) {
      let release = () => {};
      return {
        async run() {
          const id = options.spec.taskId, task = plan.tasks.find((task) => task.id === id)!;
          calls.set(id, (calls.get(id) ?? 0) + 1);
          const stage = task.stage === "rewrite" ? `rewrite/${(task.data as TaskData).rewriteOf!.stage}` : task.stage;
          if ((task.stage === "rewrite" || task.stage === "clustering") && !interrupted.has(stage)) {
            interrupted.add(stage); interruptedTasks.add(id);
            const stopped = new Promise<void>((resolve) => { release = resolve; });
            controller.abort();
            await stopped;
            return;
          }
          const result = task.stage === "attribution" ? attributionResult(false, "2+2=5") : taskResult(options.spec);
          const submitted = await options.execute("submit_evaluation", draftFor(options.spec, result));
          assert.equal(submitted.isError, undefined, JSON.stringify(submitted));
        },
        async abort() { release(); },
        async dispose() {},
      };
    },
  };
  const worker = await startWorker(backend, path.join(directory, "worker"));
  try {
    const runId = `daily-${date}`, run = path.join(evaluation.output.path, runId);
    const accepted = new Set<string>();
    for (let restart = 0; restart < 5; restart++) {
      controller = new AbortController();
      const previous = restart ? comparisonCodec.encode(await readRunState(run)) : undefined;
      const result = await runEvaluation({
        ...services, runId, output: evaluation.output, config: evaluation, plan, modelForStage,
        evaluatorVersion: fakeEvaluatorVersion, engine: "pi", identity: fakeIdentity,
        policy: evaluation.execution, concurrency: 1, retries: 0, retryDelaySeconds: 0,
        discoverInputs: true, workerUrls: [worker.url], signal: AbortSignal.any([controller.signal, t.signal]),
        resumeStages: previous ? automaticResumeStages(previous) : [],
      });
      const saved = await readRunState(run);
      for (const id of accepted) assert.equal(calls.get(id), interruptedTasks.has(id) ? 2 : 1);
      for (const id of Object.keys(saved.receipts)) accepted.add(id);
      assert(accepted.size > 0, "accepted work must survive interruption");
      assert.equal(result.status, restart < 4 ? "interrupted" : "finished");
      if (restart === 0) {
        const paused = comparisonCodec.encode(saved);
        const cancelled = Object.entries(paused.tasks).find(([, task]) => task.status === "cancelled")!;
        paused.pausedStages = [{ stage: cancelled[1].stage, category: "interruption", code: "attempt_interrupted",
          path: "/", taskIds: [cancelled[0]], at: Date.now() }];
        await writeJson(path.join(run, "state.json"), paused);
        assert.equal(checkpointRecovery([paused]), "interrupted");
      }
    }
    assert.deepEqual(interrupted, new Set(["clustering", "rewrite/attribution", "rewrite/comparison", "rewrite/clustering"]));
    const saved = await readRunState(run), counts = summarize([comparisonCodec.encode(saved)]);
    assert.deepEqual(Object.keys(counts.stages).sort(), ["attribution", "clustering", "comparison", "rewrite"]);
    for (const stage of Object.values(counts.stages)) {
      assert(stage.total > 0);
      assert.equal(stage.completed, stage.total);
      assert.equal(stage.failed + stage.pending + stage.running, 0);
    }
    for (const [id, count] of calls) assert.equal(count, interruptedTasks.has(id) ? 2 : 1);
    assert.equal((await validateRun(run)).valid, true);
  } finally {
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("automatic recovery distinguishes shutdown, temporary outages and persistent validation failures", async () => {
  const { directory } = await fixtureConfig();
  try {
    const state = { status: "interrupted", config: {}, preflight: { skipped: [], issues: [] }, tasks: {
      stopped: { stage: "rewrite", status: "cancelled", data: {} },
    }, pausedStages: [{ stage: "rewrite", category: "interruption", code: "attempt_interrupted", path: "/", taskIds: ["stopped"], at: 1 }],
    } as unknown as Checkpoint;
    assert.deepEqual(automaticResumeStages(state), ["rewrite"]);
    const settings = await loadAutomationConfig(path.join(ROOT, "configs/automations.json"));
    const date = "2026-09-29", job = { date, runIds: [] } as unknown as AutomationJob;
    await writeJson(path.join(directory, `daily-${date}`, "state.json"), state);
    assert.equal(await recoverEvaluation(settings, directory, job), "interrupted");
    assert.deepEqual(job.runIds, [`daily-${date}`]);
    assert.equal(job.summary?.stages.rewrite.failed, 0);
    state.tasks.stopped.status = "failed";
    state.tasks.stopped.failure = { errors: [{ category: "transport", code: "unavailable", path: "/", message: "offline" }] } as never;
    assert.equal(checkpointRecovery([state]), "transient");
    state.pausedStages![0].category = "structure";
    assert.deepEqual(automaticResumeStages(state), []);
    assert.equal(checkpointRecovery([state]), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a daily Fast run expands to Expert with all rewrites in the same directory and retains accepted receipts", { timeout: 30_000 }, async () => {
  const { directory, config, modelForStage } = await fixtureConfig(undefined, true, true);
  const complete = structuredClone(config);
  complete.comparisons = [["a_fast", "b_fast"], ["a_expert", "b_expert"]];
  config.inputs.versions = config.inputs.versions.filter((version) => ["a_fast", "b_fast"].includes(version.id));
  config.comparisons = [["a_fast", "b_fast"]];
  const calls = new Map<string, number>();
  const backend: AgentBackend = { identity: fakeIdentity, async createSession(options) {
    return { async run() {
      calls.set(options.spec.taskId, (calls.get(options.spec.taskId) ?? 0) + 1);
      const reply = await options.execute("submit_evaluation", draftFor(options.spec, taskResult(options.spec)));
      assert.equal(reply.isError, undefined, JSON.stringify(reply));
    }, async abort() {}, async dispose() {} };
  } };
  const worker = await startWorker(backend, path.join(directory, "worker"));
  try {
    const runId = "daily-2026-09-29", run = path.join(config.output.path, runId);
    const base = { ...services, runId, output: config.output, config, plan: await buildPlan(config), modelForStage,
      evaluatorVersion: fakeEvaluatorVersion, engine: "pi" as const, identity: fakeIdentity,
      policy: config.execution, concurrency: 4, retries: 0, retryDelaySeconds: 0, workerUrls: [worker.url] };
    await runEvaluation(base);
    const accepted = await readRunState(run);
    const result = await runEvaluation({ ...base, config: complete, plan: { tasks: [], inputs: {}, summary: {} }, discoverInputs: true,
      taskSource: automationWorkflow,
    });
    assert.equal(result.status, "finished");
    const after = await readRunState(run);
    assert.deepEqual((after.manifest.config as typeof config).inputs.versions.map((v) => v.id).sort(), [...REMOTE_MODELS].sort());
    assert.equal(after.manifest.tasks.filter((task) => task.stage === "comparison").length, 2);
    assert(after.manifest.tasks.some((task) => (task.data as TaskData).group?.includes("a_expert")));
    for (const [id, receipt] of Object.entries(accepted.receipts)) {
      assert.equal(calls.get(id), 1);
      assert.equal(after.receipts[id].submissionId, receipt.submissionId);
    }
    assert(Object.values(after.manifest.states).every((state) => state.status === "succeeded"));
    assert.equal((await validateRun(run)).valid, true);
  } finally { await worker.close(); await rm(directory, { recursive: true, force: true }); }
});

test("an existing Fast run retains its date identity while Expert is added; historical completion is verified", async () => {
  const record = { ...raw(), batch_id: "2026-09-29" };
  const { directory, config } = await fixtureConfig([[record], [record], [record], [record]]);
  try {
    const settings = await loadAutomationConfig(path.join(ROOT, "configs/automations.json"));
    const day: RemoteDay = { date: "2026-09-29", rows: Object.fromEntries(REMOTE_MODELS.map((model) => [model, 1])) as RemoteDay["rows"] };
    config.inputs.versions = config.inputs.versions.filter((version) => ["a_fast", "b_fast"].includes(version.id));
    const plan = await buildPlan(config);
    const state: RunState = { usage: emptyUsage(), receipts: {}, recordedAttempts: 0, manifest: {
      format: "evaluation-run", debug: false, runId: "daily-" + day.date, status: "finished", evaluatorVersion: fakeEvaluatorVersion,
      engine: fakeIdentity, config, tasks: plan.tasks, inputCatalog: plan.catalog, inputs: {},
      states: Object.fromEntries(plan.tasks.map((task) => [task.id, { status: "pending", attempts: 0 }])),
      preflight: plan.summary, startedAt: Date.now(),
    } };
    await writeJson(path.join(directory, "daily-" + day.date, "state.json"), comparisonCodec.encode(state));
    const targets = await evaluationTargets(settings, directory, day);
    assert.deepEqual(targets.runIds, ["daily-2026-09-29"]);
    await assert.rejects(evaluationTargets({ ...settings, completedDates: [day.date] }, directory, day), /not complete/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("local all-stage counts preserve rewrite failure while the remote projection counts only comparisons", () => {
  const state = { tasks: {
    comparison: { stage: "comparison", status: "succeeded", receipt: {}, dependencies: {}, data: { group: ["a_fast", "b_fast"] }, inputIds: { A: "a" } },
    rewrite: { stage: "rewrite", status: "failed", data: { rewriteOf: { taskId: "comparison", stage: "comparison" } } },
  }, config: { clustering: { enabled: false }, rewrite: { comparison: true } },
    inputs: { a: { batch_id: "date", case_id: "case" } }, preflight: { skipped: [], issues: [] } } as unknown as Checkpoint;
  const summary = summarize([state]);
  assert.equal(summary.stages.comparison.completed, 1);
  assert.equal(summary.stages.rewrite.failed, 1);
  assert.equal(summary.readyComparisons, 0);
  const progress = remoteProgress({ id: "auto", sourceUrl: "http://test", status: "running", startedAt: 1, updatedAt: 2,
    jobs: { "2026-09-29": { date: "2026-09-29", evaluation: "blocked", runIds: ["daily-2026-09-29"],
      observed: { a_fast: 1, b_fast: 1, a_expert: 0, b_expert: 0 }, adopted: false, download: "ready", checkedAt: 1,
      downloadAttempts: 0, evaluationAttempts: 3, nextDownloadAt: 0, nextEvaluationAt: 0 } } }, "pi", new Map([["2026-09-29", [state]]]));
  assert.equal(progress.status, "interrupted");
  assert.equal(progress.dates[0].pairs.fast.completed_cases, 1);
});

test("interrupted and dependency-blocked tasks are not reported as evaluation failures", () => {
  const run = { config: {}, tasks: Object.fromEntries(["cancelled", "blocked", "failed", "timed_out", "pending", "running"].map((status) =>
    [status, { stage: "rewrite", status, data: {} }])), preflight: { skipped: [], issues: [] },
  } as unknown as Checkpoint;
  assert.deepEqual(summarize([run]).stages.rewrite, {
    total: 6, completed: 0, failed: 2, pending: 1, running: 1, cancelled: 1, blocked: 1,
  });
});

test("remote progress satisfies the required six-count contract and separates skipped cases from failures", async () => {
  const date = "2026-09-30", group = ["a_fast", "b_fast"];
  const tasks = Object.fromEntries(["succeeded", "failed", "running", "pending", "cancelled", "blocked"].map((status) => [status, {
    stage: "comparison", status, data: { group }, inputIds: { A: status },
  }]));
  const run = { tasks, inputs: Object.fromEntries(Object.keys(tasks).map((id) => [id, { batch_id: date, case_id: id }])),
    preflight: { skipped: ["unpaired", "unpaired", "succeeded", "failed"].map((id) => ({ versions: group, batch_id: date, case_id: id })), issues: [] },
  } as unknown as Checkpoint;
  const progress = remoteProgress({ id: "test", sourceUrl: "http://test", status: "running", startedAt: 1, updatedAt: 2,
    jobs: { [date]: { date, runIds: ["test"], observed: { a_fast: 5, b_fast: 4, a_expert: 0, b_expert: 0 },
      adopted: false, download: "ready", evaluation: "evaluating", checkedAt: 1,
      downloadAttempts: 0, evaluationAttempts: 1, nextDownloadAt: 0, nextEvaluationAt: 0 } },
  }, "pi", new Map([[date, [run]]]));
  const fields = ["total_cases", "completed_cases", "running_cases", "queued_cases", "failed_cases", "skipped_cases"];
  // Mirror the current /evaluation-progress boundary, including exact keys for empty pairs.
  const server = await listen(async (req, res) => {
    const received = await body(req) as typeof progress;
    for (const entry of received.dates) for (const counts of Object.values(entry.pairs)) {
      if (Object.keys(counts).length !== fields.length || fields.some((key) => !Object.hasOwn(counts, key))) {
        json(res, { error: "invalid pair counts" }, 400); return;
      }
    }
    json(res, { saved: true });
  });
  try {
    await new RemoteInputs(server.url, 1000).publish(progress, AbortSignal.timeout(3000));
    assert.deepEqual(progress.dates[0].pairs.fast, {
      total_cases: 7, completed_cases: 1, running_cases: 1, queued_cases: 3, failed_cases: 1, skipped_cases: 1,
    });
    assert.deepEqual(progress.dates[0].pairs.expert, {
      total_cases: 0, completed_cases: 0, running_cases: 0, queued_cases: 0, failed_cases: 0, skipped_cases: 0,
    });
  } finally { await server.close(); }
});

test("an unpaired input date persists its preflight for progress without making model calls", async () => {
  const { directory, config, modelForStage } = await fixtureConfig([[], [], [raw()], []], true, true);
  try {
    const plan = await buildPlan(config);
    assert.equal(plan.tasks.length, 0);
    const result = await runEvaluation({
      ...services, runId: "empty-pairs", output: config.output, config, plan, modelForStage,
      evaluatorVersion: fakeEvaluatorVersion, engine: "pi", identity: fakeIdentity,
      policy: config.execution, concurrency: 1, retries: 0, retryDelaySeconds: 0,
    });
    assert.deepEqual(result.execution_task_statuses, {});
    const saved = await services.repository.readRun(path.join(config.output.path, "empty-pairs"));
    assert.equal(saved.recordedAttempts, 0);
    assert.equal((saved.manifest.preflight.skipped as unknown[]).length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
