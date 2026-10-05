import { isDeepStrictEqual } from "node:util";
import type { AgentRequest } from "@eval/contracts";
import { attributionTableReview } from "@eval/agents/attribution";
import { comparisonScope, type ComparisonInput, type SourceReviewItem } from "@eval/agents/comparison";

type TableReview = ReturnType<typeof attributionTableReview>;

/** Missing rows remain unknown; only a separate, proven common failure can make them immaterial to a one-sided core decision. */
export function comparisonSourceReview(request: AgentRequest, reviews: Record<string, TableReview>): Record<string, SourceReviewItem[]> {
  const input = request.input as unknown as ComparisonInput;
  const labels = Object.keys(input.candidates);
  const scope = comparisonScope(request);
  const common = new Set(scope.common_criterion_ids);
  const commonCoreRefs = (label: string, failed: boolean) => {
    const attribution = input.attributions[label];
    if (!attribution || !isDeepStrictEqual(attribution.task_analysis, input.task_analysis)) return [];
    return attribution.core_assessment.criterion_ids.filter(id => {
      if (!common.has(id) || !input.task_analysis.requirements.some(criterion => criterion.id === id)) return false;
      const facts = attribution.criterion_assessments.filter(fact => fact.criterion_id === id);
      return facts.length === 1 && facts[0].evidence_status === "established" &&
        (failed ? ["unmet", "partial"] : ["met", "partial"]).includes(facts[0].status);
    });
  };
  const canKeepUnverifiedWithoutReview = (label: string, review: TableReview) => {
    const attribution = input.attributions[label];
    if (labels.length !== 2 || attribution?.core_assessment.meets_core !== false || review.errors.length ||
      !review.concerns.length || review.concerns.some(concern => concern.kind !== "unverified")) return false;
    const other = labels.find(other => other !== label)!;
    const counterpart = input.attributions[other];
    const otherReview = reviews[other];
    if (counterpart?.core_assessment.meets_core !== true || !otherReview || otherReview.errors.length || otherReview.concerns.length ||
      !commonCoreRefs(other, false).length || counterpart.core_assessment.criterion_ids.some(id => {
        const facts = counterpart.criterion_assessments.filter(fact => fact.criterion_id === id);
        return facts.length !== 1 || facts[0].evidence_status !== "established" || facts[0].status === "unknown";
      })) return false;
    const failed = new Set(commonCoreRefs(label, true));
    if (!failed.size) return false;
    return review.confirmed_conflicts.some(row => row.finding_indices.some(index => {
      const finding = attribution.findings[index];
      const requirementIndex = finding?.assessment.requirement_index;
      const criterion = requirementIndex === null || requirementIndex === undefined ? undefined
        : attribution.task_analysis.requirements[requirementIndex];
      return finding?.type === "problem" && finding.importance === "high" && finding.assessment.evidence_status === "established" &&
        !!criterion && failed.has(criterion.id) && scope.findings[label]?.[index]?.scope === "pair";
    }));
  };
  return Object.fromEntries(Object.entries(reviews).flatMap(([label, review]) => {
    const keepUnknown = canKeepUnverifiedWithoutReview(label, review);
    const items: SourceReviewItem[] = [
      ...review.errors.map(issue => ({ kind: issue.code === "table_conflict_unreported" ? "unresolved_conflict" as const : "invalid_material" as const,
        reason: issue.message, requires_review: true })),
      ...review.concerns.map(concern => ({ kind: concern.kind, reason: concern.reason,
        requires_review: !(keepUnknown && concern.kind === "unverified") })),
    ];
    return items.length ? [[label, items]] : [];
  }));
}
