import { ValidationError, type AgentRequest, type ToolAudit, type ValidationIssue } from "@eval/contracts";
import { correctnessEvidenceScopeIssues, peerFinalSubmissionIssues, resolveAttributionEvidence } from "./source-evidence.js";
import type { Evidence } from "./types.js";
import { responsibilityIssues } from "./responsibility.js";
import { submissionFindingEntries } from "./norm-directory.js";

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Resolve recognizable references independently of unrelated schema and coverage failures. */
export function submissionEvidenceIssues(request: AgentRequest, draft: unknown, audit: ToolAudit): ValidationIssue[] {
  const value = object(draft);
  if (!value) return [];
  const issues: ValidationIssue[] = [];
  const check = (refs: unknown, path: string) => {
    if (!Array.isArray(refs)) return undefined;
    return refs.map((item, index): Evidence | undefined => {
      const ref = object(item);
      if (!ref || typeof ref.evidence_id !== "string") return;
      try {
        const evidence = resolveAttributionEvidence(request, ref as { evidence_id: string; observation?: unknown }, audit, `${path}/${index}`);
        issues.push(...peerFinalSubmissionIssues(request, evidence, `${path}/${index}`));
        return evidence;
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        issues.push(...error.issues!);
      }
    });
  };
  const correctness = check(value.correctness_evidence, "/correctness_evidence");
  if (correctness) issues.push(...correctnessEvidenceScopeIssues(request, correctness, value.numeric_checks));
  for (const field of ["criterion_assessments"] as const) {
    const entries = value[field];
    if (Array.isArray(entries)) entries.forEach((entry, index) => {
      check(object(entry)?.evidence, `/${field}/${index}/evidence`);
    });
  }
  for (const { finding, path } of submissionFindingEntries(value)) {
    const selected = check(finding.evidence, `${path}/evidence`);
    if (selected) issues.push(...responsibilityIssues(request, finding.problem, selected, `${path}/problem`));
  }
  if (Array.isArray(value.table_resolutions)) value.table_resolutions.forEach((entry, index) => {
    check(object(entry)?.evidence, `/table_resolutions/${index}/evidence`);
  });
  return issues;
}
