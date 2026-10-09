import type { JsonObject, PlannedTask } from "@eval/contracts";
import type { ClusteringResult } from "@eval/agents/clustering";
import type { RewriteItem, Rewrites } from "@eval/agents/rewrite";
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
export function isResourceRow(row: ComparisonResult["decision_basis"]["comparisons"][number]): boolean {
  return !row.criterion_ids.length && Object.values(row.assessments).every(cell => !cell.finding_indices.length);
}
export function attributionSlots(result: AttributionResult): RewriteItem[] {
  const items: RewriteItem[] = [{ id: "summary", label: "回答结论", text: result.summary }];
  if (result.correctness_reason.trim())
    items.push({
      id: "correctness_reason",
      label: result.is_correct === false ? "判错理由" : "判对理由",
      text: result.correctness_reason,
    });
  result.findings.forEach((finding, index) => {
    for (const field of ["text", "reason"] as const)
      items.push({ id: `findings.${index}.${field}`, label: `发现 ${index + 1} · ${field === "text" ? "点评" : "理由"}`, text: finding[field] });
  });
  return items;
}
export function comparisonSlots(result: ComparisonResult, scope: "verdicts" | "items" | "all" = "verdicts"): RewriteItem[] {
  if (scope === "all") return [...comparisonSlots(result, "verdicts"), ...comparisonSlots(result, "items")];
  if (scope === "items") return result.decision_basis.comparisons.flatMap((row, index) =>
    isResourceRow(row) ? [] :
    Object.entries(row.assessments).map(([candidate, assessment]) => ({
      id: `comparison.${index}.${candidate}.summary`,
      label: `${row.aspect} · 【候选${candidate}】的逐项点评（只改写本格）`,
      text: assessment.summary,
      forbiddenPrefixes: [...new Set([
        ...Object.keys(row.assessments).filter((label) => label !== candidate).map((label) => `【候选${label}】：`),
        ...(row.better_candidates.length > 1 ? [row.better_candidates.map((label) => `【候选${label}】`).join("、") + "："] : []),
        "没有已证实的单方优势：", "本项已确定的优势：", "待改写原文：",
      ])],
      context: [
        `本项已确定的优势：${row.better_candidates.length ? row.better_candidates.map((label) => `【候选${label}】`).join("、") : "没有已证实的单方优势"}`,
        ...Object.entries(row.assessments).filter(([label]) => label !== candidate)
          .map(([label, other]) => `同项对照，不能写成本格事实：【候选${label}】：${other.summary}`),
      ].join("\n"),
    })),
  );
  const items: RewriteItem[] = [];
  const labels = result.ranking.flat();
  const tiers = tierOf(result.ranking);
  for (let i = 0; i < labels.length; i++)
    for (let j = i + 1; j < labels.length; j++) {
      const first = labels[i]!,
        second = labels[j]!;
      const decision = decideVerdict(
        result.assessments[first]?.meets_core ?? false,
        result.assessments[second]?.meets_core ?? false,
        tiers.get(first) ?? 0,
        tiers.get(second) ?? 0,
      );
      const winner = decision.winner === "first" ? first : second;
      const preference = decision.outcome === "win" ? `【候选${winner}】更好`
        : decision.outcome === "both_good" ? "双方都好" : "双方都差";
      items.push({
        id: verdictSlotId(first, second),
        label: `【候选${first}】与【候选${second}】的偏好及理由`,
        preference,
        text: [
          `已确定的对局结论：${verdictReason(decision, first, second)}`,
          `原裁决依据：${result.decision_basis.tradeoff}`,
          ...result.decision_basis.comparisons.filter(row => row.importance !== "low" &&
            (row.better_candidates.length || row.criterion_ids.some(id => Object.values(result.assessments).some(item => item.core_failure_refs.includes(id)))))
            .map((row) =>
            `${row.aspect}：【候选${first}】：${row.assessments[first]?.summary ?? ""}；【候选${second}】：${row.assessments[second]?.summary ?? ""}`),
        ].join("\n"),
      });
    }
  return items;
}
export function clusteringSlots(result: ClusteringResult): RewriteItem[] {
  return [
    ...result.new_classes.flatMap((item, index) =>
      (["definition", "novelty"] as const).map((field) => ({
        id: `new_classes.${index}.${field}`,
        label: `${item.label} · ${field === "definition" ? "定义" : "新建理由"}`,
        text: item[field],
      })),
    ),
    ...result.merges.map((item, index) => ({
      id: `merges.${index}.reason`, label: "合并理由", text: item.reason,
    })),
    ...result.assignments.flatMap((item, index) => item.deferred_reason === undefined ? [] : [{
      id: `assignments.${index}.deferred_reason`, label: "延期归类理由", text: item.deferred_reason,
    }]),
    ...(result.class_updates ?? []).flatMap((item, index) => [
      ...(item.definition === undefined ? [] : [{ id: `class_updates.${index}.definition`, label: "维护后的类定义", text: item.definition }]),
      { id: `class_updates.${index}.reason`, label: "类维护理由", text: item.reason },
    ]),
  ];
}
export function sourceSlots(stage: "attribution" | "comparison" | "clustering", result: unknown, scope: "verdicts" | "items" | "all" = "verdicts"): RewriteItem[] {
  if (stage === "clustering") return clusteringSlots(result as ClusteringResult);
  return stage === "attribution"
    ? attributionSlots(result as AttributionResult)
    : comparisonSlots(result as ComparisonResult, scope);
}
/** Apply already-unblinded rewrite text to its source slot without interpreting its contents. */
export function polishComparisonRow(
  row: JsonObject,
  task: PlannedTask,
  commentary: CommentaryLookup,
): JsonObject {
  const data = task.data as TaskData;
  const own = commentary.of(task.id);
  const sourceRewrites = Object.fromEntries(
    Object.entries(data.candidates).map(([label]) => [label, commentary.of(task.dependencies[label])]),
  );
  if (!own && !Object.values(sourceRewrites).some(Boolean)) return row;
  const view = structuredClone(row);
  const assessments = view.assessments as Record<string, { summary: string }>;
  const evaluations = view.evaluations as Record<string, { summary: string; correctness_reason: string; findings: AttributionResult["findings"] }>;
  for (const [label, candidate] of Object.entries(data.candidates)) {
    const assessmentText = own?.[`assessment.${label}.summary`];
    if (assessmentText && assessments[candidate.version])
      assessments[candidate.version]!.summary = assessmentText;
    const attribution = sourceRewrites[label];
    const review = evaluations[candidate.version];
    if (!attribution || !review) continue;
    if (attribution.summary) review.summary = attribution.summary;
    if (attribution.correctness_reason)
      review.correctness_reason = attribution.correctness_reason;
    review.findings?.forEach((finding, index) => {
      for (const field of ["text", "reason"] as const) {
        const text = attribution[`findings.${index}.${field}`];
        if (text) finding[field] = text;
      }
    });
  }
  if (own?.tradeoff)
    (view.decision_basis as { tradeoff: string }).tradeoff = own.tradeoff;
  const comparisons = (view.decision_basis as { comparisons: ComparisonResult["decision_basis"]["comparisons"] }).comparisons;
  comparisons.forEach((row, index) => {
    if (isResourceRow(row)) return;
    for (const [label, candidate] of Object.entries(data.candidates)) {
      const text = own?.[`comparison.${index}.${label}.summary`];
      if (text) row.assessments[candidate.version]!.summary = text;
    }
  });
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
    if (text) verdict.reason = text;
  }
  return view;
}
