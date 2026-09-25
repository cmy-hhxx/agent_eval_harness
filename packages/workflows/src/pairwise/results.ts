import { Ajv2020 } from "ajv/dist/2020.js";
import {
  type JsonObject,
  type PlannedTask,
  type RunState,
  type SubmissionReceipt,
} from "@eval/contracts";
import { correctnessProfile } from "@eval/agents/critique";
import type { CorrectnessResult, EvalConfig, PairwiseResult, RawInput, TaskData } from "./types.js";
import { annotateFindings } from "./annotations.js";
import { outputSchema } from "./schema.js";
export function display<T>(value: T, names: Record<string, string>, key = ""): T {
  if (typeof value === "string")
    return (
      key === "quote"
        ? value
        : value.replace(
            /【候选([AB])】|候选\s*([AB])(?![A-Za-z0-9_])|(?:中枢\s*A\s*\/\s*B|A\s*\/\s*B\s*\/\s*C|(?:公司|方案|情景|选项|计划|路径|项目|中枢)\s*[AB])|(?<![A-Za-z0-9_])([AB])(?![A-Za-z0-9_]|组|\s*(?:股|[+＋]\s*H|浪|类|级|轮|款|型))/gu,
            (match, bracketed: string | undefined, candidate: string | undefined, bare: string | undefined) =>
              names[bracketed || candidate || bare || ""] || match,
          )
    ) as T;
  if (Array.isArray(value)) return value.map((v) => display(v, names)) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, display(v, names, k)])) as T;
  return value;
}
export function comparisonRow(
  inputs: Record<string, unknown>,
  task: PlannedTask,
  result: PairwiseResult,
  receipts: Map<string, SubmissionReceipt>,
  names: Record<string, string>,
): JsonObject {
  const data = task.data as TaskData,
    a = data.candidates.A,
    versions = Object.values(data.candidates).map((r) => r.version);
  if (versions.length !== 2 || new Set(versions).size !== 2 || !data.pair?.every((v) => versions.includes(v)))
    throw new Error("任务配对与候选不一致");
  const labels = Object.fromEntries(
    Object.entries(data.candidates).map(([label, c]) => [label, names[c.version] || c.name]),
  );
  const evaluations: Record<string, unknown> = {};
  for (const [label, c] of Object.entries(data.candidates)) {
    const correctness = task.dependencies[label]
      ? (receipts.get(task.dependencies[label])?.evaluation as CorrectnessResult)
      : { is_correct: null, correctness_reason: "" };
    if (!correctness) throw new Error("缺少正确性任务收据");
    const review = display(structuredClone(result.evaluations[label]), labels);
    const raw = inputs[c.input_id] as RawInput;
    const traces = annotateFindings(raw, review.findings);
    review.findings.forEach((finding, i) => {
      finding.stage_trace = traces[i];
    });
    evaluations[c.version] = {
      is_correct: correctness.is_correct,
      correctness_reason: display(correctness.correctness_reason, {
        A: labels[label],
      }),
      ...review,
    };
  }
  const winner =
    result.verdict.result === "A_better" ? "A" : result.verdict.result === "B_better" ? "B" : null;
  const first = Object.values(data.candidates).find((c) => c.version === data.pair![0])!;
  const raw = inputs[first.input_id] as RawInput;
  return {
    request_time: raw.request_time ?? null,
    has_standard_answer: data.reference !== null,

    evaluation_type: "pairwise_model_comparison",
    comparison_id: data.comparisonId || "cmp_" + task.id,
    case: { batch_id: a.batch_id, case_id: a.case_id },
    ground_truth: { available: data.reference !== null, value: data.reference },
    models: Object.fromEntries(
      Object.values(data.candidates).map((c) => [
        c.version,
        {
          version: names[c.version] || c.name,
          llm: c.llm,
          trace_id: c.trace_id,
        },
      ]),
    ),
    verdict: {
      result: winner ? "win" : result.verdict.result,
      winner_version: winner ? data.candidates[winner].version : null,
      winner_name: winner ? labels[winner] : null,
      reason: display(result.verdict.reason, labels),
    },
    evaluations,
    task_analysis: display(result.task_analysis, labels),
    decision_basis: {
      tradeoff: display(result.decision_basis.tradeoff, labels),
      ...Object.fromEntries(
        ["decisive_findings", "counterevidence"].map((kind) => [
          kind,
          result.decision_basis[kind as "decisive_findings" | "counterevidence"].map((ref) => ({
            ...ref,
            candidate: data.candidates[ref.candidate].version,
          })),
        ]),
      ),
    },
  };
}
export function correctnessRow(task: PlannedTask, receipt: SubmissionReceipt): JsonObject {
  const candidate = (task.data as TaskData).candidates.A;
  return {
    evaluation_type: "correctness",
    task_id: task.id,
    submission_id: receipt.submissionId,
    input_id: task.inputIds.A,
    case: { batch_id: candidate.batch_id, case_id: candidate.case_id },
    version: candidate.version,
    evaluation: receipt.evaluation,
  };
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
const validateOutput = ajv.compile(outputSchema),
  validateCorrectness = ajv.compile(correctnessProfile.resolvedSchema!);
export function encodeResult(task: PlannedTask, state: RunState, inputs: Record<string, unknown>) {
  const receipt = state.receipts[task.id],
    data = task.data as TaskData;
  if (task.stage === "correctness") {
    const row = receipt.exported?.row || correctnessRow(task, receipt);
    if (!validateCorrectness(row.evaluation))
      throw new Error("正确性结果 schema 无效：" + ajv.errorsText(validateCorrectness.errors));
    return { id: task.id, file: "correctness.jsonl", row };
  }
  const config = state.manifest.config as EvalConfig;
  const names = Object.fromEntries(config.inputs.versions.map((v) => [v.id, v.display_name || v.name]));
  const result = receipt.evaluation as PairwiseResult;
  const row =
    receipt.exported?.row ||
    comparisonRow(inputs, task, result, new Map(Object.entries(state.receipts)), names);
  if (!validateOutput(row))
    throw new Error("导出 schema 无效：" + ajv.errorsText(validateOutput.errors));
  return {
    id: String(row.comparison_id),
    file: data.pair!.join("__vs__") + ".jsonl",
    row,
  };
}
