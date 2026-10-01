import { isDeepStrictEqual } from "node:util";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  schemaIssues, ValidationError, type AgentRequest, type ToolAudit,
  type ValidationIssue, type TaskAnalysis, type TaskCriterion,
} from "@eval/contracts";
import { images, traceReadCoverage } from "@eval/tools";
import type { ComparisonResult, Finding, CriterionAssessment, CriterionStatus } from "./types.js";
import schema from "../../../../schemas/comparison/result.schema.json" with { type: "json" };

interface Candidate {
  candidate_id: string;
  final_message_index: number;
  deferred_final_material: { message_index: number; path: string; total_chars: number }[];
  original_answer_timing: { finish_seconds: number | null };
  original_answer_usage: { total_tokens: number | null; issues: string[] };
}
interface Input {
  task_analysis: TaskAnalysis;
  candidates: Record<string, Candidate>;
  attributions: Record<string, {
    task_analysis: TaskAnalysis;
    findings: Finding[];
    criterion_assessments: CriterionAssessment[];
    core_assessment: { meets_core: boolean | null; reason: string; criterion_ids: string[] };
  }>;
  strength_checks: { candidate: string; finding_index: number }[];
}
const validator = new Ajv2020({ allErrors: true, strict: false }).compile<unknown>(schema);
const aggregateStatus = (facts: CriterionAssessment[]): CriterionStatus => {
  if (!facts.length) return "not_applicable";
  for (const status of ["unknown", "unmet", "partial"] as const)
    if (facts.some((fact) => fact.status === status)) return status;
  return "met";
};
export function validateEvaluation(request: AgentRequest, result: unknown, audit: ToolAudit): void {
  if (!validator(result)) throw new ValidationError(schemaIssues(validator.errors, result));
  const input = request.input as unknown as Input;
  const value = result as ComparisonResult;
  const errors: ValidationIssue[] = [];
  const issue = (code: string, path: string, message: string, candidate?: string, actual?: unknown) =>
    errors.push({ category: "decision", code, path, message, candidate, actual });
  const labels = Object.keys(input.candidates);
  const labelHelp = `合法候选标识为 ${JSON.stringify(labels)}，所有候选键和引用必须原样使用这些标识。`;
  if (labels.length !== 2 || !labels.includes("A") || !labels.includes("B"))
    issue("pair_candidates_invalid", "/candidates", "每次 Comparison 必须只比较 A、B 两个候选。");
  if (!isDeepStrictEqual(value.task_analysis, input.task_analysis))
    issue("task_analysis_changed", "/task_analysis", "共享任务分析由 Host 镜像，Comparison 不得增加、改写或删除标准。");
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
      if (assessment.meets_core !== sourceCore.meets_core && !(value.status === "needs_review" && assessment.meets_core === null))
        issue("core_assessment_changed", `/assessments/${label}/meets_core`, "核心通过状态只能照录来源 core_assessment；发现冲突须 needs_review，不能自行改判。", label);
      if (assessment.meets_core === false) {
        const refs = assessment.core_failure_refs;
        if (!refs.length || !isDeepStrictEqual([...refs].sort(), [...sourceCore.criterion_ids].sort()))
          issue("core_failure_refs_mismatch", `/assessments/${label}/core_failure_refs`, "核心失败须明确照录来源 core_assessment.criterion_ids。", label, refs);
        for (const id of refs) {
          const fact = facts.get(id);
          if (!input.task_analysis.requirements.some((criterion) => criterion.id === id) || !applicable(label, id) ||
            fact?.evidence_status !== "established" || !["unmet", "partial"].includes(fact?.status ?? ""))
            issue("core_failure_unproven", `/assessments/${label}/core_failure_refs`, "核心失败只可引用适用 requirements 中已证实的 unmet/partial。", label, id);
        }
      } else if (assessment.core_failure_refs.length)
        issue("core_failure_refs_unexpected", `/assessments/${label}/core_failure_refs`, "核心通过或证据不足时 core_failure_refs 必须为空。", label);
    }
    const candidate = input.candidates[label];
    const raw = request.sources[label]?.value as { messages?: unknown[] } | undefined;
    for (const [index, material] of candidate.deferred_final_material.entries()) {
      const coverage = traceReadCoverage(audit, {
        candidate: label, message_index: material.message_index, kind: "text", path: material.path,
        start: 0, end: material.total_chars,
      });
      if (!coverage.covered) errors.push({
        category: "evidence", code: "deferred_final_material_not_read", path: `/candidates/${label}/deferred_final_material/${index}`,
        candidate: label, message: "未完整读取延后展示的最终材料；按缺口用 read_trace 补读并继续 next_offset。", actual: coverage.missing,
      });
    }
    if (images(raw?.messages?.[candidate.final_message_index]).length && !audit.viewedImages.includes(`${label}:${candidate.final_message_index}`))
      errors.push({ category: "evidence", code: "final_image_not_viewed", path: `/candidates/${label}`, candidate: label,
        message: `最终回答含图片，必须先 view_image(candidate="${label}", message_index=${candidate.final_message_index}) 查看完整交付。` });
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
    if (!labels.includes(review.candidate)) issue("review_candidate_invalid", path, "复核请求须引用本组候选。" + labelHelp);
    if (!review.criterion_ids.length && !review.finding_indices.length)
      issue("review_reference_missing", path, "复核请求须定位至少一个标准或既有 finding；疑似漏项引用相关 criterion_id。");
    for (const id of review.criterion_ids) if (!byId.has(id)) issue("criterion_missing", path, "复核请求引用未知标准。", review.candidate, id);
    for (const index of review.finding_indices) if (!input.attributions[review.candidate]?.findings[index])
      issue("finding_missing", path, "复核请求只能引用该候选既有 finding。" + findingHelp(review.candidate), review.candidate, index);
  }
  const covered = new Map(labels.map((label) => [label, new Set<number>()]));
  const criteriaCovered = new Map(labels.map((label) => [label, new Set<string>()]));
  for (const [index, row] of value.decision_basis.comparisons.entries()) {
    const path = `/decision_basis/comparisons/${index}`;
    const compared = Object.keys(row.assessments);
    if (compared.length !== labels.length || !labels.every((label) => compared.includes(label)))
      issue("comparison_incomplete", `${path}/assessments`, "每个比较点必须在同一行包含全部候选的表现。" + labelHelp, undefined, compared);
    for (const id of row.criterion_ids) if (!byId.has(id)) issue("criterion_missing", `${path}/criterion_ids`, "比较行只能引用共享标准 ID。", undefined, id);
    if (row.better_candidates.some((label) => !labels.includes(label)) || row.better_candidates.length >= labels.length)
      issue("comparison_advantage_invalid", `${path}/better_candidates`, "优势候选必须属于本组；共同优点或无已证实优势时填空数组。" + labelHelp, undefined, row.better_candidates);
    for (const [label, cell] of Object.entries(row.assessments)) {
      const facts = row.criterion_ids.filter((id) => applicable(label, id)).flatMap((id) => {
        criteriaCovered.get(label)?.add(id);
        const fact = sourceFacts.get(label)?.get(id); return fact ? [fact] : [];
      });
      if (row.criterion_ids.length) {
        const missing = row.criterion_ids.some((id) => applicable(label, id) && !sourceFacts.get(label)?.has(id));
        const inconsistent = facts.some((fact) => fact.status === "not_applicable" ||
          input.attributions[label].criterion_assessments.filter((item) => item.criterion_id === fact.criterion_id).length !== 1);
        const status = missing || inconsistent ? "unknown" : aggregateStatus(facts);
        const evidence = missing || inconsistent || facts.some((fact) => fact.evidence_status === "uncertain") ? "uncertain" : "established";
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
        else covered.get(label)?.add(findingIndex);
        if (input.attributions[label]?.findings[findingIndex]?.assessment.evidence_status === "uncertain" && cell.evidence_status === "established")
          issue("finding_evidence_strengthened", `${path}/assessments/${label}/evidence_status`, "引用 uncertain finding 的格必须保留 uncertain，不得升级确证。", label, findingIndex);
      }
      if (!row.criterion_ids.length && !cell.finding_indices.length && cell.evidence_status === "established") {
        const candidate = input.candidates[label];
        const timed = candidate?.original_answer_timing?.finish_seconds;
        const tokens = candidate?.original_answer_usage?.total_tokens;
        if (!(typeof timed === "number" && Number.isFinite(timed) && timed >= 0) &&
          !(typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens >= 0 && !candidate.original_answer_usage.issues.length))
          issue("unlinked_observation_unproven", `${path}/assessments/${label}`, "无 criterion 或 finding 的比较格只能依据有效原始资源指标，否则应保留 unknown/uncertain。", label);
      }
    }
    if (row.better_candidates.length) {
      if (row.criterion_ids.some((id) => !labels.every((label) => applicable(label, id))))
        issue("comparison_advantage_scope_mismatch", `${path}/better_candidates`, "相对优势行的标准必须共同适用于双方；候选专有约束单独展示，不跨候选扣分。");
      if (labels.some((label) => !row.assessments[label] || row.assessments[label].evidence_status !== "established" || ["unknown", "not_applicable"].includes(row.assessments[label].status)))
        issue("comparison_advantage_unproven", `${path}/better_candidates`, "相对优势需要两方同一适用方面的 established 事实；未知或不适用不能当作落后。");
      if (labels.some((label) => row.assessments[label]?.finding_indices.some((i) => input.attributions[label]?.findings[i]?.assessment.evidence_status === "uncertain")))
        issue("comparison_advantage_uncertain_finding", `${path}/better_candidates`, "含 uncertain finding 的比较行不能用于确证优势；需先请求归因复核。");
    }
  }
  for (const label of labels) for (const criterion of criteria)
    if (applicable(label, criterion.id) && !criteriaCovered.get(label)?.has(criterion.id))
      issue("comparison_criterion_uncovered", "/decision_basis/comparisons", "逐项对照必须覆盖每个候选的全部适用标准，不能只列有 finding 的方面。", label, criterion.id);
  const materialProblems = Object.entries(input.attributions).flatMap(([candidate, attribution]) =>
    attribution.findings.flatMap((finding, finding_index) => finding.type === "problem" && finding.importance !== "low" ? [{ candidate, finding_index }] : []));
  for (const ref of [...input.strength_checks, ...materialProblems, ...value.decision_basis.decisive_findings])
    if (input.attributions[ref.candidate]?.findings[ref.finding_index] && !covered.get(ref.candidate)?.has(ref.finding_index))
      issue("comparison_finding_uncovered", "/decision_basis/comparisons",
        `逐项对照必须覆盖全部待核对优点、中高重要性问题和决定性发现。漏项为 ${ref.candidate}.findings[${ref.finding_index}]。将索引加入对应行 assessments.${ref.candidate}.finding_indices；索引从0开始。`, ref.candidate, ref.finding_index);
  for (const [index, ref] of value.decision_basis.decisive_findings.entries()) {
    const finding = input.attributions[ref.candidate]?.findings[ref.finding_index];
    if (!finding) issue("finding_missing", `/decision_basis/decisive_findings/${index}`, "决定性发现必须引用归因结果中的既有 finding。" + findingHelp(ref.candidate), ref.candidate, ref.finding_index);
    else if (finding.assessment.evidence_status !== "established")
      issue("decisive_finding_uncertain", `/decision_basis/decisive_findings/${index}`, "uncertain finding 不能作为决定性依据。", ref.candidate, ref.finding_index);
  }
  if (value.status === "decided" && labels.every((label) => value.assessments[label]?.meets_core === true)) {
    const [first, second] = labels;
    const advantage = (a: string) => value.decision_basis.comparisons.some((row) => row.importance !== "low" && row.better_candidates.includes(a));
    if (advantage(first) !== advantage(second)) {
      const better = advantage(first) ? first : second; const worse = better === first ? second : first;
      if (tierOf(better) >= tierOf(worse)) issue("ranking_ignores_advantage", "/ranking", "仅一方有已确认的中高重要性优势，不能判都好或把优势方排后；应根据实质差异分胜负。");
    }
  }
  if (errors.length) throw new ValidationError(errors);
}
