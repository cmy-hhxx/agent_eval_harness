import { type PlannedTask, type RunState, type SubmissionReceipt, type TaskState } from "@eval/contracts";
import { normalizeLabel, type ClusteringResult } from "@eval/agents/clustering";
import { planClusteringTasks } from "./clustering-job-plan.js";
import { jobMaterial, jobObservations, type ClusteringJobTask } from "./clustering-job-types.js";

/** Only untouched suffixes may change phase; paid attempts and accepted decisions keep their identities. */
export function parallelClusteringAssignments(tasks: PlannedTask[], inputs: Record<string, unknown>,
  states: Record<string, TaskState> = {}, receipts: Record<string, SubmissionReceipt> = {}, scope?: string[]): PlannedTask[] {
  const selected = scope && new Set(scope), replacements = new Map<string, PlannedTask>();
  for (const model of Object.keys(inputs)) {
    const material = jobMaterial(inputs, model);
    if (material.config.clusteringJob.assignmentOnly) continue;
    const own = tasks.filter(t => t.stage === "clustering" && (t.data as ClusteringJobTask).model === model);
    if (own.some(t => (t.data as ClusteringJobTask).assignmentPass)) continue;
    const final = own.find(t => (t.data as ClusteringJobTask).consolidate);
    const untouched = (t: PlannedTask) => !receipts[t.id] && !(states[t.id]?.attempts) &&
      (!states[t.id] || ["pending", "blocked"].includes(states[t.id].status)) && (!selected || selected.has(t.id));
    if (!final || !untouched(final)) continue;
    const known = new Set(material.library.components.filter(c => c.classes.length)
      .flatMap(c => [c.label, ...c.aliases].map(normalizeLabel)));
    const candidates = own.slice(0, own.indexOf(final));
    let start = candidates.length;
    while (start > 0) {
      const task = candidates[start - 1], data = task.data as ClusteringJobTask;
      if (!untouched(task) || data.revisit || data.discovery ||
          !jobObservations(inputs, data).every(item => known.has(normalizeLabel(item.component)))) break;
      start--;
    }
    const parallel = candidates.slice(start);
    if (parallel.length < 2) continue;
    const dependencies = parallel[0].dependencies;
    parallel.forEach(task => replacements.set(task.id, { ...task, dependencies: { ...dependencies },
      data: { ...(task.data as ClusteringJobTask), assignmentPass: true } }));
    replacements.set(final.id, { ...final,
      dependencies: Object.fromEntries(parallel.map((task, index) => [`assignment${index}`, task.id])),
      data: { ...(final.data as ClusteringJobTask), discoveryBarrier: true } });
  }
  return tasks.map(task => replacements.get(task.id) ?? task);
}

/** Unmatched observations retain a full discovery pass; the directory cannot mutate before all readers finish. */
export function discoverAfterAssignments(task: PlannedTask, state: RunState, inputs: Record<string, unknown>) {
  const data = task.data as ClusteringJobTask;
  if (task.stage !== "clustering" || !data.assignmentPass) return undefined;
  const final = state.manifest.tasks.find(t => t.stage === "clustering" &&
    (t.data as ClusteringJobTask).model === data.model && (t.data as ClusteringJobTask).discoveryBarrier);
  if (!final || Object.values(final.dependencies).some(id => !state.receipts[id])) return undefined;
  const deferred = new Set(Object.values(final.dependencies).flatMap(id =>
    (state.receipts[id].evaluation as ClusteringResult).assignments.filter(a => a.deferred_reason !== undefined).map(a => a.item_id)));
  const material = jobMaterial(inputs, data.model);
  const planned = planClusteringTasks(data.model, material.observations.filter(item => deferred.has(item.id)), material.config);
  const directory = planned.find(t => (t.data as ClusteringJobTask).consolidate && t.stage === "clustering");
  const followup = planned.filter(t => t.id !== directory?.id && (t.data as ClusteringJobTask).rewriteOf !== directory?.id)
    .map(t => ({ ...t, data: { ...(t.data as ClusteringJobTask), discovery: true } }));
  const shards = followup.filter(t => t.stage === "clustering");
  if (shards.length) shards[0].dependencies = { ...final.dependencies };
  const { discoveryBarrier: _barrier, ...finalData } = final.data as ClusteringJobTask;
  return { tasks: followup, replace: [{ ...final, data: finalData,
    dependencies: shards.length ? { previous: shards.at(-1)!.id } : final.dependencies }] };
}

/** Follow-up discovery is appended after the original barrier; replay must follow dependencies, not array position. */
export function acceptedClusteringOrder(state: RunState): PlannedTask[] {
  const tasks = new Map(state.manifest.tasks.map(task => [task.id, task]));
  const visited = new Set<string>(), visiting = new Set<string>(), ordered: PlannedTask[] = [];
  const visit = (task: PlannedTask) => {
    if (visited.has(task.id)) return;
    if (visiting.has(task.id)) throw new Error("Clustering dependency cycle");
    visiting.add(task.id);
    for (const id of Object.values(task.dependencies)) {
      const dependency = tasks.get(id);
      if (dependency?.stage === "clustering" && state.receipts[id]) visit(dependency);
    }
    visiting.delete(task.id); visited.add(task.id); ordered.push(task);
  };
  for (const task of state.manifest.tasks)
    if (task.stage === "clustering" && state.receipts[task.id]) visit(task);
  return ordered;
}
