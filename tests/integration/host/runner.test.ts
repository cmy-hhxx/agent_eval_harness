import { submitFor, draftFor, invalidDraft, taskResult } from "../../fixtures/comparison.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { AgentBackend, AttemptRecord, JsonObject } from "@eval/contracts";
import { createFileLogger, exists, hasLiveRunOwner, internalPath, readJson, readJsonl, writeJsonl } from "@eval/data";
import { loadRunInputs, readRunState, writeRunState } from "@eval/workflows/comparison";
import { startWorker } from "@eval/runtime/worker";
import { body, listen } from "@eval/runtime/http";
import { runEvaluation } from "@eval/host";
import { validateRun } from "../../fixtures/services.js";
import { buildPlan } from "@eval/workflows/comparison";
import { services } from "../../fixtures/services.js";
import { reportRun } from "@eval/workflows/comparison";
import { inspectMaterials, inspectFor, fakeEvaluatorVersion, fakeIdentity, fixtureConfig, optionalVerificationTask, raw } from "../../fixtures/comparison.js";
import type { TaskData } from "@eval/workflows/comparison";

test("a failed checkpoint save during cleanup still releases the Host lock", async () => {
  const { directory, config, modelForStage } = await fixtureConfig([[raw()], [], [raw()], []]);
  try {
    const plan = await buildPlan(config), runId = "failed-save-unlocks";
    await assert.rejects(runEvaluation({ ...services, runId, output: config.output, config, engine: "pi",
      identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion, plan, policy: config.execution, modelForStage,
      concurrency: 1, retries: 0, retryDelaySeconds: 0, workerUrls: [],
      repository: { ...services.repository, async writeRun() { throw new Error("checkpoint save failed"); } },
    }), /checkpoint save failed/);
    assert.equal(await hasLiveRunOwner(path.join(config.output.path, runId)), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("repository defaults give criteria, each attribution and comparison three independent repairs and preserve accepted tasks on resume", async () => {
  const { directory, config, modelForStage } = await fixtureConfig([[raw()], [], [raw()], []]);
  const plan = await buildPlan(config), calls = new Map<string, number>();
  const backend: AgentBackend = { identity: fakeIdentity, async createSession(options) { return {
    async run() {
      calls.set(options.spec.taskId, (calls.get(options.spec.taskId) ?? 0) + 1);
      assert.equal(options.spec.policy.repairAttempts, 3, `${options.spec.evaluation.id} has its own repair budget`);
      for (let index = 0; index < 3; index++) {
        const rejected = await submitFor(options, {});
        assert.equal(rejected.isError, true);
        const feedback = JSON.parse(rejected.content[0].text!);
        assert.equal(feedback.budget.content_remaining, 3 - index);
      }
      assert.equal((await submitFor(options, draftFor(options.spec, taskResult(options.spec)))).terminate, true);
    }, async abort() {}, async dispose() {},
  }; } };
  const worker = await startWorker(backend, path.join(directory, "worker"));
  try {
    const options = { ...services, runId: "stage-repairs", output: config.output, config, engine: "pi" as const,
      identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion, plan, policy: config.execution, modelForStage,
      concurrency: 1, retries: 0, retryDelaySeconds: 0, workerUrls: [worker.url] };
    await runEvaluation(options);
    const before = await readRunState(path.join(config.output.path, options.runId));
    assert.deepEqual(new Set(plan.tasks.map(task => task.stage)), new Set(["criteria", "attribution", "comparison", "instruction-review"]));
    for (const task of plan.tasks) {
      assert.equal(before.manifest.states[task.id].status, "succeeded", task.stage);
      assert.equal(before.receipts[task.id].submissionStats?.contentSubmissions, 4);
      assert.equal(calls.get(task.id), 1);
    }
    await runEvaluation(options);
    const after = await readRunState(path.join(config.output.path, options.runId));
    for (const task of plan.tasks) {
      assert.equal(calls.get(task.id), 1, "accepted tasks must not call the model again");
      assert.equal(after.receipts[task.id].submissionId, before.receipts[task.id].submissionId);
    }
  } finally { await worker.close(); await rm(directory, { recursive: true, force: true }); }
});

test("stage content limits stop rejected attribution after its first submission even when global repairs are enabled",async()=>{
  const {directory,config,modelForStage}=await fixtureConfig([[raw()],[],[raw()],[]]);
  config.execution.repairAttempts=3;config.execution.stageRepairAttempts={attribution:0};
  const plan=await buildPlan(config),calls=new Map<string,number>();
  const backend:AgentBackend={identity:fakeIdentity,async createSession(options){return {
    async run(){
      calls.set(options.spec.taskId,(calls.get(options.spec.taskId)??0)+1);
      if(options.spec.evaluation.id==="attribution"){
        assert.equal(options.spec.policy.repairAttempts,0);
        assert.equal((await submitFor(options,invalidDraft(options.spec))).isError,true);
      }else assert.equal((await submitFor(options,draftFor(options.spec,taskResult(options.spec)))).terminate,true);
    },async abort(){},async dispose(){},
  };}};
  const worker=await startWorker(backend,path.join(directory,"worker"));
  try{
    await runEvaluation({...services,runId:"first-submission",output:config.output,config,engine:"pi",identity:fakeIdentity,evaluatorVersion:fakeEvaluatorVersion,
      plan,policy:config.execution,modelForStage,concurrency:1,retries:1,retryDelaySeconds:0,workerUrls:[worker.url]});
    const state=await readRunState(path.join(config.output.path,"first-submission"));
    for(const task of plan.tasks.filter(task=>task.stage==="attribution")){
      assert.equal(calls.get(task.id),1);assert.equal(state.manifest.states[task.id].status,"failed");
      assert.equal(state.manifest.states[task.id].failure?.contentSubmissions,1);
    }
  }finally{await worker.close();await rm(directory,{recursive:true,force:true});}
});

test("two workers execute dependency graph, archive receipts and reuse only same-run results", async () => {
  const { directory, config, modelForStage } = await fixtureConfig([[raw()], [raw()], [raw()], [raw()]]);
  config.comparisons = [
    ["a_fast", "b_fast"],
    ["a_expert", "b_expert"],
  ];
  const plan = await buildPlan(config);
  let calls = 0;
  const backend: AgentBackend = {
    identity: fakeIdentity,
    async createSession(options) {
      return {
        async run() {
          await inspectFor(options);
          calls++;
          options.onEvent({
            type: "message_end",
            message: {
              role: "assistant",
              usage: {
                input: 10,
                output: 5,
                cacheRead: 30,
                cacheWrite: 10,
                totalTokens: 55,
              },
            },
          });
          const submitted = await submitFor(options, draftFor(options.spec, taskResult(options.spec)));
          assert.equal(submitted.isError, undefined, JSON.stringify(submitted));
          assert.equal(submitted.terminate, true);
          if (options.spec.evaluation.id === "comparison") {
            const file = path.join(
              config.output.path,
              options.spec.runId,
              "results",
              "comparison.jsonl",
            );
            const rows = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
            const data = plan.tasks.find((task) => task.id === options.spec.taskId)!.data as TaskData;
            assert(rows.some((row) => row.comparison_id === data.comparisonId),
              "this result is durable before the worker receives a successful submission response");
          }
        },
        async abort() {},
        async dispose() {},
      };
    },
  };
  const workers = await Promise.all([
    startWorker(backend, path.join(directory, "w1")),
    startWorker(backend, path.join(directory, "w2")),
  ]);
  try {
    const options = {
      runId: "first",
      debug: true,
      output: config.output,
      engine: "pi" as const,
      identity: fakeIdentity,
      evaluatorVersion: fakeEvaluatorVersion,
      config,
      ...services,
      logger: createFileLogger({
        directory: path.join(directory, "log"),
        lockDirectory: path.join(directory, "locks"),
      }),
      plan,
      policy: config.execution,
      modelForStage,
      concurrency: 2,
      retries: 0,
      retryDelaySeconds: 0,
      workerUrls: workers.map((w) => w.url),
    };
    await assert.rejects(runEvaluation({ ...options, evaluatorVersion: " " }), /evaluatorVersion/);
    const summary = await runEvaluation(options);
    assert.equal(summary.completed_comparisons, 2);
    assert.equal(calls, 11);
    const businessLog = path.join(directory, "log/evaluation.log");
    const logged = (await readFile(businessLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(logged.length, 11);
    assert.equal(logged.filter((row) => row.stage === "criteria").length, 1);
    assert.equal(logged.filter((row) => row.stage === "attribution").length, 4);
    assert.equal(logged.filter((row) => row.stage === "comparison").length, 2);
    assert.equal(await readFile(path.join(directory, "log/runtime.log"), "utf8"), "");
    assert.deepEqual(summary.tokens, {
      input: 110,
      output: 55,
      cacheRead: 330,
      cacheWrite: 110,
      totalTokens: 605,
    });
    assert.deepEqual(summary.cache, {
      model_input: { hit_rate: 0.6 },
    });
    assert.deepEqual(summary.evaluator_versions, [fakeEvaluatorVersion]);
    assert.deepEqual(summary.judge_models, { criteria: ["fixture"], attribution: ["fixture"], comparison: ["fixture"], "instruction-review":["fixture"] });
    const run = path.join(config.output.path, "first");
    assert.deepEqual(await readJson(path.join(run, "stats.json")), summary);
    const checkpoint = await readJson(path.join(run, "state.json"));
    assert.equal(checkpoint.manifest, undefined);
    assert.equal(checkpoint.receipts, undefined);
    for (const task of plan.tasks) {
      const stored = (checkpoint.tasks as Record<string, { receipt: Record<string, unknown> }>)[task.id]
        .receipt;
      assert(stored.exported);
      assert.equal(stored.evaluation, undefined, "formal verdicts are referenced, not copied into state");
      assert.equal(stored.judge, "fixture");
      assert.equal(stored.evaluatorVersion, fakeEvaluatorVersion);
    }
    assert(!JSON.stringify(summary).includes("case_ids"));
    assert.equal(summary.statistical_diagnostics, undefined, "consistent pair sources produce no conflict payload");
    assert(Buffer.byteLength(JSON.stringify(summary, null, 2)) < 8000, "five-stage aggregate metrics stay compact without answer bodies");
    assert.deepEqual((await readdir(run)).sort(), [
      "_internal",
      "model-behavior.jsonl",
      "overview.json",
      "report.md",
      "results",
      "state.json",
      "stats.json",
      "task_summaries.md",
    ]);
    assert.equal(await exists(internalPath(run, "exports")), false);
    assert.equal(await exists(internalPath(run, "diagnostics", "failures.jsonl")), false);
    assert.equal(await exists(internalPath(run, "diagnostics", "attribution.jsonl")), false);
    assert.equal(
      (await readFile(path.join(run, "results", "attribution.jsonl"), "utf8")).trim().split("\n").length,
      4,
    );
    assert.deepEqual(await loadRunInputs((await readRunState(run)).manifest), plan.inputs);
    assert.equal(await exists(path.join(run, "inputs")), false);
    assert.equal(await exists(path.join(run, "preflight.json")), false);
    for (const task of plan.tasks) {
      const attempt = path.join(run, "_internal", "tasks", task.id, "attempt-001");
      assert.deepEqual((await readdir(attempt)).sort(), ["attempt.json", "events.jsonl.gz"]);
      const events = [];
      for await (const event of readJsonl(path.join(attempt, "events.jsonl.gz"))) events.push(event);
      assert.equal((events.at(-1) as { type: string }).type, "finished");
      assert.equal(await exists(path.join(attempt, "events.jsonl")), false);
    }
    assert.deepEqual(await readdir(path.join(directory, "w1")), []);
    assert.deepEqual(await readdir(path.join(directory, "w2")), []);
    assert.equal((await validateRun(run)).valid, true, "evidence reads the original source files");
    assert.match(await readFile(path.join(run, "report.md"), "utf8"), /离线校验：通过/);
    await reportRun(run, { details: true });
    assert.equal(await exists(internalPath(run, "exports", "task_summaries.jsonl")), true);
    const summaries: JsonObject[] = [];
    for await (const row of readJsonl(internalPath(run, "exports", "task_summaries.jsonl"))) summaries.push(row as JsonObject);
    assert.equal(summaries.length, 2);
    assert(summaries.every((row) => row.evaluator_version === fakeEvaluatorVersion));
    assert.equal(await exists(internalPath(run, "exports", "task_outcomes.jsonl")), true);
    const comparisonFile = path.join(run, "results", "comparison.jsonl");
    const comparisonRows: JsonObject[] = [];
    for await (const row of readJsonl(comparisonFile)) comparisonRows.push(row as JsonObject);
    await writeJsonl(comparisonFile, [
      { ...comparisonRows[0], evaluator_version: "wrong" }, ...comparisonRows.slice(1),
    ]);
    await assert.rejects(readRunState(run), /结果评测器版本与收据不一致/);
    await writeJsonl(comparisonFile, comparisonRows);
    assert.equal((await readJson(path.join(run, "stats.json"))).validation, undefined);
    assert.match(await readFile(path.join(run, "report.md"), "utf8"), /离线校验：尚未校验/);
    await runEvaluation(options);
    assert.equal(calls, 11, "same-run resume repeats none of the accepted evaluation tasks");
    assert.equal((await readFile(businessLog, "utf8")).trim().split("\n").length, 11);
    const cached = await runEvaluation({ ...options, runId: "second" });
    assert.equal(calls, 22, "a new run must evaluate independently");
    assert.equal((await readFile(businessLog, "utf8")).trim().split("\n").length, 22);
    assert.deepEqual(cached.cache, {
      model_input: { hit_rate: 0.6 },
    });
    assert.equal((cached.tokens as { totalTokens: number }).totalTokens, 605);
    assert.equal((await validateRun(path.join(config.output.path, "second"))).valid, true);
  } finally {
    await Promise.all(workers.map((w) => w.close()));
    await rm(directory, { recursive: true, force: true });
  }
});
test("different runs and batches evaluate independently", async () => {
  const days = ["2026-09-23", "2026-09-24"];
  const rows = days.map((batch_id) => ({ ...raw("q1", null), batch_id }));
  const { directory, config, modelForStage } = await fixtureConfig([rows, [], rows, []]);
  let calls = 0;
  const worker = await startWorker(
    {
      identity: fakeIdentity,
      async createSession(options) {
        return {
          async run() {
            await inspectFor(options);
            calls++;
            const result = await submitFor(options, draftFor(options.spec, taskResult(options.spec)));
            assert.equal(result.isError, undefined);
          },
          async abort() {},
          async dispose() {},
        };
      },
    },
    path.join(directory, "worker"),
  );
  try {
    const options = {
      output: config.output,
      engine: "pi" as const,
      identity: fakeIdentity,
      evaluatorVersion: fakeEvaluatorVersion,
      config,
      ...services,
      policy: config.execution,
      modelForStage,
      concurrency: 1,
      retries: 0,
      retryDelaySeconds: 0,
      workerUrls: [worker.url],
    };
    for (const [index, day] of days.entries()) {
      config.inputs.batches = [day];
      const stats = await runEvaluation({
        ...options,
        runId: day,
        plan: await buildPlan(config),
      });
      assert.equal(stats.completed_comparisons, 1);
      assert.equal(calls, (index + 1) * 6, "another batch must invoke the evaluator even for the same question");
    }
    config.inputs.batches = days;
    const combined = await runEvaluation({
      ...options,
      runId: "combined",
      plan: await buildPlan(config),
    });
    assert.equal(calls, 24);
    assert.equal(combined.completed_comparisons, 2);
    assert.deepEqual(Object.keys(combined.by_batch as object), days);
    assert.equal((await validateRun(path.join(config.output.path, "combined"))).valid, true);
  } finally {
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const missingArtifact of [false, true])
  test(`failed attempt archives diagnostics and releases only complete copies (missing artifact: ${missingArtifact})`, async () => {
    const { directory, config, modelForStage } = await fixtureConfig([[raw("q", null)], [], [raw("q", null)], []]);
    const backend: AgentBackend = {
      identity: fakeIdentity,
      async createSession(options) {
        return {
          async run() {
            await inspectFor(options);
            if (options.spec.evaluation.id === "criteria") {
              const submitted = await submitFor(options, draftFor(options.spec, taskResult(options.spec)));
              assert.equal(submitted.isError, undefined, JSON.stringify(submitted));
              return;
            }
            options.onEvent({
              type: "message_end",
              message: {
                role: "assistant",
                usage: { input: 6, output: 4, cacheRead: 9, totalTokens: 19 },
              },
            });
            await options.execute("execute_code", {
              language: "python",
              code: "print('failed attempt evidence')",
            });
            if (missingArtifact) {
              const artifacts = path.join(directory, "worker", options.spec.attemptId, "artifacts");
              await rm(path.join(artifacts, (await readdir(artifacts))[0]));
            }
            assert.equal(
              (await submitFor(options, invalidDraft(options.spec))).isError,
              true,
            );
            throw new Error("Agent ended without an accepted submission", {
              cause: new Error("Original worker failure with diagnostic detail"),
            });
          },
          async abort() {},
          async dispose() {},
        };
      },
    };
    const worker = await startWorker(backend, path.join(directory, "worker"));
    try {
      const plan = await buildPlan(config);
      const summary = await runEvaluation({
        runId: "failure",
        debug: true,
        output: config.output,
        engine: "pi",
        identity: fakeIdentity,
        evaluatorVersion: fakeEvaluatorVersion,
        config,
        ...services,
        logger: createFileLogger({
          directory: path.join(directory, "log"),
          lockDirectory: path.join(directory, "locks"),
        }),
        plan,
        policy: config.execution,
        modelForStage,
        concurrency: 1,
        retries: 0,
        retryDelaySeconds: 0,
        workerUrls: [worker.url],
      });
      assert.equal(summary.completed_comparisons, 0);
      assert.deepEqual(summary.task_statuses, { succeeded: 1, failed: 2, blocked: 1 });
      const runtimeLog = (await readFile(path.join(directory, "log/runtime.log"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const failures = runtimeLog.filter((row) => row.event === "attempt_failed");
      assert.equal(failures.length, 4, "both attempts of both tasks are retained");
      const attributionTasks = plan.tasks.filter((task) => task.stage === "attribution");
      assert.deepEqual([...new Set(failures.map((row) => row.task_id))].sort(), attributionTasks.map((task) => task.id).sort());
      assert.equal(new Set(failures.map((row) => row.attempt_id)).size, 4);
      assert(failures.every((row) => row.errors.length > 0));
      assert(failures.every((row) => row.detail.includes("Original worker failure with diagnostic detail")));
      assert(failures.every((row) => row.detail.includes("at Object.run")));
      const accepted = (await readFile(path.join(directory, "log/evaluation.log"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      assert.deepEqual(accepted.map((row) => row.stage), ["criteria"], "failed attributions must not produce accepted business results");
      assert.equal((summary.tokens as { totalTokens: number }).totalTokens, 76);
      const run = path.join(config.output.path, "failure");
      assert.equal(await exists(internalPath(run, "diagnostics", "attribution.jsonl")), false);
      assert.equal(await exists(internalPath(run, "diagnostics", "failures.jsonl")), true);
      const record = await readJson<AttemptRecord>(
        internalPath(run, "tasks", attributionTasks[0]!.id, "attempt-001/attempt.json"),
      );
      assert.equal(record.status?.state, "failed");
      assert.match(record.error!, /without an accepted submission/);
      assert.equal(record.pendingSubmission, undefined, "a Host-rejected draft is not an unacknowledged submission");
      assert(record.failure?.draft, "the rejected content remains in its recovery checkpoint");
      assert(record.metrics!.audit.artifacts.length > 0);
      if (missingArtifact) {
        assert.match(record.artifactError!, /Artifact unavailable/);
        assert.equal((await readdir(path.join(directory, "worker"))).length, 4);
      } else {
        for (const artifact of record.metrics!.audit.artifacts)
          assert.equal(
            (await readFile(internalPath(run, "tasks", attributionTasks[0]!.id, "artifacts", artifact.id)))
              .byteLength,
            artifact.bytes,
          );
        assert.deepEqual(await readdir(path.join(directory, "worker")), []);
      }
    } finally {
      await worker.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
test("one host routes tasks to both engines without sharing sessions or workspaces", async () => {
  const { directory, config, modelForStage } = await fixtureConfig();
  config.comparisons = [
    ["a_fast", "b_fast"],
    ["a_expert", "b_expert"],
  ];
  const calls = { pi: 0, prime: 0 },
    workdirs = new Set<string>();
  const primeIdentity = { ...fakeIdentity, engine: "prime" as const };
  const backend = (engine: "pi" | "prime"): AgentBackend => ({
    identity: engine === "pi" ? fakeIdentity : primeIdentity,
    async createSession(options) {
      assert.equal(options.spec.engine.engine, engine);
      assert(!workdirs.has(options.workdir));
      workdirs.add(options.workdir);
      return {
        async run() {
          await inspectFor(options);
          calls[engine]++;
          await submitFor(options, draftFor(options.spec, taskResult(options.spec)));
        },
        async abort() {},
        async dispose() {},
      };
    },
  });
  const workers = await Promise.all([
    startWorker(backend("pi"), path.join(directory, "pi")),
    startWorker(backend("prime"), path.join(directory, "prime")),
  ]);
  try {
    const summary = await runEvaluation({
      runId: "mixed",
      output: config.output,
      engine: "pi",
      identity: fakeIdentity,
      evaluatorVersion: fakeEvaluatorVersion,
      identities: { prime: primeIdentity },
      engineForTask: (task) =>
        Object.values((task.data as TaskData).candidates).some((c) => c.version.includes("expert"))
          ? "prime"
          : "pi",
      config,
      ...services,
      plan: await buildPlan(config),
      policy: config.execution,
      modelForStage,
      concurrency: 2,
      retries: 0,
      retryDelaySeconds: 0,
      workerUrls: workers.map((w) => w.url),
    });
    assert.equal(summary.completed_comparisons, 2);
    assert.deepEqual(calls, { pi: 5, prime: 6 });
    assert.equal(workdirs.size, 11);
    const run = path.join(config.output.path, "mixed");
    assert.deepEqual((await readdir(run)).sort(), [
      "model-behavior.jsonl",
      "overview.json",
      "report.md",
      "results",
      "state.json",
      "stats.json",
      "task_summaries.md",
    ]);
    assert.doesNotMatch(await readFile(path.join(run, "report.md"), "utf8"), /_internal/);
    assert.equal((await validateRun(run)).valid, true);
    await reportRun(run);
    await assert.rejects(reportRun(run, { details: true }), /--debug/);
    assert.equal(await exists(internalPath(run)), false);
  } finally {
    await Promise.all(workers.map((w) => w.close()));
    await rm(directory, { recursive: true, force: true });
  }
});
test("pausing drains an accepted task and preserves pending work for the same run", async () => {
  const { directory, config, modelForStage } = await fixtureConfig();
  const pause = new AbortController();
  let started = 0, aborted = 0;
  const backend: AgentBackend = { identity: fakeIdentity, async createSession(options) {
    return { async run() {
      started++; pause.abort();
      await inspectFor(options);
      const submitted = await submitFor(options, draftFor(options.spec, taskResult(options.spec)));
      assert.equal(submitted.isError, undefined, JSON.stringify(submitted));
    }, async abort() { aborted++; }, async dispose() {} };
  } };
  const worker = await startWorker(backend, path.join(directory, "pause-worker"));
  try {
    const options = { ...services, runId: "pause-drain", output: config.output, config, plan: await buildPlan(config),
      modelForStage, engine: "pi" as const, identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion,
      policy: config.execution, concurrency: 1, retries: 0, retryDelaySeconds: 0, workerUrls: [worker.url] };
    const result = await runEvaluation({ ...options, pauseSignal: pause.signal });
    assert.equal(result.status, "interrupted"); assert.equal(started, 1); assert.equal(aborted, 0);
    const saved = await readRunState(path.join(config.output.path, options.runId));
    assert.equal(Object.keys(saved.receipts).length, 1);
    assert(Object.values(saved.manifest.states).some(state => state.status === "pending"));
    assert(!Object.values(saved.manifest.states).some(state => state.status === "cancelled"));
  } finally { await worker.close(); await rm(directory, { recursive: true, force: true }); }
});

test("stopping concurrent attempts never trips the stage circuit and the same run resumes", async () => {
  const rows = [raw("one"), raw("two")];
  const { directory, config, modelForStage } = await fixtureConfig([rows, [], rows, []]);
  const controller = new AbortController();
  let started = 0, resume = false;
  const backend: AgentBackend = {
    identity: fakeIdentity,
    async createSession(options) {
      let release = () => {};
      return {
        async run() {
          await inspectFor(options);
          if (!resume) {
            const stopped = new Promise<void>((resolve) => { release = resolve; });
            if (++started === 2) controller.abort();
            await stopped;
          } else {
            const submitted = await submitFor(options, draftFor(options.spec, taskResult(options.spec)));
            assert.equal(submitted.isError, undefined, JSON.stringify(submitted));
          }
        },
        async abort() { release(); },
        async dispose() {},
      };
    },
  };
  const workers = await Promise.all([0, 1].map((i) => startWorker(backend, path.join(directory, "worker-" + i))));
  try {
    const options = {
      ...services, runId: "stop-concurrent", output: config.output, config, plan: await buildPlan(config),
      modelForStage, engine: "pi" as const, identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion,
      policy: config.execution, concurrency: 2, retries: 1, retryDelaySeconds: 0,
      failureGuard: { windowSize: 4, threshold: 2 }, workerUrls: workers.map((worker) => worker.url),
    };
    const stopped = await runEvaluation({ ...options, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
    assert.equal(stopped.status, "interrupted");
    assert.equal(started, 2);
    assert.deepEqual(stopped.paused_stages, [], "normal shutdown must not persist a circuit pause");
    const saved = await readRunState(path.join(config.output.path, options.runId));
    assert.deepEqual(saved.manifest.pausedStages, []);
    assert(Object.values(saved.manifest.states).every((state) => state.status === "cancelled"));
    resume = true;
    const result = await runEvaluation({ ...options, signal: AbortSignal.timeout(15_000) });
    assert.equal(result.status, "finished");
    assert.equal(result.completed_comparisons, 2);
  } finally {
    await Promise.all(workers.map((worker) => worker.close()));
    await rm(directory, { recursive: true, force: true });
  }
});

for (const stop of [false, true]) test(`Host persists its actual retry deadline and clears it on ${stop ? "stop" : "retry"}`, async () => {
  const { directory, config, modelForStage } = await fixtureConfig();
  const controller = new AbortController();
  let calls = 0, deadline = 0;
  const worker = await startWorker({ identity: fakeIdentity, async createSession(options) {
    return { async run() {
      await inspectFor(options);
      if (++calls === 1) options.onEvent({ type: "message_end", message: {
        role: "assistant", stopReason: "error", errorMessage: "Connection error.",
      } });
      else {
        const result = await submitFor(options, draftFor(options.spec, taskResult(options.spec)));
        assert.equal(result.isError, undefined, JSON.stringify(result));
      }
    }, async abort() {}, async dispose() {} };
  } }, path.join(directory, "worker"));
  try {
    await runEvaluation({ ...services, runId: "retry-deadline", output: config.output, config,
      plan: await buildPlan(config), modelForStage, engine: "pi", identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion,
      policy: config.execution, concurrency: 1, retries: 1, retryDelaySeconds: .05, workerUrls: [worker.url],
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      repository: { ...services.repository, async writeRun(run, saved) {
        await services.repository.writeRun(run, saved);
        const retry = Object.values(saved.manifest.states).find((task) => task.nextRetryAt !== undefined);
        if (retry && !deadline) {
          deadline = retry.nextRetryAt!;
          assert(deadline > Date.now() - 1000);
          if (stop) controller.abort();
        }
      } },
    });
    assert(deadline, "the scheduled task retry must be visible on disk");
    const saved = await readRunState(path.join(config.output.path, "retry-deadline"));
    assert(Object.values(saved.manifest.states).every((task) => task.nextRetryAt === undefined));
    assert.equal(saved.manifest.status, stop ? "interrupted" : "finished");
    assert.equal(calls > 1, !stop);
  } finally { await worker.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const exhausted of [false, true]) test(`completed SDK malformed arguments ${exhausted ? "stop at" : "recover within"} the loading budget in one Host attempt`, async () => {
  const { directory, config, modelForStage } = await fixtureConfig();
  const loadingBudget = 3;
  let targetId: string | undefined, targetCalls = 0;
  const worker = await startWorker({ identity: fakeIdentity, async createSession(options) {
    targetId ??= options.spec.taskId;
    return { async run() {
      await inspectFor(options);
      if (options.spec.taskId === targetId && (++targetCalls === 1 || exhausted)) {
        options.onEvent({ type: "message_end", message: { role: "assistant", stopReason: "error", rawStopReason: "completed",
          errorMessage: `Invalid OpenAI Responses tool arguments: ${options.spec.evaluation.fileSubmission ? "submit_evaluation_file" : "submit_evaluation"} (call_retry|fc_retry); expected complete JSON object` } });
        return;
      }
      const result = await submitFor(options, draftFor(options.spec, taskResult(options.spec)));
      assert.equal(result.isError, undefined, JSON.stringify(result));
    }, async abort() {}, async dispose() {} };
  } }, path.join(directory, "worker"));
  try {
    const runId = exhausted ? "malformed-arguments-exhausted" : "malformed-arguments-recovered";
    const summary = await runEvaluation({ ...services, runId, output: config.output, config,
      plan: await buildPlan(config), modelForStage, engine: "pi", identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion,
      policy: config.execution, concurrency: 1, retries: 1, retryDelaySeconds: 0, workerUrls: [worker.url] });
    const saved = await readRunState(path.join(config.output.path, runId));
    assert.equal(targetCalls, exhausted ? loadingBudget : 2, "malformed input receives one same-session correction");
    assert.equal(saved.manifest.states[targetId!].attempts, 1, "parameter feedback continues the same session without a transport attempt");
    assert.equal(saved.manifest.states[targetId!].status, exhausted ? "failed" : "succeeded");
    assert.equal(summary.completed_comparisons, exhausted ? 0 : 1);
    if (exhausted) {
      assert.equal(saved.receipts[targetId!], undefined);
      assert.equal(saved.manifest.states[targetId!].failure?.errors[0].code, "tool_arguments_invalid");
      assert.equal(saved.manifest.states[targetId!].failure?.contentSubmissions, 0);
      assert.equal(saved.manifest.states[targetId!].failure?.fileErrors, loadingBudget);
      assert.equal(saved.manifest.states[targetId!].failure?.draft, undefined, "unknown malformed JSON cannot manufacture a draft");
    } else {
      assert(saved.receipts[targetId!], "only the valid resubmission produces an accepted evaluation");
      assert.equal(saved.receipts[targetId!].submissionStats?.contentSubmissions, 1);
      assert.equal(saved.receipts[targetId!].submissionStats?.fileErrors, 1);
    }
  } finally { await worker.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const reason of ["no-submission", "idle"] as const)
  for (const written of [false, true])
    for (const scenario of ["disabled", "recovered", "exhausted"] as const)
      test(`unsubmitted ${reason} interruptions ${scenario} respect the configured retry budget (written draft: ${written})`, async () => {
        const { directory, config, modelForStage } = await fixtureConfig();
        let targetId: string | undefined, targetAttempts = 0, targetRuns = 0, retryAt: number | undefined;
        const starts: number[] = [];
        let draft: unknown;
        const worker = await startWorker({ identity: fakeIdentity, async createSession(options) {
          if (!written || options.spec.evaluation.id === "attribution") targetId ??= options.spec.taskId;
          const targeted = options.spec.taskId === targetId;
          const fail = targeted && (++targetAttempts === 1 || scenario === "exhausted");
          if (targeted) starts.push(Date.now());
          let release = () => {};
          return { async run() {
            await inspectFor(options);
            if (targeted) targetRuns++;
            if (targeted && written && options.spec.recovery) {
              assert.deepEqual(await readJson(path.join(options.workdir, "submission-rejected.json")), draft);
              assert.equal(options.spec.recovery.contentSubmissions, 0);
            }
            if (fail) {
              if (written) {
                draft = draftFor(options.spec, taskResult(options.spec));
                assert.equal((await options.execute("edit_json", { path: "evaluation-draft.json", set_json: JSON.stringify(draft) })).isError, undefined);
              }
              if (reason === "idle") await new Promise<void>((resolve) => { release = resolve; });
              return;
            }
            const result = await submitFor(options, draftFor(options.spec, taskResult(options.spec)));
            assert.equal(result.isError, undefined, JSON.stringify(result));
          }, async abort() { release(); }, async dispose() {} };
        } }, path.join(directory, "worker"));
        try {
          const runId = `${reason}-${scenario}`;
          const summary = await runEvaluation({ ...services, runId, output: config.output, config,
            plan: await buildPlan(config), modelForStage, engine: "pi", identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion,
            policy: { ...config.execution, idleTimeoutSeconds: reason === "idle" ? 1 : 10 }, concurrency: 1,
            retries: scenario === "disabled" ? 0 : 1, retryDelaySeconds: .05, workerUrls: [worker.url],
            signal: AbortSignal.timeout(20_000),
            repository: { ...services.repository, async writeRun(run, saved) {
              await services.repository.writeRun(run, saved);
              if (targetId && retryAt === undefined) retryAt = saved.manifest.states[targetId]?.nextRetryAt;
            } },
          });
          const saved = await readRunState(path.join(config.output.path, runId));
          const state = saved.manifest.states[targetId!];
          const attempts = scenario === "disabled" ? 1 : 2;
          assert.equal(targetAttempts, attempts, "the configured budget bounds fresh attempts");
          assert.equal(state.attempts, attempts);
          assert.equal(state.nextRetryAt, undefined);
          if (scenario === "disabled") assert.equal(retryAt, undefined);
          else {
            assert(retryAt, "the existing retry delay is persisted before the replacement attempt");
            assert(starts[1] >= retryAt, "replacement attempts wait until the persisted retry deadline");
          }
          assert.equal(summary.completed_comparisons, scenario === "recovered" ? 1 : 0);
          if (scenario === "recovered") {
            assert.equal(state.status, "succeeded");
            assert(saved.receipts[targetId!]);
            assert.equal(saved.receipts[targetId!].submissionStats?.contentSubmissions, 1);
          } else {
            assert.equal(state.status, reason === "idle" ? "timed_out" : "failed");
            assert.equal(state.reason, reason === "idle" ? "Model/tool idle timeout" : "Agent ended without an accepted submission");
            assert.equal(state.failure?.errors[0]?.category, "interruption");
            assert.equal(state.failure?.contentSubmissions, 0);
            assert.deepEqual(state.failure?.draft, written ? draft : undefined);
            assert.equal(saved.receipts[targetId!], undefined);
          }
          assert.equal(targetRuns, reason === "idle" ? attempts : scenario === "recovered" ? 3 : 2 * attempts,
            "only a normally stopped session receives one submission nudge");
        } finally { await worker.close(); await rm(directory, { recursive: true, force: true }); }
      });

test("a repair attempt that makes no submission retains its draft and counters for explicit resume", async () => {
  const { directory, config, modelForStage } = await fixtureConfig();
  let targetId: string | undefined, attempts = 0, resumed = false;
  let draft: unknown;
  const worker = await startWorker({ identity: fakeIdentity, async createSession(options) {
    if (options.spec.evaluation.id === "attribution") targetId ??= options.spec.taskId;
    const targeted = options.spec.taskId === targetId;
    if (targeted) attempts++;
    return { async run() {
      await inspectFor(options);
      if (targeted && !resumed) {
        if (attempts === 1 && draft === undefined) {
          draft = invalidDraft(options.spec);
          assert.equal((await submitFor(options, draft)).isError, true);
          assert.equal((await options.execute("edit_json", { path: "evaluation-draft.json", set_json: JSON.stringify(draft) })).isError, undefined);
        } else assert.deepEqual(await readJson(path.join(options.workdir, "submission-rejected.json")), draft);
        return;
      }
      if (targeted) {
        assert.equal(options.spec.policy.repairAttempts, 2, "the resumed task has three submissions left within its cumulative cap of four");
        assert.deepEqual(options.spec.recovery?.draft, draft);
        assert.equal(options.spec.recovery?.contentSubmissions, 1);
        assert.deepEqual(await readJson(path.join(options.workdir, "submission-rejected.json")), draft);
      }
      const result = await submitFor(options, draftFor(options.spec, taskResult(options.spec)));
      assert.equal(result.isError, undefined, JSON.stringify(result));
    }, async abort() {}, async dispose() {} };
  } }, path.join(directory, "worker"));
  try {
    const options = { ...services, runId: "unsubmitted-repair", output: config.output, config,
      plan: await buildPlan(config), modelForStage, engine: "pi" as const, identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion,
      policy: config.execution, concurrency: 1, retries: 2, retryDelaySeconds: 0, workerUrls: [worker.url] };
    const failed = await runEvaluation({ ...options, signal: AbortSignal.timeout(20_000) });
    assert.equal(failed.completed_comparisons, 0);
    assert.equal(attempts, 2, "a business draft uses only the content repair budget");
    const saved = await readRunState(path.join(config.output.path, options.runId));
    const state = saved.manifest.states[targetId!];
    assert.equal(state.status, "failed");
    assert.deepEqual(state.failure?.draft, draft);
    assert.equal(state.failure?.contentSubmissions, 1);
    assert.equal(state.failure?.errors[0]?.category, "interruption");
    assert(state.failure?.errors.some(({ category }) => category === "evidence" || category === "structure"));
    resumed = true;
    const complete = await runEvaluation({ ...options, signal: AbortSignal.timeout(20_000) });
    assert.equal(complete.completed_comparisons, 1);
    assert.equal(attempts, 3);
    assert.deepEqual((await readRunState(path.join(config.output.path, options.runId))).receipts[targetId!].submissionStats,
      { contentSubmissions: 2, fileErrors: 0 });
  } finally { await worker.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const interruption of ["content", "transport"] as const)
  test(`automatic ${interruption} attempts and explicit resume share the cumulative task content cap`, async () => {
    const input = raw(`shared-content-${interruption}`, null);
    const { directory, config, modelForStage } = await fixtureConfig([[input], [], [input], []]);
    config.execution.repairAttempts = 3;
    const plan = await buildPlan(config), target = plan.tasks.find((task) => task.stage === "attribution")!;
    let attempts = 0, submissions = 0, resumed = false;
    const repairBudgets: number[] = [];
    const worker = await startWorker({ identity: fakeIdentity, async createSession(options) {
      const targeted = options.spec.taskId === target.id;
      if (targeted) { attempts++; repairBudgets.push(options.spec.policy.repairAttempts); }
      return { async run() {
        await inspectFor(options);
        const draft = draftFor(options.spec, taskResult(options.spec)) as { strengths?: { importance: string }[] };
        if (!targeted || resumed) {
          if (targeted) {
            assert.equal(options.spec.recovery?.contentSubmissions, 4, "resume preserves historical submission costs");
            submissions++;
          }
          const accepted = await submitFor(options, draft);
          assert.equal(accepted.isError, undefined, JSON.stringify(accepted));
          return;
        }
        const count = Math.min(attempts === 1 ? 3 : 1, 4 - submissions);
        for (let index = 0; index < count; index++) {
          draft.strengths![0].importance = `invalid-${++submissions}`;
          const rejected = await submitFor(options, draft);
          assert.equal(rejected.isError, true, "changing the actual error does not trip the identical-error stop");
        }
        if (interruption === "transport" && attempts === 1) throw new Error("Connection error.");
      }, async abort() {}, async dispose() {} };
    } }, path.join(directory, "worker"));
    try {
      const runId = `shared-content-${interruption}`;
      const options = { ...services, runId, output: config.output, config, plan,
        modelForStage, engine: "pi" as const, identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion,
        policy: config.execution, concurrency: 1, retries: 3, retryDelaySeconds: 0, workerUrls: [worker.url] };
      const failed = await runEvaluation(options);
      assert.equal(failed.completed_comparisons, 0);
      const run = path.join(config.output.path, runId), saved = await readRunState(run);
      const failedAttempts = interruption === "content" ? 1 : 2;
      const expectedBudgets = interruption === "content" ? [3] : [3, 0];
      assert.equal(attempts, failedAttempts, "content repairs stay in-session; transport interruptions require a new attempt");
      assert.equal(submissions, 4, "the initial submission and three repairs are shared across automatic attempts");
      assert.deepEqual(repairBudgets, expectedBudgets, "every attempt receives only the remaining content budget");
      assert.equal(saved.manifest.states[target.id].failure!.contentSubmissions, 4);
      assert.equal(saved.manifest.states[target.id].failure!.repeatedErrors, 1);
      assert.equal(saved.receipts[target.id], undefined);
      resumed = true;
      const stillFailed = await runEvaluation({ ...options, plan: { tasks: [], inputs: {}, summary: {} } });
      assert.equal(stillFailed.completed_comparisons, 0);
      assert.equal(attempts, failedAttempts, "an exhausted task never creates a session on same-budget resume");
      const retained = await readRunState(run);
      assert.deepEqual(retained.manifest.states[target.id].failure, saved.manifest.states[target.id].failure,
        "resume preserves the exhausted draft, errors and cumulative count");
      config.execution.repairAttempts = 4;
      const complete = await runEvaluation({ ...options, plan: { tasks: [], inputs: {}, summary: {} } });
      assert.equal(complete.completed_comparisons, 1);
      assert.equal(attempts, failedAttempts + 1);
      assert.deepEqual(repairBudgets, [...expectedBudgets, 0], "raising the cumulative cap grants exactly one remaining submission");
      const accepted = (await readRunState(run)).receipts[target.id];
      assert.equal(accepted.submissionStats!.contentSubmissions, 5, "the cost ledger includes the previous invocation");
      assert.equal((await validateRun(run)).valid, true);
    } finally { await worker.close(); await rm(directory, { recursive: true, force: true }); }
  });

test("an unknown final submission ledger stops automatic retries and permits explicit same-run resume", async (t) => {
  const input = raw("unknown-content-ledger", null);
  const { directory, config, modelForStage } = await fixtureConfig([[input], [], [input], []]);
  config.execution.repairAttempts = 3;
  const plan = await buildPlan(config), target = plan.tasks.find((task) => task.stage === "attribution")!;
  let attempts = 0, submissions = 0, resumed = false, hideLedger = false;
  let failedAttemptId: string | undefined;
  const repairBudgets: number[] = [];
  const worker = await startWorker({ identity: fakeIdentity, async createSession(options) {
    const targeted = options.spec.taskId === target.id;
    if (targeted) { attempts++; repairBudgets.push(options.spec.policy.repairAttempts); }
    return { async run() {
      await inspectFor(options);
      const draft = draftFor(options.spec, taskResult(options.spec)) as { strengths?: { importance: string }[] };
      if (!targeted || resumed || attempts > 1) {
        if (targeted) submissions++;
        const accepted = await submitFor(options, draft);
        assert.equal(accepted.isError, undefined, JSON.stringify(accepted));
        return;
      }
      failedAttemptId = options.spec.attemptId;
      for (let index = 0; index < 3; index++) {
        draft.strengths![0].importance = `invalid-${++submissions}`;
        assert.equal((await submitFor(options, draft)).isError, true);
      }
      submissions++;
      const unacknowledged = await submitFor(options, draftFor(options.spec, taskResult(options.spec)));
      assert.equal(unacknowledged.isError, true);
      assert.match(unacknowledged.content[0]!.text!, /HTTP 503/);
      hideLedger = true;
    }, async abort() {}, async dispose() {} };
  } }, path.join(directory, "worker"));
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new URL(String(url));
    if (!resumed && init?.method === "POST" && request.pathname === "/api/submissions") {
      const submission = JSON.parse(String(init.body));
      if (submission.taskId === target.id && submission.submissionStats.contentSubmissions === 4)
        return Response.json({ error: "HTTP 503 submission connection unavailable" }, { status: 503 });
    }
    if (!resumed && hideLedger && request.origin === worker.url &&
      [ `/api/attempts/${failedAttemptId}`, `/api/attempts/${failedAttemptId}/record` ].includes(request.pathname) &&
      (!init?.method || init.method === "GET"))
      return Response.json({ error: "HTTP 503 final ledger unavailable" }, { status: 503 });
    return fetch(url, init);
  });
  try {
    const options = { ...services, runId: "unknown-content-ledger", output: config.output, config, plan,
      modelForStage, engine: "pi" as const, identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion,
      policy: config.execution, concurrency: 1, retries: 3, retryDelaySeconds: 0, workerUrls: [worker.url],
      signal: AbortSignal.timeout(20_000) };
    const failed = await runEvaluation(options);
    assert.equal(attempts, 1, "an unobservable fourth submission cannot create an automatic fifth submission");
    assert.equal(submissions, 4);
    assert.equal(failed.completed_comparisons, 0);
    const run = path.join(config.output.path, options.runId), saved = await readRunState(run);
    const state = saved.manifest.states[target.id];
    assert.equal(state.failure?.contentSubmissions, 3, "only acknowledged checkpoints are recorded as known costs");
    assert(state.failure?.errors.some((issue) => issue.code === "submission_ledger_unavailable"));
    assert.match(state.reason!, /无法确认剩余内容额度/);
    assert.equal(saved.receipts[target.id], undefined);
    resumed = true;
    const complete = await runEvaluation({ ...options, signal: AbortSignal.timeout(20_000) });
    assert.equal(complete.completed_comparisons, 1);
    assert.equal(attempts, 2);
    assert.deepEqual(repairBudgets, [3, 0], "explicit resume spends only the allowance left after acknowledged historical submissions");
  } finally { await worker.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a socket closed before worker dispatch retries the same attempt without duplicating a model session", async (t) => {
  const {directory,config,modelForStage}=await fixtureConfig([[raw()],[],[raw()],[]]);
  const plan=await buildPlan(config),target=plan.tasks.find(task=>task.stage==='criteria')!;
  let sessions=0;const attempts:string[]=[];
  const worker=await startWorker({identity:fakeIdentity,async createSession(options){sessions++;return {
    async run(){const accepted=await submitFor(options,draftFor(options.spec,taskResult(options.spec)));assert.equal(accepted.isError,undefined,JSON.stringify(accepted));},
    async abort(){},async dispose(){},
  };}},path.join(directory,'worker'));
  const fetch=globalThis.fetch;
  t.mock.method(globalThis,'fetch',async(url:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>{
    if(String(url)===`${worker.url}/api/attempts`&&init?.method==='POST'){
      attempts.push(JSON.parse(String(init.body)).attemptId);
      if(attempts.length===1)throw new TypeError('fetch failed',{cause:Object.assign(new Error('other side closed'),{code:'UND_ERR_SOCKET'})});
    }
    return fetch(url,init);
  });
  try{
    await runEvaluation({...services,runId:'dispatch-reconnect',output:config.output,config,engine:'pi',identity:fakeIdentity,
      evaluatorVersion:fakeEvaluatorVersion,plan,taskIds:[target.id],policy:config.execution,modelForStage,
      concurrency:1,retries:0,retryDelaySeconds:0,workerUrls:[worker.url]});
    const state=await readRunState(path.join(config.output.path,'dispatch-reconnect'));
    assert.equal(state.manifest.states[target.id].status,'succeeded',state.manifest.states[target.id].reason);
    assert.equal(state.manifest.states[target.id].attempts,1);assert.equal(sessions,1);
    assert.equal(attempts.length,2);assert.equal(attempts[0],attempts[1]);
  }finally{await worker.close();await rm(directory,{recursive:true,force:true});}
});

test("a rejected worker start with no registered attempt can retry without spending content", async (t) => {
  const input = raw("rejected-worker-start", null);
  const { directory, config, modelForStage } = await fixtureConfig([[input], [], [input], []]);
  const plan = await buildPlan(config), target = plan.tasks.find((task) => task.stage === "criteria")!;
  let starts = 0, sessions = 0;
  const worker = await startWorker({ identity: fakeIdentity, async createSession(options) {
    if (options.spec.taskId === target.id) sessions++;
    return { async run() {
      await inspectFor(options);
      const accepted = await submitFor(options, draftFor(options.spec, taskResult(options.spec)));
      assert.equal(accepted.isError, undefined, JSON.stringify(accepted));
    }, async abort() {}, async dispose() {} };
  } }, path.join(directory, "worker"));
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new URL(String(url));
    if (request.origin === worker.url && request.pathname === "/api/attempts" && init?.method === "POST" &&
      JSON.parse(String(init.body)).taskId === target.id && ++starts === 1)
      return Response.json({ error: "Worker busy" }, { status: 409 });
    return fetch(url, init);
  });
  try {
    const runId = "rejected-worker-start";
    const complete = await runEvaluation({ ...services, runId, output: config.output, config, plan,
      modelForStage, engine: "pi", identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion,
      policy: config.execution, concurrency: 1, retries: 1, retryDelaySeconds: 0, workerUrls: [worker.url],
      signal: AbortSignal.timeout(20_000) });
    assert.equal(starts, 2, "explicit pre-execution rejection preserves the normal transport retry");
    assert.equal(sessions, 1, "the rejected attempt never starts an agent session");
    assert.equal(complete.completed_comparisons, 1);
    const saved = await readRunState(path.join(config.output.path, runId));
    assert.equal(saved.manifest.states[target.id].attempts, 2);
    assert.equal(saved.receipts[target.id].submissionStats?.contentSubmissions, 1);
  } finally { await worker.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a task deadline without a submission does not consume the automatic retry budget", async () => {
  const { directory, config, modelForStage } = await fixtureConfig();
  let targetId: string | undefined, attempts = 0;
  const worker = await startWorker({ identity: fakeIdentity, async createSession(options) {
    targetId ??= options.spec.taskId;
    let release = () => {};
    return { async run() {
      await inspectFor(options);
      if (options.spec.taskId === targetId) {
        attempts++;
        await new Promise<void>((resolve) => { release = resolve; });
      } else {
        const result = await submitFor(options, draftFor(options.spec, taskResult(options.spec)));
        assert.equal(result.isError, undefined, JSON.stringify(result));
      }
    }, async abort() { release(); }, async dispose() {} };
  } }, path.join(directory, "worker"));
  try {
    await runEvaluation({ ...services, runId: "unsubmitted-deadline", output: config.output, config,
      plan: await buildPlan(config), modelForStage, engine: "pi", identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion,
      policy: { ...config.execution, timeoutSeconds: 1, idleTimeoutSeconds: 10 }, concurrency: 1,
      retries: 1, retryDelaySeconds: 0, workerUrls: [worker.url], signal: AbortSignal.timeout(10_000) });
    const saved = await readRunState(path.join(config.output.path, "unsubmitted-deadline"));
    assert.equal(attempts, 1);
    assert.equal(saved.manifest.states[targetId!].attempts, 1);
    assert.equal(saved.manifest.states[targetId!].status, "timed_out");
    assert.equal(saved.manifest.states[targetId!].reason, "Task deadline exceeded");
    assert.equal(saved.receipts[targetId!], undefined);
  } finally { await worker.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const debug of [false, true])
  test(`same run ID resumes with changed model, budget and build (debug: ${debug})`, async () => {
    const rows = ["2026-09-23", "2026-09-24"].map((batch_id) => ({
      ...raw("q1", null),
      batch_id,
    }));
    const { directory, config, modelForStage } = await fixtureConfig([rows, [], rows, []]);
    const controller = new AbortController();
    let resume = false;
    const calls: Record<string, number> = {};
    const backend: AgentBackend = {
      identity: fakeIdentity,
      async createSession(options) {
        const id = options.spec.taskId;
        let release: () => void = () => {};
        return {
          async run() {
            await inspectFor(options);
            calls[id] = (calls[id] || 0) + 1;
            if (Object.keys(calls).length === 2 && !resume) {
              controller.abort();
              await new Promise<void>((r) => {
                release = r;
              });
            } else {
              const submitted = await submitFor(options, draftFor(options.spec, taskResult(options.spec)));
              assert.equal(submitted.isError, undefined, JSON.stringify(submitted));
              assert.equal(submitted.terminate, true);
            }
          },
          async abort() {
            release();
          },
          async dispose() {},
        };
      },
    };
    const worker = await startWorker(backend, path.join(directory, "worker"));
    try {
      const options = {
        runId: "resume",
        debug,
        output: config.output,
        engine: "pi" as const,
        identity: fakeIdentity,
        evaluatorVersion: fakeEvaluatorVersion,
        config,
        ...services,
        plan: await buildPlan(config),
        policy: config.execution,
        modelForStage,
        concurrency: 1,
        retries: 0,
        retryDelaySeconds: 0,
        workerUrls: [worker.url],
      };
      const stopped = await runEvaluation({
        ...options,
        signal: controller.signal,
      });
      assert.equal(stopped.status, "interrupted");
      assert.equal(stopped.completed_comparisons, 0);
      const failureFile = internalPath(
        path.join(config.output.path, "resume"),
        "diagnostics",
        "failures.jsonl",
      );
      assert.equal(await exists(failureFile), false, "interrupted tasks are not exported as execution failures");
      const run = path.join(config.output.path, "resume");
      assert.match(await readFile(path.join(run, "task_summaries.md"), "utf8"), /Interrupted/);
      const saved = await readRunState(run);
      assert.ok(Object.values(saved.receipts).length > 0, "the interrupted run keeps accepted work");
      assert.deepEqual(
        [...new Set(Object.values(saved.receipts).map((receipt) => receipt.evaluatorVersion))],
        [fakeEvaluatorVersion],
      );
      await writeRunState(run, saved);
      resume = true;
      const complete = await runEvaluation({
        ...options,
        evaluatorVersion: "fixture-2",
        config: {
          ...config,
          inputs: { ...config.inputs, batches: ["2026-09-23"] },
        },
        modelForStage: (stage) => ({
          ...modelForStage(stage),
          model: "changed-model",
        }),
        policy: {
          ...config.execution,
          maxToolCalls: config.execution.maxToolCalls + 1,
        },
      });
      assert.equal(complete.completed_comparisons, 2,
        JSON.stringify((await readRunState(run)).manifest.states));
      assert.deepEqual(complete.evaluator_versions, [fakeEvaluatorVersion, "fixture-2"].sort());
      assert.deepEqual(complete.judge_models, {
        criteria: ["changed-model", "fixture"], attribution: ["changed-model"], comparison: ["changed-model"],
        "instruction-review": ["changed-model"],
      });
      assert.equal(await exists(failureFile), false, "a successful resume has no failure export");
      assert.deepEqual(Object.values(calls).sort(), [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2]);
      assert.equal((await validateRun(path.join(config.output.path, "resume"))).valid, true);
      assert.equal(await exists(internalPath(run)), debug);
      const completedState = await readRunState(run);
      assert.equal(completedState.manifest.evaluatorVersion, "fixture-2");
      assert.equal(
        [...new Set(Object.values(completedState.receipts).map((receipt) => receipt.evaluatorVersion))]
          .sort()
          .join("\u0000"),
        [fakeEvaluatorVersion, "fixture-2"].sort().join("\u0000"),
        "accepted receipts keep the version they were produced with",
      );
      for (const receipt of Object.values(completedState.receipts)) {
        assert.equal(receipt.exported?.row.evaluator_version, receipt.evaluatorVersion);
        assert.equal(receipt.judge, receipt.evaluatorVersion === fakeEvaluatorVersion ? "fixture" : "changed-model");
      }
      assert.deepEqual(
        completedState.manifest.tasks.filter(task => saved.manifest.tasks.some(original => original.id === task.id)),
        saved.manifest.tasks,
        "resume preserves tasks and blind assignments",
      );
      assert.equal(completedState.manifest.tasks.filter(task => task.stage === "instruction-review").length, 4);
      for (const version of config.inputs.versions)
        await writeJsonl(
          version.sources[0].path,
          ["a_fast", "b_fast"].includes(version.id)
            ? [...rows, { ...raw("q1", null), batch_id: "2026-09-25" }]
            : [],
        );
      const appendedPlan = await buildPlan(config);
      assert.equal(appendedPlan.tasks.length, 12);
      const unchanged = await runEvaluation({ ...options, plan: appendedPlan });
      assert.equal(unchanged.completed_comparisons, 2);
      assert.equal((unchanged.planned as { cases: number }).cases, 2);
      assert.deepEqual(Object.keys(unchanged.by_batch as object), ["2026-09-23", "2026-09-24"]);
      assert.deepEqual(Object.values(calls).sort(), [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2]);
      const validation = await validateRun(run);
      assert.equal(validation.results.valid, true);
      assert.equal(
        validation.evidence.valid,
        true,
        "appended unrelated records do not invalidate accepted evidence",
      );
    } finally {
      await worker.close();
      await rm(directory, { recursive: true, force: true });
    }
  });


for (const reportedContent of [0, undefined]) test(`a worker's ${reportedContent === undefined ? "missing" : "lower"} final ledger cannot authorize another draft after a Host-confirmed inspection`, async (t) => {
  const input = raw("inspection-final-ledger", null);
  const { directory, config, modelForStage } = await fixtureConfig([[input], [], [input], []]);
  config.execution.repairAttempts = 3;
  const plan = await buildPlan(config), target = optionalVerificationTask(plan.tasks.find(task => task.stage === "comparison")!);
  plan.tasks.push(target);
  let attempts = 0, resumed = false, targetAttempt: string | undefined;
  const worker = await startWorker({ identity: fakeIdentity, async createSession(options) {
    const targeted = options.spec.taskId === target.id;
    if (targeted) { attempts++; targetAttempt = options.spec.attemptId; }
    return { async run() {
      if (targeted && !resumed && attempts === 1) {
        for (let index = 0; index < 2; index++)
          assert.equal((await inspectMaterials(options, { checks: [], concerns: [] })).isError, true);
        await inspectFor(options);
        throw new Error("Connection error after Host acknowledged inspection.");
      }
      await inspectFor(options);
      if (targeted && resumed) assert.equal(options.spec.policy.repairAttempts, 0,
        "a confirmed inspection at count three leaves exactly one final submission within the cap of four");
      const result = await submitFor(options, draftFor(options.spec, taskResult(options.spec)));
      assert.equal(result.isError, undefined, JSON.stringify(result));
    }, async abort() {}, async dispose() {} };
  } }, path.join(directory, "worker"));
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new URL(String(url)), response = await fetch(url, init);
    if (!resumed && targetAttempt && request.origin === worker.url && response.ok &&
      [`/api/attempts/${targetAttempt}`, `/api/attempts/${targetAttempt}/record`].includes(request.pathname) &&
      (!init?.method || init.method === "GET")) {
      const value = await response.json() as { failure?: { contentSubmissions?: number }; status?: { failure?: { contentSubmissions?: number } } };
      for (const failure of [value.failure, value.status?.failure]) if (failure) {
        if (reportedContent === undefined) delete failure.contentSubmissions;
        else failure.contentSubmissions = reportedContent;
      }
      return Response.json(value);
    }
    return response;
  });
  try {
    const options = { ...services, runId: "inspection-final-ledger", output: config.output, config, plan,
      modelForStage, engine: "pi" as const, identity: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion,
      policy: config.execution, concurrency: 1, retries: 3, retryDelaySeconds: 0, workerUrls: [worker.url],
      signal: AbortSignal.timeout(20_000) };
    const failed = await runEvaluation(options), run = path.join(config.output.path, options.runId), saved = await readRunState(run);
    assert.equal(attempts, 1, "a final count below the known Host count is incomplete, so no automatic extra draft is allowed");
    assert.equal(failed.completed_comparisons, 1, "the failed optional inspection cannot withhold the accepted primary comparison");
    const state = saved.manifest.states[target.id];
    assert.equal(state.failure!.contentSubmissions, 3, "preserve only the acknowledged historical count without inventing unknown costs");
    assert(state.failure!.inspection); assert(state.failure!.errors.some(issue => issue.code === "submission_ledger_unavailable"));
    assert.equal(saved.receipts[target.id], undefined);
    resumed = true;
    const complete = await runEvaluation({ ...options, signal: AbortSignal.timeout(20_000) });
    assert.equal(complete.completed_comparisons, 1); assert.equal(attempts, 2);
    const recovered = (await readRunState(run)).receipts[target.id];
    assert.equal(recovered.submissionStats!.contentSubmissions, 4);
    assert.equal(recovered.audit.inspection!.id, state.failure!.inspection!.id, "explicit resume preserves the real inspection rather than creating a new one");
  } finally { await worker.close(); await rm(directory, { recursive: true, force: true }); }
});


test("terminal archival drains the actual worker event sequence before compressing", async () => {
  const { directory, config, modelForStage } = await fixtureConfig();
  const plan = await buildPlan(config);
  plan.tasks = plan.tasks.filter(task => task.stage === "criteria");
  let calls = 0;
  const worker = await startWorker({
    identity: fakeIdentity,
    async createSession(options) {
      return {
        async run() {
          calls++;
          for (let index = 0; index < 2200; index++) options.onEvent({ type: "text_delta", delta: "x" });
          await submitFor(options, draftFor(options.spec, taskResult(options.spec)));
        },
        async abort() {}, async dispose() {},
      };
    },
  }, path.join(directory, "worker"));
  try {
    await runEvaluation({
      runId: "event-backlog", debug: true, output: config.output, engine: "pi", identity: fakeIdentity,
      evaluatorVersion: fakeEvaluatorVersion, config, ...services, plan, policy: config.execution,
      modelForStage, concurrency: 1, retries: 0, retryDelaySeconds: 0, workerUrls: [worker.url],
      onEvent() {
        // A deterministic slow durable consumer recreates the terminal poll outrunning its sink.
        const until = performance.now() + 1; while (performance.now() < until) {}
      },
    });
    assert.equal(calls, 1);
    const task = plan.tasks[0]!;
    const attempt = path.join(config.output.path, "event-backlog", "_internal", "tasks", task.id, "attempt-001");
    const record = await readJson<AttemptRecord>(path.join(attempt, "attempt.json"));
    const events: { seq: number; type: string }[] = [];
    for await (const event of readJsonl(path.join(attempt, "events.jsonl.gz"))) events.push(event as { seq: number; type: string });
    assert.equal(events.at(-1)?.seq, record.status!.lastSeq, "terminal archive must reach its authoritative worker lastSeq");
    assert.equal(events.at(-1)?.type, "finished");
    assert.deepEqual(await readdir(path.join(directory, "worker")), [], "release requires the complete durable archive");
  } finally {
    await worker.close(); await rm(directory, { recursive: true, force: true });
  }
});


test("incomplete terminal SSE preserves the worker and reports a missing archive without reevaluating", async () => {
  const { directory, config, modelForStage } = await fixtureConfig();
  config.execution.idleTimeoutSeconds = 1;
  const plan = await buildPlan(config);
  plan.tasks = plan.tasks.filter(task => task.stage === "criteria");
  const calls = new Map<string, number>();
  const worker = await startWorker({ identity: fakeIdentity, async createSession(options) {
    return { async run() {
      calls.set(options.spec.taskId, (calls.get(options.spec.taskId) ?? 0) + 1); await submitFor(options, draftFor(options.spec, taskResult(options.spec)));
    }, async abort() {}, async dispose() {} };
  } }, path.join(directory, "worker"));
  const proxy = await listen(async (req, res, url) => {
    if (url.pathname.endsWith("/events")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (url.searchParams.get("after") !== "0") { res.end(); return; }
      const upstream = await fetch(worker.url + url.pathname + url.search);
      const reader = upstream.body!.getReader(); let first = "";
      while (!first.includes("\n\n")) {
        const next = await reader.read(); if (next.done) break;
        first += new TextDecoder().decode(next.value);
      }
      res.end(first.slice(0, first.indexOf("\n\n") + 2)); await reader.cancel(); return;
    }
    const upstream = await fetch(worker.url + url.pathname + url.search, { method: req.method,
      ...(req.method === "POST" ? { body: JSON.stringify(await body(req)), headers: { "content-type": "application/json" } } : {}) });
    res.writeHead(upstream.status, { "content-type": "application/json" }); res.end(await upstream.text());
  });
  const options = {
    runId: "incomplete-events", debug: true, output: config.output, engine: "pi" as const, identity: fakeIdentity,
    evaluatorVersion: fakeEvaluatorVersion, config, ...services, plan, policy: config.execution,
    modelForStage, concurrency: 1, retries: 0, retryDelaySeconds: 0, workerUrls: [proxy.url],
    logger: createFileLogger({ directory: path.join(directory, "log"), lockDirectory: path.join(directory, "locks") }),
  };
  try {
    await runEvaluation(options);
    const task = plan.tasks[0]!;
    const run = path.join(config.output.path, "incomplete-events");
    const attempt = path.join(run, "_internal", "tasks", task.id, "attempt-001");
    const record = await readJson<AttemptRecord>(path.join(attempt, "attempt.json"));
    assert.match(record.artifactError!, /Terminal event archive incomplete/);
    assert.equal(await exists(path.join(attempt, "events.jsonl")), true);
    assert.equal(await exists(path.join(attempt, "events.jsonl.gz")), false, "a known prefix must never become a compressed terminal archive");
    const state = await readRunState(run);
    assert.equal(state.manifest.states[task.id]!.status, "succeeded", "accepted evaluation survives a missing debug archive");
    assert.equal(state.manifest.states[task.id]!.artifactStatus?.status, "missing");
    assert.deepEqual(await readdir(path.join(directory, "worker")), [record.spec.attemptId]);
    assert.match(await readFile(path.join(directory, "log/runtime.log"), "utf8"), /event_archive_incomplete/);
    await runEvaluation(options); assert.equal(calls.get(task.id), 1, "resume may add pending workflow tasks but must not reevaluate the committed task to repair debug output");
  } finally {
    await proxy.close(); await worker.close(); await rm(directory, { recursive: true, force: true });
  }
});
