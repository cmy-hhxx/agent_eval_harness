import { Ajv2020 } from "ajv/dist/2020.js";
import {
  schemaIssues,
  ValidationError,
  type AgentRequest,
  type ToolAudit,
  type ValidationIssue,
} from "@eval/contracts";
import { validateTraceEvidence } from "@eval/tools";
import type { PairwiseResult } from "./types.js";
import schema from "./profiles/default/resolved.schema.json" with { type: "json" };
interface Input {
  ground_truth: { available: boolean; value: unknown };
  candidates: Record<
    string,
    {
      final_message_index: number;
      original_answer_timing: { finish_seconds: number | null };
    }
  >;
  correctness?: Record<string, { is_correct: boolean | null; correctness_reason?: string }>;
}

const validator = new Ajv2020({
  allErrors: true,
  strict: false,
}).compile<unknown>(schema);
export function validateEvaluation(request: AgentRequest, result: unknown, audit: ToolAudit): void {
  if (!validator(result)) throw new ValidationError(schemaIssues(validator.errors, result));
  const input = request.input as unknown as Input;
  const repairErrors: ValidationIssue[] = [];
  const pairwise = result as PairwiseResult;
  const issue = (
    code: string,
    path: string,
    message: string,
    candidate?: string,
    expected?: unknown,
    actual?: unknown,
  ) =>
    repairErrors.push({
      category: "decision",
      code,
      path,
      message,
      candidate,
      expected,
      actual,
    });
  const { evaluations, references, analysis } = {
    evaluations: pairwise.evaluations,
    references: pairwise.decision_basis,
    analysis: pairwise.task_analysis,
  };
  for (const [candidate, review] of Object.entries(evaluations))
    for (const [i, finding] of review.findings.entries())
      if (finding.assessment.requirement_index >= analysis.requirements.length)
        issue(
          "requirement_index_invalid",
          `/evaluations/${candidate}/findings/${i}/assessment/requirement_index`,
          "发现关联了不存在的任务要求",
          candidate,
          analysis.requirements.length,
          finding.assessment.requirement_index,
        );
  const decisive = references.decisive_findings.flatMap((ref, i) => {
    const finding = evaluations[ref.candidate]?.findings[ref.finding_index];
    if (!finding) {
      issue(
        "finding_missing",
        `/decision_basis/decisive_findings/${i}`,
        "判决引用了不存在的发现",
        ref.candidate,
        undefined,
        ref.finding_index,
      );
      return [];
    }
    if (pairwise.verdict.result !== "not_comparable" && finding.assessment.evidence_status !== "established")
      issue(
        "finding_uncertain",
        `/decision_basis/decisive_findings/${i}`,
        "不确定的发现不能决定胜负、都好或都差",
        ref.candidate,
      );
    return [{ candidate: ref.candidate, finding }];
  });
  for (const [i, ref] of references.counterevidence.entries())
    if (!evaluations[ref.candidate]?.findings[ref.finding_index])
      issue(
        "counterevidence_invalid",
        `/decision_basis/counterevidence/${i}`,
        "反向证据索引无效",
        ref.candidate,
        undefined,
        ref.finding_index,
      );
  if (pairwise.verdict.result !== "not_comparable" && new Set(decisive.map((d) => d.candidate)).size !== 2)
    issue("both_candidates_required", "/decision_basis/decisive_findings", "判决必须引用双方发现");
  const winner =
    pairwise.verdict.result === "A_better" ? "A" : pairwise.verdict.result === "B_better" ? "B" : null;
  if (
    winner &&
    !decisive.some((d) =>
      d.candidate === winner ? d.finding.type === "strength" : d.finding.type === "problem",
    )
  )
    issue("winner_unsupported", "/verdict/result", "决定性发现未支持所选赢家", winner || undefined);
  for (const [candidate, review] of Object.entries(evaluations)) {
    const correctness = input.correctness?.[candidate];
    if (input.ground_truth.available && !correctness)
      issue(
        "correctness_receipt_missing",
        `/evaluations/${candidate}`,
        `缺少有效的独立正确性收据：${candidate}`,
        candidate,
      );
    const support = decisive.filter((d) => d.candidate === candidate).map((d) => d.finding);
    if (pairwise.verdict.result === "both_good") {
      if (input.ground_truth.available && correctness?.is_correct !== true)
        issue(
          "both_good_correctness",
          "/verdict/result",
          `both_good 要求 ${candidate} 的独立正确性为 true`,
          candidate,
          true,
          correctness?.is_correct,
        );
      if (review.findings.some((f) => f.type === "problem" && f.importance === "high"))
        issue(
          "both_good_contradiction",
          `/evaluations/${candidate}/findings`,
          `both_good 与 ${candidate} 的严重问题矛盾；需先核实并解决`,
          candidate,
        );
      for (let index = 0; index < analysis.requirements.length; index++)
        if (
          !support.some(
            (f) =>
              f.type === "strength" && f.importance !== "low" && f.assessment.requirement_index === index,
          )
        )
          issue(
            "requirement_uncovered",
            "/decision_basis/decisive_findings",
            `both_good 缺少 ${candidate} 对核心要求 ${index} 的已确认重要优势引用`,
            candidate,
            index,
          );
    }
    if (pairwise.verdict.result === "both_bad") {
      if (!support.some((f) => f.type === "problem" && f.importance === "high"))
        issue(
          "both_bad_unsupported",
          "/decision_basis/decisive_findings",
          `both_bad 缺少 ${candidate} 的已确认严重问题引用`,
          candidate,
        );
      if (
        correctness?.is_correct === true &&
        review.findings.some(
          (f) =>
            f.type === "problem" &&
            f.importance === "high" &&
            f.dimension === "correctness" &&
            f.assessment.evidence_status === "established",
        )
      )
        issue(
          "correctness_contradiction",
          `/evaluations/${candidate}/findings`,
          `both_bad 的 ${candidate} 正确性错误与独立正确性收据矛盾`,
          candidate,
        );
    }
  }
  if (pairwise.verdict.result !== "not_comparable")
    for (const [candidate, review] of Object.entries(evaluations))
      review.findings.forEach((finding, index) => {
        const opposite = winner
          ? candidate === winner
            ? finding.type === "problem"
            : finding.type === "strength"
          : pairwise.verdict.result === "both_good"
            ? finding.type === "problem"
            : finding.type === "strength";
        if (
          opposite &&
          finding.importance !== "low" &&
          finding.assessment.evidence_status === "established" &&
          !references.counterevidence.some((r) => r.candidate === candidate && r.finding_index === index)
        )
          issue(
            "counterevidence_missing",
            "/decision_basis/counterevidence",
            `遗漏已确认的重要反向证据：counterevidence 缺少 ${candidate}:${index}`,
            candidate,
            index,
          );
      });
  if (
    Object.values(input.candidates).some((r) => r.original_answer_timing.finish_seconds === null) &&
    analysis.timing_analysis
  )
    issue(
      "timing_unavailable",
      "/task_analysis/timing_analysis",
      "无完整双方耗时时 timing_analysis 必须为空",
    );

  for (const [label, candidate] of Object.entries(input.candidates)) {
    const raw = request.sources[label].value as {
      messages: Record<string, unknown>[];
    };
    const evidence = pairwise.evaluations[label].findings.flatMap((f, i) =>
      f.evidence.map((item, j) => ({
        item,
        location: `evaluations.${label}.findings[${i}].evidence[${j}]`,
      })),
    );
    repairErrors.push(...validateTraceEvidence(raw, evidence, label, audit, undefined));
    void candidate;
  }
  if (repairErrors.length) throw new ValidationError(repairErrors);
}
