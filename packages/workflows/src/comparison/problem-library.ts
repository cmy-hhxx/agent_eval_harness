import path from "node:path";
import type { ProblemLibrary, RunState } from "@eval/contracts";
import { problemLibraryFile, readProblemLibrary, withProblemLibraryLock, writeProblemLibrary } from "@eval/data";
import { applyClustering, countProblemSamples, effectiveProblemOccurrences, emptyLibrary, problemSampleKey, type ClusteringResult } from "@eval/agents/clustering";
import type { EvalConfig, TaskData } from "./types.js";
import { taskObservations } from "./observations.js";

export interface ProblemLibraryStats {
  components: number;
  classes: number;
  occurrences: number;
  assigned: number;
  proposed_new_classes: number;
  merged_classes: number;
}

/**
 * Fold accepted clustering receipts into each model's problem library. Reapplying receipts is
 * idempotent; merges update class/occurrence lineage without duplicating events or samples.
 */
export async function syncProblemLibrary(
  state: RunState,
): Promise<Record<string, ProblemLibraryStats>> {
  const config = state.manifest.config as EvalConfig;
  // Accepted receipts remain part of the run even when clustering is disabled for future work.
  const byModel = new Map<string, typeof state.manifest.tasks>();
  for (const task of state.manifest.tasks) {
    if (task.stage !== "clustering") continue;
    const scope = (task.data as TaskData).scope;
    if (!scope) throw new Error(`聚类任务缺少范围：${task.id}`);
    byModel.set(scope.version, [...(byModel.get(scope.version) ?? []), task]);
  }
  const stats: Record<string, ProblemLibraryStats> = {};
  const staged: { file: string; library: ProblemLibrary }[] = [];
  const models = [...byModel.keys()].sort();
  // Hold model locks in a fixed order until every cap has been checked; a failing model cannot
  // partially commit the other models in this report.
  const apply = async (index: number): Promise<void> => {
    if (index === models.length) {
      for (const { file, library } of staged) await writeProblemLibrary(file, library);
      return;
    }
    const model = models[index]!;
    await withProblemLibraryLock(config.problemLibrary, model, async () => {
      const tasks = byModel.get(model)!;
      const file = problemLibraryFile(config.problemLibrary, model);
      const saved = await readProblemLibrary(file);
      let library: ProblemLibrary = saved ?? emptyLibrary(model);
      if (library.model !== model) throw new Error(`问题库模型身份不一致：${model}`);
      let applied = false, changed = false, proposed = 0, merged = 0;
      const assigned = new Set<string>();
      for (const task of tasks) {
        const receipt = state.receipts[task.id];
        if (!receipt) continue;
        const scope = (task.data as TaskData).scope!;
        const result = receipt.evaluation as ClusteringResult;
        const observations = taskObservations(task, (id) => state.receipts[id], {
          run: path.join(config.output.path, state.manifest.runId), run_id: state.manifest.runId,
        });
        const before = library;
        library = applyClustering(library, {
          run_id: state.manifest.runId,
          evaluator_version: receipt.evaluatorVersion,
          task_id: task.id,
          submission_id: receipt.submissionId,
          version: model,
          batch_id: scope.batch_id,
          observations,
          result,
        });
        changed ||= library !== before;
        const items = new Map(observations.map(observation => [observation.id, observation]));
        for (const assignment of result.assignments)
          if (assignment.deferred_reason === undefined)
            for (const ref of items.get(assignment.item_id)?.refs ?? []) assigned.add(problemSampleKey(ref));
        proposed += result.new_classes.length;
        merged += result.merges.reduce((total, merge) => total + merge.from.length, 0);
        applied = true;
      }
      const classes = Object.values(library.classes).filter((problem) => problem.status === "active").length;
      const components = Object.keys(library.components).length;
      if (applied) {
        // Plan budgets can become stale across runs; check the current library under the lock.
        if (classes > config.clustering.maxClassesPerModel)
          throw new Error(`问题库 ${model} 归类后有 ${classes} 个活跃类，超过上限 ${config.clustering.maxClassesPerModel}；请先合并或调高 maxClassesPerModel`);
        if (components > config.clustering.maxComponentsPerModel)
          throw new Error(`问题库 ${model} 有 ${components} 个组件，超过上限 ${config.clustering.maxComponentsPerModel}；请调高 maxComponentsPerModel`);
        if (changed || !saved) staged.push({ file, library });
      }
      stats[model] = {
        components,
        classes,
        occurrences: countProblemSamples(effectiveProblemOccurrences(library)),
        assigned: assigned.size,
        proposed_new_classes: proposed,
        merged_classes: merged,
      };
      await apply(index + 1);
    });
  };
  await apply(0);
  return stats;
}
