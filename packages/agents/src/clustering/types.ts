import type { RewrittenResult } from "@eval/contracts";
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
  evidence_status: "established" | "uncertain";
}
/** One deduplicated problem observation: identical proposals collapsed before clustering. */
export interface ClusteringItem {
  id: string;
  component: string;
  label: string;
  definition: string;
  count: number;
  established_count: number;
  uncertain_count: number;
  /** Confirmed independent answers; class support is the union across assigned items. */
  established_answer_ids: string[];
  examples: ClusteringExample[];
}
export interface ClusteringRequest {
  model: string;
  batch_ids: string[];
  budget: ClusteringBudget;
  library: ProblemProjection;
  items: ClusteringItem[];
}
export interface ClusteringAssignment {
  /** Resolved identities; the model submits request-local O/C references instead. */
  item_id: string;
  class_id?: string;
  new_class_key?: string;
  /** No suitable class within the available creation/support budget. */
  deferred_reason?: string;
}
export interface ClusteringNewClass {
  key: string;
  component: string;
  label: string;
  definition: string;
  /** Most similar active class in the same component; null when that component has no class. */
  closest_existing: string | null;
  novelty: string;
  category_paths: string[][];
}
export interface ClusteringClassUpdate {
  class_id: string;
  label?: string;
  definition?: string;
  category_paths?: string[][];
  reason: string;
}
export interface ClusteringMerge {
  into: string;
  from: string[];
  reason: string;
}
export interface ClusteringResult {
  rewritten?: RewrittenResult;
  assignments: ClusteringAssignment[];
  new_classes: ClusteringNewClass[];
  merges: ClusteringMerge[];
  /** Explicit directory maintenance; source observations and component responsibility stay fixed. */
  class_updates?: ClusteringClassUpdate[];
}

/** Request-local model choices; generated new-class keys belong to the resolved result. */
export interface ClusteringSubmission {
  assignments: Array<Omit<ClusteringAssignment, "new_class_key"> & {
    /** Zero-based position in this submission's new_classes array. */
    new_class_index?: number;
  }>;
  new_classes: Array<Omit<ClusteringNewClass, "key" | "closest_existing"> & {
    /** Required only when this component has active classes to compare. */
    closest_existing?: string | null;
  }>;
  merges: ClusteringMerge[];
  class_updates?: ClusteringClassUpdate[];
}
