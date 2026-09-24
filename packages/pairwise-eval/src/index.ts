import { readFileSync } from "node:fs";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type {
  EvaluationPack,
  JsonSchema,
  PlannedTask,
  SubmissionReceipt,
  ToolAudit,
} from "../../contracts/src/index.js";
import { ROOT, canonical, digest } from "../../contracts/src/io.js";
import { buildPlan, comparisonPair, contentText, strings } from "./input.js";
import type { CorrectnessResult, EvalConfig, PairwiseResult, RawInput, TaskData } from "./types.js";
import { reportRun } from "./report.js";
import { readRunState, writeRunState } from "./run-data.js";

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
  if (!validator(result)) throw new Error("输出结构无效：" + ajv.errorsText(validator.errors));
  if (data.stage === "pairwise") comparisonPair(Object.values(data.candidates).map((r) => r.version));
  const pairwise = result as PairwiseResult;
  const repairErrors: string[] = [];
  if (data.stage === "pairwise") {
    const { evaluations, references, analysis } = {
      evaluations: pairwise.evaluations,
      references: pairwise.decision_basis,
      analysis: pairwise.task_analysis,
    };
    for (const review of Object.values(evaluations))
      for (const finding of review.findings)
        if (finding.assessment.requirement_index >= analysis.requirements.length)
          throw new Error("发现关联了不存在的任务要求");
    const decisive = references.decisive_findings.map((ref) => {
      const finding = evaluations[ref.candidate]?.findings[ref.finding_index];
      if (!finding) throw new Error("判决引用了不存在的发现");
      if (
        pairwise.verdict.result !== "not_comparable" &&
        finding.assessment.evidence_status !== "established"
      )
        throw new Error("不确定的发现不能决定胜负、都好或都差");
      return { candidate: ref.candidate, finding };
    });
    for (const ref of references.counterevidence)
      if (!evaluations[ref.candidate]?.findings[ref.finding_index]) throw new Error("反向证据索引无效");
    if (pairwise.verdict.result !== "not_comparable" && new Set(decisive.map((d) => d.candidate)).size !== 2)
      throw new Error("判决必须引用双方发现");
    const winner =
      pairwise.verdict.result === "A_better" ? "A" : pairwise.verdict.result === "B_better" ? "B" : null;
    if (
      winner &&
      !decisive.some((d) =>
        d.candidate === winner ? d.finding.type === "strength" : d.finding.type === "problem",
      )
    )
      throw new Error("决定性发现未支持所选赢家");
    for (const [candidate, review] of Object.entries(evaluations)) {
      const dependencyId = task.dependencies[candidate],
        dependency = dependencies[candidate];
      if (data.reference !== null && (
        !dependencyId || !dependency || dependency.taskId !== dependencyId || dependency.status !== "succeeded"
      ))
        throw new Error(`缺少有效的独立正确性收据：${candidate}`);
      const correctness = dependency?.evaluation as CorrectnessResult | undefined;
      const support = decisive.filter((d) => d.candidate === candidate).map((d) => d.finding);
      if (pairwise.verdict.result === "both_good") {
        if (data.reference !== null && correctness?.is_correct !== true)
          repairErrors.push(`both_good 要求 ${candidate} 的独立正确性为 true`);
        if (review.findings.some((f) => f.type === "problem" && f.importance === "high"))
          repairErrors.push(`both_good 与 ${candidate} 的严重问题矛盾；需先核实并解决`);
        for (let index = 0; index < analysis.requirements.length; index++)
          if (!support.some((f) => f.type === "strength" && f.importance !== "low" && f.assessment.requirement_index === index))
            repairErrors.push(`both_good 缺少 ${candidate} 对核心要求 ${index} 的已确认重要优势引用`);
      }
      if (pairwise.verdict.result === "both_bad") {
        if (!support.some((f) => f.type === "problem" && f.importance === "high"))
          repairErrors.push(`both_bad 缺少 ${candidate} 的已确认严重问题引用`);
        if (correctness?.is_correct === true && review.findings.some((f) =>
          f.type === "problem" && f.importance === "high" && f.dimension === "correctness" &&
          f.assessment.evidence_status === "established",
        ))
          repairErrors.push(`both_bad 的 ${candidate} 正确性错误与独立正确性收据矛盾`);
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
            repairErrors.push(`遗漏已确认的重要反向证据：counterevidence 缺少 ${candidate}:${index}`);
        });
    if (
      Object.values(data.candidates).some((r) => r.answer_timing.finish_seconds === null) &&
      analysis.timing_analysis
    )
      throw new Error("无完整双方耗时时 timing_analysis 必须为空");
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
        throw new Error("独立判对错只能引用最终回答");
      const message = raw.messages[item.message_index];
      if (!message) throw new Error("证据 message_index 越界");
      if (item.quote.startsWith("[图像观察]")) {
        if (!audit.viewedImages.includes(`${label}:${item.message_index}`))
          throw new Error("不能引用未查看的图片");
      } else if (!strings(message).some(([, text]) => text.includes(item.quote)))
        repairErrors.push(`quote 不是对应消息的逐字原文：${location}，候选 ${label} 的原始 message_index=${item.message_index}；请读取该消息并复制连续原文`);
    }
  }
  if (repairErrors.length) throw new Error(repairErrors.join("\n"));
}

export const pairwisePack: EvaluationPack = {
  id: "pairwise",
  version: "autonomous-v2",
  snapshots: () => ({
    "output_schema.json": outputSchema,
    "contract.json": {
      id: "pairwise",
      version: "autonomous-v2",
      systemPrompt: SYSTEM_PROMPT,
      instructions,
      correctnessSchema: stageSchema("correctness"),
      pairwiseSchema: stageSchema("pairwise"),
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
        const initial: { message_index: number; value: unknown }[] = [];
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
            initial.push({ message_index: i, value });
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
    const schema = stageSchema(data.stage);
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
      version: "autonomous-v2",
      systemPrompt: SYSTEM_PROMPT,
      outputSchema: schema,
      toolNames,
    };
    return {
      evaluation: { ...spec, digest: digest(spec) },
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
  report: reportRun,
  readRun: readRunState,
  writeRun: writeRunState,
};
