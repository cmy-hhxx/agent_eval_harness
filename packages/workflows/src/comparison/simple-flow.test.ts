import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import { comparisonProfile } from "@eval/agents/comparison";
import type { RunManifest } from "@eval/contracts";
import { loadConfig } from "@eval/host-app/config";
import { fixtureConfig, raw } from "../../../../tests/fixtures/comparison.js";
import { ROOT } from "../../../../tests/fixtures/services.js";
import { buildPlan } from "./input.js";
import { comparisonWorkflow } from "./workflow.js";
import type { TaskData } from "./types.js";

test("evaluation with explicit rewrites off has one comparison and no mandatory verification or source-review cells", async () => {
  const f = await fixtureConfig([[raw()], [], [raw()], []]);
  try {
    const plan = await buildPlan(f.config);
    assert.deepEqual(plan.tasks.map(task => task.stage), ["criteria", "attribution", "attribution", "comparison"]);
    const comparison = plan.tasks.find(task => task.stage === "comparison")!;
    assert.equal((comparison.data as TaskData).verificationOf, undefined);
    const schema = comparisonProfile.submissionSchema as { properties: { comparisons: { items: { properties: {
      assessments: { properties: Record<string, { properties: Record<string, unknown> }> }
    } } } } };
    for (const candidate of ["A", "B"]) assert.equal(schema.properties.comparisons.items.properties.assessments.properties[candidate].properties.source_review, undefined);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("real config defaults polish each attribution and comparison, then separately enabled clustering", async () => {
  const defaults = (await loadConfig(path.join(ROOT, "configs/host.json"), { EVAL_BASE_URL: "http://127.0.0.1:1/v1" })).evaluation;
  assert.deepEqual(defaults.rewrite, { attribution: true, comparison: true, clustering: true });
  assert.equal(defaults.clustering.enabled, false);
  const f = await fixtureConfig([[raw()], [], [raw()], []]);
  f.config.rewrite = { ...defaults.rewrite };
  try {
    const primary = await buildPlan(f.config);
    const sources = primary.tasks.filter(task => ["attribution", "comparison"].includes(task.stage));
    assert.equal(sources.filter(task => task.stage === "attribution").length, 2);
    assert.equal(sources.filter(task => task.stage === "comparison").length, 1);
    assert.equal(primary.tasks.filter(task => task.stage === "rewrite").length, 3);
    assert.equal(primary.tasks.filter(task => task.stage === "clustering").length, 0);
    for (const source of sources) {
      const polish = primary.tasks.filter(task => (task.data as TaskData).rewriteOf?.taskId === source.id);
      assert.equal(polish.length, 1);
      assert.equal((polish[0].data as TaskData).rewriteOf!.stage, source.stage);
      assert.deepEqual(polish[0].dependencies, { source: source.id });
      assert.equal((source.data as TaskData).verificationAudit, undefined);
      assert.equal((source.data as TaskData).verificationOf, undefined);
      assert(Object.values(source.dependencies).every(id => primary.tasks.find(task => task.id === id)?.stage !== "rewrite"));
    }

    const maintenance = await buildPlan({ ...f.config, clustering: { ...f.config.clustering, enabled: true } });
    const clusters = maintenance.tasks.filter(task => task.stage === "clustering");
    assert.equal(clusters.length, 2);
    const manifest = { tasks: maintenance.tasks, states: Object.fromEntries(maintenance.tasks.map(task => [task.id,
      { status: "pending", attempts: 0 }])) } as RunManifest;
    for (const cluster of clusters) {
      assert.equal(comparisonWorkflow.canStart!(cluster, manifest), false);
      const polish = maintenance.tasks.filter(task => (task.data as TaskData).rewriteOf?.taskId === cluster.id);
      assert.equal(polish.length, 1);
      assert.equal((polish[0].data as TaskData).rewriteOf!.stage, "clustering");
      assert.deepEqual(polish[0].dependencies, { source: cluster.id });
      assert(Object.values(cluster.dependencies).every(id => maintenance.tasks.find(task => task.id === id)?.stage === "attribution"));
    }
    for (const task of maintenance.tasks.filter(task => task.stage === "attribution")) manifest.states[task.id].status = "succeeded";
    for (const cluster of clusters) assert.equal(comparisonWorkflow.canStart!(cluster, manifest), true,
      "settled attribution opens the separate clustering phase while comparisons and polish are pending");
    assert.equal(maintenance.tasks.filter(task => task.stage === "comparison").length, 1);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("clustering starts after the base attribution queue settles without a global success dependency", async () => {
  const rows = [raw("q1"), raw("q2")];
  const f = await fixtureConfig([rows, [], rows, []], false, true);
  f.config.clustering.maxCasesPerTask = 1;
  try {
    const plan = await buildPlan(f.config), cluster = plan.tasks.find(task => task.stage === "clustering")!;
    const manifest = { tasks: plan.tasks, states: Object.fromEntries(plan.tasks.map(task => [task.id,
      { status: "succeeded", attempts: 1 }])) } as RunManifest;
    const unrelated = plan.tasks.find(task => task.stage === "attribution" && !Object.values(cluster.dependencies).includes(task.id))!;
    const comparison = plan.tasks.find(task => task.stage === "comparison")!;
    for (const status of ["pending", "running"] as const) {
      manifest.states[unrelated.id].status = status;
      assert.equal(comparisonWorkflow.canStart!(cluster, manifest), false);
      assert.equal(comparisonWorkflow.canStart!(comparison, manifest), true);
    }
    manifest.states[unrelated.id].status = "failed";
    assert.equal(comparisonWorkflow.canStart!(cluster, manifest), true, "an unrelated failed answer does not block accepted observations");
    const optional = { ...unrelated, id: "optional-review", data: { ...(unrelated.data as TaskData),
      reviewOf: { taskId: unrelated.id, round: 1, reasons: ["显式复核。"] } } };
    manifest.tasks.push(optional);
    manifest.states[optional.id] = { status: "pending", attempts: 0 };
    assert.equal(comparisonWorkflow.canStart!(cluster, manifest), true, "optional attribution review does not gate maintenance");
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
