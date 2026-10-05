import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { comparisonProfile } from "@eval/agents/comparison";
import type { RunManifest } from "@eval/contracts";
import { fixtureConfig, raw } from "../../../../tests/fixtures/comparison.js";
import { buildPlan } from "./input.js";
import { comparisonWorkflow } from "./workflow.js";
import type { TaskData } from "./types.js";

test("default evaluation has one comparison and no mandatory verification or source-review cells", async () => {
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
