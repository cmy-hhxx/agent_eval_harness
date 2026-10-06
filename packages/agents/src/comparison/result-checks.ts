import type { AgentRequest, ValidationIssue } from "@eval/contracts";
import { criterionAppliesToPair, findingAppliesToPair } from "./pair-scope.js";
import type { ComparisonInput, ComparisonResult } from "./types.js";

/** Check source ownership and coverage on the program-bound formal result. */
export function comparisonResultIssues(request: AgentRequest, value: ComparisonResult): ValidationIssue[] {
  if (value.status !== "decided") return [];
  const input = request.input as unknown as ComparisonInput;
  const labels = Object.keys(input.candidates);
  const criteria = [...input.task_analysis.requirements, ...input.task_analysis.scoring_points, ...input.task_analysis.red_flags];
  const byId = new Map(criteria.map(criterion => [criterion.id, criterion]));
  const { comparisons: rows, decisive_findings: decisive } = value.decision_basis;
  const errors: ValidationIssue[] = [];
  const issue = (code: string, path: string, message: string, candidate?: string, actual?: unknown) =>
    errors.push({ category: "decision", code, path, message, candidate, actual });
  const covered = new Map(labels.map(label => [label, new Set<number>()]));
  const criteriaCovered = new Map(labels.map(label => [label, new Set<string>()]));
  const advantageRepair = "保留当前比较格，better_candidate=null，summary 写清已核对事实与未知范围，不删除必填槽。";
  for (const label of labels) {
    const concerns = input.source_review?.[label]?.filter(concern => concern.requires_review) ?? [];
    if (concerns.length)
      issue("source_review_required", "/review_requests", "来源核验存在未解决事项，正式结果必须保留来源复核请求，不能用未决事实支持排名。", label, concerns);
    const core = input.attributions[label]?.core_assessment;
    if (core?.meets_core === null)
      issue("core_review_required", "/review_requests", "来源核心状态未决，正式结果必须保留来源复核请求，不能改写核心状态后排名。", label, core.criterion_ids);
  }
  rows.forEach((row, index) => {
    const cells = row.assessments, ids = row.criterion_ids;
    const path = `/decision_basis/comparisons/${index}`;
    for (const label of labels) {
      const cell = cells[label];
      if (!cell) continue;
      for (const id of ids) if (byId.has(id)) criteriaCovered.get(label)!.add(id);
      for (const findingIndex of cell.finding_indices)
        if (input.attributions[label]?.findings[findingIndex]) covered.get(label)!.add(findingIndex);
    }
    if (!row.better_candidates.length) return;
    if (ids.some(id => byId.has(id) && !criterionAppliesToPair(input, byId.get(id)!)))
      issue("comparison_advantage_scope_mismatch", `${path}/better_candidates`, "相对优势行的标准必须共同适用于双方；候选专有约束单独展示，不跨候选扣分。" + advantageRepair + "在不适用候选格的 summary 说明此条仅评审来源候选、现有材料未提供本方同等约束。");
    if (labels.some(label => cells[label]?.finding_indices.some(findingIndex =>
      input.attributions[label]?.findings[findingIndex] && !findingAppliesToPair(input, label, findingIndex, request.sources[label]?.value))))
      issue("comparison_advantage_finding_scope_mismatch", `${path}/better_candidates`,
        "引用 finding 的来源规范须属于双方共同 requirement；本方专有 instruction_following 事实只保留本方合规点评，不能作为横向优势。" + advantageRepair);
  });
  for (const label of labels) for (const criterion of criteria)
    if (criterionAppliesToPair(input, criterion) && !criteriaCovered.get(label)!.has(criterion.id))
      issue("comparison_criterion_uncovered", "/decision_basis/comparisons", `共同标准 ${criterion.id} 缺少 ${label} 的评审。按 comparison_slots 保留该行及双方点评；证据不足时保留未知状态，不用删行修复优势错误。`, label, criterion.id);
  const seen = new Set<string>();
  for (const ref of decisive) {
    const key = `${ref.candidate}:${ref.finding_index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (input.attributions[ref.candidate]?.findings[ref.finding_index] && !covered.get(ref.candidate)?.has(ref.finding_index))
      issue("comparison_finding_uncovered", "/decision_basis/comparisons",
        `决定性发现 ${ref.candidate}.findings[${ref.finding_index}] 缺少对应比较行。只有已经进入共同标准对照的发现才能支持取舍。`, ref.candidate, ref.finding_index);
  }
  decisive.forEach((ref, index) => {
    if (!input.attributions[ref.candidate]?.findings[ref.finding_index]) return;
    if (!findingAppliesToPair(input, ref.candidate, ref.finding_index, request.sources[ref.candidate]?.value))
      issue("decisive_finding_scope_mismatch", `/decision_basis/decisive_findings/${index}`,
        "专有 requirement 的 finding 只能保留本方合规点评，不能作为跨候选决定性依据；requirement_index=null 的 instruction_following finding 不能作为决定性依据，Comparison 不能用比较行 criterion_ids 为来源补充适用范围。显式引用的来源规范须属于该共同 requirement；错误索引不能扩展自身系统协议的作用域。", ref.candidate, ref.finding_index);
  });
  return errors;
}
