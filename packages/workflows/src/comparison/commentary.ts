import type { JsonObject, PlannedTask } from "@eval/contracts";
import type { RewriteItem, Rewrites } from "@eval/agents/rewrite";
import { display } from "./results.js";
import type { AttributionResult, ComparisonResult, TaskData } from "./types.js";
import { decideVerdict, tierOf, verdictReason } from "./verdicts.js";

/** Accepted rewrites addressed by source task; report rendering only reads from it. */
export interface CommentaryLookup {
  of(sourceTaskId: string | undefined): Rewrites | undefined;
}
/** Stable slot id for one two-way reason; label order does not matter. */
export function verdictSlotId(first: string, second: string): string {
  return `verdict.${[first, second].sort().join("__vs__")}.reason`;
}
export function attributionSlots(result: AttributionResult): RewriteItem[] {
  const items: RewriteItem[] = [{ id: "summary", label: "回答结论", text: result.summary }];
  if (result.correctness_reason.trim())
    items.push({
      id: "correctness_reason",
      label: result.is_correct === false ? "判错理由" : "判对理由",
      text: result.correctness_reason,
    });
  return items;
}
export function comparisonSlots(result: ComparisonResult): RewriteItem[] {
  const items: RewriteItem[] = Object.entries(result.assessments).map(([label, assessment]) => ({
    id: `assessment.${label}.summary`,
    label: `候选${label} 结论`,
    text: assessment.summary,
  }));
  items.push({ id: "tradeoff", label: "权衡说明", text: result.decision_basis.tradeoff });
  const labels = result.ranking.flat();
  const tiers = tierOf(result.ranking);
  for (let i = 0; i < labels.length; i++)
    for (let j = i + 1; j < labels.length; j++) {
      const first = labels[i]!,
        second = labels[j]!;
      items.push({
        id: verdictSlotId(first, second),
        label: `候选${first} 与候选${second} 的两两结论`,
        text: verdictReason(
          decideVerdict(
            result.assessments[first]?.meets_core ?? false,
            result.assessments[second]?.meets_core ?? false,
            tiers.get(first) ?? 0,
            tiers.get(second) ?? 0,
          ),
          first,
          second,
        ),
      });
    }
  return items;
}
export function sourceSlots(stage: "attribution" | "comparison", result: unknown): RewriteItem[] {
  return stage === "attribution"
    ? attributionSlots(result as AttributionResult)
    : comparisonSlots(result as ComparisonResult);
}
/** Presentation-only view of an exported comparison row with own and dependency rewrites applied. */
export function polishComparisonRow(
  row: JsonObject,
  task: PlannedTask,
  names: Record<string, string>,
  commentary: CommentaryLookup,
): JsonObject {
  const data = task.data as TaskData;
  const own = commentary.of(task.id);
  const sourceRewrites = Object.fromEntries(
    Object.entries(data.candidates).map(([label]) => [label, commentary.of(task.dependencies[label])]),
  );
  if (!own && !Object.values(sourceRewrites).some(Boolean)) return row;
  const labels = Object.fromEntries(
    Object.entries(data.candidates).map(([label, candidate]) => [label, names[candidate.version] || candidate.name]),
  );
  const view = structuredClone(row);
  const assessments = view.assessments as Record<string, { summary: string }>;
  const evaluations = view.evaluations as Record<string, { summary: string; correctness_reason: string }>;
  for (const [label, candidate] of Object.entries(data.candidates)) {
    const assessmentText = own?.[`assessment.${label}.summary`];
    if (assessmentText && assessments[candidate.version])
      assessments[candidate.version]!.summary = display(assessmentText, labels);
    const attribution = sourceRewrites[label];
    const review = evaluations[candidate.version];
    if (!attribution || !review) continue;
    if (attribution.summary) review.summary = display(attribution.summary, labels);
    if (attribution.correctness_reason)
      review.correctness_reason = display(attribution.correctness_reason, { A: labels[label]! });
  }
  if (own?.tradeoff)
    (view.decision_basis as { tradeoff: string }).tradeoff = display(own.tradeoff, labels);
  const labelOf = new Map(
    Object.entries(data.candidates).map(([label, candidate]) => [candidate.version, label]),
  );
  const verdicts = view.verdicts as Record<string, { reason: string }>;
  for (const [pair, verdict] of Object.entries(verdicts)) {
    const [firstVersion, secondVersion] = pair.split("__vs__");
    const first = labelOf.get(firstVersion!),
      second = labelOf.get(secondVersion!);
    if (!first || !second) continue;
    const text = own?.[verdictSlotId(first, second)];
    if (text) verdict.reason = display(text, labels);
  }
  return view;
}
