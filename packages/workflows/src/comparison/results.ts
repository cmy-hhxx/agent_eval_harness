import { Ajv2020 } from "ajv/dist/2020.js";
import {
  type JsonObject,
  type PlannedTask,
  type RunState,
  type SubmissionReceipt,
} from "@eval/contracts";
import { attributionProfile } from "@eval/agents/attribution";
import type { AttributionResult, ComparisonResult, EvalConfig, RawInput, TaskData } from "./types.js";
import { annotateFindings } from "./annotations.js";
import { outputSchema } from "./schema.js";
export function display<T>(value: T, names: Record<string, string>, key = ""): T {
  if (typeof value === "string")
    return (
      key === "quote"
        ? value
        : value.replace(
            /【候选([A-Z])】|候选\s*([A-Z])(?![A-Za-z0-9_])|(?:中枢\s*A\s*\/\s*B|A\s*\/\s*B\s*\/\s*C|(?:公司|方案|情景|选项|计划|路径|项目|中枢)\s*[A-Z])|(?<![A-Za-z0-9_])([A-Z])(?![A-Za-z0-9_]|组|\s*(?:股|[+＋]\s*H|浪|类|级|轮|款|型))/gu,
            (match, bracketed: string | undefined, candidate: string | undefined, bare: string | undefined) =>
              names[bracketed || candidate || bare || ""] || match,
          )
    ) as T;
  if (Array.isArray(value)) return value.map((v) => display(v, names)) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, display(v, names, k)])) as T;
  return value;
}

function tierOf(ranking: string[][]): Map<string, number> {
  const tiers = new Map<string, number>();
  ranking.forEach((tier, index) => tier.forEach((label) => tiers.set(label, index)));
  return tiers;
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
      const ma = result.assessments[la]!.meets_core,
        mb = result.assessments[lb]!.meets_core;
      let verdict: JsonObject, reason: string;
      if (ma && !mb) {
        verdict = { result: "win", winner_version: va, winner_name: labels[la] };
        reason = `【候选${la}】完成核心要求而【候选${lb}】未完成。`;
      } else if (!ma && mb) {
        verdict = { result: "win", winner_version: vb, winner_name: labels[lb] };
        reason = `【候选${lb}】完成核心要求而【候选${la}】未完成。`;
      } else if (!ma && !mb) {
        verdict = { result: "both_bad", winner_version: null, winner_name: null };
        reason = "双方都未完成核心要求，没有实质胜者。";
      } else {
        const ta = tiers.get(la)!,
          tb = tiers.get(lb)!;
        if (ta < tb) {
          verdict = { result: "win", winner_version: va, winner_name: labels[la] };
          reason = `双方都完成核心要求，【候选${la}】实际可用性更优。`;
        } else if (tb < ta) {
          verdict = { result: "win", winner_version: vb, winner_name: labels[lb] };
          reason = `双方都完成核心要求，【候选${lb}】实际可用性更优。`;
        } else {
          verdict = { result: "both_good", winner_version: null, winner_name: null };
          reason = "双方都完成核心要求且没有实质差异。";
        }
      }
      verdicts[va + "__vs__" + vb] = { ...verdict, reason: display(reason, labels) };
    }
  return verdicts;
}

export function comparisonRow(
  inputs: Record<string, unknown>,
  task: PlannedTask,
  result: ComparisonResult,
  receipts: Map<string, SubmissionReceipt>,
  names: Record<string, string>,
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
    const findings = display(structuredClone(attribution.findings), labels) as (AttributionResult["findings"][number] & { stage_trace?: JsonObject })[];
    const traces = annotateFindings(raw, findings);
    findings.forEach((finding, i) => {
      finding.stage_trace = traces[i];
    });
    evaluations[c.version] = {
      is_correct: attribution.is_correct,
      correctness_reason: display(attribution.correctness_reason, { A: labels[label] }),
      summary: display(attribution.summary, labels),
      findings,
    };
  }
  const first = data.candidates[Object.keys(data.candidates).find((label) => data.candidates[label]!.version === group[0])!]!;
  const raw = inputs[first.input_id] as RawInput;
  return {
    request_time: raw.request_time ?? null,
    has_standard_answer: data.reference !== null,

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
  validateAttribution = ajv.compile(attributionProfile.resolvedSchema!);
export function encodeResult(task: PlannedTask, state: RunState, inputs: Record<string, unknown>) {
  const receipt = state.receipts[task.id];
  if (task.stage === "attribution") {
    const row = receipt.exported?.row || attributionRow(task, receipt);
    if (!validateAttribution(row.evaluation))
      throw new Error("归因结果 schema 无效：" + ajv.errorsText(validateAttribution.errors));
    return { id: task.id, file: "attribution.jsonl", row };
  }
  const config = state.manifest.config as EvalConfig;
  const names = Object.fromEntries(config.inputs.versions.map((v) => [v.id, v.display_name || v.name]));
  const result = receipt.evaluation as ComparisonResult;
  const row =
    receipt.exported?.row ||
    comparisonRow(inputs, task, result, new Map(Object.entries(state.receipts)), names);
  if (!validateOutput(row))
    throw new Error("导出 schema 无效：" + ajv.errorsText(validateOutput.errors));
  return { id: String(row.comparison_id), file: "comparison.jsonl", row };
}
