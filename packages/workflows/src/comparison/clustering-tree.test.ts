import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ProblemLibrary, ProblemObservationRef } from "@eval/contracts";
import { emptyLibrary } from "@eval/agents/clustering";
import { projectClusteringTree } from "./clustering-tree.js";
import type { ClusteringJobConfig, ClusteringJobSource } from "./clustering-job-types.js";

function fixture() {
  const model = "aime_fast", inputId = randomUUID();
  const source: ClusteringJobSource = { run: "/source", run_id: "answers", task_id: randomUUID(), submission_id: randomUUID(),
    evaluator_version: "fixture", input_id: inputId, model, batch_id: "day", case_id: "case", source: { file: "/source.jsonl", line: 1 } };
  const { run, run_id, task_id, submission_id, evaluator_version } = source;
  const components = ["planner-finquery / 工具请求参数 / 动作参数生成", "finquery / 原始返回及字段含义 / 实体映射"];
  const ref: ProblemObservationRef = { version: model, input_id: inputId, finding_id: "f0", batch_id: "day", case_id: "case",
    source: source.source, attribution: { run, run_id, task_id, submission_id, evaluator_version },
    components, evidence_status: "established", importance: "high", summary: "返回不完整且结论缺少支持。" };
  const config = { clusteringJob: { sources: [source, { ...source, input_id: randomUUID(), task_id: randomUUID(),
    submission_id: randomUUID(), case_id: "healthy", source: { file: "/source.jsonl", line: 2 } }] } } as ClusteringJobConfig;
  const inputs = { [model]: { pending: [ref] } };
  const library = emptyLibrary(model);
  components.forEach((label, index) => {
    const componentId = randomUUID(), classId = randomUUID();
    library.components[componentId] = { id: componentId, label, definition: "", aliases: [], first_seen: null };
    library.classes[classId] = { id: classId, component_id: componentId, label: "问题" + index, definition: "机制边界" + index,
      aliases: [], status: "active", merged_into: null, first_seen: null, category_paths: [["可靠性"]] };
    library.occurrences.push({ id: randomUUID(), class_id: classId, version: model, evaluator_version: "fixture", batch_id: "day",
      case_id: "case", input_id: inputId, run_id: "cluster", task_id: randomUUID(), submission_id: randomUUID(),
      attribution: ref.attribution, finding_id: ref.finding_id, evidence_status: ref.evidence_status, message_index: 1,
      source: ref.source, classification: "created", previous_class_id: null, at: new Date(0).toISOString() });
  });
  return { config, inputs, library, ref };
}

test("multi-responsibility tree counts findings once per node and keeps healthy answers in cohort coverage", () => {
  const f = fixture(), tree = projectClusteringTree(f.config, f.inputs, [f.library]);
  assert.equal(tree[0].count, 1);
  assert.equal(tree[0].meta.answer_ids.length, 2);
  const leaves = tree.filter(node => node.level === 3);
  assert.equal(leaves.length, 2);
  assert(leaves.every(node => node.count === 1 && node.samples?.[0].components.length === 1));
  const historical = structuredClone(f.library.occurrences[0]);
  historical.id = randomUUID(); historical.attribution!.task_id = randomUUID();
  f.library.occurrences.push(historical);
  assert.deepEqual(projectClusteringTree(f.config, f.inputs, [f.library]), tree);
});

test("uncertain rare problems remain in a separate pending branch without invented class IDs or support", () => {
  const f = fixture();
  f.ref.evidence_status = "uncertain";
  f.library.occurrences = [];
  f.library.pending_observations = [f.ref];
  const tree = projectClusteringTree(f.config, f.inputs, [f.library]);
  assert.equal(tree[0].established_count, 0);
  assert.equal(tree[0].uncertain_count, 1);
  assert.equal(tree.filter(node => node.meta.kind === "pending").length, 2);
  assert(tree.filter(node => node.level === 3).every(node => !node.class_code && node.established_answer_ids.length === 0));
  f.library.pending_observations = [];
  assert.throws(() => projectClusteringTree(f.config, f.inputs, [f.library]), /既未归类也未列入待观察/);
});

test("tree rejects changed source receipts and exposes all-healthy cohorts without creating issue branches", () => {
  const f = fixture();
  f.library.occurrences[0].attribution = { ...f.ref.attribution, submission_id: randomUUID() };
  assert.throws(() => projectClusteringTree(f.config, f.inputs, [f.library]), /冻结归因不一致/);
  const healthy = { aime_fast: { pending: [] } };
  const tree = projectClusteringTree(f.config, healthy, [emptyLibrary("aime_fast") as ProblemLibrary]);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].count, 0);
  assert.equal(tree[0].meta.answer_ids.length, 2);
});
