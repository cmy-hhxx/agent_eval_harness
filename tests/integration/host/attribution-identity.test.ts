import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { AgentBackend } from "@eval/contracts";
import { runEvaluation } from "@eval/host";
import { startWorker } from "@eval/runtime/worker";
import { buildPlan, comparisonRepository, readRunState, type TaskData } from "@eval/workflows/comparison";
import type { RawInput } from "@eval/workflows/inputs";
import { services, validateRun } from "../../fixtures/services.js";
import { draftFor, fakeEvaluatorVersion, fakeIdentity, fixtureConfig, inspectFor, raw, submitFor, taskResult } from "../../fixtures/comparison.js";

async function verifyIdentity(t: test.TestContext, sources: RawInput[][], distinctSummaries = false) {
  const records = sources.flat(), { directory, config, modelForStage } = await fixtureConfig(sources);
  config.inputs.records = sources.flatMap((rows, source) => rows.map((record, index) => ({ model: config.inputs.versions[source]!.id,
      batch_id: String(record.batch_id), case_id: String(record.case_id), input_file: config.inputs.versions[source]!.sources[0]!.path,
      input_index: index })));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executions = new Map<string, number>();
  const backend: AgentBackend = { identity: fakeIdentity, async createSession(options) {
    return { async run() {
      executions.set(options.spec.taskId, (executions.get(options.spec.taskId) ?? 0) + 1);
      await inspectFor(options);
      const result = taskResult(options.spec) as Record<string, unknown>;
      if (distinctSummaries && "session_summary" in result) result.session_summary = "独立来源归因：" + options.spec.taskId;
      if (distinctSummaries && options.spec.evaluation.profile === "trace") result.summary = "独立来源归因：" + options.spec.taskId;
      const submitted = await submitFor(options, draftFor(options.spec, result));
      assert.equal(submitted.isError, undefined, JSON.stringify(submitted));
    }, async abort() {}, async dispose() {} };
  } };
  const worker = await startWorker(backend, path.join(directory, "worker"));
  t.after(() => worker.close());
  const plan = await buildPlan(config), runId = "attribution-identity", run = path.join(config.output.path, runId);
  assert.equal(plan.tasks.filter(task => task.stage === "attribution-session").length, records.length);
  const options = { ...services, runId, output: config.output, engine: "pi" as const, identity: fakeIdentity,
    evaluatorVersion: fakeEvaluatorVersion, config, plan, policy: config.execution, modelForStage,
    concurrency: 2, retries: 0, retryDelaySeconds: 0, workerUrls: [worker.url], debug: true };
  await runEvaluation(options);
  const file = path.join(run, "results/attribution.jsonl"), original = await readFile(file, "utf8");
  const rows = original.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(rows.length, records.length, "all source records need separate formal rows even when their bodies match");
  if (!distinctSummaries) assert.equal(new Set(rows.map(row => JSON.stringify(row, (key, value) =>
    key === "position" && typeof value === "string" ? value.split(" / evidence_id ")[0] : value))).size, 1,
    "identical verdict prose retains each record's independent evidence source identity");
  const before = await readRunState(run);
  const tasks = before.manifest.tasks.filter(task => task.stage === "attribution-session");
  assert.equal(tasks.length, records.length);
  assert.equal(new Set(tasks.map(task => before.receipts[task.id].exported!.id)).size, records.length);
  assert.equal(new Set(tasks.map(task => before.receipts[task.id].exported!.line)).size, records.length);
  const identities = new Set<string>();
  for (const task of tasks) {
    const candidate = (task.data as TaskData).candidates.A, source = plan.inputs[candidate.input_id] as RawInput;
    identities.add(JSON.stringify([candidate.version, candidate.batch_id, candidate.case_id]));
    const exported = before.receipts[task.id].exported!;
    assert.equal(exported.id, task.id);
    assert.deepEqual(rows[exported.line! - 1], before.receipts[task.id].evaluation);
    assert.deepEqual(exported.row.session_meta, source.meta, "outer metadata is passed through without additions");
    assert.deepEqual((exported.row.turns as { meta: unknown }[]).map(turn => turn.meta),
      source.turns ? source.turns.map(turn => turn.meta) : [source.meta], "trace metadata is passed through without additions");
    if (distinctSummaries) assert.equal(exported.row.session_summary, "独立来源归因：" + (services.taskSource.isComputedTask?.(task) ? task.dependencies.trace0 : task.id));
    const selected = await comparisonRepository.readTasks(run, [task.id]);
    assert.deepEqual(selected.receipts[task.id], before.receipts[task.id]);
    const archived = JSON.parse(await readFile(path.join(run, "_internal/tasks", services.taskSource.isComputedTask?.(task) ? task.dependencies.trace0! : task.id, "attempt-001/attempt.json"), "utf8"));
    assert.equal(archived.spec.taskId, services.taskSource.isComputedTask?.(task) ? task.dependencies.trace0 : task.id, "the final Worker record still retains the complete debug attempt");
    assert.equal(archived.status.state, "succeeded");
  }
  assert.equal(identities.size, records.length);
  const validation = await validateRun(run);
  assert.equal(validation.results.valid && validation.evidence.valid, true, JSON.stringify(validation));
  const executionCounts = [...executions];
  for (let round = 0; round < 2; round++) {
    await runEvaluation({ ...options, plan: { tasks: [], inputs: {}, summary: {} } });
    const after = await readRunState(run);
    assert.equal(await readFile(file, "utf8"), original);
    for (const task of tasks) {
      assert.equal(after.receipts[task.id].submissionId, before.receipts[task.id].submissionId);
      assert.equal(after.receipts[task.id].exported!.id, before.receipts[task.id].exported!.id);
      assert.equal(after.receipts[task.id].exported!.line, before.receipts[task.id].exported!.line);
      assert.deepEqual(after.receipts[task.id].evaluation, before.receipts[task.id].evaluation);
      assert.equal(executions.get(task.id), services.taskSource.isComputedTask?.(task) ? undefined : 1);
    }
    assert.deepEqual([...executions], executionCounts, "no stage is evaluated again on resume");
    const validation = await validateRun(run);
    assert.equal(validation.results.valid && validation.evidence.valid, true, JSON.stringify(validation));
  }
  // A crash after appending results but before checkpointing must not create an extra row.
  await appendFile(file, JSON.stringify(rows[0]) + "\n{\"session_meta\":");
  await runEvaluation({ ...options, plan: { tasks: [], inputs: {}, summary: {} } });
  assert.equal(await readFile(file, "utf8"), original);
  assert.deepEqual([...executions], executionCounts);
}

test("four identical flat answers with distinct outer case identities retain four formal rows through two resumes", async t => {
  await verifyIdentity(t, [["q1", "q2", "q3", "q4"].map(caseId => raw(caseId)), [], [], []]);
});

test("same-session trace captures retain separate receipts across models and batches", async t => {
  const captures = ["b1", "b2"].flatMap(batch_id => ["t1", "t2"].map(trace_id => {
    const input = raw(trace_id);
    return { batch_id, case_id: trace_id, meta: { ...input.meta, session_id: "shared-session" },
      traces: [{ meta: { trace_id, marker: { captured: true } }, messages: input.messages }] } as unknown as RawInput;
  }));
  await verifyIdentity(t, [captures, [], structuredClone(captures), []], true);
});
