import type { JsonObject, PlannedTask } from "@eval/contracts";
import type { ClusteringResult } from "@eval/agents/clustering";
import type { RewriteItem, Rewrites } from "@eval/agents/rewrite";
import type { ComparisonResult, SessionAttributionResult, SessionProblem, TaskData } from "./types.js";
import { decideVerdict, tierOf, verdictReason } from "./verdicts.js";

/** Accepted rewrites addressed by source task; report rendering only reads from it. */
export interface CommentaryLookup {
  of(sourceTaskId: string | undefined): Rewrites | undefined;
}
/** Stable slot id for one two-way reason; label order does not matter. */
export function verdictSlotId(first: string, second: string): string {
  return `verdict.${[first, second].sort().join("__vs__")}.reason`;
}
function problemSlots(prefix: string, label: string, problems: SessionProblem[]): RewriteItem[] {
  return problems.flatMap((item, index) => ([
    { id: `${prefix}.${index}.problem_phenomena`, label: `${label} ${index + 1} · 现象`, text: item.problem_phenomena },
    { id: `${prefix}.${index}.reason`, label: `${label} ${index + 1} · 理由`, text: item.reason },
    ...(item.calculations ?? []).map((calculation, calculationIndex) => ({
      id: `${prefix}.${index}.calculations.${calculationIndex}.text`, label: `${label} ${index + 1} · 计算说明`, text: calculation.text,
    })),
  ]));
}
export function attributionSlots(result: SessionAttributionResult): RewriteItem[] {
  return [
    { id: "session_summary", label: "整场归因总结", text: result.session_summary },
    ...result.turns.flatMap((turn, index) => [
      { id: `turns.${index}.summary`, label: `第 ${index + 1} 轮 · 总结`, text: turn.summary },
      ...(turn.correct_reason ? [{ id: `turns.${index}.correct_reason`, label: `第 ${index + 1} 轮 · 标准答案核对理由`, text: turn.correct_reason }] : []),
      ...problemSlots(`turns.${index}.problem`, `第 ${index + 1} 轮问题`, turn.problem),
    ]),
    ...problemSlots("session_problem", "整场问题", result.session_problem),
  ];
}
/** Keep each semantic unit together; unrelated findings never share a positional chain. */
export function attributionRewriteGroups(result: SessionAttributionResult, slotIds?: readonly string[]): string[][] {
  const selected = slotIds && new Set(slotIds), groups = new Map<string, string[]>();
  for (const item of attributionSlots(result)) {
    if (selected && !selected.has(item.id)) continue;
    const key = /^(?:turns\.\d+|session_problem)\.\d+\./u.exec(item.id)?.[0]
      ?? /^turns\.\d+\./u.exec(item.id)?.[0] ?? "session";
    const group = groups.get(key) ?? [];
    group.push(item.id); groups.set(key, group);
  }
  return [...groups.values()].flatMap(group => Array.from({ length: Math.ceil(group.length / 20) },
    (_, index) => group.slice(index * 20, (index + 1) * 20)));
}
export function comparisonSlots(result: ComparisonResult, scope: "verdicts" | "items" | "all" = "verdicts"): RewriteItem[] {
  if (scope === "all") return [...comparisonSlots(result, "verdicts"), ...comparisonSlots(result, "items")];
  if (scope === "items") return [
    ...Object.entries(result.assessments).map(([candidate, assessment]) => ({
      id: `assessment.${candidate}.summary`, label: `【候选${candidate}】的整体总评`, text: assessment.summary,
    })),
    ...result.decision_basis.comparisons.flatMap((row, index) => row.criterion_ids.length ||
      Object.values(row.assessments).some(assessment => assessment.finding_indices.length)
      ? Object.entries(row.assessments).filter(([, assessment]) => assessment.summary.trim()).map(([candidate, assessment]) => ({
        id: `comparison.${index}.${candidate}.summary`, label: `检查项 ${index + 1} · 【候选${candidate}】点评`,
        text: assessment.summary, context: row.aspect,
      })) : []),
    { id: "tradeoff", label: "整体取舍依据", text: result.decision_basis.tradeoff },
  ];
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
        text: result.decision_basis.tradeoff,
        context: `已确定的对局结论：${verdictReason(decision, first, second)}`,
      });
    }
  return items;
}
export function clusteringSlots(result: ClusteringResult): RewriteItem[] {
  return [
    ...result.new_classes.flatMap((item, index) =>
      (["label", "definition", "novelty"] as const).map((field) => ({
        id: `new_classes.${index}.${field}`,
        label: `${item.label} · ${field === "label" ? "名称" : field === "definition" ? "定义" : "新建理由"}`,
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
      ...(item.label === undefined ? [] : [{ id: `class_updates.${index}.label`, label: "维护后的类名称", text: item.label }]),
      ...(item.definition === undefined ? [] : [{ id: `class_updates.${index}.definition`, label: "维护后的类定义", text: item.definition }]),
      { id: `class_updates.${index}.reason`, label: "类维护理由", text: item.reason },
    ]),
  ];
}
/** Replace display prose only; source judgments, responsibility and evidence remain unchanged. */
export function polishAttribution(result: SessionAttributionResult, rewrites: Rewrites): SessionAttributionResult {
  const view = structuredClone(result);
  if (rewrites.session_summary) view.session_summary = rewrites.session_summary;
  const polishProblems = (prefix: string, problems: SessionProblem[]) => problems.forEach((problem, index) => {
    for (const field of ["problem_phenomena", "reason"] as const) {
      const text = rewrites[`${prefix}.${index}.${field}`];
      if (text) problem[field] = text;
    }
    problem.calculations?.forEach((calculation, calculationIndex) => {
      const text = rewrites[`${prefix}.${index}.calculations.${calculationIndex}.text`];
      if (text) calculation.text = text;
    });
  });
  view.turns.forEach((turn, index) => {
    if (rewrites[`turns.${index}.summary`]) turn.summary = rewrites[`turns.${index}.summary`]!;
    if (turn.correct_reason !== null && rewrites[`turns.${index}.correct_reason`]) turn.correct_reason = rewrites[`turns.${index}.correct_reason`]!;
    polishProblems(`turns.${index}.problem`, turn.problem);
  });
  polishProblems("session_problem", view.session_problem);
  return view;
}
export function sourceSlots(stage: "attribution" | "comparison" | "clustering", result: unknown, scope: "verdicts" | "items" | "all" = "verdicts"): RewriteItem[] {
  if (stage === "clustering") return clusteringSlots(result as ClusteringResult);
  return stage === "attribution"
    ? attributionSlots(result as SessionAttributionResult)
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
  const evaluations = view.evaluations as unknown as Record<string, SessionAttributionResult>;
  for (const [label, candidate] of Object.entries(data.candidates)) {
    const assessmentText = own?.[`assessment.${label}.summary`];
    if (assessmentText && assessments[candidate.version])
      assessments[candidate.version]!.summary = assessmentText;
    const attribution = sourceRewrites[label];
    const review = evaluations[candidate.version];
    if (!attribution || !review) continue;
    evaluations[candidate.version] = polishAttribution(review, attribution);
  }
  if (own?.tradeoff)
    (view.decision_basis as { tradeoff: string }).tradeoff = own.tradeoff;
  (view.decision_basis as ComparisonResult["decision_basis"]).comparisons.forEach((comparison, index) => {
    for (const [label, candidate] of Object.entries(data.candidates)) {
      const text = own?.[`comparison.${index}.${label}.summary`];
      if (text && comparison.assessments[candidate.version]) comparison.assessments[candidate.version].summary = text;
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
