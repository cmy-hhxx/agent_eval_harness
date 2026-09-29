import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readFile, rm } from "node:fs/promises";
import { emptyUsage, type AgentBackend, type ModelConfig, type RunState, type TaskPlan } from "@eval/contracts";
import { fileSourceReader, readJson, writeJsonl } from "@eval/data";
import { buildPlan, comparisonWorkflow } from "@eval/workflows/comparison";
import { createResultWriter } from "@eval/workflows/comparison";
import { services } from "../../fixtures/services.js";
import { readRunState, reconcileRun, writeRunState } from "@eval/workflows/comparison";
import { evidenceId, evidenceSources, cite, resolveEvidence } from "@eval/tools";
import type { EvalConfig, RawInput, TaskData } from "@eval/workflows/comparison";
import { runEvaluation } from "@eval/host";
import { validateRun } from "../../fixtures/services.js";
import { startWorker } from "@eval/runtime/worker";
import {
  attributionResult,
  draftFor,
  emptyAudit,
  fakeEvaluatorVersion,
  fakeIdentity,
  fakeJudge,
  comparisonResult,
  fixtureConfig,
  raw,
  taskResult,
} from "../../fixtures/comparison.js";

function stateFor(config: EvalConfig, plan: TaskPlan): RunState {
  return {
    manifest: {
      format: "evaluation-run",
      debug: false,
      runId: "test",
      status: "finished",
      engine: fakeIdentity,
      evaluatorVersion: fakeEvaluatorVersion,
      config,
      tasks: plan.tasks,
      inputCatalog: plan.catalog,
      inputs: Object.fromEntries(Object.keys(plan.inputs).map((id) => [id, { id, name: id }])),
      states: Object.fromEntries(plan.tasks.map((task) => [task.id, { status: "succeeded", attempts: 1 }])),
      preflight: plan.summary,
      startedAt: 1,
    },
    receipts: Object.fromEntries(
      plan.tasks.map((task) => [
        task.id,
        {
          taskId: task.id,
          attemptId: "old",
          submissionId: task.id,
          status: "succeeded",
          evaluatorVersion: fakeEvaluatorVersion,
          judge: fakeJudge,
          acceptedAt: 2,
          evaluation: task.stage === "attribution" ? attributionResult() : comparisonResult(),
          audit: emptyAudit(),
          usage: emptyUsage(),
        },
      ]),
    ),
    usage: { ...emptyUsage(), totalTokens: 123 },
    recordedAttempts: plan.tasks.length,
  };
}
function optionsFor(
  config: EvalConfig,
  modelForStage: (stage: string) => ModelConfig,
  plan: TaskPlan,
  workerUrls: string[],
) {
  return {
    runId: "test",
    config,
    plan,
    output: config.output,
    ...services,
    engine: "pi" as const,
    identity: fakeIdentity,
    evaluatorVersion: fakeEvaluatorVersion,
    policy: config.execution,
    concurrency: 1,
    retries: 0,
    retryDelaySeconds: 0,
    workerUrls,
    modelForStage,
  };
}
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error("Condition did not settle");
}

test("attribution reads identity while comparison worker sees only its blind prompt and trace", async () => {
  const first = raw("q", "4 来自 secret-model");
  first.messages[0]!.content = "计算2+2；请核查 a_fast 和 aa_fast 的结果";
  first.messages[1]!.model = "secret-model";
  first.meta!.usage = { type: "secret-model" };
  first.meta!.first_token_time_cost = "secret-model";
  const second = raw("q", "4 来自 secret-model");
  second.messages[0]!.content = first.messages[0]!.content;
  second.messages[1]!.model = "other-model";
  const { directory, config, modelForStage } = await fixtureConfig([[first], [], [second], []]);
  const stages: string[] = [];
  const worker = await startWorker({
    identity: fakeIdentity,
    async createSession(options) {
      return {
        async run() {
          const stage = options.spec.evaluation.id;
          stages.push(stage);
          const input = await readJson<RawInput>(path.join(options.workdir, `inputs/${options.spec.inputs[0]!.name}.json`));
          if (stage === "attribution") {
            assert.match(options.spec.prompt, /version_id/);
            assert.equal(options.spec.inputs[0]!.name, "answer");
            assert.equal(input.messages[1]!.model, options.spec.prompt.includes('"version_id":"a_fast"') ? "secret-model" : "other-model");
            const result = taskResult(options.spec) as { summary: string };
            result.summary = "a_fast 或 aa_fast 的有效计算";
            await options.execute("submit_evaluation", draftFor(options.spec, result));
          } else {
            assert.equal(stage, "comparison");
            assert.equal(options.spec.inputs.length, 2);
            const unbound = await fetch(`${options.spec.hostUrl}/api/inputs/${options.spec.inputs[0]!.id}`);
            assert.equal(unbound.status, 404, "the worker cannot bypass its bound blind view");
            assert.equal(input.meta, undefined);
            assert.equal(input.messages[1]!.model, undefined);
            for (const identity of ["a_fast", "aa_fast", "secret-model", "other-model", "A组Fast", "AA组Fast"]) {
              assert(!options.spec.prompt.includes(identity), `prompt leaks ${identity}`);
              assert(!JSON.stringify(input).includes(identity), `trace leaks ${identity}`);
            }
            await options.execute("submit_evaluation", draftFor(options.spec, taskResult(options.spec)));
          }
        },
        async abort() {},
        async dispose() {},
      };
    },
  }, path.join(directory, "worker"));
  try {
    const result = await runEvaluation(optionsFor(config, modelForStage, await buildPlan(config), [worker.url]));
    const saved = await readRunState(path.join(config.output.path, "test"));
    assert.equal(result.completed_comparisons, 1, JSON.stringify(saved.manifest.states));
    const comparison = saved.manifest.tasks.find((task) => task.stage === "comparison")!;
    const row = saved.receipts[comparison.id]!.exported!.row as {
      ground_truth: { value: string };
      evaluations: Record<string, { summary: string }>;
    };
    assert.equal(row.ground_truth.value, "4 来自 secret-model", "formal results keep the original reference");
    assert(row.evaluations.a_fast!.summary.includes("a_fast"), "attribution receipts are not blinded on export");
    assert.deepEqual(stages.sort(), ["attribution", "attribution", "comparison"]);
  } finally {
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("preflight keeps unknown-batch errors under a selection and aggregates independent field errors", async () => {
  const missing = raw("missing", null);
  delete missing.batch_id;
  const invalid = {
    ...raw("invalid", null),
    request_time: "",
    has_standard_answer: "false",
  } as unknown as RawInput;
  const { directory, config } = await fixtureConfig([[missing, invalid], [], [raw("valid", null)], []]);
  try {
    config.inputs.batches = ["b1"];
    const plan = await buildPlan(config);
    const issues = plan.summary.issues as {
      case_id: string;
      errors: { code: string }[];
    }[];
    assert(issues.some((issue) => issue.case_id === "missing"));
    assert.deepEqual(
      issues.find((issue) => issue.case_id === "invalid")?.errors.map((e) => e.code),
      ["request_time_invalid", "standard_answer_flag_invalid"],
    );
    for (const request_time of [undefined, null, " 2026-09-24  "]) {
      await writeJsonl(config.inputs.versions[0].sources[0].path, [{ ...raw("valid", null), request_time }]);
      assert.deepEqual((await buildPlan(config)).summary.issues, []);
    }
    for (const request_time of ["", "  ", 12, false, {}]) {
      await writeJsonl(config.inputs.versions[0].sources[0].path, [{ ...raw("valid", null), request_time }]);
      assert.equal(((await buildPlan(config)).summary.issues as unknown[]).length, 1);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("accepted work survives narrower selection, changed or missing inputs; new groups are added", async () => {
  const rows = ["b1", "b2"].map((batch_id) => ({
    ...raw("q", null),
    batch_id,
  }));
  const { directory, config } = await fixtureConfig([rows, [raw("q", null)], rows, []]);
  try {
    const plan = await buildPlan(config),
      state = stateFor(config, plan),
      run = path.join(directory, "run");
    await createResultWriter(run, plan.inputs)(state);
    await writeRunState(run, state);
    const restored = await readRunState(run),
      narrowed = structuredClone(config);
    narrowed.inputs.batches = ["b1"];
    for (const version of narrowed.inputs.versions) {
      const content = await readFile(version.sources[0].path, "utf8");
      version.sources[0].path += ".moved";
      await writeJsonl(
        version.sources[0].path,
        content.trim()
          ? content
              .trim()
              .split("\n")
              .map((s) => JSON.parse(s))
          : [],
      );
    }
    const moved = await reconcileRun(run, restored, narrowed);
    assert.deepEqual(
      moved.tasks.map((t) => t.id),
      plan.tasks.map((t) => t.id),
    );
    assert.equal(Object.keys(restored.receipts).length, 6);
    const changed = { ...rows[0], request_time: "2026-09-24" };
    await writeJsonl(narrowed.inputs.versions[0].sources[0].path, [changed, rows[1]]);
    await writeJsonl(narrowed.inputs.versions[3].sources[0].path, [raw("q", null)]);
    const replacement = await reconcileRun(run, restored, narrowed);
    assert.equal(replacement.tasks.length, 6);
    assert.equal(Object.keys(restored.receipts).length, 6);
    const affected = replacement.tasks.find(
      (t) =>
        t.id ===
        plan.tasks.find(
          (t) => t.stage === "comparison" && (t.data as TaskData).candidates.A.batch_id === "b1",
        )!.id,
    )!;
    assert.equal((affected.data as TaskData).revision, 1);
    assert.equal(
      (affected.data as TaskData).comparisonId,
      (plan.tasks.find((t) => t.id === affected.id)!.data as TaskData).comparisonId,
    );
    assert.equal(restored.manifest.states[affected.id].attempts, 1);
    assert.equal(restored.usage.totalTokens, 123);
    await writeRunState(run, restored); // crash after state replacement, before result rebuilding
    const recovered = await readRunState(run);
    assert.equal(Object.keys(recovered.receipts).length, 6);
    await writeJsonl(narrowed.inputs.versions[0].sources[0].path, [{ ...changed, request_time: "" }, rows[1]]);
    const invalid = await reconcileRun(run, recovered, narrowed);
    assert.deepEqual(
      invalid.tasks.filter((t) => recovered.receipts[t.id]).map((t) => t.inputIds),
      replacement.tasks.filter((t) => recovered.receipts[t.id]).map((t) => t.inputIds),
    );
    assert((invalid.summary.issues as unknown[]).length);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("planned input bodies are read by record only when a task accesses them", async (t) => {
  const { directory, config } = await fixtureConfig([[raw()], [], [raw()], []]);
  const reads = t.mock.method(fileSourceReader, "record");
  try {
    const plan = await buildPlan(config);
    assert.equal(reads.mock.callCount(), 0);
    const id = Object.keys(plan.inputs)[0];
    assert.deepEqual(plan.inputs[id], raw());
    assert.equal(reads.mock.callCount(), 1, "the planner must retain coordinates, not every original answer");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("each answer retains its own full system and developer constraints beyond the context budget", async () => {
  const rows = ["不能把风险放在第一位", "必须把风险放在第一位"].map((rule) => ({
    ...raw(), messages: [
      { type: "message", role: "system", content: "背景。".repeat(9000) + rule },
      { type: "message", role: "developer", content: "按自己的系统要求组织回答" },
      ...raw().messages,
    ],
  }));
  const { directory, config } = await fixtureConfig([[rows[0]], [], [rows[1]], []]);
  config.execution.initialContextChars = 1;
  try {
    const plan = await buildPlan(config);
    for (const task of plan.tasks) {
      const bound = comparisonWorkflow.bind(task, plan.inputs, {});
      const input = bound.request.input as { answer?: { initial_material: { message_index: number; value: unknown }[] }; candidates?: Record<string, { initial_material: { message_index: number; value: unknown }[] }> };
      const materials = input.answer ? { answer: input.answer } : input.candidates!;
      for (const [label, material] of Object.entries(materials)) {
        const source = plan.inputs[task.inputIds[label]] as RawInput;
        const constraints = material.initial_material.filter((m) => m.message_index < 2);
        assert.equal(constraints.length, 2);
        assert.deepEqual(constraints.map((m) => m.value), source.messages.slice(0, 2));
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("oversized final-answer blocks are deferred without duplicating their payload in evidence", async () => {
  const chart = JSON.stringify({ data: [{ y: { dtype: "f8", bdata: "A".repeat(1400000) } }], layout: { title: "业绩比较" } });
  const row = raw();
  row.messages[1].content = [
    { type: "output_text", text: "比较结论：甲优于乙。" },
    { type: "output_text", text: chart },
    { type: "output_text", text: "图表之后的风险说明。" },
  ];
  const { directory, config } = await fixtureConfig([[row], [], [row], []]);
  try {
    const plan = await buildPlan(config);
    for (const task of plan.tasks) {
      const bound = comparisonWorkflow.bind(task, plan.inputs, {});
      const input = bound.request.input as any;
      services.agents.prepare(bound);
      for (const [label, material] of Object.entries(input.answer ? { answer: input.answer } : input.candidates) as [string, any][]) {
        assert(material.final_answer.includes("比较结论"));
        assert(material.final_answer.includes("图表之后的风险说明"));
        assert(JSON.stringify(material).length < 50000, "large encoded chart data must not overwhelm the model context");
        assert.deepEqual(material.deferred_final_material, [{
          message_index: 1, path: "/content/1/text", total_chars: chart.length,
        }]);
        const source = bound.request.sources[label].value as RawInput;
        assert.equal((source.messages[1].content as any[])[1].text, chart);
        for (const evidence of material.final_evidence)
          assert.equal(resolveEvidence(source, evidence, label, [], "/evidence").quote, evidence.quote);
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("planning a shared reference change increments dependent task revisions while preserving IDs", async () => {
  const { directory, config } = await fixtureConfig([
    [raw()],
    [raw("q1", null)],
    [raw("q1", null)],
    [raw("q1", null)],
  ]);
  try {
    const first = await buildPlan(config);
    await writeJsonl(config.inputs.versions[0].sources[0].path, [raw("q1", "updated")]);
    const next = await buildPlan(config, first);
    assert.equal(next.tasks.length, 3);
    assert.deepEqual(
      next.tasks.map((t) => t.id),
      first.tasks.map((t) => t.id),
    );
    assert(next.tasks.every((t) => (t.data as TaskData).revision === 2));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("resume skips accepted cases after edits and evaluates only unfinished and newly added cases", async () => {
  const rows = [raw("done", null), raw("todo", null)];
  const { directory, config, modelForStage } = await fixtureConfig([rows, [], rows, []]);
  const calls: string[] = [];
  let resumed = false;
  const worker = await startWorker(
    {
      identity: fakeIdentity,
      async createSession(options) {
        return {
          async run() {
            const input = await readJson<RawInput>(path.join(options.workdir, `inputs/${options.spec.inputs[0]!.name}.json`));
            calls.push(input.case_id!);
            if (input.case_id === "todo" && !resumed) throw new Error("stop before submission");
            await options.execute("submit_evaluation", draftFor(options.spec, taskResult(options.spec)));
          },
          async abort() {},
          async dispose() {},
        };
      },
    },
    path.join(directory, "worker"),
  );
  try {
    const options = optionsFor(config, modelForStage, await buildPlan(config), [worker.url]);
    assert.equal((await runEvaluation(options)).completed_comparisons, 1);
    const run = path.join(config.output.path, "test"),
      before = await readRunState(run);
    const accepted = before.manifest.tasks.find((t) => before.receipts[t.id])!;
    const original = before.receipts[accepted.id];
    const changed = [
      { ...raw("todo", null), request_time: "new-time" },
      raw("new", null),
      raw("done", "4", "changed completed answer"),
    ];
    for (const version of config.inputs.versions.filter((v) => ["a_fast", "aa_fast"].includes(v.id)))
      await writeJsonl(version.sources[0].path, changed);
    resumed = true;
    assert.equal((await runEvaluation(options)).completed_comparisons, 3);
    assert.equal(calls.filter((c) => c === "done").length, 2, "accepted attribution work is not re-evaluated");
    const after = await readRunState(run);
    assert.deepEqual(after.receipts[accepted.id], original);
    assert.deepEqual(
      after.manifest.tasks.find((t) => t.id === accepted.id),
      accepted,
    );
    assert.equal((await validateRun(run)).results.valid, true);
    for (const version of config.inputs.versions) await rm(version.sources[0].path);
    assert.equal((await runEvaluation(options)).completed_comparisons, 3);
    assert.equal(calls.filter((c) => c === "done").length, 2, "accepted attribution work does not require a second model call or an input backup");
  } finally {
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("skip-failed resume streams healthy comparisons and rewrites before the attribution backlog drains", async () => {
  const rows = ["failed", "first", "last"].map((id) => raw(id, null));
  const { directory, config, modelForStage } = await fixtureConfig([rows, [], rows, []], true);
  config.rewrite.attribution = false;
  const plan = await buildPlan(config);
  const saved = stateFor(config, plan);
  saved.receipts = {};
  for (const state of Object.values(saved.manifest.states)) state.status = "pending";
  const failed = plan.tasks.find((task) => task.stage === "attribution" &&
    Object.values((task.data as TaskData).candidates).some((candidate) => candidate.case_id === "failed"))!;
  saved.manifest.states[failed.id] = { status: "failed", attempts: 3, revision: 1, reason: "leave this failure alone" };
  const run = path.join(config.output.path, "test");
  await writeRunState(run, saved);
  const started: { id: string; stage: string }[] = [];
  const worker = await startWorker({
    identity: fakeIdentity,
    async createSession(options) {
      return {
        async run() {
          started.push({ id: options.spec.taskId, stage: options.spec.evaluation.id });
          await options.execute("submit_evaluation", draftFor(options.spec, taskResult(options.spec)));
        },
        async abort() {},
        async dispose() {},
      };
    },
  }, path.join(directory, "worker"));
  try {
    const result = await runEvaluation({ ...optionsFor(config, modelForStage, plan, [worker.url]), skipFailed: true });
    assert.equal(result.completed_comparisons, 2);
    assert(!started.some((task) => task.id === failed.id));
    const after = await readRunState(run);
    assert.deepEqual(after.manifest.states[failed.id], saved.manifest.states[failed.id]);
    assert(started.findIndex((task) => task.stage === "comparison") < started.findLastIndex((task) => task.stage === "attribution"));
    assert(started.findIndex((task) => task.stage === "rewrite") < started.findLastIndex((task) => task.stage === "comparison"));
    assert.equal(after.manifest.tasks.filter((task) => task.stage === "rewrite" && after.receipts[task.id]).length, 2);
  } finally {
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const busyProbe of [1, 2]) test(`external worker recovers from busy health probe ${busyProbe} without failing work`, async (t) => {
  const { directory, config, modelForStage } = await fixtureConfig();
  const started: string[] = [];
  const worker = await startWorker({
    identity: fakeIdentity,
    async createSession(options) {
      return {
        async run() {
          started.push(options.spec.taskId);
          await options.execute("submit_evaluation", draftFor(options.spec, taskResult(options.spec)));
        },
        async abort() {}, async dispose() {},
      };
    },
  }, path.join(directory, "worker"));
  const fetch = globalThis.fetch;
  let probes = 0;
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const response = await fetch(input, init);
    if (String(input) === worker.url + "/api/health" && ++probes === busyProbe)
      return new Response(JSON.stringify({ ...await response.json(), activeAttempt: "still-cleaning-up" }), { status: 200 });
    return response;
  });
  try {
    const plan = await buildPlan(config);
    await runEvaluation({ ...optionsFor(config, modelForStage, plan, [worker.url]), signal: AbortSignal.timeout(10000) });
    const after = await readRunState(path.join(config.output.path, "test"));
    assert.equal(started.length, plan.tasks.length);
    assert.equal(new Set(started).size, started.length);
    assert(Object.values(after.manifest.states).every(state => state.status === "succeeded" && state.attempts === 1));
  } finally {
    t.mock.restoreAll();
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an interrupted model stream receives one bounded transport retry", async () => {
  const { directory, config, modelForStage } = await fixtureConfig();
  let interrupted = false;
  const worker = await startWorker({
    identity: fakeIdentity,
    async createSession(options) {
      return {
        async run() {
          if (!interrupted) { interrupted = true; throw new Error("Stream ended without finish_reason"); }
          await options.execute("submit_evaluation", draftFor(options.spec, taskResult(options.spec)));
        },
        async abort() {}, async dispose() {},
      };
    },
  }, path.join(directory, "worker"));
  try {
    const plan = await buildPlan(config);
    await runEvaluation({ ...optionsFor(config, modelForStage, plan, [worker.url]), retries: 1 });
    const after = await readRunState(path.join(config.output.path, "test"));
    assert(Object.values(after.manifest.states).every(state => state.status === "succeeded"));
    assert.equal(Object.values(after.manifest.states).reduce((n, state) => n + state.attempts, 0), plan.tasks.length + 1);
  } finally { await worker.close(); await rm(directory, { recursive: true, force: true }); }
});

test("failed dependencies are checkpointed as one batch", async () => {
  const rows = Array.from({ length: 12 }, (_, i) => raw(String(i), null));
  const { directory, config, modelForStage } = await fixtureConfig([rows, [], rows, []]);
  const plan = await buildPlan(config), saved = stateFor(config, plan);
  saved.receipts = {};
  for (const task of plan.tasks) saved.manifest.states[task.id].status = task.stage === "attribution" ? "failed" : "pending";
  await writeRunState(path.join(config.output.path, "test"), saved);
  let writes = 0;
  const worker = await startWorker({ identity: fakeIdentity, async createSession() { throw new Error("no healthy task should dispatch"); } }, path.join(directory, "worker"));
  try {
    await runEvaluation({ ...optionsFor(config, modelForStage, plan, [worker.url]), skipFailed: true,
      repository: { ...services.repository, async writeRun(...args) { writes++; return services.repository.writeRun(...args); } },
    });
    const after = await readRunState(path.join(config.output.path, "test"));
    assert.equal(Object.values(after.manifest.states).filter(state => state.status === "blocked").length, 12);
    assert(writes <= 3, `dependency handling saved the whole run ${writes} times`);
  } finally { await worker.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a dependency waiting for its transport retry does not permanently block downstream work", async () => {
  const { directory, config, modelForStage } = await fixtureConfig([[raw("q", null)], [], [raw("q", null)], []], true);
  const plan = await buildPlan(config), first = plan.tasks.find(task => task.stage === "attribution")!.id;
  let release!: () => void, failed = false;
  const failureSaved = new Promise<void>(resolve => { release = resolve; });
  const backend: AgentBackend = { identity: fakeIdentity, async createSession(options) {
    return { async run() {
      if (options.spec.taskId === first && !failed) { failed = true; throw new Error("Stream ended without finish_reason"); }
      if (plan.tasks.find(task => task.id === options.spec.taskId)?.stage === "attribution" && options.spec.taskId !== first) await failureSaved;
      await options.execute("submit_evaluation", draftFor(options.spec, taskResult(options.spec)));
    }, async abort() {}, async dispose() {} };
  } };
  const workers = await Promise.all([0, 1].map(index => startWorker(backend, path.join(directory, 'worker-' + index))));
  try {
    await runEvaluation({ ...optionsFor(config, modelForStage, plan, workers.map(worker => worker.url)),
      concurrency: 2, retries: 1, retryDelaySeconds: 1,
      repository: { ...services.repository, async writeRun(...args) {
        await services.repository.writeRun(...args);
        if (args[1].manifest.states[first]?.status === "failed") release();
      } },
    });
    const after = await readRunState(path.join(config.output.path, "test"));
    assert(Object.values(after.manifest.states).every(state => state.status === "succeeded"));
  } finally { await Promise.all(workers.map(worker => worker.close())); await rm(directory, { recursive: true, force: true }); }
});

test("raw strings, Markdown and JSON pages resolve exactly; unknown sources and indexes fail", () => {
  const input = {
    messages: [
      {
        role: "tool",
        content: '**收益**\n"中文"\\path',
        data: { value: 0.9957, count: 12 },
      },
    ],
  };
  for (const source of evidenceSources(input.messages[0])) {
    for (let start = 0; start < source.text.length; start += 7) {
      const evidence = cite(0, source, start, Math.min(start + 7, source.text.length));
      assert.equal(
        resolveEvidence(input, evidence, "A", [], "/evidence").quote,
        source.text.slice(start, start + 7),
      );
    }
  }
  assert.equal(evidenceId(10, "text", "/content/0/text", 0, 2410), "ev_10_text_0_2410_/content/0/text");
  assert.equal(evidenceId(6, "image"), "ev_6_image");
  assert.throws(
    () => resolveEvidence(input, { evidence_id: "ev_not-a-coordinate" }, "A", [], "/evidence"),
    /无法解析/,
  );
  assert.throws(
    () => resolveEvidence(input, { evidence_id: evidenceId(1, "json", "", 0, 2) }, "A", [], "/evidence"),
    /索引/,
  );
  assert.throws(
    () => resolveEvidence(input, { evidence_id: evidenceId(0, "text", "/data/value", 0, 6) }, "A", [], "/evidence"),
    /原文位置/,
  );
  const hint = (evidence: { evidence_id: string }) => {
    try {
      resolveEvidence(input, evidence, "A", [], "/evidence");
    } catch (error) {
      return (error as { issues?: { message: string }[] }).issues![0]!.message;
    }
    throw new Error("expected evidence rejection");
  };
  assert.match(hint({ evidence_id: "ev_0_text_0_1_3_/role" }), /证据原文位置无效/);
  assert.match(hint({ evidence_id: "ev_0_text_0_99_/role" }), /文本长度为 4/);
  assert.match(hint({ evidence_id: "ev_0_text_0_4_/data/tool" }), /值为「tool」的路径是 \/role/);
  assert.match(hint({ evidence_id: "ev_0_text_0_6_/missing" }), /可引用路径：\/role、\/content/);
  assert.match(hint({ evidence_id: evidenceId(0, "text", "/role", 2, 99) }), /文本长度为 4，起止应为 0 ≤ 起 < 止 ≤ 4/);
  assert.match(hint({ evidence_id: "ev_0_text_0_99_100_/role" }), /可引用路径：\/role、\/content/);
});

test("normal runs persist drafts before cleanup, carry them to one repair attempt, then clear them", async () => {
  const { directory, config, modelForStage } = await fixtureConfig([[raw("q", null)], [], [raw("q", null)], []]);
  let calls = 0,
    firstTask: string | undefined;
  const attempts = new Map<string, number>();
  const worker = await startWorker(
    {
      identity: fakeIdentity,
      async createSession(options) {
        return {
          async run() {
            calls++;
            firstTask ??= options.spec.taskId;
            const attempt = (attempts.get(options.spec.taskId) || 0) + 1;
            attempts.set(options.spec.taskId, attempt);
            if (attempt === 1 && options.spec.taskId === firstTask) {
              const invalid = taskResult(options.spec) as {
                findings?: { evidence: { quote: string }[] }[];
                evaluations?: { A: { findings: { evidence: { quote: string }[] }[] } };
              };
              (invalid.findings ?? invalid.evaluations!.A.findings)[0].evidence[0].quote = "wrong";
              await options.execute("submit_evaluation", draftFor(options.spec, invalid));
              const state = await readRunState(path.join(config.output.path, "test"));
              assert(state.manifest.states[options.spec.taskId].failure?.draft);
            } else {
              if (attempt > 1 && options.spec.taskId === firstTask) {
                assert(options.spec.recovery?.draft);
                assert.deepEqual(
                  await readJson(path.join(options.workdir, "evaluation-draft.json")),
                  options.spec.recovery.draft,
                );
              }
              await options.execute("submit_evaluation", draftFor(options.spec, taskResult(options.spec)));
            }
          },
          async abort() {},
          async dispose() {},
        };
      },
    },
    path.join(directory, "worker"),
  );
  try {
    const stats = await runEvaluation(optionsFor(config, modelForStage, await buildPlan(config), [worker.url]));
    assert.equal(calls, 4);
    assert.equal(stats.completed_comparisons, 1);
    const state = await readRunState(path.join(config.output.path, "test"));
    assert.equal(Object.values(state.manifest.states)[0].failure?.draft, undefined);
    assert.equal(Object.values(state.receipts)[0].submissionStats?.contentSubmissions, 2);
  } finally {
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a responsive external worker is not discarded after a one-second health delay", async (t) => {
  const { directory, config, modelForStage } = await fixtureConfig([[raw()], [], [raw()], []]);
  const worker = await startWorker({
    identity: fakeIdentity,
    async createSession(options) {
      return {
        async run() { await options.execute("submit_evaluation", draftFor(options.spec, taskResult(options.spec))); },
        async abort() {}, async dispose() {},
      };
    },
  }, path.join(directory, "worker"));
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (String(input) === worker.url + "/api/health")
      await delay(1100, undefined, { signal: init?.signal || undefined });
    return fetch(input, init);
  });
  try {
    const result = await runEvaluation(optionsFor(config, modelForStage, await buildPlan(config), [worker.url]));
    assert.equal(result.completed_comparisons, 1);
  } finally {
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const [kind, observationError] of [
  ["timeout", new DOMException("Status observation timed out", "TimeoutError")],
  ["connection reset", new TypeError("fetch failed", { cause: { code: "ECONNRESET" } })],
] as const)
test(`a status observation ${kind} keeps the original worker attempt running`, async (t) => {
  const { directory, config, modelForStage } = await fixtureConfig([[raw()], [], [raw()], []]);
  let launches = 0, cancellations = 0, timeouts = 0;
  const worker = await startWorker({
    identity: fakeIdentity,
    async createSession(options) {
      launches++;
      return {
        async run() {
          await delay(100);
          await options.execute("submit_evaluation", draftFor(options.spec, taskResult(options.spec)));
        },
        async abort() {}, async dispose() {},
      };
    },
  }, path.join(directory, "worker"));
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    if (url.startsWith(worker.url) && url.endsWith("/cancel")) cancellations++;
    if (!timeouts && url.startsWith(worker.url + "/api/attempts/") && init?.method === "GET" &&
        !url.endsWith("/record") && !url.includes("/events")) {
      timeouts++;
      throw observationError;
    }
    return fetch(input, init);
  });
  try {
    const plan = await buildPlan(config);
    const result = await runEvaluation(optionsFor(config, modelForStage, plan, [worker.url]));
    assert.equal(timeouts, 1);
    assert.equal(cancellations, 0, "a transient read failure must not cancel a healthy attempt");
    assert.equal(launches, plan.tasks.length, "accepted work must not be relaunched");
    assert.equal(result.completed_comparisons, 1);
  } finally {
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("interruption stops the current scheduling scan before preparing more tasks", async (t) => {
  const rows = [raw("one", null), raw("two", null)];
  const { directory, config, modelForStage } = await fixtureConfig([rows, [], rows, []]);
  const controller = new AbortController();
  const original = services.agents.prepare.bind(services.agents);
  const prepared = t.mock.method(services.agents, "prepare", (...args: Parameters<typeof original>) => {
    controller.abort();
    return original(...args);
  });
  const backend: AgentBackend = { identity: fakeIdentity, async createSession() { throw new Error("must not start after interruption"); } };
  const workers = await Promise.all([0, 1, 2, 3].map((i) => startWorker(backend, path.join(directory, `worker-${i}`))));
  try {
    const result = await runEvaluation({ ...optionsFor(config, modelForStage, await buildPlan(config), workers.map((w) => w.url)), signal: controller.signal, concurrency: 4 });
    assert.equal(result.status, "interrupted");
    assert.equal(prepared.mock.callCount(), 1);
  } finally {
    await Promise.all(workers.map((worker) => worker.close()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("live concurrency prepares only available slots and shrinking lets healthy attempts finish", async (t) => {
  const rows = [1, 2, 3, 4].map((id) => raw(String(id), null));
  const { directory, config, modelForStage } = await fixtureConfig([rows, [], rows, []]);
  const prepared = t.mock.method(services.agents, "prepare");
  const started: string[] = [],
    releases = new Map<string, () => void>();
  let aborted = 0;
  const backend: AgentBackend = {
    identity: fakeIdentity,
    async createSession(options) {
      return {
        async run() {
          started.push(options.spec.taskId);
          await new Promise<void>((resolve) => releases.set(options.spec.taskId, resolve));
          await options.execute("submit_evaluation", draftFor(options.spec, taskResult(options.spec)));
        },
        async abort() {
          aborted++;
          releases.get(options.spec.taskId)?.();
        },
        async dispose() {},
      };
    },
  };
  const workers = await Promise.all(
    [1, 2, 3].map((i) => startWorker(backend, path.join(directory, "w" + i))),
  );
  let execution: Promise<unknown> | undefined;
  try {
    execution = runEvaluation(
      optionsFor(
        config,
        modelForStage,
        await buildPlan(config),
        workers.map((w) => w.url),
      ),
    );
    await until(() => started.length === 1);
    assert.equal(prepared.mock.callCount(), 1, "a full scheduler must not prepare the rest of the batch");
    const lock = await readJson<{ url: string; token: string }>(
      path.join(config.output.path, "test", ".run-lock"),
    );
    const adjust = async (concurrency: number) => {
      const response = await fetch(lock.url + "/api/control/concurrency", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-run-token": lock.token,
        },
        body: JSON.stringify({ concurrency }),
      });
      assert.equal(response.status, 200);
    };
    await adjust(3);
    await until(() => started.length === 3);
    assert.equal(prepared.mock.callCount(), 3, "growing concurrency prepares only the newly available slots");
    await adjust(1);
    const autoRelease = setInterval(() => {
      for (const id of started) releases.get(id)?.();
    }, 10);
    releases.get(started[0])!();
    releases.get(started[1])!();
    await until(
      async () =>
        (
          (await (await fetch(lock.url + "/api/progress")).json()) as {
            running: number;
          }
        ).running === 1,
    );
    assert.equal(started.length, 3);
    assert.equal(aborted, 0);
    await execution;
    clearInterval(autoRelease);
    assert.equal(aborted, 0);
  } finally {
    for (const release of releases.values()) release();
    await Promise.all(workers.map((w) => w.close()));
    await execution?.catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("enabling debug and missing optional artifacts never remove accepted receipts", async () => {
  const { directory, config, modelForStage } = await fixtureConfig([[raw("q", null)], [], [raw("q", null)], []]);
  let calls = 0;
  const worker = await startWorker(
    {
      identity: fakeIdentity,
      async createSession(options) {
        return {
          async run() {
            calls++;
            await options.execute("execute_code", {
              language: "python",
              code: "print('artifact')",
            });
            await options.execute("submit_evaluation", draftFor(options.spec, taskResult(options.spec)));
          },
          async abort() {},
          async dispose() {},
        };
      },
    },
    path.join(directory, "worker"),
  );
  try {
    const options = optionsFor(config, modelForStage, await buildPlan(config), [worker.url]);
    await runEvaluation(options);
    await runEvaluation({ ...options, debug: true });
    const run = path.join(config.output.path, "test"),
      validation = await validateRun(run);
    assert.equal(calls, 3);
    assert.equal(validation.valid, true);
    assert.equal(validation.artifacts.status, "missing");
    assert.equal(validation.completed_comparisons, 1);
    const before = await readRunState(run);
    const file = path.join(run, "results/comparison.jsonl");
    const row = JSON.parse(await readFile(file, "utf8"));
    row.evaluation_type = "invalid";
    await writeJsonl(file, [row]);
    assert.equal((await validateRun(run)).valid, false);
    assert.equal(Object.keys(before.receipts).length, 3);
    const comparisonTask = before.manifest.tasks.find((t) => t.stage === "comparison")!;
    await writeJsonl(file, [before.receipts[comparisonTask.id].exported!.row]);
    const inputFile = (before.manifest.tasks[0].data as TaskData).candidates.A.source;
    await writeJsonl(inputFile, [raw("another-case", null)]);
    const changed = await validateRun(run);
    assert.equal(changed.results.valid, true);
    assert.equal(changed.evidence.valid, false);
  } finally {
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  }
});
