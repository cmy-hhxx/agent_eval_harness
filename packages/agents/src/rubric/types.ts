import type { ResolvedEvidence } from "@eval/contracts";

/** The four states the standard allows; every item declares its own subset. */
export type RubricState = "pass" | "partial" | "fail" | "na";
export type RubricJudge = "model" | "program" | "program+model" | "trace";
export type RubricNeed = "qa" | "trace" | "user_context";
export type RubricAvailability = "available" | "partial" | "not_collected" | "unavailable";

/** One standard item handed to the judge; wording is copied verbatim from the rubric. */
export interface RubricChecklistItem {
  index: number;
  item_id: string;
  source: "generic" | "category";
  kind?: "gate" | "quality";
  grp?: string;
  criterion: string;
  fail: string;
  pass?: string;
  partial?: string;
  states: RubricState[];
  na_when: string | null;
  needs: RubricNeed[];
  judge: RubricJudge;
}

/** The only category material the judge sees: the standard's own definition for the label. */
export interface RubricCategory {
  id: string;
  name: string;
  l1: string;
  l1_name: string;
  definition: string;
  core: string;
}

/** Host-assembled trusted material for one trace. Trace bodies are never included. */
export interface RubricCase {
  case_id: string;
  trace_index: number;
  batch_id: string;
  version: string;
  category: RubricCategory;
  task_question: string;
  answer: string;
  answer_language?: string;
  availability: { answer: RubricAvailability; trace: RubricAvailability; user_context: RubricAvailability };
  checklist: RubricChecklistItem[];
}

export interface RubricVerdict {
  item_index: number;
  item_id: string;
  source: "generic" | "category";
  kind?: "gate" | "quality";
  state: RubricState;
  reason: string;
  na_reason?: string;
  evidence: ResolvedEvidence[];
}

/** Per-trace checklist result; state counts only, never a score. */
export interface RubricResult {
  case_id: string;
  trace_index: number;
  batch_id: string;
  version: string;
  category_id: string;
  category_name: string;
  l1_id: string;
  l1_name: string;
  checklist_size: number;
  counts: Record<RubricState, number>;
  verdicts: RubricVerdict[];
}
