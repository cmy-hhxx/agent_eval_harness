import type { RunManifest, RunState, SubmissionReceipt, TaskState } from "@eval/contracts";
import type { Candidate, Stage, TaskData } from "./types.js";

type DiskReference = { file?: string; comparisonId?: string; taskId?: string };
export type Patch = { path: string[]; value?: unknown; from?: string[] }[];
export type SavedReceipt = Omit<SubmissionReceipt, "exported" | "evaluation" | "submitted"> & {
  evaluation?: unknown;
  evaluationPatch?: Patch;
  submittedPatch?: Patch;
  rewriteIds?: string[];
  exported?: DiskReference;
};
export type SavedTask = TaskState & {
  stage: Stage;
  inputIds: Record<string, string>;
  dependencies: Record<string, string>;
  data: Omit<TaskData, "candidates" | "referenceCandidates" | "stage" | "revision">;
  receipt?: SavedReceipt;
};
export interface Checkpoint extends Omit<RunManifest, "tasks" | "states" | "inputs" | "inputCatalog"> {
  inputs: Record<string, Omit<Candidate, "input_id">>;
  tasks: Record<string, SavedTask>;
  usage: RunState["usage"];
  recordedAttempts: number;
}
