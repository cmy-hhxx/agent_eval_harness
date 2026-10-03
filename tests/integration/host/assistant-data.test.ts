import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { rm } from "node:fs/promises";
import { emptyUsage, type RunState } from "@eval/contracts";
import { writeJson } from "@eval/data";
import { buildPlan, comparisonCodec, type EvalConfig } from "@eval/workflows/comparison";
import { LocalAnalysisData } from "../../../apps/host/src/assistant-data.js";
import { fakeEvaluatorVersion, fakeIdentity, fixtureConfig } from "../../fixtures/comparison.js";

async function register(config: EvalConfig) {
  const plan = await buildPlan(config);
  const state: RunState = { usage: emptyUsage(), receipts: {}, recordedAttempts: 0, manifest: {
    format: "evaluation-run", runId: "source", status: "running", debug: false,
    engine: fakeIdentity, evaluatorVersion: fakeEvaluatorVersion, config,
    tasks: plan.tasks, inputCatalog: plan.catalog, inputs: {},
    states: Object.fromEntries(plan.tasks.map((task) => [task.id, { status: "pending", attempts: 0 }])),
    preflight: plan.summary, startedAt: 0,
  } };
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
    const found = await source.list({ runId: "source", query: "A组极速" });
    assert(found.kind === "inputs");
    assert.equal(found.total, 1);
    assert.equal(found.items[0].model, "a_fast");
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
