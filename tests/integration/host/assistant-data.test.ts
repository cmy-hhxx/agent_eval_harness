import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { rm } from "node:fs/promises";
import { emptyUsage, type RunState, type SubmissionReceipt, type TaskPlan } from "@eval/contracts";
import { readJson, writeJson } from "@eval/data";
import { buildPlan, comparisonCodec, createResultWriter, type Checkpoint, type EvalConfig, type TaskData } from "@eval/workflows/comparison";
import { LocalAnalysisData } from "../../../apps/host/src/assistant-data.js";
import { attributionResult, comparisonResult, criteriaResult, emptyAudit, fakeEvaluatorVersion, fakeIdentity, fakeJudge, fixtureConfig } from "../../fixtures/comparison.js";

async function register(config: EvalConfig, accepted?: (state: RunState, plan: TaskPlan) => Promise<void>) {
  const plan = await buildPlan(config);
  const state: RunState = { usage: emptyUsage(), receipts: {}, recordedAttempts: 0, manifest: {
    format: "evaluation-run", runId: "source", status: "running", debug: false,
    engine: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion, config,
    tasks: plan.tasks, inputCatalog: plan.catalog, inputs: {},
    states: Object.fromEntries(plan.tasks.map((task) => [task.id, { status: "pending", attempts: 0 }])),
    preflight: plan.summary, startedAt: 0,
  } };
  await accepted?.(state, plan);
  await writeJson(path.join(config.output.path, "source/state.json"), comparisonCodec.encode(state));
  const source = new LocalAnalysisData(config.output.path);
  source.raw = async () => { throw new Error("Directory queries must not read source messages"); };
  return source;
}

test("Eris's paginated directory exposes persisted display names, tiers and configured comparison groups", async () => {
  const fixture = await fixtureConfig();
  try {
    fixture.config.comparisons = [["a_fast", "b_fast"], ["a_expert", "b_expert"]];
    fixture.config.inputs.versions.find((version) => version.id === "a_fast")!.display_name = "A组极速";
    const source = await register(fixture.config);
    const first = await source.list({ runId: "source", limit: 1 });
    const rest = await source.list({ runId: "source", offset: first.nextOffset!, limit: 100 });
    assert(first.kind === "inputs" && rest.kind === "inputs");
    assert.equal(first.total, 4);
    assert.equal(first.hasMore, true);
    assert.equal(first.nextOffset, 1);
    assert.equal(rest.hasMore, false);
    assert.equal(rest.nextOffset, null);
    assert.equal(first.summaryScope, "run");
    assert.equal(first.summary.inputCount, 4);
    assert.equal(first.summary.caseCount, 1);
    assert.deepEqual(rest.summary, first.summary, "whole-run progress does not depend on the input page");
    assert.deepEqual(first.comparisonGroups, [
      { comparisonTier: "Fast", models: [{ model: "a_fast", modelName: "A组极速" }, { model: "b_fast", modelName: "B组Fast" }] },
      { comparisonTier: "Expert", models: [{ model: "a_expert", modelName: "A组Expert" }, { model: "b_expert", modelName: "B组Expert" }] },
    ]);
    assert.deepEqual(rest.comparisonGroups, first.comparisonGroups);
    const items = [...first.items, ...rest.items];
    assert.deepEqual(items.map(({ model, modelName, comparisonTier }) => ({ model, modelName, comparisonTier })).sort((a, b) => a.model.localeCompare(b.model)), [
      { model: "a_expert", modelName: "A组Expert", comparisonTier: "Expert" },
      { model: "a_fast", modelName: "A组极速", comparisonTier: "Fast" },
      { model: "b_expert", modelName: "B组Expert", comparisonTier: "Expert" },
      { model: "b_fast", modelName: "B组Fast", comparisonTier: "Fast" },
    ]);
    assert(items.every((item) => item.reference.runId === "source" && item.reference.inputId === item.inputId));
    assert(items.every((item) => item.tasks.every((task) => task.status === "pending")), "configured groups do not imply completed results");
    assert.equal(new Set(items.flatMap(item => item.tasks).filter(task => task.purpose === "comparison_formal").map(task => task.taskId)).size, 2);
    const found = await source.list({ runId: "source", query: "A组极速" });
    assert(found.kind === "inputs");
    assert.equal(found.total, 1);
    assert.equal(found.items[0].model, "a_fast");
    const filteredEmpty = await source.list({ runId: "source", query: "inputs" });
    assert(filteredEmpty.kind === "inputs");
    assert.equal(filteredEmpty.total, 0, "query is a text filter, even when it happens to name the returned kind");
    assert.deepEqual(filteredEmpty.summary, first.summary, "a zero-match text filter cannot erase whole-run statistics");
    const unfiltered = await source.list({ runId: "source" });
    assert(unfiltered.kind === "inputs");
    assert.equal(unfiltered.total, 4, "a filtered empty page does not mean the run has no input data");
    assert.equal(new Set(unfiltered.items.map((item) => JSON.stringify([item.batchId, item.caseId]))).size, 1,
      "the four model answers cover one business question across both tiers");
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("Eris exposes whole-run formal standings and read scopes from recorded results without reading answer sources", async () => {
  const fixture = await fixtureConfig();
  try {
    fixture.config.comparisons = [["a_fast", "b_fast"], ["a_expert", "b_expert"]];
    let accepted: Record<string, SubmissionReceipt> = {};
    const source = await register(fixture.config, async (state, plan) => {
      for (const task of plan.tasks) {
        const evaluation = task.stage === "criteria" ? criteriaResult() : task.stage === "attribution" ? attributionResult()
          : comparisonResult(Object.keys((task.data as TaskData).candidates));
        state.receipts[task.id] = { taskId: task.id, attemptId: task.id, submissionId: randomUUID(), evaluation,
          evaluatorVersion: fakeEvaluatorVersion, judge: fakeJudge, audit: emptyAudit(), usage: emptyUsage(), status: "succeeded", acceptedAt: 0 };
        state.manifest.states[task.id] = { status: "succeeded", attempts: 1 };
      }
      await createResultWriter(path.join(fixture.config.output.path, "source"), plan.inputs)(state);
      accepted = state.receipts;
    });
    const checkpointPath = path.join(fixture.config.output.path, "source/state.json");
    const saved = await readJson<Checkpoint>(checkpointPath);
    const formal = Object.values(saved.tasks).find((task) => task.receipt?.exported?.comparisonId)!;
    delete formal.receipt!.exported!.file;
    await writeJson(checkpointPath, saved);
    const directory = await source.list({ runId: "source", limit: 1, query: "a_fast" });
    assert(directory.kind === "inputs");
    const stats = directory.summary.formalComparisonStats;
    assert.equal(stats.formalResultCount, 2);
    assert.equal(stats.comparisonCount, 2);
    assert.deepEqual(stats.tiers.map(({ comparisonTier, comparisonCount, outcomes }) => ({ comparisonTier, comparisonCount, outcomes })), [
      { comparisonTier: "Fast", comparisonCount: 1, outcomes: { win: 0, both_good: 1, both_bad: 0 } },
      { comparisonTier: "Expert", comparisonCount: 1, outcomes: { win: 0, both_good: 1, both_bad: 0 } },
    ]);
    assert(stats.tiers.every((tier) => tier.models.length === 2 && tier.models.every((model) => model.both_good === 1 && model.comparisonCount === 1)));
    const runs = await source.list({ query: "no-match" });
    assert(runs.kind === "runs");
    assert.deepEqual(runs.currentRun!.summary.formalComparisonStats, stats, "history filtering cannot change current formal standings");
    for (const record of stats.records) {
      assert.equal(record.question, "计算2+2");
      const result = await source.read(record.reference);
      assert.deepEqual(result.comparisonScope, record.scope);
      assert.deepEqual(result.result, accepted[record.reference.taskId]!.exported!.row, "read_data keeps the complete formal row alongside its scope");
    }
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("Eris chooses a recorded running data run before recent finished runs, excluding empty maintenance and page filters", async () => {
  const fixture = await fixtureConfig();
  try {
    const source = await register(fixture.config);
    const saved = await readJson<Checkpoint>(path.join(fixture.config.output.path, "source/state.json"));
    await writeJson(path.join(fixture.config.output.path, "later/state.json"), { ...saved, runId: "later", status: "finished", startedAt: 20, finishedAt: 21 });
    await writeJson(path.join(fixture.config.output.path, "maintenance/state.json"), { ...saved, runId: "maintenance", startedAt: 30, inputs: {}, tasks: {} });
    const directory = await source.list({ limit: 1 });
    assert(directory.kind === "runs");
    assert.equal(directory.items[0]!.runId, "maintenance", "the directory still sorts by recorded start time");
    assert.equal(directory.currentRun!.runId, "source");
    assert.equal(directory.currentRun!.selectionReason, "running_with_inputs");
    assert.equal(directory.currentRun!.summary.inputCount, 4);
    assert(!Object.hasOwn(directory.items[0]!, "summary"), "history entries remain compact; only the selected run carries full progress");
    assert.deepEqual(directory.runCounts, { scope: "all_registered_runs", total: 3, states: { running: 2, finished: 1, interrupted: 0 } });
    const filtered = await source.list({ query: "no-match", offset: 1 });
    assert(filtered.kind === "runs");
    assert.equal(filtered.total, 0);
    assert.deepEqual(filtered.currentRun, directory.currentRun, "query and pagination only filter returned history entries");
    assert.deepEqual(filtered.runCounts, directory.runCounts);
    await writeJson(path.join(fixture.config.output.path, "source/state.json"), { ...saved, status: "interrupted" });
    const fallback = await source.list({ query: "source" });
    assert(fallback.kind === "runs");
    assert.equal(fallback.currentRun!.runId, "later");
    assert.equal(fallback.currentRun!.selectionReason, "latest_with_inputs");
    assert.equal(fallback.currentRun!.summary.finishedAt, 21);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("Eris's directory keeps undeclared tiers unknown even when model names contain Fast", async () => {
  const fixture = await fixtureConfig();
  try {
    for (const version of fixture.config.inputs.versions) delete version.comparison_tier;
    const version = fixture.config.inputs.versions.find((item) => item.id === "a_fast")!;
    delete version.display_name;
    const source = await register(fixture.config);
    const directory = await source.list({ runId: "source" });
    assert(directory.kind === "inputs");
    assert(directory.items.every((item) => item.comparisonTier === null));
    assert.equal(directory.items.find((item) => item.model === "a_fast")!.modelName, "A Fast");
    assert.deepEqual(directory.comparisonGroups, [
      { comparisonTier: null, models: [{ model: "a_fast", modelName: "A Fast" }, { model: "b_fast", modelName: "B组Fast" }] },
    ]);
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});
