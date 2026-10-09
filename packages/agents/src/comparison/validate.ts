import { isDeepStrictEqual } from "node:util";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  schemaIssues, ValidationError, type AgentRequest, type ToolAudit,
  type ValidationIssue, type TaskCriterion,
} from "@eval/contracts";
import { images, traceReadCoverage } from "@eval/tools";
import type { ComparisonInput, ComparisonResult, CriterionAssessment } from "./types.js";
import { comparisonCoreFailureRefs } from "./resolve.js";
import { criterionAppliesToPair } from "./pair-scope.js";
import { comparisonCellState, comparisonCellCriterionIds, comparisonAdvantageCandidates, comparisonResourceMetrics, comparisonResourcesComparable, requiredSourceReviews } from "./slots.js";
import { comparisonResultIssues } from "./result-checks.js";
import schema from "../../../../schemas/comparison/result.schema.json" with { type: "json" };

const validator = new Ajv2020({ allErrors: true, strict: false }).compile<unknown>(schema);
/** Share the source-owned final-image gate between early feedback and formal validation. */
export function comparisonFinalImageIssues(request: AgentRequest, audit: ToolAudit): ValidationIssue[] {
  const input = request.input as unknown as ComparisonInput;
  return Object.entries(input.candidates).flatMap(([label, candidate]) => {
    const raw = request.sources[label]?.value as { messages?: unknown[] } | undefined;
    return images(raw?.messages?.[candidate.final_message_index]).length &&
      !audit.viewedImages.includes(`${label}:${candidate.final_message_index}`)
      ? [{ category: "evidence" as const, code: "final_image_not_viewed", path: `/candidates/${label}`, candidate: label,
        message: `最终回答含图片，必须先 view_image(candidate="${label}", message_index=${candidate.final_message_index}) 查看完整交付。` }]
      : [];
  });
}

/** The same exact full-read coverage applies before material disclosure and final acceptance. */
export function comparisonDeferredFinalIssues(request: AgentRequest, audit: ToolAudit): ValidationIssue[] {
  const input = request.input as unknown as ComparisonInput, errors: ValidationIssue[] = [];
  for (const [label, candidate] of Object.entries(input.candidates)) {
    for (const [index, material] of candidate.deferred_final_material.entries()) {
      const coverage = traceReadCoverage(audit, {
        candidate: label, message_index: material.message_index, kind: "text", path: material.path,
        start: 0, end: material.total_chars,
      });
      if (!coverage.covered) errors.push({
        category: "evidence", code: "deferred_final_material_not_read", path: `/candidates/${label}/deferred_final_material/${index}`,
        candidate: label, message: "未完整读取延后展示的最终材料；按缺口用 read_trace 补读并继续 next_offset。", actual: coverage.missing,
        expected: { read_request: { candidate: label, message_index: material.message_index, path: material.path,
          offset: coverage.missing[0]!.start, max_chars: 16000 } },
      });
    }
  }
  return errors;
}

export function validateEvaluation(request: AgentRequest, result: unknown, audit: ToolAudit, inspectionReviews: ComparisonResult["review_requests"] = []): void {
  if (!validator(result)) throw new ValidationError(schemaIssues(validator.errors, result));
  const input = request.input as unknown as ComparisonInput;
  const value = result as ComparisonResult;
  const errors: ValidationIssue[] = [...comparisonResultIssues(request, value), ...comparisonFinalImageIssues(request, audit), ...comparisonDeferredFinalIssues(request, audit)];
  const issue = (code: string, path: string, message: string, candidate?: string, actual?: unknown, expected?: unknown) =>
    errors.push({ category: "decision", code, path, message, candidate, actual, ...(expected !== undefined ? { expected } : {}) });
  const labels = Object.keys(input.candidates);
  const labelHelp = `合法候选标识为 ${JSON.stringify(labels)}，所有候选键和引用必须原样使用这些标识。`;
  const advantageRepair = "保留当前比较格，better_candidate=null，summary 写清已核对事实与未知范围，不删除必填槽。";
  if (labels.length !== 2 || !labels.includes("A") || !labels.includes("B"))
    issue("pair_candidates_invalid", "/candidates", "每次 Comparison 必须只比较 A、B 两个候选。");
  if (!isDeepStrictEqual(value.task_analysis, input.task_analysis))
    issue("task_analysis_changed", "/task_analysis", "共享任务分析是只读材料，Comparison 不得增加、改写或删除标准。");
  const criteria = [...input.task_analysis.requirements, ...input.task_analysis.scoring_points, ...input.task_analysis.red_flags];
  const byId = new Map<string, TaskCriterion>();
  for (const criterion of criteria) {
    if (byId.has(criterion.id)) issue("criterion_duplicate", "/task_analysis", "共享标准 ID 必须唯一。", undefined, criterion.id);
    byId.set(criterion.id, criterion);
  }
  const applicable = (label: string, id: string) => {
    const criterion = byId.get(id);
    return !!criterion && (!criterion.applies_to.length || criterion.applies_to.includes(input.candidates[label]?.candidate_id));
  };
  const sourceFacts = new Map<string, Map<string, CriterionAssessment>>();
  const hasReview = (label: string, id?: string) => value.status === "needs_review" && value.review_requests.some((review) =>
    review.candidate === label && (!id || review.criterion_ids.includes(id)));
  if (value.status === "needs_review") for (const [label, concerns] of Object.entries(input.source_review ?? {}))
    if (concerns.some(concern => concern.requires_review) && !hasReview(label))
      issue("source_review_required", "/review_requests", "来源核验存在影响判定的未解决冲突或缺项，必须 needs_review 并请求该候选独立归因复核，不能直接排名。", label,
        concerns.filter(concern => concern.requires_review));
  const findingHelp = (label: string) => !labels.includes(label) ? labelHelp : `该候选合法索引：${(input.attributions[label]?.findings ?? [])
    .map((finding, index) => `${index}=${finding.text}`).join("；") || "无"}。只复制该候选现有索引；没有对应 finding 时填 []。`;
  const assessed = Object.keys(value.assessments);
  if (assessed.length !== labels.length || !labels.every((label) => assessed.includes(label)))
    issue("assessment_incomplete", "/assessments", "必须为本组每个候选给出 meets_core、core_failure_refs 与 summary。" + labelHelp, undefined, assessed);
  for (const label of labels) {
    const attribution = input.attributions[label];
    if (!attribution) { issue("attribution_missing", "/attributions", "缺少候选归因。", label); continue; }
    if (!isDeepStrictEqual(attribution.task_analysis, input.task_analysis) &&
      !(value.status === "needs_review" && value.review_requests.some((review) =>
        review.candidate === label && review.criterion_ids.length > 0 && review.criterion_ids.every((id) => byId.has(id)))))
      issue("source_task_analysis_changed", `/attributions/${label}/task_analysis`,
        "来源归因的 task_analysis 与本次共同标准不一致（包括 text、applies_to 和 acceptance_rule）；不能沿用同名 ID 判决，必须 needs_review 并定位该候选及相关 criterion_ids。", label);
    const facts = new Map(attribution.criterion_assessments.map((fact) => [fact.criterion_id, fact]));
    sourceFacts.set(label, facts);
    if ((facts.size !== criteria.length || attribution.criterion_assessments.length !== criteria.length || criteria.some((criterion) => !facts.has(criterion.id))) && !hasReview(label))
      issue("source_criteria_incomplete", "/attributions", "归因须恰好覆盖共享标准；请请求复核来源，不得自行补造事实。", label);
    for (const fact of attribution.criterion_assessments)
      if ((!byId.has(fact.criterion_id) && !hasReview(label)) ||
        (byId.has(fact.criterion_id) && (fact.status === "not_applicable") === applicable(label, fact.criterion_id) && !hasReview(label, fact.criterion_id)))
        issue("source_criterion_scope_invalid", "/attributions", "归因的标准适用范围与共享标准不一致。", label, fact.criterion_id);
    const assessment = value.assessments[label];
    if (assessment) {
      const sourceCore = attribution.core_assessment;
      const privateFailures = sourceCore.criterion_ids.filter(id => {
        const criterion = input.task_analysis.requirements.find(item => item.id === id);
        const fact = facts.get(id);
        return criterion && !criterionAppliesToPair(input, criterion) && applicable(label, id) &&
          fact?.evidence_status === "established" && ["unmet", "partial"].includes(fact.status);
      });
      if (sourceCore.meets_core === false && !comparisonCoreFailureRefs(input, label).length &&
        privateFailures.some(id => !hasReview(label, id)))
        issue("core_failure_scope_review_required", "/review_requests",
          "来源仅由专有要求失败支持核心不可用，不能跨候选扣分；核查共同核心交付，在对应格的 source_review 写具体疑点，不能直接改判通过。",
          label, privateFailures);
      if (assessment.meets_core === null && !hasReview(label))
        issue("assessment_review_required", "/review_requests", "核心状态未决，必须请求该候选独立复核，不能只复核另一方。", label);
      if (value.status === "needs_review" && sourceCore.meets_core === null && (!hasReview(label) || sourceCore.criterion_ids.some(id => !hasReview(label, id))))
        issue("core_review_required", "/review_requests", "来源核心状态未决，必须请求该候选及其核心判据的独立复核，不能只复核另一方。", label, sourceCore.criterion_ids);
      if (assessment.meets_core !== sourceCore.meets_core && !(value.status === "needs_review" && assessment.meets_core === null))
        issue("core_assessment_changed", `/assessments/${label}/meets_core`, "核心通过状态只能照录来源 core_assessment；发现冲突须 needs_review，不能自行改判。", label);
      if (assessment.meets_core === false) {
        const refs = assessment.core_failure_refs;
        if (!refs.length || !isDeepStrictEqual([...refs].sort(), comparisonCoreFailureRefs(input, label).sort()))
          issue("core_failure_refs_mismatch", `/assessments/${label}/core_failure_refs`, "核心失败引用须为来源 core_assessment.criterion_ids 中适用于本对局双方且已证实的 unmet/partial requirements，至少一项；缺少此类证据须 needs_review 请求来源复核。", label, refs);
        for (const id of refs) {
          const fact = facts.get(id);
          if (!input.task_analysis.requirements.some((criterion) => criterion.id === id && criterionAppliesToPair(input, criterion)) || !applicable(label, id) ||
            fact?.evidence_status !== "established" || !["unmet", "partial"].includes(fact?.status ?? ""))
            issue("core_failure_unproven", `/assessments/${label}/core_failure_refs`, "核心失败只可引用本对局双方共同适用 requirements 中已证实的 unmet/partial。", label, id);
        }
      } else if (assessment.core_failure_refs.length)
        issue("core_failure_refs_unexpected", `/assessments/${label}/core_failure_refs`, "核心通过或证据不足时 core_failure_refs 必须为空。", label);
    }
  }
  const ranked = value.ranking.flat();
  const tierOf = (label: string) => value.ranking.findIndex((tier) => tier.includes(label));
  if (value.status === "decided") {
    if (new Set(ranked).size !== ranked.length) issue("ranking_duplicate", "/ranking", "排名包含重复候选", undefined, ranked);
    if (ranked.length !== labels.length || !labels.every((label) => ranked.includes(label)))
      issue("ranking_incomplete", "/ranking", "排名必须恰好包含本组全部候选。" + labelHelp, undefined, ranked);
    const failed = labels.filter((label) => value.assessments[label]?.meets_core === false);
    if (new Set(failed.map(tierOf)).size > 1)
      issue("failed_ranking_split", "/ranking", "未达标候选必须同层；相对取舍写在 tradeoff，不改变都差判决。");
    if (labels.some((label) => value.assessments[label]?.meets_core && failed.some((other) => tierOf(label) >= tierOf(other))))
      issue("core_ranking_contradiction", "/ranking", "达标候选必须排在所有未达标候选之前，不能同层或倒置。");
  }
  for (const [index, review] of value.review_requests.entries()) {
    const path = `/review_requests/${index}`;
    if (!review.reason.trim()) issue("review_reason_empty", `${path}/reason`, "复核原因不能为空，须说明需要核实的具体问题。", review.candidate);
    if (!labels.includes(review.candidate)) issue("review_candidate_invalid", path, "复核请求须引用本组候选。" + labelHelp);
    if (!review.criterion_ids.length && !review.finding_indices.length && !inspectionReviews.some(item => isDeepStrictEqual(item, review)) && !requiredSourceReviews(request).some(item => isDeepStrictEqual(item, review)))
      issue("review_reference_missing", path, "复核请求须定位至少一个标准或既有 finding；疑似漏项引用相关 criterion_id。");
    for (const id of review.criterion_ids) if (!byId.has(id)) issue("criterion_missing", path, "复核请求引用未知标准。", review.candidate, id);
    for (const index of review.finding_indices) if (!input.attributions[review.candidate]?.findings[index])
      issue("finding_missing", path, "复核请求只能引用该候选既有 finding。" + findingHelp(review.candidate), review.candidate, index);
  }
  for (const [index, row] of value.decision_basis.comparisons.entries()) {
    const path = `/decision_basis/comparisons/${index}`;
    const compared = Object.keys(row.assessments);
    if (compared.length !== labels.length || !labels.every((label) => compared.includes(label)))
      issue("comparison_incomplete", `${path}/assessments`, "每个比较点必须在同一行包含全部候选的表现。" + labelHelp, undefined, compared);
    for (const id of row.criterion_ids) if (!byId.has(id)) issue("criterion_missing", `${path}/criterion_ids`, "比较行只能引用共享标准 ID。", undefined, id);
    if (row.better_candidates.some((label) => !labels.includes(label)) || row.better_candidates.length >= labels.length)
      issue("comparison_advantage_invalid", `${path}/better_candidates`, "优势候选必须属于本组；共同优点或无已证实优势时填空数组。" + advantageRepair + labelHelp, undefined, row.better_candidates);
    for (const [label, cell] of Object.entries(row.assessments)) {
      const criterionIds = comparisonCellCriterionIds(input, label, row.criterion_ids, cell.finding_indices);
      const facts = criterionIds.filter((id) => applicable(label, id)).flatMap((id) => {
        const fact = sourceFacts.get(label)?.get(id); return fact ? [fact] : [];
      });
      if (criterionIds.length) {
        const missing = criterionIds.some((id) => applicable(label, id) && !sourceFacts.get(label)?.has(id));
        const derived = comparisonCellState(input, label, row.criterion_ids, cell.finding_indices);
        const { status, evidence_status: evidence } = derived;
        const downgraded = (facts.length > 0 || missing) && cell.status === "unknown" && cell.evidence_status === "uncertain";
        if (cell.status !== status && !downgraded)
          issue("criterion_status_changed", `${path}/assessments/${label}/status`, "比较格只能照录来源标准状态；多标准按 unknown、unmet、partial、met 聚合，疑似冲突只能降为 unknown/uncertain 并请求复核。", label, { expected: status, actual: cell.status });
        if (evidence === "uncertain" && cell.evidence_status !== "uncertain")
          issue("criterion_evidence_strengthened", `${path}/assessments/${label}/evidence_status`, "不能把来源 uncertain 升级为 established。", label);
        if (downgraded && status !== "unknown" && value.status !== "needs_review")
          issue("criterion_conflict_needs_review", path, "与既有标准事实存在冲突时必须 needs_review。", label);
        if (downgraded && status !== "unknown" && !hasReview(label))
          issue("criterion_conflict_review_missing", path, "来源事实冲突须为该候选列出具体复核请求。", label);
      } else if (!["met", "unknown"].includes(cell.status))
        issue("unlinked_status_invalid", `${path}/assessments/${label}/status`, "未关联标准的资源/已有 finding 行只能用 met 表示可核验观察，或 unknown 表示未知。", label);
      for (const findingIndex of cell.finding_indices) {
        if (!input.attributions[label]?.findings[findingIndex])
          issue("finding_missing", `${path}/assessments/${label}/finding_indices`, "比较点只能引用该候选的既有 finding。" + findingHelp(label), label, findingIndex);
        if (input.attributions[label]?.findings[findingIndex]?.assessment.evidence_status === "uncertain" && cell.evidence_status === "established")
          issue("finding_evidence_strengthened", `${path}/assessments/${label}/evidence_status`, "引用 uncertain finding 的格必须保留 uncertain，不得升级确证。", label, findingIndex);
      }
      if (!criterionIds.length && !cell.finding_indices.length && cell.evidence_status === "established") {
        if (!Object.values(comparisonResourceMetrics(input,label)).some(value => value !== null))
          issue("unlinked_observation_unproven", `${path}/assessments/${label}`, "无 criterion 或 finding 的比较格只能依据有效原始资源指标，否则应保留 unknown/uncertain。", label);
      }
    }
    if (row.better_candidates.length) {
      if (!row.criterion_ids.length && Object.values(row.assessments).every(cell => !cell.finding_indices.length) &&
        !comparisonResourcesComparable(input))
        issue("comparison_resource_incomparable", `${path}/better_candidates`, "资源优势须有双方同种有效指标，耗时不能与 token 数相互比较。" + advantageRepair);
      if (labels.some(label => !row.assessments[label]) || !comparisonAdvantageCandidates(row.assessments).length)
        issue("comparison_advantage_unproven", `${path}/better_candidates`, "相对优势需要两方同一适用方面的 established 事实；未知或不适用不能当作落后。" + advantageRepair + "在未知候选格的 summary 说明证据不足，不适用候选格说明此条仅评审来源候选、现有材料未提供本方同等约束。");
      if (labels.some((label) => row.assessments[label]?.finding_indices.some((i) => input.attributions[label]?.findings[i]?.assessment.evidence_status === "uncertain")))
        issue("comparison_advantage_uncertain_finding", `${path}/better_candidates`, "含 uncertain finding 的比较行不能用于确证优势。" + advantageRepair + "在对应候选格的 summary 保留证据未确认的范围；确需确认优势时请求归因复核。");
    }
  }
  for (const [index, ref] of value.decision_basis.decisive_findings.entries()) {
    const finding = input.attributions[ref.candidate]?.findings[ref.finding_index];
    if (!finding) issue("finding_missing", `/decision_basis/decisive_findings/${index}`, "决定性发现必须引用归因结果中的既有 finding。" + findingHelp(ref.candidate), ref.candidate, ref.finding_index);
    else if (finding.assessment.evidence_status !== "established")
      issue("decisive_finding_uncertain", `/decision_basis/decisive_findings/${index}`, "uncertain finding 不能作为决定性依据。", ref.candidate, ref.finding_index);
  }
  if (value.status === "decided" && labels.every((label) => value.assessments[label]?.meets_core === true)) {
    const [first, second] = labels;
    const advantage = (a: string) => value.decision_basis.comparisons.some((row, index) => {
      const path = `/decision_basis/comparisons/${index}`;
      return row.importance !== "low" && row.better_candidates.includes(a) &&
        !errors.some(error => error.path === path || error.path.startsWith(path + "/"));
    });
    const confirmed = labels.filter(advantage);
    const expected = { ranking: confirmed.length === 1
      ? [[confirmed[0]], [labels.find(label => label !== confirmed[0])!]] : [labels] };
    if (tierOf(first) !== tierOf(second)) {
      const leader = tierOf(first) < tierOf(second) ? first : second;
      if (!advantage(leader)) issue("ranking_unproven", "/ranking",
        "双方共同交付均可用时，分层须由领先方已确认的中高重要性共同优势支持；清空专有或未证实优势后不能保留无依据的偏好，合规点评仍保留。核查 better_candidate 和 preference，缺少实质优势时填 null。", undefined, value.ranking, expected);
    }
    if (advantage(first) !== advantage(second)) {
      const better = advantage(first) ? first : second; const worse = better === first ? second : first;
      if (tierOf(better) >= tierOf(worse)) issue("ranking_ignores_advantage", "/ranking", "本项中高重要性单方优势与整场 preference 不一致。先核对实际影响：差异不足以改变结果、决策或使用成本时，将该项 importance 改为 low，保留 preference=null；确有实质优势则明确选择优势方。tradeoff 须说明同一取舍，不能仅为通过校验强选赢家。", undefined, value.ranking, expected);
    }
  }
  if (errors.length) throw new ValidationError(errors);
}
