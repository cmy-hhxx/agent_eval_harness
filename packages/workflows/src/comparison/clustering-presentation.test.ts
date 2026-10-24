import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { emptyUsage, type ProblemLibrary, type RunState, type SubmissionReceipt } from "@eval/contracts";
import type { ClusteringResult } from "@eval/agents/clustering";
import { locateRun, writeJson } from "@eval/data";
import { clusteringClassText, clusteringDisplaySources, readClusteringClassText } from "./clustering-presentation.js";
import { emptyAudit } from "../../../../tests/fixtures/comparison.js";
import type { EvalConfig } from "./types.js";

function library(): ProblemLibrary {
  return { model: "model", updated_at: "2026-10-14", events: [], occurrences: [],
    components: { component: { id: "component", label: "模型自身推理", definition: "", aliases: [], first_seen: null } },
    classes: { problem: { id: "problem", component_id: "component", label: "算术核验偏差", definition: "计算中存在错误。",
      aliases: [], status: "active", merged_into: null, first_seen: null } } };
}
function result(): ClusteringResult {
  return { assignments: [{ item_id: "item", new_class_key: "n1" }], merges: [],
    new_classes: [{ key: "n1", component: "模型自身推理", label: "算术核验偏差", definition: "计算中存在错误。",
      closest_existing: null, novelty: "新的独立现象。", category_paths: [["数值可靠性"]] }] };
}
function receipt(evaluation: unknown, acceptedAt = 1): SubmissionReceipt {
  return { taskId: "clustering", attemptId: "attempt", submissionId: "submission", status: "succeeded", acceptedAt,
    evaluatorVersion: "fixture", judge: "fixture", evaluation, audit: emptyAudit(), usage: emptyUsage() };
}

test("class prose uses canonical class identity and keeps receipts, component and library untouched", () => {
  const original = library(), decision = result(), source = { receipt: receipt(decision), rewritten: {
    evaluator_version: "fixture", rewrites: [{ id: "new_classes.0.label", text: "加法算错了" },
      { id: "new_classes.0.definition", text: "把两个数相加时得到了错误结果。" },
      { id: "new_classes.0.component", text: "不能改责任方" }] } };
  const before = structuredClone({ original, source });
  const projected = clusteringClassText(original, [source]);
  assert.deepEqual(projected.get("problem"), { label: "加法算错了", definition: "把两个数相加时得到了错误结果。" });
  assert.deepEqual({ original, source }, before);
  original.components.other = { ...original.components.component, id: "other", label: "另一工具" };
  original.classes.other = { ...original.classes.problem, id: "other", component_id: "other" };
  assert.equal(clusteringClassText(original, [source]).get("other")!.label, "算术核验偏差");
});

test("later semantic maintenance invalidates old polish and updated wording uses the explicit class UUID", () => {
  const original = library(), first = { receipt: receipt(result()), rewritten: { evaluator_version: "fixture",
    rewrites: [{ id: "new_classes.0.label", text: "旧名称改写" }, { id: "new_classes.0.definition", text: "旧定义改写" }] } };
  original.classes.problem.aliases = [original.classes.problem.label];
  original.classes.problem.label = "单位换算错误";
  original.classes.problem.definition = "换算单位时使用了错误倍率。";
  assert.deepEqual(clusteringClassText(original, [first]).get("problem"), {
    label: "单位换算错误", definition: "换算单位时使用了错误倍率。" });
  const maintenance: ClusteringResult = { assignments: [], new_classes: [], merges: [], class_updates: [{
    class_id: "problem", label: "单位换算错误", definition: "换算单位时使用了错误倍率。", reason: "明确范围。" }] };
  const second = { receipt: receipt(maintenance, 2), rewritten: { evaluator_version: "fixture",
    rewrites: [{ id: "class_updates.0.label", text: "单位换错了" }, { id: "class_updates.0.definition", text: "换成另一种单位时，把换算倍数用错了。" }] } };
  assert.deepEqual(clusteringClassText(original, [second, first]).get("problem"), {
    label: "单位换错了", definition: "换成另一种单位时，把换算倍数用错了。" });
});

test("main evaluation and standalone clustering share ordered accepted Rewrite projection", () => {
  for (const rewriteOf of ["clustering", { taskId: "clustering", stage: "clustering" }]) {
    const state = { manifest: { tasks: [{ id: "clustering", stage: "clustering", data: {} },
      { id: "rewrite", stage: "rewrite", data: { rewriteOf } }, { id: "later", stage: "rewrite", data: { rewriteOf } }] },
      receipts: { clustering: receipt(result()), rewrite: receipt({ rewrites: [{ id: "new_classes.0.label", text: "第一次改写" }] }, 2),
        later: receipt({ rewrites: [{ id: "new_classes.0.label", text: "最新改写" }] }, 3) } } as unknown as RunState;
    const before = structuredClone(state), sources = clusteringDisplaySources(state);
    assert.equal(sources.length, 1);
    assert.deepEqual(sources[0].rewritten!.rewrites, [{ id: "new_classes.0.label", text: "最新改写" }]);
    assert.equal(clusteringClassText(library(), sources).get("problem")!.label, "最新改写");
    assert.deepEqual(state, before);
  }
});

test("restored clustering display reads Workflow-exported polish without modifying the raw Agent result", () => {
  const raw = result(), source = receipt(raw);
  const rewritten = { evaluator_version: "fixture", rewrites: [{ id: "new_classes.0.label", text: "恢复后的类名" }] };
  source.exported = { id: "clustering", row: { result: { ...raw, rewritten } } };
  const state = { manifest: { tasks: [{ id: "clustering", stage: "clustering", data: {} }] },
    receipts: { clustering: source } } as unknown as RunState;
  assert.deepEqual(clusteringDisplaySources(state)[0].rewritten, rewritten);
  assert.equal(clusteringClassText(library(), clusteringDisplaySources(state)).get("problem")!.label, "恢复后的类名");
  assert.deepEqual(source.evaluation, raw);
  assert(!Object.hasOwn(source.evaluation as object, "rewritten"));
});

test("class display recalls standalone maintenance Rewrite by its event directory without copying prose into the library", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "clustering-display-"));
  try {
    const run = path.join(directory, "standalone"), original = library();
    original.events.push({ id: "event", type: "class_updated", at: "2026-10-14", detail: {
      class_id: "problem", run_id: "standalone", task_id: "clustering", submission_id: "submission", run,
    } });
    const maintenance: ClusteringResult = { assignments: [], new_classes: [], merges: [], class_updates: [{
      class_id: "problem", label: "算术核验偏差", definition: "计算中存在错误。", reason: "明确问题范围。" }] };
    const clustering = receipt(maintenance), rewrite = { ...receipt({ rewrites: [
      { id: "class_updates.0.label", text: "计算结果错了" }, { id: "class_updates.0.definition", text: "计算得到的数字不正确。" },
    ] }, 2), taskId: "rewrite", submissionId: "rewrite-submission" };
    await writeJson(locateRun(run).stateFile, { kind: "clustering-job", manifest: {
      runId: "standalone", config: { clusteringJob: { sources: [] } },
      tasks: [{ id: "clustering", stage: "clustering", inputIds: {}, dependencies: {}, data: { model: "model", itemIds: [] } },
        { id: "rewrite", stage: "rewrite", inputIds: {}, dependencies: { source: "clustering" },
          data: { model: "model", itemIds: [], rewriteOf: "clustering" } }],
      states: { clustering: { status: "succeeded", attempts: 1 }, rewrite: { status: "succeeded", attempts: 1 } },
    }, receipts: { clustering, rewrite }, usage: emptyUsage(), recordedAttempts: [] });
    const before = structuredClone(original);
    const projected = await readClusteringClassText({ output: { kind: "directory", path: path.join(directory, "evaluation") } } as EvalConfig, original);
    assert.deepEqual(projected.get("problem"), { label: "计算结果错了", definition: "计算得到的数字不正确。" });
    assert.deepEqual(original, before);
    original.events[0].detail.submission_id = "changed-submission";
    await assert.rejects(readClusteringClassText({ output: { kind: "directory", path: directory } } as EvalConfig, original), /收据身份已改变/);
    await writeJson(locateRun(run).stateFile, { kind: "clustering-job", manifest: {
      runId: "standalone", config: { clusteringJob: { sources: [] } },
      tasks: [{ id: "clustering", stage: "clustering", inputIds: {}, dependencies: {}, data: { model: "model", itemIds: [] } }],
      states: { clustering: { status: "pending", attempts: 0 } },
    }, receipts: {}, usage: emptyUsage(), recordedAttempts: [] });
    assert.deepEqual((await readClusteringClassText({ output: { kind: "directory", path: directory } } as EvalConfig, original)).get("problem"),
      { label: "算术核验偏差", definition: "计算中存在错误。" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
