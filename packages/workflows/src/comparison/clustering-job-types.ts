import type { AttributionSource, JsonObject, ProblemProjection } from "@eval/contracts";
import type { ClusteringObservation } from "@eval/agents/clustering";
import type { EvalConfig } from "./types.js";

export interface ClusteringJobSource extends AttributionSource {
  model: string;
  batch_id: string;
  case_id: string;
  input_id: string;
  source: { file: string; line: number };
}
export interface ClusteringJobConfig extends EvalConfig {
  clusteringJob: { runs: string[]; sources: ClusteringJobSource[] };
}
export interface ClusteringJobTask {
  model: string;
  itemIds: string[];
  /** Rewrite tasks point to their accepted clustering result. */
  rewriteOf?: string;
  /** A final directory pass after all shards of this model have settled. */
  consolidate?: true;
}
export interface ClusteringJobMaterial {
  observations: ClusteringObservation[];
  library: ProblemProjection;
  config: ClusteringJobConfig;
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
  return [...new Set(jobMaterial(inputs, data.model).config.clusteringJob.sources
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
