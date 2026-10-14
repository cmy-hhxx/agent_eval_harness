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
export function attributionSlots(result: AttributionResult): RewriteItem[] {
  const items: RewriteItem[] = [{ id: "summary", label: "回答结论", text: result.summary }];
  if (result.core_assessment.reason.trim())
    items.push({ id: "core_assessment.reason", label: "回答对用户请求的满足情况", text: result.core_assessment.reason,
      context: "验收对象沿用本槽原文，不改变验收对象。用户索要方法或步骤时，评价回答是否给出可执行方法，不代表用户已经实施；用户要求执行时，才沿用原文的执行结果。不能把能否完成改成是否已经完成，不能新增执行证明要求；无法保证语义不变时保留原文。" });
  if (result.correctness_reason.trim())
    items.push({
      id: "correctness_reason",
      label: result.is_correct === false ? "判错理由" : "判对理由",
      text: result.correctness_reason,
    });
  result.criterion_assessments.forEach((item, index) => {
    if (item.summary.trim()) items.push({ id: `criterion_assessments.${index}.summary`, label: `检查项 ${index + 1} · 点评`, text: item.summary });
  });
  result.findings.forEach((finding, index) => {
    for (const field of ["text", "reason"] as const)
      items.push({ id: `findings.${index}.${field}`, label: `发现 ${index + 1} · ${field === "text" ? "点评" : "理由"}`, text: finding[field] });
    for (const field of ["observation", "impact"] as const)
      if (finding.assessment[field].trim()) items.push({ id: `findings.${index}.assessment.${field}`,
        label: `发现 ${index + 1} · ${field === "observation" ? "实际情况" : "实际影响"}`, text: finding.assessment[field] });
    if (finding.problem) for (const field of ["label", "definition"] as const)
      if (finding.problem[field].trim()) items.push({ id: `findings.${index}.problem.${field}`,
        label: `发现 ${index + 1} · ${field === "label" ? "问题名称" : "问题描述"}`, text: finding.problem[field] });
  });
  result.table_resolutions?.forEach((item, index) => {
    if (item.reason.trim()) items.push({ id: `table_resolutions.${index}.reason`, label: `表格核查 ${index + 1} · 理由`, text: item.reason });
  });
  return items;
}
/** Keep each semantic unit together; unrelated findings never share a positional chain. */
export function attributionRewriteGroups(result: AttributionResult, slotIds?: readonly string[]): string[][] {
  const selected = slotIds && new Set(slotIds), groups = new Map<string, string[]>();
  for (const item of attributionSlots(result)) {
    if (selected && !selected.has(item.id)) continue;
    const key = /^findings\.\d+\./u.exec(item.id)?.[0] ??
      (item.id.startsWith("criterion_assessments.") ? "criteria" : item.id.startsWith("table_resolutions.") ? "tables" : "overview");
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
        text: [
          `已确定的对局结论：${verdictReason(decision, first, second)}`,
          `原裁决依据：${result.decision_basis.tradeoff}`,
          ...result.decision_basis.comparisons.filter(row => row.importance === "low"
            ? decision.outcome !== "win" && row.better_candidates.length > 0
            : row.better_candidates.length || row.criterion_ids.some(id => Object.values(result.assessments).some(item => item.core_failure_refs.includes(id))))
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
export function polishAttribution(result: AttributionResult, rewrites: Rewrites): AttributionResult {
  const view = structuredClone(result);
  if (rewrites.summary) view.summary = rewrites.summary;
  if (rewrites.correctness_reason) view.correctness_reason = rewrites.correctness_reason;
  if (rewrites["core_assessment.reason"] && view.core_assessment)
    view.core_assessment.reason = rewrites["core_assessment.reason"];
  view.criterion_assessments?.forEach((item, index) => {
    if (rewrites[`criterion_assessments.${index}.summary`]) item.summary = rewrites[`criterion_assessments.${index}.summary`];
  });
  view.findings?.forEach((finding, index) => {
    for (const field of ["text", "reason"] as const)
      if (rewrites[`findings.${index}.${field}`]) finding[field] = rewrites[`findings.${index}.${field}`];
    for (const field of ["observation", "impact"] as const)
      if (rewrites[`findings.${index}.assessment.${field}`]) finding.assessment[field] = rewrites[`findings.${index}.assessment.${field}`];
    if (finding.problem) for (const field of ["label", "definition"] as const)
      if (rewrites[`findings.${index}.problem.${field}`]) finding.problem[field] = rewrites[`findings.${index}.problem.${field}`];
  });
  view.table_resolutions?.forEach((item, index) => {
    if (rewrites[`table_resolutions.${index}.reason`]) item.reason = rewrites[`table_resolutions.${index}.reason`];
  });
  return view;
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
  const evaluations = view.evaluations as unknown as Record<string, AttributionResult>;
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
