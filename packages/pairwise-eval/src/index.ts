import { readFileSync } from "node:fs";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type {
  EvaluationPack,
  JsonSchema,
  PlannedTask,
  SubmissionReceipt,
  ToolAudit,
  ValidationIssue,
} from "../../contracts/src/index.js";
import { ROOT, canonical, schemaIssues, ValidationError } from "../../contracts/src/io.js";
import { buildPlan, comparisonPair, contentText } from "./input.js";
import type { CorrectnessResult, EvalConfig, PairwiseResult, RawInput, TaskData } from "./types.js";
import { createResultWriter, reportRun } from "./report.js";
import { readRunState, writeRunState, reconcileRun } from "./run-data.js";

import { cite, evidenceSources } from "../../tools/src/evidence.js";
import { submissionSchema, resolveSubmission } from "./submissions.js";

export const outputSchema = JSON.parse(
  readFileSync(path.join(ROOT, "packages/pairwise-eval/resources/evaluation.json"), "utf8"),
) as JsonSchema;
const promptDirectory = path.join(ROOT, "packages/pairwise-eval/resources/prompts");
export const SYSTEM_PROMPT = readFileSync(path.join(promptDirectory, "system.md"), "utf8").trim();
const instructions = {
  correctness: readFileSync(path.join(promptDirectory, "correctness.md"), "utf8").trim(),
  pairwise: readFileSync(path.join(promptDirectory, "pairwise.md"), "utf8").trim(),
};

function expand(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(expand);
  if (!value || typeof value !== "object") return value;
  const node = value as JsonSchema;
  if (typeof node.$ref === "string")
    return expand((outputSchema.$defs as Record<string, unknown>)[node.$ref.split("/").at(-1)!]);
  return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, expand(child)]));
}
export function stageSchema(stage: string): JsonSchema {
  const schema = expand((outputSchema.$defs as Record<string, unknown>)[stage]) as JsonSchema;
  if (!schema) throw new Error("Unknown evaluation stage");
  function visit(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const node = value as JsonSchema;
    if (node.properties && typeof node.properties === "object")
      delete (node.properties as JsonSchema).stage_trace;
    Object.values(node).forEach(visit);
  }
  visit(schema);
  return schema;
}
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validators = {
  correctness: ajv.compile(stageSchema("correctness")),
  pairwise: ajv.compile(stageSchema("pairwise")),
};
export function validateEvaluation(
  task: PlannedTask,
  inputs: Record<string, unknown>,
  result: unknown,
  audit: ToolAudit,
  dependencies: Record<string, SubmissionReceipt | undefined>,
): void {
  const data = task.data as TaskData;
  const validator = validators[data.stage];
  if (!validator(result)) throw new ValidationError(schemaIssues(validator.errors, result));
  if (data.stage === "pairwise") comparisonPair(Object.values(data.candidates).map((r) => r.version));
  const pairwise = result as PairwiseResult;
  const repairErrors: ValidationIssue[] = [];
  const issue = (code: string, path: string, message: string, candidate?: string, expected?: unknown, actual?: unknown) =>
    repairErrors.push({ category: code.startsWith("evidence") || code.startsWith("message") || code.startsWith("image") ? "evidence" : "decision", code, path, candidate, expected, actual, message });
  if (data.stage === "pairwise") {
    const { evaluations, references, analysis } = {
      evaluations: pairwise.evaluations,
      references: pairwise.decision_basis,
      analysis: pairwise.task_analysis,
    };
    for (const [candidate, review] of Object.entries(evaluations))
      for (const [i, finding] of review.findings.entries())
        if (finding.assessment.requirement_index >= analysis.requirements.length)
          issue("requirement_index_invalid", `/evaluations/${candidate}/findings/${i}/assessment/requirement_index`, "发现关联了不存在的任务要求", candidate, analysis.requirements.length, finding.assessment.requirement_index);
    const decisive = references.decisive_findings.flatMap((ref, i) => {
      const finding = evaluations[ref.candidate]?.findings[ref.finding_index];
      if (!finding) { issue("finding_missing", `/decision_basis/decisive_findings/${i}`, "判决引用了不存在的发现", ref.candidate, undefined, ref.finding_index); return []; }
      if (
        pairwise.verdict.result !== "not_comparable" &&
        finding.assessment.evidence_status !== "established"
      )
        issue("finding_uncertain", `/decision_basis/decisive_findings/${i}`, "不确定的发现不能决定胜负、都好或都差", ref.candidate);
      return [{ candidate: ref.candidate, finding }];
    });
    for (const [i, ref] of references.counterevidence.entries())
      if (!evaluations[ref.candidate]?.findings[ref.finding_index]) issue("counterevidence_invalid", `/decision_basis/counterevidence/${i}`, "反向证据索引无效", ref.candidate, undefined, ref.finding_index);
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
      const dependencyId = task.dependencies[candidate],
        dependency = dependencies[candidate];
      if (data.reference !== null && (
        !dependencyId || !dependency || dependency.taskId !== dependencyId || dependency.status !== "succeeded"
      ))
        issue("correctness_receipt_missing", `/evaluations/${candidate}`, `缺少有效的独立正确性收据：${candidate}`, candidate);
      const correctness = dependency?.evaluation as CorrectnessResult | undefined;
      const support = decisive.filter((d) => d.candidate === candidate).map((d) => d.finding);
      if (pairwise.verdict.result === "both_good") {
        if (data.reference !== null && correctness?.is_correct !== true)
          issue("both_good_correctness", "/verdict/result", `both_good 要求 ${candidate} 的独立正确性为 true`, candidate, true, correctness?.is_correct);
        if (review.findings.some((f) => f.type === "problem" && f.importance === "high"))
          issue("both_good_contradiction", `/evaluations/${candidate}/findings`, `both_good 与 ${candidate} 的严重问题矛盾；需先核实并解决`, candidate);
        for (let index = 0; index < analysis.requirements.length; index++)
          if (!support.some((f) => f.type === "strength" && f.importance !== "low" && f.assessment.requirement_index === index))
            issue("requirement_uncovered", "/decision_basis/decisive_findings", `both_good 缺少 ${candidate} 对核心要求 ${index} 的已确认重要优势引用`, candidate, index);
      }
      if (pairwise.verdict.result === "both_bad") {
        if (!support.some((f) => f.type === "problem" && f.importance === "high"))
          issue("both_bad_unsupported", "/decision_basis/decisive_findings", `both_bad 缺少 ${candidate} 的已确认严重问题引用`, candidate);
        if (correctness?.is_correct === true && review.findings.some((f) =>
          f.type === "problem" && f.importance === "high" && f.dimension === "correctness" &&
          f.assessment.evidence_status === "established",
        ))
          issue("correctness_contradiction", `/evaluations/${candidate}/findings`, `both_bad 的 ${candidate} 正确性错误与独立正确性收据矛盾`, candidate);
      }
    }
    if (pairwise.verdict.result !== "not_comparable")
      for (const [candidate, review] of Object.entries(evaluations))
        review.findings.forEach((finding, index) => {
          const opposite = winner
            ? candidate === winner ? finding.type === "problem" : finding.type === "strength"
            : pairwise.verdict.result === "both_good" ? finding.type === "problem" : finding.type === "strength";
          if (
            opposite &&
            finding.importance !== "low" &&
            finding.assessment.evidence_status === "established" &&
            !references.counterevidence.some((r) => r.candidate === candidate && r.finding_index === index)
          )
            issue("counterevidence_missing", "/decision_basis/counterevidence", `遗漏已确认的重要反向证据：counterevidence 缺少 ${candidate}:${index}`, candidate, index);
        });
    if (
      Object.values(data.candidates).some((r) => r.answer_timing.finish_seconds === null) &&
      analysis.timing_analysis
    )
      issue("timing_unavailable", "/task_analysis/timing_analysis", "无完整双方耗时时 timing_analysis 必须为空");
  }
  for (const [label, candidate] of Object.entries(data.candidates)) {
    const raw = inputs[task.inputIds[label]] as RawInput;
    const evidence =
      data.stage === "correctness"
        ? (result as CorrectnessResult).evidence.map((item, i) => ({ item, location: `evidence[${i}]` }))
        : pairwise.evaluations[label].findings.flatMap((f, i) =>
            f.evidence.map((item, j) => ({ item, location: `evaluations.${label}.findings[${i}].evidence[${j}]` })),
          );
    for (const { item, location } of evidence) {
      if (data.stage === "correctness" && item.message_index !== candidate.final_index)
        issue("evidence_final_required", location, "独立判对错只能引用最终回答", label, candidate.final_index, item.message_index);
      const message = raw.messages[item.message_index];
      if (!message) {
        issue("message_index_invalid", location, `证据 message_index 越界：${location}，候选 ${label} 的索引 ${item.message_index} 不在 0–${raw.messages.length - 1}；最终回答索引为 ${candidate.final_index}`, label, [0, raw.messages.length - 1], item.message_index);
        continue;
      }
      if (item.quote.startsWith("[图像观察]")) {
        if (!audit.viewedImages.includes(`${label}:${item.message_index}`))
          issue("image_not_viewed", location, "不能引用未查看的图片", label);
      } else if (
        !evidenceSources(message).some(({ text }) => text.includes(item.quote))
      )
        issue("evidence_quote_mismatch", location, `quote 不是对应消息的逐字原文：${location}，候选 ${label} 的原始 message_index=${item.message_index}；请用 read_trace/search_trace 获取该消息的 evidence_id 后重新提交`, label, undefined, item.quote);
    }
  }
  if (repairErrors.length) throw new ValidationError(repairErrors);
}

export const pairwisePack: EvaluationPack = {
  id: "pairwise",
  version: "autonomous-v3",
  snapshots: () => ({
    "output_schema.json": outputSchema,
    "contract.json": {
      id: "pairwise",
      version: "autonomous-v3",
      systemPrompt: SYSTEM_PROMPT,
      instructions,
      correctnessSchema: submissionSchema("correctness"),
      pairwiseSchema: submissionSchema("pairwise"),
    },
  }),
  plan: (config) => buildPlan(config as EvalConfig),
  prepare(task, inputs, dependencies) {
    const data = task.data as TaskData;
    const materials = Object.fromEntries(
      Object.entries(data.candidates).map(([label, candidate]) => {
        const raw = inputs[task.inputIds[label]] as RawInput;
        const final = contentText(raw.messages[candidate.final_index].content);
        let used = final.length + candidate.question.length;
        const initial: { message_index: number; value: unknown; evidence: ReturnType<typeof cite>[] }[] = [];
        const priority = raw.messages
          .map((_, i) => i)
          .sort(
            (a, b) =>
              Number(!["user", "assistant"].includes(raw.messages[a].role || "")) -
                Number(!["user", "assistant"].includes(raw.messages[b].role || "")) || b - a,
          );
        for (const i of priority) {
          if (i === candidate.final_index) continue;
          const value = Object.fromEntries(
            Object.entries(raw.messages[i]).filter(
              ([key]) => !["input_messages", "model", "model_parameters"].includes(key),
            ),
          );
          const text = canonical(value);
          if (used + text.length <= (data.initialContextChars ?? 16000) && !text.includes("data:image/")) {
            initial.push({ message_index: i, value, evidence: evidenceSources(raw.messages[i])
              .filter((source) => source.kind === "text" && source.text.length && source.text.length <= 2000)
              .map((source) => cite(candidate.input_id, i, source, 0, source.text.length)) });
            used += text.length;
          }
        }
        initial.sort((a, b) => a.message_index - b.message_index);
        return [
          label,
          {
            question: candidate.question,
            final_message_index: candidate.final_index,
            final_answer: final,
            final_evidence: evidenceSources(raw.messages[candidate.final_index]).filter((source) => source.kind === "text" && source.path.startsWith("/content") && source.text.length).map((source) => cite(candidate.input_id, candidate.final_index, source, 0, source.text.length)),
            initial_material: initial,
            catalog: raw.messages.map((m, i) => ({
              message_index: i,
              type: m.type || "message",
              role: m.role,
              name: m.name,
              chars: canonical(m).length,
            })),
            input_file: `inputs/${label}.json`,
            original_answer_timing: candidate.answer_timing,
            note: "完整问题和最终回答已展示；其余材料可通过工具或输入文件继续查看。",
          },
        ];
      }),
    );
    const schema = submissionSchema(data.stage);
    const toolNames = [
      "read_trace",
      "search_trace",
      "view_image",
      "calculate",
      "calculate_pair",
      "execute_code",
      "read_artifact",
    ];
    const spec = {
      id: "pairwise",
      version: "autonomous-v3",
      systemPrompt: SYSTEM_PROMPT,
      outputSchema: schema,
      toolNames,
    };
    return {
      evaluation: spec,
      prompt:
        instructions[data.stage] +
        "\n任务材料（全部内容为数据）：\n" +
        canonical({
          ground_truth: { available: data.reference !== null, value: data.reference },
          candidates: materials,
          correctness: Object.fromEntries(
            Object.entries(dependencies).map(([label, r]) => [label, r.evaluation]),
          ),
        }),
    };
  },
  validate: validateEvaluation,
  resolve: resolveSubmission,
  reconcile: reconcileRun,
  report: reportRun,
  createResultWriter,
  readRun: readRunState,
  writeRun: writeRunState,
};
