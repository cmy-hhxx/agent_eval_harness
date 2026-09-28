import { Ajv2020 } from "ajv/dist/2020.js";
import {
  schemaIssues,
  ValidationError,
  type AgentRequest,
  type ToolAudit,
  type ValidationIssue,
} from "@eval/contracts";
import type { ComparisonResult, Finding } from "./types.js";
import schema from "../../../../schemas/comparison/result.schema.json" with { type: "json" };

interface Input {
  ground_truth: { available: boolean; value: unknown };
  candidates: Record<string, unknown>;
  attributions?: Record<string, { is_correct: boolean | null; findings: Finding[] }>;
  strength_checks?: { candidate: string; finding_index: number }[];
}

const validator = new Ajv2020({ allErrors: true, strict: false }).compile<unknown>(schema);
export function validateEvaluation(request: AgentRequest, result: unknown, audit: ToolAudit): void {
  void audit;
  if (!validator(result)) throw new ValidationError(schemaIssues(validator.errors, result));
  const input = request.input as unknown as Input;
  const value = result as ComparisonResult;
  const errors: ValidationIssue[] = [];
  const issue = (code: string, path: string, message: string, candidate?: string, actual?: unknown) =>
    errors.push({ category: "decision", code, path, message, candidate, actual });

  const labels = Object.keys(input.candidates);
  const findingHelp = (label: string) => `该候选合法索引：${(input.attributions?.[label]?.findings ?? [])
    .map((finding, index) => `${index}=${finding.text}`).join("；") || "无"}。只复制该候选现有索引；没有对应finding时填 []，不能填序号或其他候选的索引。`;
  const ranked = value.ranking.flat();
  if (new Set(ranked).size !== ranked.length)
    issue("ranking_duplicate", "/ranking", "排名包含重复候选", undefined, ranked);
  if (ranked.length !== labels.length || !labels.every((label) => ranked.includes(label)))
    issue("ranking_incomplete", "/ranking", "排名必须恰好包含本组全部候选", undefined, ranked);
  if (ranked.length < 2) issue("ranking_too_small", "/ranking", "对比至少需要两个候选");
  const assessed = Object.keys(value.assessments);
  if (assessed.length !== labels.length || !labels.every((label) => assessed.includes(label)))
    issue("assessment_incomplete", "/assessments", "必须为本组每个候选给出 meets_core 与 summary", undefined, assessed);
  const tierOf = (label: string) => value.ranking.findIndex((tier) => tier.includes(label));
  const failed = labels.filter((label) => value.assessments[label]?.meets_core === false);
  if (new Set(failed.map(tierOf)).size > 1)
    issue("failed_ranking_split", "/ranking", "未达标候选必须同层；局部优势写在逐项对比，不能产生整体胜者");
  if (labels.some((label) => value.assessments[label]?.meets_core && failed.some((other) => tierOf(label) >= tierOf(other))))
    issue("core_ranking_contradiction", "/ranking", "达标候选必须排在所有未达标候选之前，不能同层或倒置");
  if (failed.length === labels.length && /更好|更优|更可用|更值得|更可靠|胜出|略胜|占优|居前|优于|优先选|排(?:在)?前|列(?:在)?前/u.test(value.decision_basis.tradeoff))
    issue("failed_tradeoff_winner", "/decision_basis/tradeoff", "全部核心不可用时短评不能宣称某方更好、胜出或排前；写清共同失败，局部优势留在 comparisons");

  const covered = new Map(labels.map((label) => [label, new Set<number>()]));
  for (const [index, row] of value.decision_basis.comparisons.entries()) {
    const path = `/decision_basis/comparisons/${index}`;
    const compared = Object.keys(row.assessments);
    if (compared.length !== labels.length || !labels.every((label) => compared.includes(label)))
      issue("comparison_incomplete", `${path}/assessments`, "每个比较点必须在同一行包含全部候选的表现", undefined, compared);
    if (row.better_candidates.some((label) => !labels.includes(label)) || row.better_candidates.length >= labels.length)
      issue("comparison_advantage_invalid", `${path}/better_candidates`, "优势候选必须属于本组；共同优点或无已证实优势时填空数组", undefined, row.better_candidates);
    for (const [label, assessment] of Object.entries(row.assessments))
      for (const findingIndex of assessment.finding_indices) {
        if (!input.attributions?.[label]?.findings[findingIndex])
          issue("finding_missing", `${path}/assessments/${label}/finding_indices`, "比较点只能引用该候选的既有 finding。" + findingHelp(label), label, findingIndex);
        else covered.get(label)?.add(findingIndex);
      }
  }
  const materialProblems = Object.entries(input.attributions || {}).flatMap(([candidate, attribution]) =>
    attribution.findings.flatMap((finding, finding_index) => finding.type === "problem" && finding.importance !== "low"
      ? [{ candidate, finding_index }] : []),
  );
  for (const ref of [...(input.strength_checks || []), ...materialProblems, ...value.decision_basis.decisive_findings])
    if (input.attributions?.[ref.candidate]?.findings[ref.finding_index] && !covered.get(ref.candidate)?.has(ref.finding_index)) {
      const finding = input.attributions?.[ref.candidate]?.findings[ref.finding_index];
      issue("comparison_finding_uncovered", "/decision_basis/comparisons",
        `逐项对照必须覆盖全部待核对优点、中高重要性问题和决定性发现。漏项为 ${ref.candidate}.findings[${ref.finding_index}]：${finding?.text ?? "见归因材料"}。` +
        `请在讨论同一方面的行中，将 ${ref.finding_index} 加入 assessments.${ref.candidate}.finding_indices；索引从0开始，不是第几条的序号。不要只改文字，也不要填到其他候选。`,
        ref.candidate, ref.finding_index);
    }

  for (const [index, ref] of value.decision_basis.decisive_findings.entries()) {
    const findings = input.attributions?.[ref.candidate]?.findings;
    if (!findings?.[ref.finding_index])
      issue(
        "finding_missing",
        `/decision_basis/decisive_findings/${index}`,
        "决定性发现必须引用归因结果中的既有 finding。" + findingHelp(ref.candidate),
        ref.candidate,
        ref.finding_index,
      );
  }
  for (const label of labels) {
    const attribution = input.attributions?.[label];
    if (!attribution) continue;
    const coreProblem = attribution.findings.some((finding) => finding.type === "problem" &&
      finding.assessment.evidence_status === "established" &&
      finding.assessment.requirement_index !== null);
    if (value.assessments[label]?.meets_core === false && !coreProblem)
      issue("core_failure_unproven", `/assessments/${label}/meets_core`,
        "判核心不可用必须引用已证实、关联核心要求的问题，并说明哪项必要结果无法使用；不能只凭疑似问题", label);
  }
  for (let i = 0; i < labels.length; i++)
    for (const second of labels.slice(i + 1)) {
      const first = labels[i]!;
      if (!value.assessments[first]?.meets_core || !value.assessments[second]?.meets_core || tierOf(first) !== tierOf(second)) continue;
      const advantage = (a: string, b: string) => value.decision_basis.comparisons.some((row) =>
        row.importance !== "low" && row.better_candidates.includes(a) && !row.better_candidates.includes(b));
      if (advantage(first, second) !== advantage(second, first))
        issue("tie_ignores_advantage", "/ranking", "仅一方有已确认的中高重要性优势，不能判都好；应根据实质差异分胜负");
    }

  if (errors.length) throw new ValidationError(errors);
}
