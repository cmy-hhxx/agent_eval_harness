/** Source text is task-local; offsets use Unicode code points, matching the supplied skill. */
export interface ReviewCase {
  case_id: string;
  task_question: string;
  candidate_output_id: string;
  evidence: Record<string, string>;
  availability: Record<string, "available" | "partial" | "not_collected" | "unavailable">;
  public_requirements: { question: string };
  /** Trusted task-local proof from the preceding Score evidence pass; never model-authored. */
  review_seed?: ReviewAudit;
}
export interface ReviewQuote {
  evidence_id: string; source_id: string; start: number; end: number; quote: string;
}
export interface ReviewAudit {
  quotes: ReviewQuote[];
  sources: { id: string; content: string; record: Record<string, unknown> }[];
  actions: { kind: string; args: unknown; at: string; result?: unknown; error?: string }[];
  viewed: string[];
  searches: { id: string; result: Record<string, unknown> }[];
}
