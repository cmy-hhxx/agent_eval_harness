import type { AgentRequest, ValidationIssue } from "@eval/contracts";
import { criterionAppliesToPair, findingAppliesToPair } from "./pair-scope.js";
import type { ComparisonInput } from "./types.js";

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const indices = (value: unknown): number[] => Array.isArray(value)
  ? value.filter((item): item is number => Number.isSafeInteger(item) && item >= 0) : [];
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

/** Identify independent source/reference errors even when other draft fields fail the schema. No draft is repaired here. */
export function comparisonReferenceIssues(request: AgentRequest, draft: unknown): ValidationIssue[] {
  const value = record(draft);
  if (value?.status !== "decided") return [];
  const input = request.input as unknown as ComparisonInput;
  const labels = Object.keys(input.candidates);
  const criteria = [...input.task_analysis.requirements, ...input.task_analysis.scoring_points, ...input.task_analysis.red_flags];
  const byId = new Map(criteria.map(criterion => [criterion.id, criterion]));
  const rows = array(record(value.decision_basis)?.comparisons);
  const decisive = array(record(value.decision_basis)?.decisive_findings);
  const errors: ValidationIssue[] = [];
  const issue = (code: string, path: string, message: string, candidate?: string, actual?: unknown) =>
    errors.push({ category: "decision", code, path, message, candidate, actual });
  const covered = new Map(labels.map(label => [label, new Set<number>()]));
  const criteriaCovered = new Map(labels.map(label => [label, new Set<string>()]));
  const advantageRepair = "保留当前比较格，better_candidate=null，summary 写清已核对事实与未知范围，不删除必填槽。";
  for (const label of labels) {
    const concerns = input.source_review?.[label]?.filter(concern => concern.requires_review) ?? [];
    if (concerns.length)
      issue("source_review_required", "/review_requests", "来源核验存在影响判定的未解决事项；核查原文，在该候选对应格的 source_review 说明具体疑点，不以未决事实支持优势。", label, concerns);
    const core = input.attributions[label]?.core_assessment;
    if (core?.meets_core === null)
      issue("core_review_required", "/review_requests", "来源核心状态未决；核查该候选核心交付，在对应格的 source_review 说明需复核的事实，不改写来源核心状态。", label, core.criterion_ids);
  }
  rows.forEach((raw, index) => {
    const row = record(raw);
    if (!row) return;
    const cells = record(row.assessments), ids = strings(row.criterion_ids);
    const path = `/decision_basis/comparisons/${index}`;
    for (const label of labels) {
      const cell = record(cells?.[label]);
      if (!cell) continue;
      for (const id of ids) if (byId.has(id)) criteriaCovered.get(label)!.add(id);
      for (const findingIndex of indices(cell.finding_indices))
        if (input.attributions[label]?.findings[findingIndex]) covered.get(label)!.add(findingIndex);
    }
    if (!strings(row.better_candidates).length) return;
    if (ids.some(id => byId.has(id) && !criterionAppliesToPair(input, byId.get(id)!)))
      issue("comparison_advantage_scope_mismatch", `${path}/better_candidates`, "相对优势行的标准必须共同适用于双方；候选专有约束单独展示，不跨候选扣分。" + advantageRepair + "在不适用候选格的 summary 说明此条仅评审来源候选、现有材料未提供本方同等约束。");
    if (labels.some(label => indices(record(cells?.[label])?.finding_indices).some(findingIndex =>
      input.attributions[label]?.findings[findingIndex] && !findingAppliesToPair(input, label, findingIndex, request.sources[label]?.value))))
      issue("comparison_advantage_finding_scope_mismatch", `${path}/better_candidates`,
        "引用 finding 的来源规范须属于双方共同 requirement；本方专有 instruction_following 事实只保留本方合规点评，不能作为横向优势。" + advantageRepair);
  });
  for (const label of labels) for (const criterion of criteria)
    if (criterionAppliesToPair(input, criterion) && !criteriaCovered.get(label)!.has(criterion.id))
      issue("comparison_criterion_uncovered", "/decision_basis/comparisons", `逐项对照必须覆盖双方的全部共同标准，不能只列有 finding 的方面。漏项为 ${label} 的 ${criterion.id}；按 comparison_slots 保留该标准对应行及双方 summary。证据不足的共同标准行仍须保留；无法确认相对优势时 better_candidate=null，不能靠删行修复优势错误。专有标准由来源归因完整评审，其待核对优点和中高重要性问题仍须在矩阵中展示。`, label, criterion.id);
  const required = [...Object.entries(input.attributions).flatMap(([candidate, attribution]) =>
    attribution.findings.flatMap((finding, finding_index) => finding.type === "strength" || finding.importance !== "low" ? [{ candidate, finding_index }] : [])),
  ...decisive.flatMap(raw => {
    const ref = record(raw);
    return typeof ref?.candidate === "string" && Number.isSafeInteger(ref.finding_index)
      ? [{ candidate: ref.candidate, finding_index: Number(ref.finding_index) }] : [];
  })];
  const seen = new Set<string>();
  for (const ref of required) {
    const key = `${ref.candidate}:${ref.finding_index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (input.attributions[ref.candidate]?.findings[ref.finding_index] && !covered.get(ref.candidate)?.has(ref.finding_index))
      issue("comparison_finding_uncovered", "/decision_basis/comparisons",
        `逐项对照必须覆盖全部待核对优点、中高重要性问题和决定性发现。漏项为 ${ref.candidate}.findings[${ref.finding_index}]。按 comparison_slots 保留对应比较行，在该候选的 summary 核查并说明本项事实。`, ref.candidate, ref.finding_index);
  }
  decisive.forEach((raw, index) => {
    const ref = record(raw);
    if (typeof ref?.candidate !== "string" || !Number.isSafeInteger(ref.finding_index) || !input.attributions[ref.candidate]?.findings[Number(ref.finding_index)]) return;
    if (!findingAppliesToPair(input, ref.candidate, Number(ref.finding_index), request.sources[ref.candidate]?.value))
      issue("decisive_finding_scope_mismatch", `/decision_basis/decisive_findings/${index}`,
        "专有 requirement 的 finding 只能保留本方合规点评，不能作为跨候选决定性依据；requirement_index=null 的 instruction_following finding 不能作为决定性依据，Comparison 不能用比较行 criterion_ids 为来源补充适用范围。显式引用的来源规范须属于该共同 requirement；错误索引不能扩展自身系统协议的作用域。", ref.candidate, ref.finding_index);
  });
  return errors;
}
