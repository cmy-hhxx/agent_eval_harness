import type { AgentRequest } from "@eval/contracts";
import { attributionTableReview } from "@eval/agents/attribution";
import type { ComparisonInput, SourceReviewItem } from "@eval/agents/comparison";

type TableReview = ReturnType<typeof attributionTableReview>;

/** Text matching supplies reading hints; only invalid material can block the agent's judgment. */
export function comparisonSourceReview(request: AgentRequest, reviews: Record<string, TableReview>): Record<string, SourceReviewItem[]> {
  const input = request.input as unknown as ComparisonInput;
  const labels = Object.keys(input.candidates);
  return Object.fromEntries(labels.flatMap((label) => {
    const review = reviews[label];
    const items: SourceReviewItem[] = [
      ...(review?.errors ?? []).map(issue => ({ kind: "invalid_material" as const,
        reason: issue.message, requires_review: true })),
      ...(review?.concerns ?? []).map(concern => ({ kind: concern.kind, reason: concern.reason,
        requires_review: false })),
    ];
    return items.length ? [[label, items]] : [];
  }));
}
