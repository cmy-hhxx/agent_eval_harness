import { ValidationError, type AgentRequest, type ToolAudit, type ValidationIssue } from "@eval/contracts";
import { comparisonReferenceIssues } from "./submission-checks.js";
import { resolveComparison } from "./resolve.js";
import { comparisonFinalImageIssues, validateEvaluation } from "./validate.js";
import { comparisonSlots, resolveSourceReviews } from "./slots.js";

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** A prose or unrelated schema error cannot hide known review-cell scope errors. */
function sourceReviewIssues(request: AgentRequest, draft: unknown): ValidationIssue[] {
  const rows = object(draft)?.comparisons;
  if (!Array.isArray(rows) || rows.length !== comparisonSlots(request).length) return [];
  const labels = Object.keys(request.sources);
  const reviews = rows.map(row => Object.fromEntries(labels.map(label => {
    const value = object(object(object(row)?.assessments)?.[label])?.source_review;
    return [label, typeof value === "string" ? value : null];
  })));
  try { resolveSourceReviews(request, reviews, "/comparisons"); }
  catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    return error.issues ?? [];
  }
  return [];
}

/** Aggregate dependent decision feedback once reference errors can be resolved safely. */
export function comparisonSubmissionIssues(request: AgentRequest, draft: unknown, audit: ToolAudit): ValidationIssue[] {
  const independent = [...comparisonReferenceIssues(request, draft), ...comparisonFinalImageIssues(request, audit), ...sourceReviewIssues(request, draft)];
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
