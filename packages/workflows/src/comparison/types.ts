import type { Candidate, EvaluationConfig } from "../inputs/types.js";
import type { ProblemLibraryTarget, ProblemProjection } from "@eval/contracts";
import type { ClusteringBudget } from "@eval/agents/clustering";
import type { PredictionConfig, PredictionMetadata } from "./prediction.js";
export interface EvalConfig extends EvaluationConfig {
  problemLibrary: ProblemLibraryTarget;
  /** Two or three selected models, expanded into independent two-candidate comparisons. */
  comparisons: string[][];
  /** Opt-in independent review of a claimed error in the standard answer. */
  standardAnswerReview?: boolean;
  /** Explicit audit questions for selected cases; never accepted facts or requested verdicts. */
  reviewQuestions?: { batch_id: string; case_id: string; questions: string[] }[];
  prediction?: PredictionConfig;
  /** Language polish targets. Every accepted source result gets one rewrite task. */
  rewrite: {
    comparison: boolean;
    /** Include every comparison cell as well as the verdict reasons. */
    comparisonItems?: boolean;
    attribution: boolean;
    clustering: boolean;
  };
  /** Problem-library maintenance and its hard cardinality limits. */
  clustering: {
    enabled: boolean;
    maxClassesPerModel: number;
    maxNewClassesPerTask: number;
    maxComponentsPerModel: number;
    /** Active class count at which consolidation expands beyond the current observations. */
    consolidateAt: number;
    minSupport: number;
    maxCasesPerTask: number;
  };
}
export interface BatchPreflight {
  cases: number;
  valid_inputs: number;
  attribution_tasks: number;
  comparison_tasks: number;
  comparison_verification_tasks: number;
  skipped_groups: number;
  input_issues: number;
}
export type Stage = "criteria" | "attribution-compact-field" | "attribution-compact" | "attribution-trace" | "attribution-session" |
  "comparison" | "rewrite" | "clustering" | import("../review/dimensions.js").DimensionAttributionStage;
/** The accepted result a rewrite task polishes. */
export interface RewriteSource {
  stage: "attribution" | "comparison" | "clustering";
  taskId: string;
  /** Result id used to join the source JSONL row. */
  resultId: string;
}
/** Business identity for tasks that own no input material. */
export interface TaskCase {
  batch_id: string;
  case_id: string;
  question: string;
}
/** One attribution answer covered by a clustering task. */
export interface ClusteringCase {
  case_id: string;
  source: { file: string; line: number };
}
/** Clustering tasks read attribution receipts through these input ids and budgets. */
export interface ClusteringScope {
  version: string;
  batch_id: string;
  shard: number;
  /** input_id -> answer identity; dependency labels are input ids. */
  cases: Record<string, ClusteringCase>;
  budget: ClusteringBudget;
}
export interface TaskData {
  /** Canonical attribution unit input, retained alongside the comparison candidates map. */
  candidate?: Candidate;
  /** Independent answer retained even when no comparison consumes it. */
  standalone?: boolean;
  initialContextChars?: number;
  stage: Stage;
  candidates: Record<string, Candidate>;
  reference: unknown;
  /** Compared group version IDs, in declaration order. */
  group?: string[];
  comparisonId?: string;
  /** Independent optional verification of this accepted formal comparison. */
  verificationOf?: { taskId: string };
  /** Optional retrospective check; never owns or replaces the formal comparison. */
  verificationAudit?: true;
  /** Registered same-case factual sources available only to an attribution review. */
  referenceCandidates?: Record<string, Candidate>;
  /** Business scope of the shared criteria, including its candidate set. */
  criteriaScope?: string;
  /** Attribution reassessment lineage; accepted source receipts remain unchanged. */
  reviewOf?: { taskId: string; round: number; reasons: string[] };
  /** One independent evidence check before a proposed standard conflict reaches consumers. */
  standardConflictReview?: true;
  standardAnswerReview?: boolean;
  /** User-selected semantic checks, applied equally to the case's candidate answers. */
  reviewQuestions?: string[];
  prediction?: PredictionMetadata;
  /** Present on rewrite tasks; the rewrite owns no input and only edits text slots. */
  rewriteOf?: RewriteSource;
  rewriteNames?: Record<string, string>;
  /** Complete automatic polish or a selected presentation refresh. */
  comparisonRewriteScope?: "verdicts" | "items" | "all";
  /** Explicit subset of source slots for a presentation repair. */
  rewriteSlotIds?: string[];
  rewriteScope?: { batch_id: string; model: string };
  /** Present on rewrite tasks, which carry no candidates. */
  case?: TaskCase;
  /** Present on clustering tasks: the recalled problem-library projection. */
  projection?: ProblemProjection;
  /** Present on clustering tasks, which aggregate attribution receipts per model and batch. */
  scope?: ClusteringScope;
  /** Explicit new classification of deferred observations; the accepted source task is retained. */
  reclassifyOf?: { task_id: string; item_ids: string[] };
  revision?: number;
}
export type { Finding, TaskAnalysis, ComparisonResult } from "@eval/agents/comparison";
export type { SessionAttributionResult, SessionProblem, TraceAttributionResult } from "@eval/agents/attribution";
