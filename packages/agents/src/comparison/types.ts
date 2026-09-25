import type { JsonObject } from "@eval/contracts";
export interface Evidence {
  message_index: number;
  quote: string;
}
export interface Finding {
  type: "strength" | "problem";
  dimension: string;
  stage: string;
  importance: "high" | "medium" | "low";
  text: string;
  reason: string;
  evidence: Evidence[];
  assessment: {
    requirement_index: number;
    observation: string;
    evidence_status: "established" | "uncertain";
    impact: string;
  };
  stage_trace?: JsonObject;
}
export interface Review {
  summary: string;
  findings: Finding[];
}
export interface TaskAnalysis {
  task_type: string;
  goal: string;
  requirements: string[];
  scoring_points: string[];
  red_flags: string[];
  timing_analysis: string;
}
export interface FindingRef {
  candidate: string;
  finding_index: number;
}
export interface PairwiseResult {
  verdict: {
    result: "A_better" | "B_better" | "both_good" | "both_bad";
    reason: string;
  };
  evaluations: Record<string, Review>;
  task_analysis: TaskAnalysis;
  decision_basis: {
    decisive_findings: FindingRef[];
    counterevidence: FindingRef[];
    tradeoff: string;
  };
}
