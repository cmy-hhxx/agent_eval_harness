import { compactResultSchema } from "@eval/agents/compact";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  type JsonObject,
  type ResultReference,
  type PlannedTask,
  type RunState,
  type SubmissionReceipt,
} from "@eval/contracts";
import { attributionDimension, dimensionAttributionRow } from "../review/dimensions.js";
import { criteriaProfile } from "@eval/agents/criteria";
import { comparisonProfile } from "@eval/agents/comparison";
import type { RewriteResult } from "@eval/agents/rewrite";
import type { ClusteringObservation, ClusteringResult } from "@eval/agents/clustering";
import type { ComparisonResult, EvalConfig, SessionAttributionResult, Stage, TaskData } from "./types.js";
import type { RawInput } from "../inputs/types.js";
import { clusteringSchema, rewrittenSchema, outputSchema } from "./schema.js";
import { decideVerdict, tierOf, verdictReason } from "./verdicts.js";
import { taskObservations } from "./observations.js";
import { acceptedRewriteProjection } from "./rewrite-projection.js";
import { sessionAttributionResultSchema } from "@eval/agents/attribution";
export { acceptedRewrites, acceptedRewriteProjection, sourceRewriteTasks } from "./rewrite-projection.js";
import { displayComparison } from "./candidate-display.js";
export { display, displayComparison } from "./candidate-display.js";

/** Refresh display-only fields of a durable row without changing judgments or evidence. */
export function displayComparisonRow(row: JsonObject, task: PlannedTask): JsonObject {
  const models = row.models as Record<string, { version: string }>;
  const names = Object.fromEntries(Object.entries((task.data as TaskData).candidates)
    .map(([label, candidate]) => [label, models[candidate.version].version]));
  const view = structuredClone(row);
  const prose = (item: JsonObject, field: string) => { item[field] = displayComparison(item[field], names); };
  for (const item of Object.values(view.assessments as Record<string, JsonObject>)) prose(item, "summary");
  for (const item of Object.values(view.verdicts as Record<string, JsonObject>)) prose(item, "reason");
  view.task_analysis = displayComparison(view.task_analysis, names);
  const basis = view.decision_basis as JsonObject;
  prose(basis, "tradeoff");
  for (const item of basis.comparisons as JsonObject[]) {
    prose(item, "aspect");
    for (const assessment of Object.values(item.assessments as Record<string, JsonObject>)) prose(assessment, "summary");
  }
  if (view.rewritten) for (const item of (view.rewritten as JsonObject).rewrites as JsonObject[]) prose(item, "text");
  return view;
}

/** Derive every two-way verdict from the group ranking plus per-candidate core classification. */
function deriveVerdicts(
  candidates: Record<string, { version: string }>,
  result: ComparisonResult,
  group: string[],
  labels: Record<string, string>,
): Record<string, JsonObject> {
  if (result.status !== "decided") throw new Error("待复核结果不能推导对战判决");
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
        result.assessments[la]!.meets_core!,
        result.assessments[lb]!.meets_core!,
        tiers.get(la) ?? 0,
        tiers.get(lb) ?? 0,
      );
      const winnerVersion = decision.winner === "first" ? va : decision.winner === "second" ? vb : null;
      const winnerLabel = decision.winner === "first" ? la : decision.winner === "second" ? lb : null;
      verdicts[va + "__vs__" + vb] = {
        result: decision.outcome,
        winner_version: winnerVersion,
        winner_name: winnerLabel ? labels[winnerLabel] : null,
        reason: displayComparison(verdictReason(decision, la, lb), labels),
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
      ? (receipts.get(task.dependencies[label])?.evaluation as SessionAttributionResult)
      : undefined;
    if (!attribution) throw new Error("缺少归因任务收据");
    evaluations[c.version] = structuredClone(attribution);
  }
  const first = data.candidates[Object.keys(data.candidates).find((label) => data.candidates[label]!.version === group[0])!]!;
  const raw = inputs[first.input_id] as RawInput;
  return {
    request_time: raw.request_time ?? null,
    has_standard_answer: data.reference !== null,
    evaluator_version: evaluatorVersion,
    status: result.status,
    criteria_task_id: task.dependencies.criteria,
    attribution_task_ids: Object.fromEntries(Object.keys(data.candidates).map((label) => [data.candidates[label]!.version, task.dependencies[label]])),

    evaluation_type: "group_model_comparison",
    ...(data.prediction ? { evaluation_purpose: "prediction", prediction: data.prediction } : {}),
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
        { meets_core: assessment.meets_core, core_failure_refs: assessment.core_failure_refs, summary: displayComparison(assessment.summary, labels) },
      ]),
    ),
    evaluations,
    verdicts: deriveVerdicts(data.candidates, result, group, labels),
    task_analysis: displayComparison(result.task_analysis, labels),
    decision_basis: {
      tradeoff: displayComparison(result.decision_basis.tradeoff, labels),
      comparisons: result.decision_basis.comparisons.map((item) => ({
        aspect: displayComparison(item.aspect, labels),
        importance: item.importance,
        criterion_ids: item.criterion_ids,
        better_candidates: item.better_candidates.map((label) => data.candidates[label]!.version),
        assessments: Object.fromEntries(Object.entries(item.assessments).map(([label, assessment]) => [
          data.candidates[label]!.version,
          { ...assessment, summary: displayComparison(assessment.summary, labels) },
        ])),
      })),
      decisive_findings: result.decision_basis.decisive_findings.map((ref) => ({
        candidate: data.candidates[ref.candidate]!.version,
        finding_index: ref.finding_index,
      })),
    },
  };
}
export function attributionRow(_task:PlannedTask,receipt:SubmissionReceipt):JsonObject{
  return structuredClone(receipt.evaluation) as JsonObject;
}
/** Result file per stage; the single place that maps stages to JSONL artifacts. */
export function resultFile(stage: Stage | "attribution"): string {
  const dimension = attributionDimension(stage);
  if (dimension) return dimension.resultKey + ".jsonl";
  if (stage === "attribution-compact") return "compact.jsonl";
  if (stage === "criteria") return "criteria.jsonl";
  if (stage === "attribution" || stage === "attribution-session") return "attribution.jsonl";
  if (stage === "comparison") return "comparison.jsonl";
  if (stage === "rewrite") throw new Error("改写结果必须引用源结果文件");
  return "clustering.jsonl";
}
/** The stage output inside its exported identity envelope. */
export function stageResult(stage: string, row: JsonObject): JsonObject {
  const dimension = attributionDimension(stage);
  if (dimension) return row[dimension.resultKey] as JsonObject;
  return stage === "criteria" || ["comparison_review", "comparison_verification"].includes(String(row.evaluation_type)) ? row.result as JsonObject
    : stage === "attribution" || stage === "attribution-session" ? row
    : stage === "clustering" ? row.result as JsonObject : row;
}
function replaceStageResult(stage: string, row: JsonObject, result: JsonObject): JsonObject {
  const dimension = attributionDimension(stage);
  if (dimension) return { ...row, [dimension.resultKey]: result };
  return stage === "attribution" || stage === "attribution-session" ? result
    : stage === "clustering" || stage === "criteria" || ["comparison_review", "comparison_verification"].includes(String(row.evaluation_type)) ? { ...row, result } : result;
}
export function stageRewritten(stage:string,row:JsonObject):unknown{
 return row.evaluation_type === "attribution_rewrite" ? row.rewritten : stageResult(stage,row).rewritten;
}
export function originalResultRow(stage:string,row:JsonObject):JsonObject{
 const {rewritten:_rewritten,...result}=stageResult(stage,row);return replaceStageResult(stage,row,result);
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
    items: observations.map(({ id, component, label, count, established_count, uncertain_count, established_answer_ids }) =>
      ({ id, component, label, count, established_count, uncertain_count, established_answer_ids })),
    result: receipt.evaluation as ClusteringResult,
  };
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
const validateCompact = ajv.compile(compactResultSchema);
const validateOutput = ajv.compile(outputSchema),
  validateCriteria = ajv.compile(criteriaProfile.resultSchema!),
  validateComparison = ajv.compile(comparisonProfile.resultSchema!),
  validateAttribution = ajv.compile(sessionAttributionResultSchema),
  validateRewritten = ajv.compile(rewrittenSchema),
  validateClustering = ajv.compile(clusteringSchema);
export function encodeResult(task: PlannedTask, state: RunState, inputs: Record<string, unknown>):
  ResultReference & { row: JsonObject; auxiliary?: boolean } | null {
  const data = task.data as TaskData;
  if ((data.verificationAudit || data.verificationOf) &&
    (task.stage !== "comparison" || data.verificationAudit !== true || !data.verificationOf?.taskId))
    throw new Error("可选核验必须同时声明核验标记与正式对比来源。");
  const receipt = state.receipts[task.id];
  if (task.stage === "attribution-trace" || task.stage === "attribution-compact-field") return null;
  if (attributionDimension(task.stage)) return receipt.exported ?? { id: task.id, file: resultFile(task.stage as Stage),
    row: dimensionAttributionRow(task, receipt, Object.values(data.candidates)[0]) };
  if (task.stage === "attribution-compact" && !validateCompact(receipt.evaluation))
    throw new Error("Compact 导出契约无效：" + ajv.errorsText(validateCompact.errors));
  // Durable exports have already crossed the acceptance boundary. Reuse their exact row on resume.
  if (receipt.exported && task.stage !== "rewrite") {
    const data = task.data as TaskData;
    const file = receipt.exported.file ?? (data.stage === "comparison" && data.verificationAudit ? "comparison-verification.jsonl"
      : data.stage === "comparison" && (receipt.evaluation as ComparisonResult).status === "needs_review" ? "comparison-review.jsonl"
      : resultFile(data.stage === "rewrite" ? data.rewriteOf!.stage : task.stage as Stage));
    if (task.stage === "comparison" && receipt.exported.row.evaluation_type === "group_model_comparison") {
      const row = displayComparisonRow(receipt.exported.row, task);
      // Presentation repairs may replace a durable row; accepted model receipts remain immutable.
      if (JSON.stringify(row) !== JSON.stringify(receipt.exported.row))
        return { ...receipt.exported, file, row, auxiliary: true };
    }
    return { ...receipt.exported, file };
  }
  if (task.stage === "criteria") {
    if (!validateCriteria(receipt.evaluation)) throw new Error("共同验收基准 schema 无效：" + ajv.errorsText(validateCriteria.errors));
    return { id: task.id, file: "criteria.jsonl", row: {
      evaluation_type: "criteria", evaluator_version: receipt.evaluatorVersion,
      task_id: task.id, case: { batch_id: Object.values((task.data as TaskData).candidates)[0]!.batch_id,
        case_id: Object.values((task.data as TaskData).candidates)[0]!.case_id }, result: receipt.evaluation,
    } };
  }
  if (task.stage === "attribution-compact") {
    const row = receipt.evaluation as JsonObject;
    return { id: task.id, file: "compact.jsonl", row };
  }
  if (task.stage === "attribution-session") {
    const row = attributionRow(task, receipt);
    if (!validateAttribution(row))
      throw new Error("归因结果 schema 无效：" + ajv.errorsText(validateAttribution.errors));
    return { id: task.id, file: "attribution.jsonl", row };
  }
  if (task.stage === "rewrite") {
    const source = (task.data as TaskData).rewriteOf!;
    const sourceTask = state.manifest.tasks.find((item) => item.id === source.taskId)!;
    const exported = encodeResult(sourceTask, state, inputs);
    if (!exported) throw new Error("改写来源没有正式结果：" + source.taskId);
    const rewritten = acceptedRewriteProjection(state, source.taskId)!.rewritten;
    if (!validateRewritten(rewritten))
      throw new Error("改写结果 schema 无效：" + ajv.errorsText(validateRewritten.errors));
    if (source.stage === "attribution") {
      const candidate = (sourceTask.data as TaskData).candidates.A;
      return { id: task.id, file: "rewrite.jsonl", auxiliary: true, row: {
        evaluation_type: "attribution_rewrite", evaluator_version: receipt.evaluatorVersion, task_id: task.id,
        source_attribution_task_id: source.taskId, input_id: candidate.input_id,
        batch_id: candidate.batch_id, case_id: candidate.case_id, version: candidate.version, rewritten,
      } };
    }
    return { ...exported, row: replaceStageResult(source.stage, exported.row,
      { ...stageResult(source.stage, exported.row), rewritten }), auxiliary: true };
  }

  if (task.stage === "clustering") {
    const row = clusteringRow(task, receipt, taskObservations(task, (id) => state.receipts[id]));
    if (!validateClustering(row))
      throw new Error("聚类结果 schema 无效：" + ajv.errorsText(validateClustering.errors));
    return { id: task.id, file: "clustering.jsonl", row };
  }
  const config = state.manifest.config as EvalConfig;
  const names = Object.fromEntries(config.inputs.versions.map((v) => [v.id, v.display_name || v.name]));
  const result = receipt.evaluation as ComparisonResult;
  if ((task.data as TaskData).verificationAudit) {
    if (!validateComparison(result)) throw new Error("可选复核结果 schema 无效：" + ajv.errorsText(validateComparison.errors));
    return { id: task.id, file: "comparison-verification.jsonl", row: {
      evaluation_type: "comparison_verification", evaluator_version: receipt.evaluatorVersion,
      task_id: task.id, comparison_id: (task.data as TaskData).comparisonId,
      source_task_id: (task.data as TaskData).verificationOf!.taskId, result,
    } };
  }
  if (result.status === "needs_review") {
    if (!validateComparison(result)) throw new Error("复核结果 schema 无效：" + ajv.errorsText(validateComparison.errors));
    return { id: task.id, file: "comparison-review.jsonl", row: {
    evaluation_type: "comparison_review", evaluator_version: receipt.evaluatorVersion, task_id: task.id,
    comparison_id: (task.data as TaskData).comparisonId, result: receipt.evaluation,
    } };
  }
  const row = comparisonRow(inputs, task, result, new Map(Object.entries(state.receipts)), names, receipt.evaluatorVersion);
  if (!validateOutput(row))
    throw new Error("导出 schema 无效：" + ajv.errorsText(validateOutput.errors));
  return { id: String(row.comparison_id), file: "comparison.jsonl", row };
}
