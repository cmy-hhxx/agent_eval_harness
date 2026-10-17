import path from "node:path";
import { safeId, type JsonObject, type ProblemLibrary, type RewrittenResult, type RunState, type SubmissionReceipt } from "@eval/contracts";
import { normalizeLabel, type ClusteringResult } from "@eval/agents/clustering";
import { locateRun, readJson } from "@eval/data";
import { readRunTasks } from "./run-data.js";
import { clusteringJobStorage } from "./clustering-job-codec.js";
import { acceptedRewriteProjection } from "./rewrite-projection.js";
import type { Checkpoint } from "./checkpoint.js";
import type { EvalConfig, TaskData } from "./types.js";

export interface ClusteringDisplaySource {
  receipt: SubmissionReceipt;
  rewritten?: RewrittenResult;
}
export interface ClusteringClassText {
  label: string;
  definition: string;
}

/** The two current workflows store Rewrite dependencies differently; presentation shares one projection. */
export function clusteringDisplaySources(state: RunState): ClusteringDisplaySource[] {
  const tasks = state.manifest.tasks.map(task => {
    const data = task.data as JsonObject, target = data.rewriteOf;
    return task.stage === "rewrite" && typeof target === "string"
      ? { ...task, data: { ...data, rewriteOf: { taskId: target, stage: "clustering" } } } : task;
  });
  const view = { ...state, manifest: { ...state.manifest, tasks } };
  return tasks.flatMap(task => {
    const receipt = state.receipts[task.id];
    if (task.stage !== "clustering" || !receipt) return [];
    return [{ receipt, rewritten: acceptedRewriteProjection(view, task.id)?.rewritten ??
      (receipt.evaluation as ClusteringResult).rewritten }];
  });
}

/** Class UUIDs and original definitions decide identity; polished text is never written into the library. */
export function clusteringClassText(library: ProblemLibrary, sources: ClusteringDisplaySource[]): Map<string, ClusteringClassText> {
  const texts = new Map(Object.values(library.classes).map(item => [item.id, { label: item.label, definition: item.definition }]));
  const matches = (item: { label: string; aliases: string[] }, label: string) =>
    [item.label, ...item.aliases].some(value => normalizeLabel(value) === normalizeLabel(label));
  for (const { receipt, rewritten } of [...sources].sort((a, b) => a.receipt.acceptedAt - b.receipt.acceptedAt)) {
    if (!rewritten) continue;
    const result = receipt.evaluation as ClusteringResult;
    const rewrites = new Map(rewritten.rewrites.map(item => [item.id, item.text]));
    const apply = (id: string, source: { label?: string; definition?: string }, prefix: string) => {
      const original = library.classes[id], display = texts.get(id);
      if (!original || !display) return;
      for (const field of ["label", "definition"] as const) {
        const polished = rewrites.get(`${prefix}.${field}`);
        // A later semantic update invalidates an earlier field's wording, even if its alias remains.
        if (polished && source[field] === original[field]) display[field] = polished;
      }
    };
    result.new_classes.forEach((item, index) => {
      const components = Object.values(library.components).filter(component => matches(component, item.component));
      const candidates = Object.values(library.classes).filter(problem =>
        components.some(component => component.id === problem.component_id) && matches(problem, item.label));
      if (candidates.length === 1) apply(candidates[0].id, item, `new_classes.${index}`);
    });
    result.class_updates?.forEach((item, index) => apply(item.class_id, item, `class_updates.${index}`));
  }
  return texts;
}

/** Load only the library's referenced clustering tasks and their text rewrites; raw answers stay in the sources. */
export async function readClusteringClassText(config: EvalConfig, library: ProblemLibrary): Promise<Map<string, ClusteringClassText>> {
  const directories = new Map<string, string>();
  for (const item of library.occurrences)
    directories.set(item.run_id, item.clustering_run ?? path.join(config.output.path, safeId(item.run_id)));
  for (const item of library.events)
    if (typeof item.detail.run_id === "string" && typeof item.detail.run === "string")
      directories.set(item.detail.run_id, item.detail.run);
  const tasks = new Map<string, { runId: string; submissions: Map<string, string> }>();
  const add = (runId: string, taskId: string, submissionId: string) => {
    const directory = directories.get(runId) ?? path.join(config.output.path, safeId(runId));
    const selected = tasks.get(directory) ?? { runId, submissions: new Map<string, string>() };
    if (selected.runId !== runId || selected.submissions.has(taskId) && selected.submissions.get(taskId) !== submissionId)
      throw new Error("问题库的聚类展示来源身份不一致：" + directory);
    selected.submissions.set(taskId, submissionId); tasks.set(directory, selected);
  };
  for (const item of library.occurrences)
    if (item.classification === "created") add(item.run_id, item.task_id, item.submission_id);
  for (const item of library.events)
    if (typeof item.detail.run_id === "string" && typeof item.detail.task_id === "string" && typeof item.detail.submission_id === "string")
      add(item.detail.run_id, item.detail.task_id, item.detail.submission_id);
  const sources = await Promise.all([...tasks].map(async ([run, selected]): Promise<ClusteringDisplaySource[]> => {
    const ids = new Set(selected.submissions.keys());
    let saved: Checkpoint | { kind: "clustering-job" };
    try { saved = await readJson(locateRun(run).stateFile); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    let state: RunState;
    try {
      if ("kind" in saved && saved.kind === "clustering-job") state = await clusteringJobStorage.readRun(run);
      else {
        const checkpoint = saved as Checkpoint;
        if (checkpoint.format !== "evaluation-run") throw new Error("聚类展示来源的运行状态无效：" + run);
        const rewrites = Object.entries(checkpoint.tasks).flatMap(([id, task]) =>
          task.stage === "rewrite" && ids.has((task.data as TaskData).rewriteOf!.taskId) ? [id] : []);
        state = await readRunTasks(run, [...ids, ...rewrites]);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (state.manifest.runId !== selected.runId) throw new Error("聚类展示来源的 run ID 不一致：" + run);
    for (const [id, submissionId] of selected.submissions)
      if (state.receipts[id] && state.receipts[id].submissionId !== submissionId)
        throw new Error("聚类展示来源收据身份已改变：" + run + "/" + id);
    return clusteringDisplaySources(state).filter(source => ids.has(source.receipt.taskId));
  }));
  return clusteringClassText(library, sources.flat());
}
