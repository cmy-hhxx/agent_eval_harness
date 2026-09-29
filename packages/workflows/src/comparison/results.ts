import { Ajv2020 } from "ajv/dist/2020.js";
import {
  type JsonObject,
  type ResultReference,
  type PlannedTask,
  type RunState,
  type SubmissionReceipt,
} from "@eval/contracts";
import { attributionProfile } from "@eval/agents/attribution";
import type { RewriteResult } from "@eval/agents/rewrite";
import type { ClusteringObservation, ClusteringResult } from "@eval/agents/clustering";
import type { AttributionResult, ComparisonResult, EvalConfig, RawInput, Stage, TaskData } from "./types.js";
import { annotateFindings } from "./annotations.js";
import { clusteringSchema, rewrittenSchema, outputSchema } from "./schema.js";
import { decideVerdict, tierOf, verdictReason } from "./verdicts.js";
import { taskObservations } from "./observations.js";
export function display<T>(value: T, names: Record<string, string>, key = ""): T {
  if (typeof value === "string")
    return (
      key === "quote"
        ? value
        : value.replace(
            /【候选([A-Z])】|候选\s*([A-Z])(?![A-Za-z0-9_])|(?:中枢\s*A\s*\/\s*B|A\s*\/\s*B\s*\/\s*C|(?:公司|方案|情景|选项|计划|路径|项目|中枢)\s*[A-Z])|(?<![A-Za-z0-9_全])([A-Z])(?![A-Za-z0-9_]|组|\s*(?:股|[+＋]\s*H|浪|类|级|轮|款|型))/gu,
            (match, bracketed: string | undefined, candidate: string | undefined, bare: string | undefined) =>
              names[bracketed || candidate || bare || ""] || match,
          )
    ) as T;
  if (Array.isArray(value)) return value.map((v) => display(v, names)) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, display(v, names, k)])) as T;
  return value;
}

/** Derive every two-way verdict from the group ranking plus per-candidate core classification. */
function deriveVerdicts(
  candidates: Record<string, { version: string }>,
  result: ComparisonResult,
  group: string[],
  labels: Record<string, string>,
): Record<string, JsonObject> {
  const labelOf = new Map(Object.entries(candidates).map(([label, c]) => [c.version, label]));
  const tiers = tierOf(result.ranking);
  const verdicts: Record<string, JsonObject> = {};
  for (let i = 0; i < group.length; i++)
    for (let j = i + 1; j < group.length; j++) {
      const va = group[i]!,
        vb = group[j]!,
        la = labelOf.get(va)!,
        lb = labelOf.get(vb)!;
      const decision = decideVerdict(
        result.assessments[la]!.meets_core,
        result.assessments[lb]!.meets_core,
        tiers.get(la) ?? 0,
        tiers.get(lb) ?? 0,
      );
      const winnerVersion = decision.winner === "first" ? va : decision.winner === "second" ? vb : null;
      const winnerLabel = decision.winner === "first" ? la : decision.winner === "second" ? lb : null;
      verdicts[va + "__vs__" + vb] = {
        result: decision.outcome,
        winner_version: winnerVersion,
        winner_name: winnerLabel ? labels[winnerLabel] : null,
        reason: display(verdictReason(decision, la, lb), labels),
      };
    }
  return verdicts;
}

export function comparisonRow(
  inputs: Record<string, unknown>,
  task: PlannedTask,
  result: ComparisonResult,
  receipts: Map<string, SubmissionReceipt>,
  names: Record<string, string>,
  evaluatorVersion: string,
): JsonObject {
  const data = task.data as TaskData,
    group = data.group!;
  const labels = Object.fromEntries(
    Object.entries(data.candidates).map(([label, c]) => [label, names[c.version] || c.name]),
  );
  const evaluations: Record<string, unknown> = {};
  for (const [label, c] of Object.entries(data.candidates)) {
    const attribution = task.dependencies[label]
      ? (receipts.get(task.dependencies[label])?.evaluation as AttributionResult)
      : undefined;
    if (!attribution) throw new Error("缺少归因任务收据");
    const raw = inputs[c.input_id] as RawInput;
    const findings = structuredClone(attribution.findings) as (AttributionResult["findings"][number] & { stage_trace?: JsonObject })[];
    const traces = annotateFindings(raw, findings);
    findings.forEach((finding, i) => {
      finding.stage_trace = traces[i];
    });
    evaluations[c.version] = {
      is_correct: attribution.is_correct,
      correctness_reason: attribution.correctness_reason,
      correctness_evidence: attribution.correctness_evidence,
      numeric_checks: attribution.numeric_checks,
      summary: attribution.summary,
      findings,
    };
  }
  const first = data.candidates[Object.keys(data.candidates).find((label) => data.candidates[label]!.version === group[0])!]!;
  const raw = inputs[first.input_id] as RawInput;
  return {
    request_time: raw.request_time ?? null,
    has_standard_answer: data.reference !== null,
    evaluator_version: evaluatorVersion,

    evaluation_type: "group_model_comparison",
    comparison_id: data.comparisonId || "cmp_" + task.id,
    case: { batch_id: first.batch_id, case_id: first.case_id },
    ground_truth: { available: data.reference !== null, value: data.reference },
    models: Object.fromEntries(
      Object.values(data.candidates).map((c) => [
        c.version,
        { version: names[c.version] || c.name, llm: c.llm, trace_id: c.trace_id },
      ]),
    ),
    ranking: result.ranking.map((tier) => tier.map((label) => data.candidates[label]!.version)),
    assessments: Object.fromEntries(
      Object.entries(result.assessments).map(([label, assessment]) => [
        data.candidates[label]!.version,
        { meets_core: assessment.meets_core, summary: display(assessment.summary, labels) },
      ]),
    ),
    evaluations,
    verdicts: deriveVerdicts(data.candidates, result, group, labels),
    task_analysis: display(result.task_analysis, labels),
    decision_basis: {
      tradeoff: display(result.decision_basis.tradeoff, labels),
      comparisons: result.decision_basis.comparisons.map((item) => ({
        aspect: display(item.aspect, labels),
        importance: item.importance,
        better_candidates: item.better_candidates.map((label) => data.candidates[label]!.version),
        assessments: Object.fromEntries(Object.entries(item.assessments).map(([label, assessment]) => [
          data.candidates[label]!.version,
          { summary: display(assessment.summary, labels), finding_indices: assessment.finding_indices },
        ])),
      })),
      decisive_findings: result.decision_basis.decisive_findings.map((ref) => ({
        candidate: data.candidates[ref.candidate]!.version,
        finding_index: ref.finding_index,
      })),
    },
  };
}
export function attributionRow(task: PlannedTask, receipt: SubmissionReceipt): JsonObject {
  const candidate = (task.data as TaskData).candidates.A;
  return {
    evaluation_type: "attribution",
    evaluator_version: receipt.evaluatorVersion,
    task_id: task.id,
    submission_id: receipt.submissionId,
    input_id: task.inputIds.answer,
    case: { batch_id: candidate.batch_id, case_id: candidate.case_id },
    version: candidate.version,
    evaluation: receipt.evaluation,
  };
}
/** Result file per stage; the single place that maps stages to JSONL artifacts. */
export function resultFile(stage: Stage): string {
  if (stage === "attribution") return "attribution.jsonl";
  if (stage === "comparison") return "comparison.jsonl";
  if (stage === "rewrite") throw new Error("改写结果必须引用源结果文件");
  return "clustering.jsonl";
}
/** The stage output inside its exported identity envelope. */
export function stageResult(stage: string, row: JsonObject): JsonObject {
  return stage === "attribution" ? row.evaluation as JsonObject
    : stage === "clustering" ? row.result as JsonObject : row;
}
function replaceStageResult(stage: string, row: JsonObject, result: JsonObject): JsonObject {
  return stage === "attribution" ? { ...row, evaluation: result }
    : stage === "clustering" ? { ...row, result } : result;
}
export function originalResultRow(stage: string, row: JsonObject): JsonObject {
  const { rewritten: _rewritten, ...result } = stageResult(stage, row);
  return replaceStageResult(stage, row, result);
}
/** Text-only polish embedded in the source result row. */
export function rewrittenResult(receipt: SubmissionReceipt): JsonObject {
  return {
    evaluator_version: receipt.evaluatorVersion,
    rewrites: (receipt.evaluation as RewriteResult).rewrites,
  };
}
/** Accepted classification decision for one model and batch, joined by task id. */
export function clusteringRow(
  task: PlannedTask,
  receipt: SubmissionReceipt,
  observations: ClusteringObservation[],
): JsonObject {
  const scope = (task.data as TaskData).scope!;
  return {
    clustering_type: "problem_library",
    evaluator_version: receipt.evaluatorVersion,
    task_id: task.id,
    model: scope.version,
    batch_id: scope.batch_id,
    items: observations.map(({ id, component, label, count, established_count, uncertain_count }) =>
      ({ id, component, label, count, established_count, uncertain_count })),
    result: receipt.evaluation as ClusteringResult,
  };
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
const validateOutput = ajv.compile(outputSchema),
  validateAttribution = ajv.compile(attributionProfile.resultSchema!),
  validateRewritten = ajv.compile(rewrittenSchema),
  validateClustering = ajv.compile(clusteringSchema);
export function encodeResult(task: PlannedTask, state: RunState, inputs: Record<string, unknown>): ResultReference & { row: JsonObject; auxiliary?: boolean } {
  const receipt = state.receipts[task.id];
  if (task.stage === "attribution") {
    const row = receipt.exported?.row || attributionRow(task, receipt);
    if (!validateAttribution(row.evaluation))
      throw new Error("归因结果 schema 无效：" + ajv.errorsText(validateAttribution.errors));
    return { id: task.id, file: "attribution.jsonl", row };
  }
  if (task.stage === "rewrite") {
    const source = (task.data as TaskData).rewriteOf!;
    const sourceTask = state.manifest.tasks.find((item) => item.id === source.taskId)!;
    const exported = encodeResult(sourceTask, state, inputs);
    const rewritten = rewrittenResult(receipt);
    const previous = stageResult(source.stage, exported.row).rewritten as { rewrites?: { id: string; text: string }[] } | undefined;
    const merged = new Map((previous?.rewrites ?? []).map((item) => [item.id, item]));
    for (const item of (receipt.evaluation as RewriteResult).rewrites) merged.set(item.id, item);
    rewritten.rewrites = [...merged.values()];
    if (!validateRewritten(rewritten))
      throw new Error("改写结果 schema 无效：" + ajv.errorsText(validateRewritten.errors));
    return {
      ...exported,
      row: replaceStageResult(source.stage, exported.row, { ...stageResult(source.stage, exported.row), rewritten }),
      auxiliary: true,
    };
  }

  if (task.stage === "clustering") {
    const row =
      receipt.exported?.row ||
      clusteringRow(task, receipt, taskObservations(task, (id) => state.receipts[id]));
    if (!validateClustering(row))
      throw new Error("聚类结果 schema 无效：" + ajv.errorsText(validateClustering.errors));
    return { id: task.id, file: "clustering.jsonl", row };
  }
  const config = state.manifest.config as EvalConfig;
  const names = Object.fromEntries(config.inputs.versions.map((v) => [v.id, v.display_name || v.name]));
  const result = receipt.evaluation as ComparisonResult;
  const row =
    receipt.exported?.row ||
    comparisonRow(inputs, task, result, new Map(Object.entries(state.receipts)), names, receipt.evaluatorVersion);
  if (!validateOutput(row))
    throw new Error("导出 schema 无效：" + ajv.errorsText(validateOutput.errors));
  return { id: String(row.comparison_id), file: "comparison.jsonl", row };
}
