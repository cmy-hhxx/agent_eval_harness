import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, readdir } from "node:fs/promises";
import path from "node:path";
import { emptyUsage, type RunState } from "../../packages/contracts/src/index.js";
import { ROOT, exists, readJson, writeJson, writeInputs, runLock } from "../../packages/contracts/src/io.js";
import { buildPlan } from "../../packages/pairwise-eval/src/input.js";
import { reportRun } from "../../packages/pairwise-eval/src/report.js";
import { writeRunInputs, writeRunState, readRunState } from "../../packages/pairwise-eval/src/run-data.js";
import { upgradeRun } from "../../packages/pairwise-eval/src/upgrade.js";
import { emptyAudit, fakeIdentity, fixtureConfig, pairResult, raw } from "./fixtures.js";

test("explicit upgrade preserves IDs, assignments, result bytes and usage after an interrupted backup", async () => {
  const { directory, config } = await fixtureConfig([[raw("q", null)], [], [raw("q", null)], []]);
  const run = path.join(directory, "legacy");
  try {
    const plan = await buildPlan(config), task = plan.tasks[0];
    const state: RunState = { manifest: { format: "dual-agent-eval/5", debug: false, runId: "legacy", status: "finished", config,
      engine: fakeIdentity, tasks: plan.tasks, inputCatalog: plan.catalog, states: { [task.id]: { status: "succeeded", attempts: 2 } },
      inputs: {}, preflight: plan.summary, startedAt: 1 }, receipts: { [task.id]: { taskId: task.id, attemptId: "old-attempt", submissionId: "old-submission",
        evaluation: pairResult(), audit: emptyAudit(), usage: emptyUsage(), acceptedAt: 2, status: "succeeded" } },
      usage: { ...emptyUsage(), totalTokens: 700 }, recordedAttempts: 2 };
    await writeRunInputs(run, plan.inputs); await writeRunState(run, state); await reportRun(run);
    const saved = await readJson(path.join(run, "state.json"));
    const { plan: _plan, inputCatalog: _catalog, inputs: _inputs, preflight: _preflight, ...legacy } = saved;
    const legacyPlan = structuredClone(plan);
    for (const entry of legacyPlan.tasks) for (const record of Object.values((entry.data as { candidates: Record<string, Record<string, unknown>> }).candidates)) {
      record.input_hash = record.input_id; delete record.input_id;
    }
    await writeJson(path.join(run, "state.json"), { ...legacy, format: "dual-agent-eval/4" });
    await writeJson(path.join(run, "_internal/plan.json"), { tasks: legacyPlan.tasks, summary: plan.summary });
    await writeInputs(run, plan.inputs); await rm(path.join(run, "inputs"), { recursive: true });
    const formal = path.join(run, "results/a_fast__vs__aa_fast.jsonl"), before = await readFile(formal);
    const release = await runLock(run);
    await assert.rejects(upgradeRun(run, true), /owned/); await release();
    assert.equal((await upgradeRun(run)).applied, false);
    assert.equal((await readJson(path.join(run, "state.json"))).format, "dual-agent-eval/4");
    await mkdir(run + ".before-v5");
    await writeJson(path.join(run + ".before-v5", "partial.json"), { interrupted: true });
    assert.equal((await upgradeRun(run, true)).applied, true);
    assert(before.equals(await readFile(formal)));
    assert.equal(await exists(path.join(run + ".before-v5", "backup-complete.json")), true);
    const current = await readRunState(run);
    assert.deepEqual(current.manifest.tasks.map((t) => t.inputIds), plan.tasks.map((t) => t.inputIds));
    assert.equal(current.receipts[task.id].submissionId, "old-submission");
    assert.equal(current.usage.totalTokens, 700);
    assert.equal(current.recordedAttempts, 2);
    assert.equal((await upgradeRun(run, true)).reason, "already_current");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("project execution code has no hash computations or tree digest helpers", async () => {
  async function inspect(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && !["node_modules", "dist", "__pycache__"].includes(entry.name)) await inspect(file);
      else if (entry.isFile() && /\.(?:[cm]?[jt]s|py)$/.test(file))
        assert.doesNotMatch(await readFile(file, "utf8"), /\b(?:createHash|createHmac|sha256|sha1|md5|treeHash|buildHash)\s*\(|crypto\.subtle\.digest\s*\(|hashlib\./, file);
    }
  }
  for (const directory of ["apps", "packages", "scripts"]) await inspect(path.join(ROOT, directory));
});
