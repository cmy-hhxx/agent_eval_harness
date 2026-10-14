import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_POLICY, REMOTE_MODELS, emptyUsage, type AgentBackend, type RemoteDay, type RunState } from "@eval/contracts";
import { readJson, writeJson, writeJsonl } from "@eval/data";
import { runEvaluation } from "@eval/host";
import { RemoteInputs } from "@eval/runtime/client";
import { runPipeline, type AutomationJob, type AutomationState } from "@eval/automations";
import { startWorker } from "@eval/runtime/worker";
import { body, json, listen } from "@eval/runtime/http";
import { assertStatisticsLog, attributionSlots, buildPlan, comparisonCodec, comparisonSlots, deliveryCoverage, PublicationStatistics, readRunState, reconcileRun, type Checkpoint, type TaskData } from "@eval/workflows/comparison";
import { automationEvaluationConfig, loadAutomationConfig } from "../../../apps/host/src/automation-config.js";
import { automationCommand } from "../../../apps/host/src/automation-command.js";
import { publicationSnapshot, syncMongoDay } from "../../../apps/host/src/automation-publication.js";
import { automaticResumeStages, createAutomationWorkflow, checkpointRecovery, evaluationOutcome, evaluationTargets, recoverEvaluation, summarize, remoteDateProgress, remoteProgress } from "../../../apps/host/src/automation-evaluation.js";
import { submitFor, inspectFor, attributionResult, comparisonResult, draftFor, fixtureConfig, raw, fakeIdentity, fakeEvaluatorVersion, taskResult, parsedMaterial } from "../../fixtures/comparison.js";
import { ROOT, services, validateRun } from "../../fixtures/services.js";

const automationWorkflow = createAutomationWorkflow(300);

test("automation refuses an explicit retry outside its configured date range", async () => {
  const { directory } = await fixtureConfig();
  try {
    const config = await loadAutomationConfig(path.join(ROOT, "configs/automations.json"));
    const file = path.join(directory, "automations.json");
    await writeJson(file, { ...config, fromDate: "2026-10-08", stateDirectory: path.join(directory, "state") });
    await assert.rejects(automationCommand(["retry", "--config", file, "--date", "2026-10-07"]),
      /Cannot retry a date outside the configured automation range/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("completed quota stays completed despite unpaired inputs, including after restart", async () => {
  const rows = Array.from({ length: 300 }, (_, index) => raw(`q${index}`));
  const { directory, config } = await fixtureConfig([[...rows, raw("missing")], rows, rows, rows], true);
  try {
    config.comparisons = [["a_fast", "b_fast"], ["a_expert", "b_expert"]];
    config.rewrite = { attribution: true, comparison: true, comparisonItems: true, clustering: false };
    const plan = await automationWorkflow.plan(config);
    const saved = comparisonCodec.encode({ usage: emptyUsage(), receipts: {}, recordedAttempts: 0, manifest: {
      format: "evaluation-run", debug: false, runId: "daily-2026-09-29", status: "finished", evaluatorVersion: fakeEvaluatorVersion,
      engine: fakeIdentity, config, tasks: plan.tasks, inputCatalog: plan.catalog, inputs: {},
      states: Object.fromEntries(plan.tasks.map(task => [task.id, { status: "pending", attempts: 0 }])),
      preflight: plan.summary, startedAt: Date.now(),
    } });
    for (const task of Object.values(saved.tasks)) {
      task.status = "succeeded";
      task.receipt = { acceptedAt: Date.now(), exported: {} } as NonNullable<typeof task.receipt>;
    }
    const summary = summarize([saved]);
    assert.equal(summary.readyComparisons, 600);
    assert.equal(summary.skipped, 2);
    assert.equal(evaluationOutcome([saved], summary, DEFAULT_POLICY, 300).status, "completed");
    assert.equal(evaluationOutcome([saved], summary, DEFAULT_POLICY, 301).status, "waiting_inputs", "unfilled quotas still wait for missing pairs");
    assert.equal(evaluationOutcome([saved], { ...summary, issues: 1 }, DEFAULT_POLICY, 300).status, "waiting_inputs", "quota completion cannot hide invalid inputs");
    const rewrite = Object.values(saved.tasks).find(task => task.stage === "rewrite")!;
    rewrite.status = "failed";
    assert.equal(evaluationOutcome([saved], summarize([saved]), DEFAULT_POLICY, 300).status, "retry", "all planned rewrites must finish before completion");
    rewrite.status = "succeeded";
    const settings = await loadAutomationConfig(path.join(ROOT, "configs/automations.json"));
    const job = { date: "2026-09-29", runIds: [saved.runId], evaluation: "waiting_inputs" } as AutomationJob;
    await writeJson(path.join(directory, saved.runId, "state.json"), saved);
    await recoverEvaluation(settings, directory, job, DEFAULT_POLICY);
    assert.equal(job.evaluation, "completed");
    assert.equal(job.summary!.skipped, 2, "input gaps remain visible separately from completion");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("automation caps each tier at 300 battles and keeps reservations across input refreshes", async () => {
  const fast = Array.from({ length: 303 }, (_, index) => raw(`q${String(index).padStart(4, "0")}`));
  const expert = Array.from({ length: 305 }, (_, index) => raw(`q${String(index + 500).padStart(4, "0")}`));
  const { directory, config } = await fixtureConfig([fast, expert, fast, expert], true);
  try {
    config.comparisons = [["a_fast", "b_fast"], ["a_expert", "b_expert"]];
    config.rewrite.comparisonItems = true;
    const plan = await automationWorkflow.plan(config);
    assert.deepEqual(plan.summary.group_counts, { "a_fast+b_fast": 300, "a_expert+b_expert": 300 });
    assert.equal(plan.summary.comparison_tasks, 600);
    assert.equal(plan.summary.attribution_tasks, 1200);
    assert.equal(plan.summary.rewrite_tasks, 1800);
    assert.equal(Object.keys(plan.inputs).length, (303 + 305) * 2, "unselected inputs remain available");
    assert.equal((await buildPlan(config)).summary.comparison_tasks, 608, "manual evaluation is unrestricted");
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
    assert.deepEqual(state.manifest.preflight.group_counts, { "a_fast+b_fast": 300, "a_expert+b_expert": 300 });
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
      const reply = await submitFor(options, draftFor(options.spec, taskResult(options.spec)));
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
    assert.equal(await recoverEvaluation(settings, config.output.path, job, DEFAULT_POLICY), "interrupted", "excluded errors must not block remaining quota");
    const workflow = createAutomationWorkflow(settings.dailyComparisonLimitPerTier);
    const result = await runEvaluation({ ...base, taskSource: workflow, discoverInputs: true, plan: { tasks: [], inputs: {}, summary: {} } });
    assert.equal(result.status, "finished");
    const saved = await readRunState(run);
    assert.deepEqual(saved.manifest.pausedStages, []);
    assert.deepEqual(saved.manifest.preflight.group_counts, { "a_fast+b_fast": 3, "a_expert+b_expert": 2 });
    assert.equal(calls.has(excluded.id), false);
    for (const [id, receipt] of Object.entries(accepted.receipts)) {
      assert.deepEqual(saved.receipts[id], receipt, "completed output and receipt must remain unchanged");
      assert.equal(calls.get(id), 1);
    }
    const callsAfterReconciliation = calls.size;
    await runEvaluation({ ...base, taskSource: workflow, discoverInputs: true, plan: { tasks: [], inputs: {}, summary: {} } });
    assert.equal(calls.size, callsAfterReconciliation, "restart must not replenish quota");
    assert([...calls.values()].every((count) => count === 1));
    assert.equal((await validateRun(run)).valid, true);
  } finally { await worker.close(); await rm(directory, { recursive: true, force: true }); }
});

test("automation comparison quota is a required positive integer setting", async () => {
  const { directory } = await fixtureConfig();
  try {
    const source = path.join(ROOT, "configs/automations.json"), file = path.join(directory, "automation.json");
    const settings = await readJson<Record<string, unknown>>(source);
    assert.equal((await loadAutomationConfig(source)).dailyComparisonLimitPerTier, 300);
    for (const value of [undefined, 0, -1, 1.5, "300"]) {
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
    assert.equal(evaluation.rewrite.clustering, true);
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
    state.receipts[accepted.id] = { taskId: accepted.id,
      evaluation: attributionResult(true, "2+2=4", true, accepted.inputIds.answer) } as RunState["receipts"][string];
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

test("automation defers unfinished clustering and later classifies attributions independently of comparisons", async () => {
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
        const attribution = task.stage === "attribution" ? attributionResult(true, "2+2=4", true, task.inputIds.answer)
          : (task.data as TaskData).rewriteOf?.stage === "attribution" ? attributionResult(true, "2+2=4", true,
            plan.tasks.find(source => source.id === task.dependencies.source)!.inputIds.answer) : undefined;
        return [task.id, { taskId: task.id,
          ...(task.stage === "comparison" ? { evaluation: comparisonResult(), exported: {
            id: (task.data as TaskData).comparisonId!, row: { rewritten: { rewrites } },
          } } : task.stage === "attribution" ? { evaluation: attribution }
            : (task.data as TaskData).rewriteOf?.stage === "attribution" ? {
              evaluation: { rewrites: attributionSlots(attribution!).map(({ id, text }) => ({ id, text })) },
            } : (task.data as TaskData).rewriteOf?.stage === "comparison" ? { evaluation: { rewrites } } : {}),
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
    assert(clusters.every(cluster => Object.values(cluster.dependencies).every(id =>
      state.manifest.tasks.find(task => task.id === id)!.stage === "attribution")), "clustering has no comparative dependencies");
    for (const task of state.manifest.tasks.filter(task => task.stage === "attribution"))
      assert(clusters.some(cluster => Object.values(cluster.dependencies).includes(task.id)), "missing deferred clustering for " + task.id);
    for (const cluster of clusters)
      assert(state.manifest.tasks.some(task => (task.data as TaskData).rewriteOf?.taskId === cluster.id));
    for (const [id, receipt] of accepted) assert.equal(state.receipts[id], receipt);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("automation resumes current outputs across evaluator changes and delivers complete Mongo and statistics rows", { timeout: 60_000 }, async (t) => {
  t.after(() => {
  });
  const { directory, config, modelForStage } = await fixtureConfig();
  let controller = new AbortController();
  const interrupted = new Set<string>(), interruptedTasks = new Set<string>(), calls = new Map<string, number>();
  const date = "2026-10-08", source = path.join(directory, "source");
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
          await inspectFor(options);
          const id = options.spec.taskId, evaluationId = options.spec.evaluation.id;
          calls.set(id, (calls.get(id) ?? 0) + 1);
          const stage = evaluationId === "rewrite" ? `rewrite/${(parsedMaterial(options.spec) as { kind: string }).kind}` : evaluationId;
          if ((evaluationId === "rewrite" || evaluationId === "clustering") && !interrupted.has(stage)) {
            interrupted.add(stage); interruptedTasks.add(id);
            const stopped = new Promise<void>((resolve) => { release = resolve; });
            controller.abort();
            await stopped;
            return;
          }
          const result = evaluationId === "attribution" ? attributionResult(false, "2+2=5", true, options.spec.inputs.find(input => input.name === "answer")!.id) : taskResult(options.spec);
          const submitted = await submitFor(options, draftFor(options.spec, result));
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
        evaluatorVersion: restart ? "fixture-next" : fakeEvaluatorVersion, engine: "pi", identity: fakeIdentity,
        policy: evaluation.execution, concurrency: 1, retries: 0, retryDelaySeconds: 0,
        discoverInputs: true, workerUrls: [worker.url], signal: AbortSignal.any([controller.signal, t.signal]),
        resumeStages: previous ? automaticResumeStages(previous, DEFAULT_POLICY) : [],
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
        assert.equal(checkpointRecovery([paused], DEFAULT_POLICY), "interrupted");
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
    assert.deepEqual(new Set(Object.values(saved.receipts).map(receipt => receipt.evaluatorVersion)),
      new Set([fakeEvaluatorVersion, "fixture-next"]));
    const hostFile = path.join(directory, "host.json");
    await writeJson(hostFile, { ...await readJson(path.join(ROOT, "configs/host.json")), ...evaluation });
    const settings = { ...await loadAutomationConfig(path.join(ROOT, "configs/automations.json")),
      hostConfigs: [hostFile], sourceDirectory: source };
    settings.publication = { ...settings.publication, mongoUriEnv: "PATH" };
    const job = { date, runIds: [runId], adopted: false, download: "ready" } as AutomationJob;
    const stats = new PublicationStatistics(evaluation.comparisons);
    const delivered = await syncMongoDay(settings, job, t.signal, {
      snapshot: publicationSnapshot,
      mongo: async (_settings, batch, inputs, results) => {
        assert.equal(batch, date);
        let inputCount = 0, comparisonCount = 0;
        for await (const input of inputs) { stats.addInput(input); inputCount++; }
        for await (const result of results) {
          stats.addResult(result); comparisonCount++;
          const receipt = Object.values(saved.receipts).find(item => item.exported && item.exported.id === result.row.comparison_id && !item.exported.auxiliary)!;
          assert.deepEqual(result.row, receipt.exported!.row, "delivery preserves the full current result and its evaluator provenance");
          assert.equal(result.row.status, "decided");
        }
        return { inputs: inputCount, comparisons: comparisonCount, inserted: comparisonCount, updated: 0 };
      },
    });
    assert.equal(delivered.comparisons, counts.readyComparisons);
    assert(delivered.comparisons > 0);
    assertStatisticsLog(stats.record("current-automation-output", Date.now()));
    // A narrower, valid presentation scope stays usable after its date becomes read-only history.
    const checkpoint = comparisonCodec.encode(saved);
    (checkpoint.config as typeof config).rewrite.comparisonItems = false;
    for (const task of Object.values(checkpoint.tasks))
      if (task.data.rewriteOf?.stage === "comparison") task.data.comparisonRewriteScope = "verdicts";
    await writeJson(path.join(run, "state.json"), checkpoint);
    for (const [fromDate, expected] of [[date, 0], ["2026-10-09", delivered.comparisons]] as const) {
      const snapshot = await publicationSnapshot({ ...settings, fromDate }, job, t.signal);
      let count = 0;
      for await (const _row of snapshot.results()) count++;
      assert.equal(count, expected, "only active dates must meet the current full-rewrite requirement");
    }
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
    assert.deepEqual(automaticResumeStages(state, DEFAULT_POLICY), ["rewrite"]);
    const settings = await loadAutomationConfig(path.join(ROOT, "configs/automations.json"));
    const date = "2026-09-29", job = { date, runIds: [] } as unknown as AutomationJob;
    await writeJson(path.join(directory, `daily-${date}`, "state.json"), state);
    assert.equal(await recoverEvaluation(settings, directory, job, DEFAULT_POLICY), "interrupted");
    assert.deepEqual(job.runIds, [`daily-${date}`]);
    assert.equal(job.summary?.stages.rewrite.failed, 0);
    state.tasks.stopped.status = "failed";
    state.tasks.stopped.failure = { errors: [{ category: "transport", code: "unavailable", path: "/", message: "offline" }] } as never;
    assert.equal(checkpointRecovery([state], DEFAULT_POLICY), "transient");
    state.pausedStages![0].category = "structure";
    assert.deepEqual(automaticResumeStages(state, DEFAULT_POLICY), []);
    assert.equal(checkpointRecovery([state], DEFAULT_POLICY), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("automation stops confirmed cumulative content exhaustion and resumes only when the current cap allows it", async () => {
  const { directory, config } = await fixtureConfig();
  try {
    const date = "2026-09-29", settings = await loadAutomationConfig(path.join(ROOT, "configs/automations.json"));
    const saved = { status: "interrupted", config, preflight: { skipped: [], issues: [] }, tasks: {
      spent: { stage: "rewrite", status: "failed", dependencies: {}, data: {}, failure: {
        contentSubmissions: 3, fileErrors: 2, errors: [{ category: "transport", code: "offline", path: "/", message: "offline" }],
        repeatedErrors: 0, stopped: false, attemptId: "last-attempt",
      } },
    }, pausedStages: [{ stage: "rewrite", category: "transport", code: "offline", path: "/", taskIds: ["spent"], at: 1 }],
    } as unknown as Checkpoint;
    const file = path.join(directory, `daily-${date}`, "state.json");
    await writeJson(file, saved);
    for (const category of ["transport", "interruption"] as const) {
      saved.tasks.spent.failure!.errors[0].category = category;
      saved.pausedStages![0].category = category;
      const outcome = evaluationOutcome([saved], summarize([saved]), { repairAttempts: 2 }, 300);
      assert.equal(outcome.status, "blocked");
      assert.equal(outcome.transient, false);
      assert.match(outcome.error!, /spent.*3\/3/);
      assert.equal(checkpointRecovery([saved], { repairAttempts: 2 }), undefined);
      assert.deepEqual(automaticResumeStages(saved, { repairAttempts: 2 }), []);
    }
    const job = { date, runIds: [], evaluation: "retry", evaluationAttempts: 4, nextEvaluationAt: 100 } as unknown as AutomationJob;
    assert.equal(await recoverEvaluation(settings, directory, job, { repairAttempts: 2 }), undefined);
    assert.equal(job.evaluation, "blocked");
    assert.equal(job.evaluationAttempts, 4);
    assert.equal(job.nextEvaluationAt, 0);
    assert.match(job.evaluationError!, /spent.*3\/3/);
    assert.equal(saved.tasks.spent.failure!.contentSubmissions, 3);
    assert.equal(evaluationOutcome([saved], summarize([saved]), { repairAttempts: 3 }, 300).status, "retry");
    assert.equal(checkpointRecovery([saved], { repairAttempts: 3 }), "transient", "use the current cap even though the saved configuration allows only three");
    assert.deepEqual(automaticResumeStages(saved, { repairAttempts: 3 }), ["rewrite"]);
    assert.equal(await recoverEvaluation(settings, directory, job, { repairAttempts: 3 }), "transient");
    saved.tasks.spent.failure!.contentSubmissions = 2;
    assert.equal(checkpointRecovery([saved], { repairAttempts: 2 }), "transient", "remaining budget permits the next submission");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("automation and restart honor the current stage repair cap without refunding prior submissions", async () => {
  const { directory, config } = await fixtureConfig();
  try {
    const settings = await loadAutomationConfig(path.join(ROOT, "configs/automations.json"));
    const saved = { status: "interrupted", config, preflight: { skipped: [], issues: [] }, tasks: {
      answer: { stage: "attribution", status: "failed", dependencies: {}, data: {}, failure: {
        contentSubmissions: 1, fileErrors: 0, errors: [{ category: "transport", code: "offline", path: "/", message: "offline" }],
        repeatedErrors: 0, stopped: false, attemptId: "last-attempt",
      } },
    }, pausedStages: [{ stage: "attribution", category: "transport", code: "offline", path: "/", taskIds: ["answer"], at: 1 }],
    } as unknown as Checkpoint;
    const date = "2026-09-29", job = { date, runIds: [], evaluation: "retry", resumePaused: true } as unknown as AutomationJob;
    await writeJson(path.join(directory, `daily-${date}`, "state.json"), saved);
    const policy = { repairAttempts: 3, stageRepairAttempts: { attribution: 0 } };
    assert.equal(evaluationOutcome([saved], summarize([saved]), policy, 300).status, "blocked");
    assert.equal(checkpointRecovery([saved], policy), undefined);
    assert.deepEqual(automaticResumeStages(saved, policy), []);
    assert.equal(await recoverEvaluation(settings, directory, job, policy), undefined);
    assert.equal(job.evaluation, "blocked");
    assert.match(job.evaluationError!, /answer.*1\/1/);
    policy.stageRepairAttempts.attribution = 1;
    assert.equal(checkpointRecovery([saved], policy), "transient");
    assert.deepEqual(automaticResumeStages(saved, policy), ["attribution"]);
    assert.equal(await recoverEvaluation(settings, directory, job, policy), "transient");
    assert.equal(saved.tasks.answer.failure!.contentSubmissions, 1);
    assert.equal(checkpointRecovery([saved], { repairAttempts: 3 }), "transient", "stages without overrides use the global cap");
    saved.tasks.answer.failure!.contentSubmissions = 4;
    assert.equal(checkpointRecovery([saved], { repairAttempts: 0, stageRepairAttempts: { attribution: 4 } }), "transient",
      "a stage cap can explicitly exceed the global default");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("automation retries an unavailable final submission ledger without inventing or refunding costs", async () => {
  const { directory, config } = await fixtureConfig();
  try {
    const date = "2026-09-29", settings = await loadAutomationConfig(path.join(ROOT, "configs/automations.json"));
    const saved = { status: "interrupted", config, preflight: { skipped: [], issues: [] }, tasks: {
      unknown: { stage: "rewrite", status: "failed", data: {}, dependencies: {}, failure: {
        contentSubmissions: 1, fileErrors: 2,
        errors: [{ category: "transport", code: "submission_ledger_unavailable", path: "/", message: "final status unavailable" }],
        repeatedErrors: 0, stopped: false, attemptId: "uncertain-attempt",
      } },
    }, pausedStages: [{ stage: "rewrite", category: "transport", code: "submission_ledger_unavailable", path: "/", taskIds: ["unknown"], at: 1 }],
    } as unknown as Checkpoint;
    const file = path.join(directory, `daily-${date}`, "state.json");
    await writeJson(file, saved);
    assert.equal(checkpointRecovery([saved], { repairAttempts: 2 }), "transient");
    assert.deepEqual(automaticResumeStages(saved, { repairAttempts: 2 }), ["rewrite"]);
    const outcome = evaluationOutcome([saved], summarize([saved]), { repairAttempts: 2 }, 300);
    assert.equal(outcome.status, "retry");
    assert.equal(outcome.transient, true);
    assert.match(outcome.error!, /submission_ledger_unavailable/);
    const job = { date, runIds: [], evaluation: "blocked", evaluationAttempts: 4, nextEvaluationAt: 100 } as unknown as AutomationJob;
    assert.equal(await recoverEvaluation(settings, directory, job, { repairAttempts: 2 }), "transient");
    assert.equal(job.evaluation, "blocked");
    assert.equal(job.evaluationAttempts, 4);
    assert.equal(job.nextEvaluationAt, 100, "the pipeline retains the cooldown across restarts");
    assert.equal(saved.tasks.unknown.failure!.contentSubmissions, 1, "unknown final cost is never guessed");
    saved.tasks.unknown.status = "cancelled";
    await writeJson(file, saved);
    assert.equal(await recoverEvaluation(settings, directory, job, { repairAttempts: 2 }), "interrupted");
    saved.tasks.unknown.failure!.errors.push({ category: "structure", code: "invalid", path: "/", message: "invalid content" });
    saved.pausedStages![0].category = "structure";
    assert.equal(evaluationOutcome([saved], summarize([saved]), { repairAttempts: 2 }, 300).status, "blocked",
      "an unavailable ledger must not override a content validation pause");
    saved.tasks.unknown.failure!.contentSubmissions = 3;
    await writeJson(file, saved);
    assert.equal(await recoverEvaluation(settings, directory, job, { repairAttempts: 2 }), undefined);
    assert.equal(job.evaluation, "blocked", "automatic recovery cannot refund confirmed costs");
    assert.match(job.evaluationError!, /unknown.*3\/3/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the pipeline reopens a blocked ledger checkpoint and retries until recovery without a retry command", async () => {
  const { directory, config } = await fixtureConfig();
  try {
    const date = "2026-10-08", settings = await loadAutomationConfig(path.join(ROOT, "configs/automations.json"));
    settings.fromDate = date;
    const saved = { status: "interrupted", config, preflight: { skipped: [], issues: [] }, tasks: {
      unknown: { stage: "rewrite", status: "failed", data: {}, dependencies: {}, failure: {
        contentSubmissions: 1, fileErrors: 2,
        errors: [{ category: "transport", code: "submission_ledger_unavailable", path: "/", message: "final status unavailable" }],
        repeatedErrors: 0, stopped: false, attemptId: "uncertain-attempt",
      } },
      accepted: { stage: "rewrite", status: "succeeded", data: {}, receipt: { acceptedAt: 1 } },
    }, pausedStages: [{ stage: "rewrite", category: "transport", code: "submission_ledger_unavailable", path: "/", taskIds: ["unknown"], at: 1 }],
    } as unknown as Checkpoint;
    const file = path.join(directory, `daily-${date}`, "state.json");
    await writeJson(file, saved);
    const rows = Object.fromEntries(REMOTE_MODELS.map(model => [model, 1])) as RemoteDay["rows"];
    const job: AutomationJob = { date, runIds: [`daily-${date}`], observed: rows, downloaded: rows, adopted: false,
      download: "ready", evaluation: "blocked", checkedAt: Date.now(), evaluationAttempts: 0,
      downloadAttempts: 0, nextDownloadAt: 0, nextEvaluationAt: 0 };
    const state: AutomationState = { id: "recovery-test", sourceUrl: "http://source.invalid", status: "stopped",
      startedAt: 0, updatedAt: 0, jobs: { [date]: job } };
    const controller = new AbortController(), events: string[] = [];
    let attempts = 0;
    await runPipeline(state, { ...settings, retryMs: 1, pollMs: 10_000 }, {
      discover: async () => [{ date, rows }],
      initialize: async () => { throw new Error("existing date must be reused"); },
      sync: async () => { throw new Error("ready inputs must be reused"); },
      recover: current => recoverEvaluation(settings, directory, current, { repairAttempts: 2 }),
      evaluate: async current => {
        attempts++;
        assert.equal(current.resumePaused, undefined, "recovery does not require a manual override");
        const checkpoint = await readJson<Checkpoint>(file);
        assert.deepEqual(automaticResumeStages(checkpoint, { repairAttempts: 2 }), ["rewrite"]);
        if (attempts === 1) return evaluationOutcome([checkpoint], summarize([checkpoint]), { repairAttempts: 2 }, 300);
        return { status: "completed", summary: { ...summarize([checkpoint]), stages: {
          rewrite: { total: 2, completed: 2, failed: 0, pending: 0, running: 0, cancelled: 0, blocked: 0 },
        } } };
      },
      save: async current => { if (current.jobs[date].evaluation === "completed") controller.abort(); },
      event: async name => { events.push(name); },
    }, AbortSignal.any([controller.signal, AbortSignal.timeout(3_000)]));
    assert.equal(attempts, 2);
    assert.equal(job.evaluation, "completed");
    assert.ok(events.includes("evaluation_retry"));
    assert.equal(events.includes("evaluation_blocked"), false);
    assert.deepEqual(await readJson(file), saved, "scheduling preserves accepted receipts and confirmed submission history");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("accepted unresolved comparison is terminal for its blocked dependency closure", async () => {
  const { directory } = await fixtureConfig();
  try {
    const saved = { status: "finished", config: { inputs: { versions: REMOTE_MODELS.map(id => ({ id })) },
      rewrite: { comparison: true, comparisonItems: true } }, preflight: { skipped: [], issues: [] }, tasks: {
        review: { stage: "comparison", status: "succeeded", dependencies: {},
          receipt: { status: "succeeded", exported: { file: "comparison-review.jsonl" } },
          data: { comparisonId: "review-result", group: ["a_fast", "b_fast"] } },
        polish: { stage: "rewrite", status: "blocked", dependencies: { source: "review" },
          data: { rewriteOf: { taskId: "review", stage: "comparison" }, comparisonRewriteScope: "all" } },
        descendant: { stage: "rewrite", status: "blocked", dependencies: { source: "polish" }, data: {} },
      } } as unknown as Checkpoint;
    const settings = await loadAutomationConfig(path.join(ROOT, "configs/automations.json"));
    const date = "2026-09-29", file = path.join(directory, `daily-${date}`, "state.json");
    const recover = async (state: Checkpoint) => {
      await writeJson(file, state);
      const job = { date, runIds: [], evaluation: "retry", evaluationAttempts: 2, nextEvaluationAt: 100 } as unknown as AutomationJob;
      return { recovery: await recoverEvaluation(settings, directory, job, DEFAULT_POLICY), job };
    };
    const terminal = await recover(saved);
    assert.equal(terminal.recovery, undefined);
    assert.equal(terminal.job.evaluation, "blocked");
    assert.equal(terminal.job.evaluationAttempts, 2, "semantic review must not clear the existing retry ledger");
    assert.equal(terminal.job.nextEvaluationAt, 0);
    assert.match(terminal.job.evaluationError!, /Comparison remains unresolved.*review/);
    assert.equal(terminal.job.summary!.stages.comparison.failed, 0);
    assert.equal(terminal.job.summary!.stages.rewrite.blocked, 2);
    assert.equal(terminal.job.summary!.readyComparisons, 0);
    const outcome = (state: Checkpoint) => evaluationOutcome([state], summarize([state]), DEFAULT_POLICY, 300);
    assert.equal(outcome(saved).status, "blocked");
    assert.equal(outcome(saved).transient, false);

    const stalePause = structuredClone(saved);
    stalePause.pausedStages = [{ stage: "rewrite", category: "transport", code: "offline", path: "/",
      taskIds: ["polish"], at: 1 }];
    assert.equal(outcome(stalePause).status, "blocked", "an old pause cannot reopen only unresolved-review descendants");
    assert.equal((await recover(stalePause)).job.evaluation, "blocked");

    const mechanical = structuredClone(saved);
    mechanical.tasks.independent = { stage: "rewrite", status: "failed", dependencies: {}, data: {},
      failure: { errors: [{ category: "transport", code: "unavailable", path: "/", message: "offline" }] } } as never;
    const temporary = await recover(mechanical);
    assert.equal(temporary.recovery, "transient", "independent mechanical failures remain recoverable");
    assert.equal(temporary.job.evaluation, "retry");
    assert.equal(outcome(mechanical).status, "retry");
    assert.equal(outcome(mechanical).transient, true);
    mechanical.tasks.independent.failure!.errors[0].category = "structure";
    assert.equal(outcome(mechanical).status, "retry");
    assert.equal(outcome(mechanical).transient, false, "independent validation failures retain the ordinary bounded retry policy");
    mechanical.tasks.independent.status = "cancelled";
    delete mechanical.tasks.independent.failure;
    assert.equal((await recover(mechanical)).recovery, "interrupted");
    for (const status of ["cancelled", "pending", "running"] as const) {
      mechanical.tasks.independent.status = status;
      assert.equal(outcome(mechanical).status, "retry");
      assert.equal(outcome(mechanical).transient, true);
    }
    mechanical.tasks.independent.status = "blocked";
    assert.equal((await recover(mechanical)).job.evaluation, "retry", "unrelated blockers cannot be attributed to review");
    assert.equal(outcome(mechanical).status, "retry");

    const unfinished = structuredClone(saved);
    unfinished.tasks.review.status = "pending";
    delete unfinished.tasks.review.receipt;
    unfinished.tasks.polish.status = "pending";
    assert.equal(outcome(unfinished).status, "retry", "a comparison without an accepted decision remains runnable");

    const noChildren = structuredClone(saved);
    delete noChildren.tasks.polish; delete noChildren.tasks.descendant;
    assert.equal((await recover(noChildren)).job.evaluation, "blocked", "accepted needs_review is not a decided delivery");
    assert.equal(outcome(noChildren).status, "blocked");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("optional verification never blocks or replaces a delivered formal comparison", async () => {
  const { directory } = await fixtureConfig();
  try {
    const receipt = { status: "succeeded", acceptedAt: 100, exported: {} };
    const saved = { status: "finished", config: { inputs: { versions: REMOTE_MODELS.map(id => ({ id })) },
      rewrite: { comparison: true, comparisonItems: true } }, preflight: { skipped: [], issues: [] }, tasks: {
        comparison: { stage: "comparison", status: "succeeded", dependencies: {}, receipt,
          data: { comparisonId: "formal-result", group: ["a_fast", "b_fast"] } },
        audit: { stage: "comparison", status: "failed", dependencies: { draft: "comparison" },
          data: { verificationAudit: true, verificationOf: { taskId: "comparison" } },
          failure: { contentSubmissions: 4, errors: [{ category: "structure", code: "invalid", path: "/", message: "invalid" }] } },
        polish: { stage: "rewrite", status: "succeeded", dependencies: { source: "comparison" }, receipt,
          data: { rewriteOf: { taskId: "comparison", stage: "comparison" }, comparisonRewriteScope: "all" } },
      } } as unknown as Checkpoint;
    const settings = await loadAutomationConfig(path.join(ROOT, "configs/automations.json"));
    const date = "2026-09-29", job = { date, runIds: [], evaluation: "retry" } as unknown as AutomationJob;
    await writeJson(path.join(directory, `daily-${date}`, "state.json"), saved);
    assert.equal(await recoverEvaluation(settings, directory, job, DEFAULT_POLICY), undefined);
    assert.equal(job.evaluation, "completed");
    assert.equal(job.summary!.stages.comparison.completed, 1);
    assert.equal(job.summary!.stages.comparison.total, 1);
    assert.equal(job.summary!.readyComparisons, 1);
    for (const status of ["failed", "pending", "running", "succeeded"] as const) {
      saved.tasks.audit.status = status;
      if (status === "succeeded") saved.tasks.audit.receipt = {
        ...receipt, exported: { file: "comparison-verification.jsonl" },
      } as never;
      assert.equal(evaluationOutcome([saved], summarize([saved]), DEFAULT_POLICY, 300).status, "completed");
    }
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
    assert.equal(checkpointRecovery([saved], DEFAULT_POLICY), undefined);
    assert.deepEqual(automaticResumeStages(saved, DEFAULT_POLICY), []);
    const settings = await loadAutomationConfig(path.join(ROOT, "configs/automations.json"));
    const date = "2026-09-29", current = { date, runIds: [], evaluation: "retry", evaluationError: "cluster: invalid" } as unknown as AutomationJob;
    await writeJson(path.join(directory, `daily-${date}`, "state.json"), saved);
    await recoverEvaluation(settings, directory, current, DEFAULT_POLICY);
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
      await inspectFor(options);
      calls.set(options.spec.taskId, (calls.get(options.spec.taskId) ?? 0) + 1);
      if (options.spec.evaluation.id === "rewrite") {
        const items = (parsedMaterial(options.spec) as { items: { id: string; label: string; preference?: string }[] }).items;
        assert(items.every(item => typeof item.id === "string" && item.id.length > 0));
        requestedSlots.set(options.spec.taskId, [...(requestedSlots.get(options.spec.taskId) ?? []), items.map(item => item.id)]);
      }
      const reply = await submitFor(options, draftFor(options.spec, taskResult(options.spec)));
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
    assert.equal(await recoverEvaluation(settings, config.output.path, job, complete.execution), "interrupted");
    assert.equal(job.mongo!.synced, undefined, "backfilled text must be uploaded even when the comparison count is unchanged");
    const prepared = await readRunState(run);
    await automationWorkflow.reconcile!(run, prepared, complete);
    const supplemental = prepared.manifest.tasks.find(task => !accepted.receipts[task.id] &&
      (task.data as TaskData).rewriteOf?.taskId && accepted.receipts[(task.data as TaskData).rewriteOf!.taskId] &&
      (task.data as TaskData).rewriteOf!.stage === "comparison")!;
    assert(supplemental);
    prepared.manifest.states[supplemental.id].status = "failed";
    prepared.manifest.states[supplemental.id].failure = { contentSubmissions: 3, fileErrors: 2,
      errors: [{ category: "structure", code: "invalid", path: "/", message: "invalid" }],
      repeatedErrors: 0, stopped: false, attemptId: "spent-supplemental" };
    const preparedIds = prepared.manifest.tasks.map(task => task.id).sort();
    await automationWorkflow.reconcile!(run, prepared, complete);
    assert.deepEqual(prepared.manifest.tasks.map(task => task.id).sort(), preparedIds,
      "input discovery reuses unfinished supplemental work instead of issuing another UUID");
    assert.equal(prepared.manifest.states[supplemental.id].failure!.contentSubmissions, 3);
    assert.equal(prepared.manifest.states[supplemental.id].failure!.fileErrors, 2);
    const result = await runEvaluation({ ...base, config: complete, plan: { tasks: [], inputs: {}, summary: {} }, discoverInputs: true,
      taskSource: automationWorkflow,
    });
    assert.equal(result.status, "finished");
    const after = await readRunState(run);
    assert.deepEqual((after.manifest.config as typeof config).inputs.versions.map((v) => v.id).sort(), [...REMOTE_MODELS].sort());
    assert.equal(after.manifest.tasks.filter((task) => task.stage === "comparison" && !(task.data as { verificationAudit?: boolean }).verificationAudit).length, 2);
    assert(after.manifest.tasks.some((task) => (task.data as TaskData).group?.includes("a_expert")));
    for (const [id, receipt] of Object.entries(accepted.receipts)) {
      if ((accepted.manifest.tasks.find((task) => task.id === id)!.data as TaskData).rewriteOf?.stage === "comparison") {
        const source = (accepted.manifest.tasks.find((task) => task.id === id)!.data as TaskData).rewriteOf!.taskId;
        const supplemental = after.manifest.tasks.find(task => task.id !== id && (task.data as TaskData).rewriteOf?.taskId === source)!;
        assert(supplemental, "missing item slots are new text work with their own UUID");
        assert.equal(calls.get(id), 1);
        assert.equal(calls.get(supplemental.id), 1);
        assert.deepEqual(after.receipts[id].evaluation, receipt.evaluation);
        assert.equal(after.receipts[id].submissionId, receipt.submissionId);
        const [original] = requestedSlots.get(id)!, [missing] = requestedSlots.get(supplemental.id)!;
        assert(original.every((slot) => slot.startsWith("verdict.")));
        assert.deepEqual(new Set(missing), new Set(["assessment.A.summary", "assessment.B.summary", "tradeoff"]));
        const saved = after.receipts[source].exported!.row.rewritten as { rewrites: { id: string; text: string }[] };
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
      downloadAttempts: 0, evaluationAttempts: 3, nextDownloadAt: 0, nextEvaluationAt: 0 } } }, "pi", [remoteDateProgress("2026-09-29", [state], 300)]);
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
  const run = { config: { comparisons: [["a_fast", "b_fast"], ["a_expert", "b_expert"]] }, tasks, inputs: Object.fromEntries(Object.keys(tasks).map((id) => [id, { batch_id: date, case_id: id }])),
    preflight: { skipped: ["unpaired", "unpaired", "succeeded", "failed"].map((id) => ({ versions: group, batch_id: date, case_id: id })), issues: [] },
  } as unknown as Checkpoint;
  const progress = remoteProgress({ id: "test", sourceUrl: "http://test", status: "running", startedAt: 1, updatedAt: 2,
    jobs: { [date]: { date, runIds: ["test"], observed: { a_fast: 5, b_fast: 4, a_expert: 0, b_expert: 0 },
      adopted: false, download: "ready", evaluation: "evaluating", checkedAt: 1,
      downloadAttempts: 0, evaluationAttempts: 1, nextDownloadAt: 0, nextEvaluationAt: 0 } },
  }, "pi", [remoteDateProgress(date, [run], 300), remoteDateProgress("2026-10-08", [], 300)]);
  const fields = ["total_cases", "completed_cases", "running_cases", "queued_cases", "failed_cases", "skipped_cases"];
  // Mirror the external contract, including pair names before a date has any Host checkpoint.
  const server = await listen(async (req, res) => {
    const received = await body(req) as typeof progress;
    for (const entry of received.dates) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date) || Object.keys(entry.pairs).sort().join(",") !== "expert,fast") {
        json(res, { error: "invalid date or comparison pairs" }, 400); return;
      }
      for (const counts of Object.values(entry.pairs)) {
        if (Object.keys(counts).length !== fields.length || fields.some((key) => !Object.hasOwn(counts, key) ||
          !Number.isSafeInteger(counts[key as keyof typeof counts]) || counts[key as keyof typeof counts] < 0)) {
          json(res, { error: "invalid pair counts" }, 400); return;
        }
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
    assert.deepEqual(progress.dates[1].pairs, {
      fast: progress.dates[0].pairs.expert, expert: progress.dates[0].pairs.expert,
    }, "newly discovered dates must report both pairs with zero counts before a run exists");
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
  const progress = remoteProgress(state, "pi", [remoteDateProgress(date, [run], 2)]);
  assert.deepEqual(progress.dates[0].pairs.fast, {
    total_cases: 4, completed_cases: 3, running_cases: 0, queued_cases: 0, failed_cases: 0, skipped_cases: 1,
  });
  assert.deepEqual(progress.dates[0].pairs.expert, {
    total_cases: 2, completed_cases: 1, running_cases: 0, queued_cases: 0, failed_cases: 1, skipped_cases: 0,
  });
  assert.deepEqual(run, before, "progress projection must not mutate saved tasks or results");
});

test("local progress retains baseline pairs while the remote boundary reports only Fast and Expert", () => {
  const date = "2026-09-30", ids = ["a_fast", "b_fast", "baseline"];
  const run = { config: { comparisons: [ids] }, tasks: {
    one: { stage: "comparison", status: "succeeded", data: { group: ["a_fast", "baseline"] }, inputIds: { A: "a" } },
  }, inputs: { a: { batch_id: date, case_id: "case" } }, preflight: { skipped: [], issues: [] } } as unknown as Checkpoint;
  const state = { id: "test", status: "running", jobs: { [date]: { date, evaluation: "evaluating" } } } as unknown as Parameters<typeof remoteProgress>[0];
  const local = remoteDateProgress(date, [run], 300), before = structuredClone(local);
  assert.deepEqual(Object.keys(local.pairs).sort(), ["a_fast__vs__b_fast", "a_fast__vs__baseline", "b_fast__vs__baseline"].sort());
  assert.equal(local.pairs.a_fast__vs__baseline.completed_cases, 1);
  const progress = remoteProgress(state, "pi", [local]);
  assert.deepEqual(Object.keys(progress.dates[0].pairs).sort(), ["expert", "fast"]);
  assert.equal(progress.dates[0].pairs.fast.completed_cases, 0, "baseline battles cannot inflate the A/B pair");
  assert.deepEqual(local, before);
});

test("remote progress retains accepted pairs after selection changes and keeps review requests queued", () => {
  const date = "2026-09-30";
  const run = { config: { comparisons: [["a_fast", "baseline"]] }, tasks: {
    accepted: { stage: "comparison", status: "succeeded", data: { group: ["a_fast", "b_fast"] }, inputIds: { A: "a" }, receipt: { exported: { file: "comparison.jsonl" } } },
    review: { stage: "comparison", status: "succeeded", data: { group: ["a_fast", "baseline"] }, inputIds: { A: "a" }, receipt: { exported: { file: "comparison-review.jsonl" } } },
  }, inputs: { a: { batch_id: date, case_id: "case" } }, preflight: { skipped: [], issues: [] } } as unknown as Checkpoint;
  const state = { id: "test", status: "running", jobs: { [date]: { date, evaluation: "evaluating" } } } as unknown as Parameters<typeof remoteProgress>[0];
  const local = remoteDateProgress(date, [run], 300);
  const progress = remoteProgress(state, "pi", [local]).dates[0].pairs;
  assert.equal(progress.fast.completed_cases, 1);
  assert.equal(local.pairs.a_fast__vs__baseline.completed_cases, 0);
  assert.equal(local.pairs.a_fast__vs__baseline.queued_cases, 1);
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
