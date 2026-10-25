export type ReviewStatus = "met" | "violated" | "unverified" | "not_applicable";
export type Applicability = "task_requirement" | "observed_behavior" | "both" | "undetermined" | "not_triggered";
export interface HostBasis { pointer: string; value: unknown; rule_id: "no_public_or_observed_trigger" | "unknown_trigger" | "missing_observation" }
export interface Judgment { status: ReviewStatus; reason: string; evidence_ids: string[]; host_basis?: HostBasis[] }
export interface Rating extends Judgment { grade: string; score: number | null; score_range: [number,number] | null }
export interface Diagnostic extends Judgment { diagnostic_id: string; diagnostic_name: string; applicability: Applicability }
export interface Unit extends Rating { item_id: string; item_name: string; applicability: Applicability }
export interface ScoreFinding { finding_id: string; affected_item_ids: string[]; description: string; component: "candidate_output"|"tool_call"|"tool_service"|"capture"|"public_rule"|"unknown"; attribution: "established"|"hypothesis"|"unknown"; primary_diagnostic_id: string; diagnostic_ids: string[]; evidence_ids: string[]; unmapped_reason?: string|null }
export interface ScoreResult { case_id: string; final_answer_score: Rating & {finding_ids:string[]}; evaluations: Unit[]; diagnostics: Diagnostic[]; findings: ScoreFinding[]; evidence: import("@eval/contracts").ReviewQuote[]; explicit_probability: number|null; probability_evidence_ids:string[] }
export interface ScoreException {case_id:string;assessment_status:"needs_material"|"blocked_by_rule_conflict"|"host_empty_response";reason:string;missing_material:string[];affected_units:string[]}
