import { canonical, type AttributionSource, type JsonObject, type ProblemProjection, type ProblemObservationRef, type RunState } from "@eval/contracts";
import type { ClusteringObservation } from "@eval/agents/clustering";
import type { EvalConfig } from "./types.js";

/** Application-supplied projection of current workflow sources into the clustering view. */
export type ClusteringRunReader = (run: string, taskIds: string[]) => Promise<RunState>;

export interface ClusteringJobSource extends AttributionSource {
  model: string;
  batch_id: string;
  case_id: string;
  input_id: string;
  source: { file: string; line: number };
}
export interface ClusteringJobConfig extends EvalConfig {
  clusteringJob: { runs: string[]; sources: ClusteringJobSource[]; recall?: ProblemObservationRef[]; assignmentOnly?: boolean };
}
export interface ClusteringJobTask {
  model: string;
  itemIds: string[];
  /** Rewrite tasks point to their accepted clustering result. */
  rewriteOf?: string;
  /** A final directory pass after all shards of this model have settled. */
  consolidate?: true;
  reclassify?: true;
  revisit?: true;
  /** Parallel read-only assignment before serial discovery of unmatched observations. */
  assignmentPass?: true;
  discoveryBarrier?: true;
  discovery?: true;
}
export interface ClusteringJobMaterial {
  observations: ClusteringObservation[];
  library: ProblemProjection;
  config: ClusteringJobConfig;
  pending: ProblemObservationRef[];
}
export function allClusteringJobSources(config: ClusteringJobConfig): ClusteringJobSource[] {
  const sources = new Map(config.clusteringJob.sources.map(source => [source.input_id, source]));
  for (const ref of config.clusteringJob.recall ?? []) {
    const source = { ...ref.attribution, model: ref.version, batch_id: ref.batch_id,
      case_id: ref.case_id, input_id: ref.input_id, source: ref.source };
    const previous = sources.get(ref.input_id);
    if (previous && canonical(previous) !== canonical(source))
      throw new Error("待观察引用与所选归因冲突：" + ref.input_id);
    sources.set(ref.input_id, previous ?? source);
  }
  return [...sources.values()];
}
export const clusteringJobItems = (observations: ClusteringObservation[]) =>
  observations.map(({ id, component, label, count, established_count, uncertain_count, established_answer_ids, refs }) =>
    ({ id, component, label, count, established_count, uncertain_count, established_answer_ids, refs }));
export function jobMaterial(inputs: Record<string, unknown>, model: string): ClusteringJobMaterial {
  const value = inputs[model] as ClusteringJobMaterial | undefined;
  if (!value) throw new Error("聚类作业缺少模型材料：" + model);
  return value;
}
export function jobObservations(inputs: Record<string, unknown>, data: ClusteringJobTask): ClusteringObservation[] {
  const all = jobMaterial(inputs, data.model).observations;
  const selected = new Set(data.itemIds);
  const items = all.filter(item => selected.has(item.id));
  if (items.length !== selected.size || selected.size !== data.itemIds.length)
    throw new Error("聚类作业含缺失或重复的观察引用");
  return items;
}
export function jobBatchIds(inputs: Record<string, unknown>, data: ClusteringJobTask): string[] {
  return [...new Set(allClusteringJobSources(jobMaterial(inputs, data.model).config)
    .filter(source => source.model === data.model).map(source => source.batch_id))].sort();
}
export interface ClusteringJobRow extends JsonObject {
  job_id: string;
  task_id: string;
  submission_id: string;
  evaluator_version: string;
  stage: "clustering" | "rewrite";
  model: string;
  batch_ids: string[];
  source_task_id?: string;
  items: ReturnType<typeof clusteringJobItems>;
  result: unknown;
}
