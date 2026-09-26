import {
  canonical,
  type WorkflowDefinition,
  type PlannedTask,
  type SubmissionReceipt,
} from "@eval/contracts";
import { cite, evidenceSources } from "@eval/tools";
import { buildPlan, contentText } from "./input.js";
import type { TaskData, RawInput, EvalConfig } from "./types.js";
import { reconcileRun } from "./run-data.js";
import { sourceSlots } from "./commentary.js";
import { observationsFor, requestItems } from "./observations.js";
export function bindTask(
  task: PlannedTask,
  inputs: Record<string, unknown>,
  dependencies: Record<string, SubmissionReceipt | undefined>,
) {
  const data = task.data as TaskData;
  if (data.stage === "clustering") {
    const scope = data.scope;
    if (!scope) throw new Error("clustering task is missing its scope");
    return {
      agent: "clustering",
      profile: "default",
      request: {
        input: {
          model: scope.version,
          batch_id: scope.batch_id,
          budget: scope.budget,
          library: data.projection ?? { components: [] },
          items: requestItems(observationsFor(scope, (inputId) => dependencies[inputId])),
        },
        sources: {},
      },
    };
  }
  if (data.stage === "rewrite") {
    const source = dependencies.source;
    if (!source || !data.rewriteOf)
      throw new Error("改写任务缺少已接受的源结果：" + data.rewriteOf?.taskId);
    return {
      agent: "rewrite",
      profile: "default",
      request: {
        input: {
          kind: data.rewriteOf.stage,
          case: data.case!,
          items: sourceSlots(data.rewriteOf.stage, source.evaluation),
        },
        sources: {},
      },
    };
  }
  if (data.stage === "comparison" && (data.group?.length ?? 0) < 2)
    throw new Error("对比组至少需要两个候选");
  const materials = Object.fromEntries(
    Object.entries(data.candidates).map(([label, candidate]) => {
      const raw = inputs[task.inputIds[label]] as RawInput;
      const final = contentText(raw.messages[candidate.final_index].content);
      let used = final.length + candidate.question.length;
      const initial: {
        message_index: number;
        value: unknown;
        evidence: ReturnType<typeof cite>[];
      }[] = [];
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
          initial.push({
            message_index: i,
            value,
            evidence: evidenceSources(raw.messages[i])
              .filter((source) => source.kind === "text" && source.text.length && source.text.length <= 2000)
              .map((source) => cite(candidate.input_id, i, source, 0, source.text.length)),
          });
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
          final_evidence: evidenceSources(raw.messages[candidate.final_index])
            .filter(
              (source) => source.kind === "text" && source.path.startsWith("/content") && source.text.length,
            )
            .map((source) => cite(candidate.input_id, candidate.final_index, source, 0, source.text.length)),
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

  const attribution = data.stage === "attribution";
  return {
    agent: attribution ? "attribution" : "comparison",
    profile: "default",
    request: {
      input: attribution
        ? {
            ground_truth: { available: data.reference !== null, value: data.reference },
            candidates: materials,
          }
        : {
            ground_truth: { available: data.reference !== null, value: data.reference },
            candidates: materials,
            attributions: Object.fromEntries(
              Object.entries(dependencies)
                .filter(([label, r]) => r?.taskId === task.dependencies[label] && r?.status === "succeeded")
                .map(([label, r]) => [label, r!.evaluation]),
            ),
          },
      sources: Object.fromEntries(
        Object.entries(task.inputIds).map(([label, id]) => [label, { id, value: inputs[id] }]),
      ),
    },
  };
}
export const comparisonWorkflow: WorkflowDefinition = {
  id: "comparison",
  plan: (config) => buildPlan(config as EvalConfig),
  reconcile: reconcileRun,
  bind: bindTask,
};
