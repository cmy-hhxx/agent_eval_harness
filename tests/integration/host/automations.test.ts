import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { REMOTE_MODELS, emptyUsage, type AgentBackend, type RemoteDay, type RunState } from "@eval/contracts";
import { readJson, writeJson, writeJsonl } from "@eval/data";
import { runEvaluation } from "@eval/host";
import { RemoteInputs } from "@eval/runtime/client";
import type { AutomationJob, AutomationState } from "@eval/automations";
import { startWorker } from "@eval/runtime/worker";
import { body, json, listen } from "@eval/runtime/http";
import { buildPlan, comparisonCodec, comparisonSlots, deliveryCoverage, readRunState, reconcileRun, type Checkpoint, type TaskData } from "@eval/workflows/comparison";
import { automationEvaluationConfig, loadAutomationConfig } from "../../../apps/host/src/automation-config.js";
import { automaticResumeStages, createAutomationWorkflow, checkpointRecovery, evaluationTargets, recoverEvaluation, summarize, remoteProgress } from "../../../apps/host/src/automation-evaluation.js";
import { attributionResult, comparisonResult, draftFor, fixtureConfig, raw, fakeIdentity, fakeEvaluatorVersion, taskResult, parsedMaterial } from "../../fixtures/comparison.js";
import { ROOT, services, validateRun } from "../../fixtures/services.js";

const automationWorkflow = createAutomationWorkflow(600);

test("automation caps each tier at 600 battles and keeps reservations across input refreshes", async () => {
  const fast = Array.from({ length: 603 }, (_, index) => raw(`q${String(index).padStart(4, "0")}`));
  const expert = Array.from({ length: 605 }, (_, index) => raw(`q${String(index + 500).padStart(4, "0")}`));
  const { directory, config } = await fixtureConfig([fast, expert, fast, expert], true);
  try {
    config.comparisons = [["a_fast", "b_fast"], ["a_expert", "b_expert"]];
    config.rewrite.comparisonItems = true;
    const plan = await automationWorkflow.plan(config);
    assert.deepEqual(plan.summary.group_counts, { "a_fast+b_fast": 600, "a_expert+b_expert": 600 });
    assert.equal(plan.summary.comparison_tasks, 1200);
    assert.equal(plan.summary.attribution_tasks, 2400);
    assert.equal(plan.summary.rewrite_tasks, 3600);
    assert.equal(Object.keys(plan.inputs).length, (603 + 605) * 2, "unselected inputs remain available");
    assert.equal((await buildPlan(config)).summary.comparison_tasks, 1208, "manual evaluation is unrestricted");
    const ids = new Set(plan.tasks.map((task) => task.id));
    for (const task of plan.tasks) for (const id of Object.values(task.dependencies)) assert(ids.has(id));
    const state: RunState = { usage: emptyUsage(), receipts: {}, recordedAttempts: 0, manifest: {
      format: "evaluation-run", debug: false, runId: "daily", status: "interrupted", evaluatorVersion: fakeEvaluatorVersion,
      engine: fakeIdentity, config, tasks: plan.tasks, inputCatalog: plan.catalog, inputs: {},
      states: Object.fromEntries(plan.tasks.map((task) => [task.id, { status: "cancelled", attempts: 1 }])),
      preflight: plan.summary, startedAt: Date.now(),
    } };
    for (const version of config.inputs.versions) {
      const rows = version.id.endsWith("fast") ? fast : expert;
      await writeJsonl(path.join(directory, version.id + ".jsonl"), [raw("earlier-case"), ...rows.toReversed()]);
    }
    await automationWorkflow.reconcile!(directory, state, config);
    assert.deepEqual(new Set(state.manifest.tasks.map((task) => task.id)), ids, "refresh must not rotate the reserved battles");
    for (const id of ids) assert.equal(state.manifest.states[id].attempts, 1);
    assert.deepEqual(state.manifest.preflight.group_counts, { "a_fast+b_fast": 600, "a_expert+b_expert": 600 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("quota changes preserve completed battles and stop excess queued work without borrowing tier capacity", { timeout: 90_000 }, async (t) => {
  const date = "2026-09-29", fast = [raw("q2"), raw("q3"), raw("q4")], expert = [raw("q4")];
  const { directory, config, modelForStage } = await fixtureConfig([fast, expert, fast, expert], true);
  config.comparisons = [["a_fast", "b_fast"], ["a_expert", "b_expert"]];
  config.rewrite.comparisonItems = true;
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
    const runId = "daily-" + date, run = path.join(config.output.path, runId);
    const base = { ...services, runId, output: config.output, config, plan: await buildPlan(config), modelForStage,
      evaluatorVersion: fakeEvaluatorVersion, engine: "pi" as const, identity: fakeIdentity,
      policy: config.execution, concurrency: 4, retries: 0, retryDelaySeconds: 0, workerUrls: [worker.url], signal: t.signal };
    await runEvaluation(base);
    const accepted = await readRunState(run);
    for (const version of config.inputs.versions)
      await writeJsonl(path.join(directory, version.id + ".jsonl"), [raw("q0"), raw("q1"), ...(version.id.endsWith("fast") ? fast : expert)]);
    // Reproduce an existing unlimited queue, including a persistent error on excess work.
    const queued = await readRunState(run);
    await reconcileRun(run, queued, config);
    const excluded = queued.manifest.tasks.find((task) => task.stage === "attribution" &&
      (task.data as TaskData).candidates.A.version === "a_fast" && (task.data as TaskData).candidates.A.case_id === "q0")!;
    queued.manifest.states[excluded.id].status = "failed";
    queued.manifest.pausedStages = [{ stage: "attribution", category: "structure", code: "invalid", path: "/", at: 1, taskIds: [excluded.id] }];
    await services.repository.writeRun(run, queued);
    const settings = { ...await loadAutomationConfig(path.join(ROOT, "configs/automations.json")), dailyComparisonLimitPerTier: 2 };
    const job = { date, runIds: [runId], evaluation: "blocked" } as AutomationJob;
    assert.equal(await recoverEvaluation(settings, config.output.path, job), "interrupted", "excluded errors must not block remaining quota");
    const workflow = createAutomationWorkflow(settings.dailyComparisonLimitPerTier);
    const result = await runEvaluation({ ...base, taskSource: workflow, discoverInputs: true, plan: { tasks: [], inputs: {}, summary: {} } });
    assert.equal(result.status, "finished");
    const saved = await readRunState(run);
    assert.deepEqual(saved.manifest.pausedStages, []);
    assert.deepEqual(saved.manifest.preflight.group_counts, { "a_fast+b_fast": 3, "a_expert+b_expert": 2 });
    assert.equal(calls.size, 30, "only one additional battle's six stages may run");
    assert.equal(calls.has(excluded.id), false);
    for (const [id, receipt] of Object.entries(accepted.receipts)) {
      assert.deepEqual(saved.receipts[id], receipt, "completed output and receipt must remain unchanged");
      assert.equal(calls.get(id), 1);
    }
    await runEvaluation({ ...base, taskSource: workflow, discoverInputs: true, plan: { tasks: [], inputs: {}, summary: {} } });
    assert.equal(calls.size, 30, "restart must not replenish quota");
    assert([...calls.values()].every((count) => count === 1));
    assert.equal((await validateRun(run)).valid, true);
  } finally { await worker.close(); await rm(directory, { recursive: true, force: true }); }
});

test("automation comparison quota is a required positive integer setting", async () => {
  const { directory } = await fixtureConfig();
  try {
    const source = path.join(ROOT, "configs/automations.json"), file = path.join(directory, "automation.json");
    const settings = await readJson<Record<string, unknown>>(source);
    assert.equal((await loadAutomationConfig(source)).dailyComparisonLimitPerTier, 600);
    for (const value of [undefined, 0, -1, 1.5, "600"]) {
      await writeJson(file, { ...settings, dailyComparisonLimitPerTier: value });
      await assert.rejects(loadAutomationConfig(file), /Invalid automations.dailyComparisonLimitPerTier/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("automation plans attribution, comparison and both rewrites while deferring clustering", async () => {
  const { directory, config } = await fixtureConfig();
  try {
    const date = "2026-09-29", source = path.join(directory, "source");
    for (const model of REMOTE_MODELS) await writeJsonl(path.join(source, date, model + ".jsonl"), [raw()].map((record) => ({ ...record, batch_id: date })));
    const evaluation = automationEvaluationConfig(config, source, date);
    const plan = await automationWorkflow.plan(evaluation);
    assert.deepEqual(new Set(plan.tasks.map((task) => task.stage)), new Set(["criteria", "attribution", "comparison", "rewrite"]));
    assert.equal(evaluation.clustering.enabled, false);
    assert.equal(evaluation.rewrite.clustering, false);
    const rewrites = plan.tasks.filter((task) => task.stage === "rewrite");
    assert.equal(evaluation.rewrite.comparisonItems, true);
    assert(rewrites.filter((task) => (task.data as TaskData).rewriteOf?.stage === "comparison")
      .every((task) => (task.data as TaskData).comparisonRewriteScope === "all"));
    assert.deepEqual(new Set(rewrites.map((task) => (task.data as TaskData).rewriteOf!.stage)), new Set(["attribution", "comparison"]));
    for (const task of plan.tasks.filter((task) => task.stage === "attribution" || task.stage === "comparison"))
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
    for (const model of REMOTE_MODELS) await writeJsonl(path.join(source, date, model + ".jsonl"), [raw(), raw("new-case")].map((record) => ({ ...record, batch_id: date })));
    await automationWorkflow.reconcile!(directory, state, evaluation);
    assert.equal(state.manifest.tasks.find((task) => task.id === accepted.id), accepted);
    assert(state.manifest.tasks.some((task) => task.stage === "comparison" && Object.values((task.data as TaskData).candidates)[0].case_id === "new-case"));
    assert.equal(state.manifest.states[accepted.id].status, "succeeded");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("automation keeps an explicitly same-tier local baseline without requesting another remote source", async () => {
  const { directory, config } = await fixtureConfig();
  try {
    const date = "2026-09-29", source = path.join(directory, "source"), local = path.join(directory, "baseline.jsonl");
    for (const model of REMOTE_MODELS) await writeJsonl(path.join(source, date, model + ".jsonl"), [{ ...raw(), batch_id: date }]);
    await writeJsonl(local, [{ ...raw(), batch_id: date }, { ...raw("other-date"), batch_id: "2026-09-28" }]);
    config.inputs.versions.push({ id: "baseline", name: "Baseline", adapter: "a", comparison_tier: "Fast", sources: [{ kind: "file", path: local }] });
    config.comparisons = [["a_fast", "b_fast", "baseline"]];
    const evaluation = automationEvaluationConfig(config, source, date);
    assert.deepEqual(evaluation.inputs.versions.find((version) => version.id === "baseline")!.sources, [{ kind: "file", path: local }]);
    assert.deepEqual(evaluation.comparisons, config.comparisons);
    const plan = await buildPlan(evaluation);
    assert.equal(plan.tasks.filter((task) => task.stage === "comparison").length, 3);
    assert.equal(plan.tasks.filter((task) => task.stage === "attribution").length, 3);
    assert(plan.tasks.filter((task) => task.stage === "comparison").every((task) => Object.values((task.data as TaskData).candidates).every((candidate) => candidate.batch_id === date)));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("automation defers unfinished clustering, retains accepted results and can cluster all attributions later", async () => {
  const { directory, config } = await fixtureConfig();
  try {
    const date = "2026-09-29", source = path.join(directory, "source");
    for (const model of REMOTE_MODELS) await writeJsonl(path.join(source, date, model + ".jsonl"), [raw("old")].map((record) => ({ ...record, batch_id: date })));
    const evaluation = automationEvaluationConfig(config, source, date);
    const clustered = { ...evaluation, clustering: { ...evaluation.clustering, enabled: true }, rewrite: { ...evaluation.rewrite, clustering: true } };
    const plan = await buildPlan(clustered);
    const state: RunState = { usage: emptyUsage(), recordedAttempts: 0,
      receipts: Object.fromEntries(plan.tasks.map(task => {
        const rewrites = comparisonSlots(comparisonResult(), "all").map(({ id, text }) => ({ id, text }));
        return [task.id, { taskId: task.id,
          ...(task.stage === "comparison" ? { evaluation: comparisonResult(), exported: {
            id: (task.data as TaskData).comparisonId!, row: { rewritten: { rewrites } },
          } } : (task.data as TaskData).rewriteOf?.stage === "comparison" ? { evaluation: { rewrites } } : {}),
        }];
      })) as RunState["receipts"], manifest: {
        format: "evaluation-run", runId: "daily", debug: false, status: "finished", startedAt: 1,
        evaluatorVersion: fakeEvaluatorVersion, engine: fakeIdentity, config: clustered,
        tasks: plan.tasks, inputCatalog: plan.catalog, inputs: {}, preflight: plan.summary,
        states: Object.fromEntries(plan.tasks.map(task => [task.id, { status: "succeeded", attempts: 1 }])),
      } };
    const deferred = plan.tasks.find((task) => task.stage === "clustering")!;
    const polish = plan.tasks.find((task) => (task.data as TaskData).rewriteOf?.taskId === deferred.id)!;
    for (const task of [deferred, polish]) {
      delete state.receipts[task.id];
      state.manifest.states[task.id].status = "failed";
    }
    state.manifest.pausedStages = [deferred, polish].map((task) => ({ stage: task.stage, category: "structure", code: "invalid",
      path: "/", at: 1, taskIds: [task.id] }));
    const accepted = new Map(Object.entries(state.receipts));
    for (const model of REMOTE_MODELS) await writeJsonl(path.join(source, date, model + ".jsonl"), [raw("old"), raw("new")].map((record) => ({ ...record, batch_id: date })));
    await automationWorkflow.reconcile!(directory, state, evaluation);
    assert(!state.manifest.tasks.some((task) => task.id === deferred.id || task.id === polish.id));
    assert.deepEqual(state.manifest.pausedStages, []);
    for (const task of state.manifest.tasks.filter(task => task.stage === "clustering" || (task.data as TaskData).rewriteOf?.stage === "clustering"))
      assert(accepted.has(task.id), "automation must not schedule new clustering work");
    for (const [id, receipt] of accepted) assert.equal(state.receipts[id], receipt);
    const ids = state.manifest.tasks.map(task => task.id);
    await automationWorkflow.reconcile!(directory, state, evaluation);
    assert.deepEqual(state.manifest.tasks.map(task => task.id).sort(), ids.sort(), "reconciliation must not duplicate supplemental tasks");
    await reconcileRun(directory, state, clustered);
    const clusters = state.manifest.tasks.filter(task => task.stage === "clustering");
    for (const task of state.manifest.tasks.filter(task => task.stage === "attribution"))
      assert(clusters.some(cluster => Object.values(cluster.dependencies).includes(task.id)), "missing deferred clustering for " + task.id);
    for (const cluster of clusters)
      assert(state.manifest.tasks.some(task => (task.data as TaskData).rewriteOf?.taskId === cluster.id));
    for (const [id, receipt] of accepted) assert.equal(state.receipts[id], receipt);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("automation resumes each evaluation rewrite without running clustering or repeating accepted tasks", { timeout: 60_000 }, async (t) => {
  const { directory, config, modelForStage } = await fixtureConfig();
  let controller = new AbortController();
  const interrupted = new Set<string>(), interruptedTasks = new Set<string>(), calls = new Map<string, number>();
  const date = "2026-09-29", source = path.join(directory, "source");
  for (const model of REMOTE_MODELS)
    await writeJsonl(path.join(source, date, model + ".jsonl"), [raw("q1", "4", "2+2=5")].map((record) => ({ ...record, batch_id: date })));
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
    for (let restart = 0; restart < 3; restart++) {
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
      assert.equal(result.status, restart < 2 ? "interrupted" : "finished");
      if (restart === 0) {
        const paused = comparisonCodec.encode(saved);
        const cancelled = Object.entries(paused.tasks).find(([, task]) => task.status === "cancelled")!;
        paused.pausedStages = [{ stage: cancelled[1].stage, category: "interruption", code: "attempt_interrupted",
          path: "/", taskIds: [cancelled[0]], at: Date.now() }];
        await writeJson(path.join(run, "state.json"), paused);
        assert.equal(checkpointRecovery([paused]), "interrupted");
      }
    }
    assert.deepEqual(interrupted, new Set(["rewrite/attribution", "rewrite/comparison"]));
    const saved = await readRunState(run), counts = summarize([comparisonCodec.encode(saved)]);
    assert.deepEqual(Object.keys(counts.stages).sort(), ["attribution", "comparison", "criteria", "rewrite"]);
    for (const stage of Object.values(counts.stages)) {
      assert(stage.total > 0);
      assert.equal(stage.completed, stage.total);
      assert.equal(stage.failed + stage.pending + stage.running, 0);
    }
    assert.equal(deliveryCoverage(saved, { rewriteScopes: ["verdicts", "items"] }).valid, true);
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

test("deferred clustering failures and pauses cannot block completed evaluation or enter its retry pool", async () => {
  const { directory } = await fixtureConfig();
  try {
    const receipt = { acceptedAt: 100, exported: {} };
    const saved = { config: { inputs: { versions: REMOTE_MODELS.map(id => ({ id })) },
      rewrite: { comparison: true, comparisonItems: true, clustering: true }, clustering: { enabled: true } },
      preflight: { skipped: [], issues: [] }, tasks: {
        comparison: { stage: "comparison", status: "succeeded", receipt, dependencies: {}, data: { comparisonId: "c", group: ["a_fast", "b_fast"] } },
        polish: { stage: "rewrite", status: "succeeded", receipt, dependencies: {}, data: {
          rewriteOf: { taskId: "comparison", stage: "comparison" }, comparisonRewriteScope: "all" } },
        cluster: { stage: "clustering", status: "failed", data: {}, dependencies: {} },
        clusterPolish: { stage: "rewrite", status: "blocked", data: { rewriteOf: { taskId: "cluster", stage: "clustering" } } },
      }, pausedStages: [
        { stage: "clustering", category: "structure", code: "invalid", path: "/", taskIds: ["cluster"], at: 1 },
        { stage: "rewrite", category: "transport", code: "unavailable", path: "/", taskIds: ["clusterPolish"], at: 1 },
      ] } as unknown as Checkpoint;
    const summary = summarize([saved]);
    assert.equal(summary.readyComparisons, 1);
    assert.equal(summary.stages.clustering, undefined);
    assert.equal(summary.stages.rewrite.total, 1);
    assert.equal(summary.stages.rewrite.blocked, 0);
    assert.equal(checkpointRecovery([saved]), undefined);
    assert.deepEqual(automaticResumeStages(saved), []);
    const settings = await loadAutomationConfig(path.join(ROOT, "configs/automations.json"));
    const date = "2026-09-29", current = { date, runIds: [], evaluation: "retry", evaluationError: "cluster: invalid" } as unknown as AutomationJob;
    await writeJson(path.join(directory, `daily-${date}`, "state.json"), saved);
    await recoverEvaluation(settings, directory, current);
    assert.equal(current.evaluation, "completed");
    assert.equal(current.evaluationError, undefined);
    saved.tasks.polish.data.comparisonRewriteScope = "verdicts";
    (saved.config as { rewrite: { comparisonItems: boolean } }).rewrite.comparisonItems = false;
    assert.equal(summarize([saved]).readyComparisons, 0, "ordinary automation still requires complete comparison rewriting");
    assert.equal(summarize([saved], false).readyComparisons, 1, "adopted history retains its declared completed scope");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a daily Fast run expands to Expert with all rewrites in the same directory and retains accepted receipts", { timeout: 30_000 }, async () => {
  const { directory, config, modelForStage } = await fixtureConfig(undefined, true, true);
  const complete = structuredClone(config);
  complete.rewrite.comparisonItems = true;
  complete.rewrite.clustering = false;
  complete.clustering.enabled = false;
  complete.comparisons = [["a_fast", "b_fast"], ["a_expert", "b_expert"]];
  config.inputs.versions = config.inputs.versions.filter((version) => ["a_fast", "b_fast"].includes(version.id));
  config.comparisons = [["a_fast", "b_fast"]];
  const calls = new Map<string, number>();
  const requestedSlots = new Map<string, string[][]>();
  const backend: AgentBackend = { identity: fakeIdentity, async createSession(options) {
    return { async run() {
      calls.set(options.spec.taskId, (calls.get(options.spec.taskId) ?? 0) + 1);
      if (options.spec.evaluation.id === "rewrite") {
        const items = (parsedMaterial(options.spec) as { items: { id: string }[] }).items;
        requestedSlots.set(options.spec.taskId, [...(requestedSlots.get(options.spec.taskId) ?? []), items.map((item) => item.id)]);
      }
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
    const settings = await loadAutomationConfig(path.join(ROOT, "configs/automations.json"));
    const job = { date: "2026-09-29", runIds: [], evaluation: "completed",
      mongo: { status: "completed", synced: { inputsUpdatedAt: 1, comparisons: 1 } },
    } as unknown as AutomationJob;
    assert.equal(await recoverEvaluation(settings, config.output.path, job), "interrupted");
    assert.equal(job.mongo!.synced, undefined, "backfilled text must be uploaded even when the comparison count is unchanged");
    const result = await runEvaluation({ ...base, config: complete, plan: { tasks: [], inputs: {}, summary: {} }, discoverInputs: true,
      taskSource: automationWorkflow,
    });
    assert.equal(result.status, "finished");
    const after = await readRunState(run);
    assert.deepEqual((after.manifest.config as typeof config).inputs.versions.map((v) => v.id).sort(), [...REMOTE_MODELS].sort());
    assert.equal(after.manifest.tasks.filter((task) => task.stage === "comparison").length, 2);
    assert(after.manifest.tasks.some((task) => (task.data as TaskData).group?.includes("a_expert")));
    for (const [id, receipt] of Object.entries(accepted.receipts)) {
      if ((accepted.manifest.tasks.find((task) => task.id === id)!.data as TaskData).rewriteOf?.stage === "comparison") {
        assert.equal(calls.get(id), 2);
        const [original, missing] = requestedSlots.get(id)!;
        assert(original.every((slot) => slot.startsWith("verdict.")));
        assert(missing.length > 0 && missing.every((slot) => slot.startsWith("comparison.")));
        const saved = after.receipts[id].exported!.row.rewritten as { rewrites: { id: string; text: string }[] };
        for (const item of (receipt.evaluation as { rewrites: { id: string; text: string }[] }).rewrites)
          assert.deepEqual(saved.rewrites.find((entry) => entry.id === item.id), item);
        continue;
      }
      assert.equal(calls.get(id), 1);
      assert.equal(after.receipts[id].submissionId, receipt.submissionId);
    }
    assert(Object.values(after.manifest.states).every((state) => state.status === "succeeded"));
    assert.equal(deliveryCoverage(after, { rewriteScopes: ["verdicts", "items"] }).valid, true);
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

test("local evaluation counts preserve rewrite failure while the remote projection counts only comparisons", () => {
  const state = { tasks: {
    comparison: { stage: "comparison", status: "succeeded", receipt: {}, dependencies: {}, data: { group: ["a_fast", "b_fast"] }, inputIds: { A: "a" } },
    rewrite: { stage: "rewrite", status: "failed", data: { rewriteOf: { taskId: "comparison", stage: "comparison" } } },
  }, config: { comparisons: [["a_fast", "b_fast"], ["a_expert", "b_expert"]], clustering: { enabled: false }, rewrite: { comparison: true } },
    inputs: { a: { batch_id: "date", case_id: "case" } }, preflight: { skipped: [], issues: [] } } as unknown as Checkpoint;
  const summary = summarize([state]);
  assert.equal(summary.stages.comparison.completed, 1);
  assert.equal(summary.stages.rewrite.failed, 1);
  assert.equal(summary.readyComparisons, 0);
  const progress = remoteProgress({ id: "auto", sourceUrl: "http://test", status: "running", startedAt: 1, updatedAt: 2,
    jobs: { "2026-09-29": { date: "2026-09-29", evaluation: "blocked", runIds: ["daily-2026-09-29"],
      observed: { a_fast: 1, b_fast: 1, a_expert: 0, b_expert: 0 }, adopted: false, download: "ready", checkedAt: 1,
      downloadAttempts: 0, evaluationAttempts: 3, nextDownloadAt: 0, nextEvaluationAt: 0 } } }, "pi", new Map([["2026-09-29", [state]]]), 600);
  assert.equal(progress.status, "interrupted");
  assert.equal(progress.dates[0].pairs.a_fast__vs__b_fast.completed_cases, 1);
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
  const run = { config: { comparisons: [["a_fast", "b_fast"], ["a_expert", "b_expert"]] }, tasks, inputs: Object.fromEntries(Object.keys(tasks).map((id) => [id, { batch_id: date, case_id: id }])),
    preflight: { skipped: ["unpaired", "unpaired", "succeeded", "failed"].map((id) => ({ versions: group, batch_id: date, case_id: id })), issues: [] },
  } as unknown as Checkpoint;
  const progress = remoteProgress({ id: "test", sourceUrl: "http://test", status: "running", startedAt: 1, updatedAt: 2,
    jobs: { [date]: { date, runIds: ["test"], observed: { a_fast: 5, b_fast: 4, a_expert: 0, b_expert: 0 },
      adopted: false, download: "ready", evaluation: "evaluating", checkedAt: 1,
      downloadAttempts: 0, evaluationAttempts: 1, nextDownloadAt: 0, nextEvaluationAt: 0 } },
  }, "pi", new Map([[date, [run]]]), 600);
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
    assert.deepEqual(progress.dates[0].pairs.a_fast__vs__b_fast, {
      total_cases: 7, completed_cases: 1, running_cases: 1, queued_cases: 3, failed_cases: 1, skipped_cases: 1,
    });
    assert.deepEqual(progress.dates[0].pairs.a_expert__vs__b_expert, {
      total_cases: 0, completed_cases: 0, running_cases: 0, queued_cases: 0, failed_cases: 0, skipped_cases: 0,
    });
  } finally { await server.close(); }
});

test("remote progress excludes excess queued battles before the daily run is reconciled", () => {
  const date = "2026-10-01";
  const tasks = Object.fromEntries([
    ["fast", "succeeded"], ["fast", "succeeded"], ["fast", "succeeded"],
    ["fast", "pending"], ["fast", "blocked"], ["fast", "failed"],
    ["expert", "succeeded"], ["expert", "failed"], ["expert", "pending"],
  ].map(([tier, status], index) => [String(index), {
    stage: "comparison", status, ...(status === "succeeded" ? { receipt: {} } : {}),
    dependencies: {}, data: { group: [`a_${tier}`, `b_${tier}`] }, inputIds: { A: String(index) },
  }]));
  const run = { config: { comparisons: [["a_fast", "b_fast"], ["a_expert", "b_expert"]] }, tasks,
    inputs: Object.fromEntries(Object.keys(tasks).map(id => [id, { batch_id: date, case_id: id }])),
    preflight: { skipped: [{ versions: ["a_fast", "b_fast"], batch_id: date, case_id: "unpaired" }], issues: [] },
  } as unknown as Checkpoint;
  const before = structuredClone(run);
  const state = { id: "test", status: "running", startedAt: 1,
    jobs: { [date]: { date, evaluation: "pending", download: "ready" } },
  } as unknown as AutomationState;
  const progress = remoteProgress(state, "pi", new Map([[date, [run]]]), 2);
  assert.deepEqual(progress.dates[0].pairs.fast, {
    total_cases: 4, completed_cases: 3, running_cases: 0, queued_cases: 0, failed_cases: 0, skipped_cases: 1,
  });
  assert.deepEqual(progress.dates[0].pairs.expert, {
    total_cases: 2, completed_cases: 1, running_cases: 0, queued_cases: 0, failed_cases: 1, skipped_cases: 0,
  });
  assert.deepEqual(run, before, "progress projection must not mutate saved tasks or results");
});

test("remote progress includes every configured baseline pair", () => {
  const date = "2026-09-30", ids = ["a_fast", "b_fast", "baseline"];
  const run = { config: { comparisons: [ids] }, tasks: {
    one: { stage: "comparison", status: "succeeded", data: { group: ["a_fast", "baseline"] }, inputIds: { A: "a" } },
  }, inputs: { a: { batch_id: date, case_id: "case" } }, preflight: { skipped: [], issues: [] } } as unknown as Checkpoint;
  const state = { id: "test", status: "running", jobs: { [date]: { date, evaluation: "evaluating" } } } as unknown as Parameters<typeof remoteProgress>[0];
  const progress = remoteProgress(state, "pi", new Map([[date, [run]]]), 600);
  assert.deepEqual(Object.keys(progress.dates[0].pairs).sort(), ["a_fast__vs__b_fast", "a_fast__vs__baseline", "b_fast__vs__baseline"].sort());
  assert.equal(progress.dates[0].pairs.a_fast__vs__baseline.completed_cases, 1);
});

test("remote progress retains accepted pairs after selection changes and keeps review requests queued", () => {
  const date = "2026-09-30";
  const run = { config: { comparisons: [["a_fast", "baseline"]] }, tasks: {
    accepted: { stage: "comparison", status: "succeeded", data: { group: ["a_fast", "b_fast"] }, inputIds: { A: "a" }, receipt: { exported: { file: "comparison.jsonl" } } },
    review: { stage: "comparison", status: "succeeded", data: { group: ["a_fast", "baseline"] }, inputIds: { A: "a" }, receipt: { exported: { file: "comparison-review.jsonl" } } },
  }, inputs: { a: { batch_id: date, case_id: "case" } }, preflight: { skipped: [], issues: [] } } as unknown as Checkpoint;
  const state = { id: "test", status: "running", jobs: { [date]: { date, evaluation: "evaluating" } } } as unknown as Parameters<typeof remoteProgress>[0];
  const progress = remoteProgress(state, "pi", new Map([[date, [run]]]), 600).dates[0].pairs;
  assert.equal(progress.a_fast__vs__b_fast.completed_cases, 1);
  assert.equal(progress.a_fast__vs__baseline.completed_cases, 0);
  assert.equal(progress.a_fast__vs__baseline.queued_cases, 1);
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
