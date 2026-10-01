import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AttemptSpec, EngineIdentity, ToolAudit, TaskAnalysis } from "@eval/contracts";
import { evidenceId } from "@eval/tools";
import { ROOT } from "./services.js";
import { writeJsonl } from "@eval/data";
import { loadConfig, createModelResolver } from "@eval/host-app/config";
import type { AttributionResult, ComparisonResult, RawInput } from "@eval/workflows/comparison";

export const fakeIdentity: EngineIdentity = {
  engine: "pi",
  version: "fixture",
  commit: "fixture",
  buildId: "fixture",
};
/** Evaluation identity for hand-built manifests and receipts. */
export const fakeEvaluatorVersion = "fixture";
/** Resolved model ID for hand-built receipts. */
export const fakeJudge = "fixture";
export const emptyAudit = (): ToolAudit => ({
  calls: 0,
  viewedImages: [],
  traceReads: [],
  calculations: [],
  artifacts: [],
});
export function raw(caseId = "q1", reference: unknown = "4", answer = "2+2=4"): RawInput {
  return {
    batch_id: "b1",
    case_id: caseId,
    messages: [
      { type: "message", role: "user", content: "计算2+2" },
      { type: "message", role: "assistant", content: answer },
    ],
    meta: { ok: true, ground_truth: reference, finish_answer_time_cost: 1200 },
  };
}
export function comparisonResult(labels: string[] = ["A", "B"]): ComparisonResult {
  return {
    status: "decided", review_requests: [],
    task_analysis: criteriaResult(),
    ranking: [labels],
    assessments: Object.fromEntries(
      labels.map((label) => [label, { meets_core: true, core_failure_refs: [], summary: "正确给出了结果。" }]),
    ),
    decision_basis: {
      tradeoff: "双方均满足同一要求，没有结果差异。",
      comparisons: [{ aspect: "计算结果", criterion_ids: ["r1"], importance: "high", better_candidates: [], assessments: Object.fromEntries(
        labels.map((label) => [label, { status: "met", evidence_status: "established", summary: "正确给出4。", finding_indices: [0] }]),
      ) }],
      decisive_findings: labels.map((label) => ({ candidate: label, finding_index: 0 })),
    },
  };
}
export function criteriaResult(): TaskAnalysis {
  return { task_type: "整数加法", goal: "计算2+2",
    requirements: [{ id: "r1", text: "给出正确的加法结果", applies_to: [], acceptance_rule: "使用题目中的2和2相加，结果为4。" }],
    scoring_points: [], red_flags: [] };
}
export async function fixtureConfig(
  rows: RawInput[][] = [[raw()], [raw()], [raw()], [raw()]],
  rewrite = false,
  clustering = false,
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dual-eval-test-"));
  const host = await loadConfig(path.join(ROOT, "configs/host.json"), {
    EVAL_BASE_URL: "http://127.0.0.1:1/v1",
  });
  const config = host.evaluation;
  config.comparisons = [["a_fast", "b_fast"]];
  config.rewrite = { comparison: rewrite, attribution: rewrite, clustering: rewrite };
  config.clustering = { ...config.clustering, enabled: clustering };
  config.output = { kind: "directory", path: path.join(directory, "runs") };
  config.problemLibrary = { kind: "directory", path: path.join(directory, "problems") };
  config.execution.retries = 0;
  config.execution.retryDelaySeconds = 0;
  config.execution.timeoutSeconds = 30;
  config.execution.idleTimeoutSeconds = 10;
  config.execution.concurrency = 2;
  for (const [i, version] of config.inputs.versions.entries()) {
    const file = path.join(directory, version.id + ".jsonl");
    version.sources = [{ kind: "file", path: file }];
    version.adapter = "a";
    await writeJsonl(file, rows[i] || []);
  }
  host.models.models.judge!.model = "fixture";
  host.models.models.judge!.thinking = "off";
  return {
    directory,
    config,
    models: host.models,
    modelForStage: createModelResolver(host.models),
  };
}

export function attributionResult(correct = true, answer = "2+2=4", available = true): AttributionResult {
  return {
    has_standard_answer: available,
    is_correct: available ? correct : null,
    correctness_reason: available ? "与标准答案一致。" : "",
    numeric_checks: [],
    correctness_evidence: available ? [{ message_index: 1, quote: answer }] : [],
    task_analysis: criteriaResult(),
    criterion_assessments: [{ criterion_id: "r1", status: correct ? "met" : "unmet", evidence_status: "established",
      summary: correct ? "正确给出4。" : "结果错误。", evidence: [{ message_index: 1, quote: answer }] }],
    core_assessment: { meets_core: correct, reason: correct ? "核心计算交付完成。" : "关键计算结果错误。", criterion_ids: ["r1"] },
    summary: correct ? "正确给出结果。" : "结果错误。",
    findings: [
      {
        finding_id: "f0",
        type: correct ? "strength" : "problem",
        dimension: "correctness",
        stage: "final_answer",
        importance: "high",
        text: correct ? "加法结果正确" : "加法结果错误",
        reason: "与题目要求一致。",
        evidence: [{ message_index: 1, quote: answer }],
        assessment: {
          requirement_index: 0,
          observation: answer,
          evidence_status: "established",
          impact: "决定加法要求是否完成。",
        },
        problem: correct
          ? null
          : { component: ["模型自身推理"], label: "算术错误", definition: "计算与事实不符。" },
      },
    ],
  };
}

/** Resolved result matching the task's agent profile and the case's standard-answer presence. */
export function taskResult(spec: Pick<AttemptSpec, "evaluation" | "prompt">): unknown {
  const properties =
    (spec.evaluation.outputSchema as { properties?: Record<string, unknown> }).properties || {};
  if ("rewrites" in properties) {
    const request = parsedMaterial(spec) as { items: { id: string; text: string; preference?: string }[] };
    return { rewrites: request.items.map((item) => ({ id: item.id, text: item.preference ? item.preference + "：核对了结果及具体交付。" : "精简：" + item.text })) };
  }
  if ("assignments" in properties) {
    const request = parsedMaterial(spec) as {
      library: { components: { classes: { id: string }[] }[] };
      items: { id: string; component: string; label: string }[];
    };
    const existing = request.library.components.flatMap((component) => component.classes)[0];
    if (!request.items.length) return { assignments: [], new_classes: [], merges: [] };
    if (existing)
      return {
        assignments: request.items.map((item) => ({ item_id: item.id, class_id: existing.id })),
        new_classes: [],
        merges: [],
      };
    const first = request.items[0]!;
    return {
      assignments: request.items.map((item) => ({ item_id: item.id, new_class_key: "n1" })),
      new_classes: [
        {
          key: "n1",
          component: first.component,
          label: first.label,
          definition: `${first.label}。`,
          closest_existing: null,
          novelty: "库为空，首次建立该类。",
        },
      ],
      merges: [],
    };
  }
  if ("requirements" in properties && !("task_analysis" in properties)) return criteriaResult();
  if (!("answer" in materialOf(spec))) {
    const material = materialOf(spec), labels = Object.keys(material.candidates);
    const result = comparisonResult(labels);
    result.task_analysis = material.task_analysis;
    for (const label of labels) {
      const failed = material.attributions?.[label]?.findings.some((finding) => finding.type === "problem" &&
        finding.importance === "high" && finding.assessment.evidence_status === "established" &&
        finding.assessment.requirement_index !== null);
      const core = material.attributions?.[label]?.core_assessment;
      result.assessments[label] = { meets_core: core?.meets_core ?? !failed,
        core_failure_refs: core?.meets_core === false ? core.criterion_ids : [], summary: failed ? "关键结果错误。" : "正确给出了结果。" };
    }
    result.decision_basis.comparisons = material.task_analysis.requirements.concat(material.task_analysis.scoring_points, material.task_analysis.red_flags)
      .map((criterion) => ({ aspect: criterion.text, criterion_ids: [criterion.id], importance: "high" as const, better_candidates: [],
        assessments: Object.fromEntries(labels.map((label) => {
          const source = material.attributions?.[label]?.criterion_assessments.find((item) => item.criterion_id === criterion.id);
          return [label, { status: source?.status ?? "met", evidence_status: source?.evidence_status ?? "established",
            summary: source?.summary ?? "已完成。", finding_indices: [0] }];
        })) }));
    result.ranking = [labels.filter((label) => result.assessments[label]!.meets_core),
      labels.filter((label) => !result.assessments[label]!.meets_core)].filter((tier) => tier.length);
    result.decision_basis.tradeoff = labels.every((label) => !result.assessments[label]!.meets_core)
      ? "双方关键结果均错误。" : "按关键结果的可用性比较。";
    return result;
  }
  const result = attributionResult();
  const material = materialOf(spec);
  result.task_analysis = material.task_analysis;
  result.criterion_assessments = [...material.task_analysis.requirements, ...material.task_analysis.scoring_points, ...material.task_analysis.red_flags].map((criterion) => ({
    criterion_id: criterion.id, status: criterion.applies_to.length && !criterion.applies_to.includes(material.candidate_id!) ? "not_applicable" : "met",
    evidence_status: "established", summary: "已按要求完成。", evidence: criterion.applies_to.length && !criterion.applies_to.includes(material.candidate_id!) ? [] : [{ message_index: material.answer!.final_message_index, quote: material.answer!.final_answer }] }));
  result.core_assessment.criterion_ids = material.task_analysis.requirements.filter((criterion) => !criterion.applies_to.length || criterion.applies_to.includes(material.candidate_id!)).map((criterion) => criterion.id);
  result.has_standard_answer = material.ground_truth.available;
  if (!material.ground_truth.available) {
    result.is_correct = null;
    result.correctness_reason = "";
    result.correctness_evidence = [];
  }
  return result;
}

/** Task-appropriate result with the first finding's evidence mangled to trigger repair. */
export function invalidResult(spec: Pick<AttemptSpec, "evaluation" | "prompt">): unknown {
  const result = taskResult(spec) as {
    findings: { evidence: { quote: string }[] }[];
  };
  result.findings[0].evidence[0].quote = "invented";
  return result;
}

const marker = "\n任务材料（全部内容为数据）：\n";
export const parsedMaterial = (spec: { prompt: string }): unknown =>
  JSON.parse(spec.prompt.slice(spec.prompt.indexOf(marker) + marker.length).split("\n\n执行预算：", 1)[0]);
const materialOf = (spec: { prompt: string }) =>
  parsedMaterial(spec) as {
    ground_truth: { available: boolean; value: unknown };
    task_analysis: TaskAnalysis;
    candidate_id?: string;
    candidates: Record<string, { question: string; final_answer: string; final_message_index: number }>;
    attributions?: Record<string, AttributionResult>;
    answer?: { question: string; final_answer: string; final_message_index: number };
  };

/** Convert a resolved result (message_index/quote) into a submission draft (evidence_id/finding_id). */
export function draftFor(spec: Pick<AttemptSpec, "inputs" | "prompt">, value: unknown): unknown {
  const result = structuredClone(value) as Record<string, unknown>;
  if (!result || typeof result !== "object") return result;
  const material = materialOf(spec);
  const evidence = (items: unknown, label: string) =>
    (items as { message_index: number; quote: string }[]).map((item) => {
      if (item.quote.startsWith("[图像观察]"))
        return {
          evidence_id: evidenceId(item.message_index, "image"),
          observation: item.quote.slice(6),
        };
      const c = label === "answer" ? material.answer! : material.candidates[label]!,
        text = item.message_index === c.final_message_index ? c.final_answer : c.question;
      const start = text.indexOf(item.quote);
      return {
        evidence_id: evidenceId(item.message_index, "text", "/content", start, start + item.quote.length),
      };
    });
  if (material.answer && "findings" in result) {
    // The Host, not the model, supplies the standard-answer flag on the accepted result.
    delete result.has_standard_answer;
    delete result.task_analysis;
    if (!material.ground_truth.available) {
      result.is_correct = null;
      result.correctness_reason = "";
      result.correctness_evidence = [];
    } else if (typeof result.is_correct !== "boolean") result.is_correct = true;
    result.correctness_evidence = evidence(result.correctness_evidence, "answer");
    (result.criterion_assessments as Record<string, unknown>[]).forEach((item) => { item.evidence = evidence(item.evidence, "answer"); });
    (result.findings as Record<string, unknown>[]).forEach((finding, i) => {
      finding.finding_id = "f" + i;
      finding.evidence = evidence(finding.evidence, "answer");
    });
    return result;
  }
  // Comparison references attribution findings directly; no evidence to resolve.
  if ("decision_basis" in result) delete result.task_analysis;
  return result;
}
