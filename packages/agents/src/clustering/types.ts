import type { ProblemProjection } from "@eval/contracts";

export interface ClusteringBudget {
  active_classes: number;
  max_classes: number;
  max_new_classes: number;
  active_components: number;
  max_components: number;
  max_new_components: number;
  consolidate: boolean;
  min_support: number;
}
export interface ClusteringExample {
  finding: string;
  reason: string;
  dimension: string;
  importance: string;
  stage: string;
}
/** One deduplicated problem observation: identical proposals collapsed before clustering. */
export interface ClusteringItem {
  id: string;
  component: string;
  label: string;
  definition: string;
  count: number;
  examples: ClusteringExample[];
}
export interface ClusteringRequest {
  model: string;
  batch_id: string;
  budget: ClusteringBudget;
  library: ProblemProjection;
  items: ClusteringItem[];
}
export interface ClusteringAssignment {
  item_id: string;
  class_id?: string;
  new_class_key?: string;
}
export interface ClusteringNewClass {
  key: string;
  component: string;
  label: string;
  definition: string;
  /** Active class that is most similar; null only when the library is empty. */
  closest_existing: string | null;
  novelty: string;
}
export interface ClusteringMerge {
  into: string;
  from: string[];
  reason: string;
}
export interface ClusteringResult {
  assignments: ClusteringAssignment[];
  new_classes: ClusteringNewClass[];
  merges: ClusteringMerge[];
}
