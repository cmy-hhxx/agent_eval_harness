import { ValidationError, type AgentRequest, type ToolAudit, type ValidationIssue } from "@eval/contracts";
import { comparisonReferenceIssues } from "./submission-checks.js";
import { resolveComparison } from "./resolve.js";
import { comparisonFinalImageIssues, validateEvaluation } from "./validate.js";

/** Aggregate dependent decision feedback once reference errors can be resolved safely. */
export function comparisonSubmissionIssues(request: AgentRequest, draft: unknown, audit: ToolAudit): ValidationIssue[] {
  const independent = [...comparisonReferenceIssues(request, draft), ...comparisonFinalImageIssues(request, audit)];
  if (!independent.length) return [];
  let result;
  try { result = resolveComparison(request, draft); }
  catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    return [...independent, ...(error.issues?.filter(issue => issue.category !== "structure" && issue.code !== "final_image_not_viewed") ?? [])];
  }
  try { validateEvaluation(request, result, audit); }
  catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    return [...independent, ...(error.issues?.filter(issue => issue.category !== "structure" && issue.code !== "final_image_not_viewed") ?? [])];
  }
  return independent;
}
