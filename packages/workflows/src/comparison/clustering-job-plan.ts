import { randomUUID } from "node:crypto";
import type { PlannedTask, RunState } from "@eval/contracts";
import type { ClusteringObservation, ClusteringResult } from "@eval/agents/clustering";
import { jobMaterial, type ClusteringJobConfig, type ClusteringJobTask } from "./clustering-job-types.js";

/** Keep components separate, and never split one observation's independent-answer support. */
export function planClusteringTasks(model: string, observations: ClusteringObservation[], config: ClusteringJobConfig,
  previous?: string, revisit = false): PlannedTask[] {
  const buckets = new Map<string, ClusteringObservation[]>();
  for (const item of observations) buckets.set(item.component, [...buckets.get(item.component) ?? [], item]);
  const shards: string[][] = [];
  for (const [, items] of [...buckets].sort(([a], [b]) => a.localeCompare(b))) {
    let ids: string[] = [], answers = new Set<string>();
    for (const item of items) {
      const combined = new Set([...answers, ...item.refs.map(ref => ref.input_id)]);
      if (ids.length && combined.size > config.clustering.maxCasesPerTask) {
        shards.push(ids); ids = []; answers = new Set();
      }
      ids.push(item.id);
      item.refs.forEach(ref => answers.add(ref.input_id));
    }
    if (ids.length) shards.push(ids);
  }
  const tasks: PlannedTask[] = [];
  for (const [index, itemIds] of [...shards, ...(!revisit && !config.clusteringJob.assignmentOnly && shards.length ? [[]] : [])].entries()) {
    const id = randomUUID(), data: ClusteringJobTask = { model, itemIds, reclassify: true,
      ...(revisit ? { revisit: true } : index === shards.length ? { consolidate: true } : {}) };
    tasks.push({ id, stage: "clustering", dependencies: previous ? { previous } : {}, inputIds: {}, data });
    if (config.rewrite.clustering) tasks.push({ id: randomUUID(), stage: "rewrite",
      dependencies: { source: id }, inputIds: {}, data: { ...data, rewriteOf: id } });
    if (!revisit && !config.clusteringJob.assignmentOnly) previous = id;
  }
  return tasks;
}

/** After directory consolidation, retry deferred observations once against the final directory. */
export function planDeferredRecall(task: PlannedTask, state: RunState, inputs: Record<string, unknown>): PlannedTask[] {
  const data = task.data as ClusteringJobTask;
  if (task.stage !== "clustering" || !data.consolidate || !data.reclassify ||
      state.manifest.tasks.some(next => (next.data as ClusteringJobTask).revisit &&
        (next.data as ClusteringJobTask).model === data.model)) return [];
  const decisions = new Map<string, boolean>();
  for (const previous of state.manifest.tasks) {
    const receipt = state.receipts[previous.id];
    if (previous.stage !== "clustering" || (previous.data as ClusteringJobTask).model !== data.model || !receipt) continue;
    for (const assignment of (receipt.evaluation as ClusteringResult).assignments)
      decisions.set(assignment.item_id, assignment.deferred_reason !== undefined);
  }
  const material = jobMaterial(inputs, data.model);
  return planClusteringTasks(data.model, material.observations.filter(item => decisions.get(item.id)),
    material.config, task.id, true);
}
