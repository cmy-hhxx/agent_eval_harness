import {
  canonical,
  type WorkflowDefinition,
  type PlannedTask,
  type SubmissionReceipt,
} from "@eval/contracts";
import { cite, evidenceSources } from "@eval/tools";
import { buildPlan, contentText, type PlanOptions } from "./input.js";
import type { TaskData, RawInput, EvalConfig } from "./types.js";
import { reconcileRun } from "./run-data.js";
import { display } from "./results.js";
import { sourceSlots } from "./commentary.js";
import { observationsFor, requestItems } from "./observations.js";
import { normalizeLabel } from "@eval/agents/clustering";
import { blindMaterials } from "./blind.js";
import type { AttributionResult } from "@eval/agents/attribution";
import { originalAnswerUsage } from "./experience.js";
export function bindTask(
  task: PlannedTask,
  inputs: Record<string, unknown>,
  dependencies: Record<string, SubmissionReceipt | undefined>,
) {
  const data = task.data as TaskData;
  if (data.stage === "clustering") {
    const scope = data.scope;
    if (!scope) throw new Error("clustering task is missing its scope");
    const library = data.projection ?? { components: [] };
    const items = requestItems(observationsFor(scope, (inputId) => dependencies[inputId]));
    const knownComponents = new Set(
      library.components.flatMap((component) =>
        [component.label, ...component.aliases].map((label) => normalizeLabel(label)),
      ),
    );
    return {
      agent: "clustering",
      profile: "default",
      request: {
        input: {
          model: scope.version,
          batch_id: scope.batch_id,
          // Observations narrow this shard's reserved headroom, but cannot enlarge it:
          // other shards may accept new components against the same model library.
          budget: {
            ...scope.budget,
            max_new_components: Math.min(
              scope.budget.max_new_components,
              new Set(
                items.map((item) => normalizeLabel(item.component)).filter((component) => !knownComponents.has(component)),
              ).size,
            ),
          },
          library,
          items,
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
          ...(data.rewriteScope ? { scope: data.rewriteScope } : { case: {
            batch_id: data.case!.batch_id, case_id: data.case!.case_id,
          } }),
          items: sourceSlots(data.rewriteOf.stage, source.evaluation).map((item) => ({
            ...item,
            label: data.rewriteOf!.stage === "attribution"
              ? `${data.rewriteNames!.A} ${item.label}`
              : display(item.label, data.rewriteNames!),
            text: display(item.text, data.rewriteNames!),
          })),
        },
        sources: {},
      },
    };
  }
  if (data.stage === "comparison" && (data.group?.length ?? 0) < 2)
    throw new Error("对比组至少需要两个候选");
  const attribution = data.stage === "attribution";
  const blind = attribution ? undefined : blindMaterials(data.candidates);
  const reference = blind ? blind.value(data.reference) : data.reference;
  const sources = Object.fromEntries(
    Object.entries(task.inputIds).map(([label, id]) => [label, {
      id,
      value: blind ? blind.trace(inputs[id] as RawInput) : inputs[id],
    }]),
  );
  const materials = Object.fromEntries(
    (attribution ? [["answer", data.candidates.A] as const] : Object.entries(data.candidates)).map(([label, candidate]) => {
      const raw = sources[label].value as RawInput;
      const final = contentText(raw.messages[candidate.final_index].content);
      const question = blind ? blind.value(candidate.question) : candidate.question;
      let used = final.length + question.length;
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
        // Evidence must describe the projected material actually shown, and its quotes count
        // against the same budget. Raw-only fields stay behind read_trace for progressive
        // disclosure instead of inflating the first prompt with quotes from hidden content.
        const evidence = evidenceSources(value)
          .filter((source) => source.kind === "text" && source.text.length && source.text.length <= 2000)
          .map((source) => cite(i, source, 0, source.text.length));
        const cost = text.length + evidence.reduce((total, item) => total + item.quote.length, 0);
        if (used + cost <= (data.initialContextChars ?? 16000) && !text.includes("data:image/")) {
          initial.push({ message_index: i, value, evidence });
          used += cost;
        }
      }
      initial.sort((a, b) => a.message_index - b.message_index);
      return [
        label,
        {
          question,
          final_message_index: candidate.final_index,
          final_answer: final,
          final_evidence: evidenceSources(raw.messages[candidate.final_index])
            .filter(
              (source) => source.kind === "text" && source.path.startsWith("/content") && source.text.length,
            )
            .map((source) => cite(candidate.final_index, source, 0, source.text.length)),
          initial_material: initial,
          catalog: raw.messages.map((m, i) => ({
            message_index: i,
            type: m.type || "message",
            role: m.role,
            name: m.name,
            chars: canonical(m).length,
          })),
          input_file: `inputs/${label}.json`,
          original_answer_timing: blind ? blind.value(candidate.answer_timing) : candidate.answer_timing,
          ...(!attribution ? { original_answer_usage: originalAnswerUsage(inputs[candidate.input_id] as RawInput) } : {}),
          note: "完整问题和最终回答已展示；其余材料可通过工具或输入文件继续查看。",
        },
      ];
    }),
  );

  return {
    agent: attribution ? "attribution" : "comparison",
    profile: "default",
    request: {
      input: attribution
        ? {
            ground_truth: { available: data.reference !== null, value: reference },
            answer: {
              ...materials.answer,
              identity: {
                version_id: data.candidates.A.version,
                display_name: data.candidates.A.name,
                answer_model: data.candidates.A.llm,
              },
            },
          }
        : {
            ground_truth: { available: data.reference !== null, value: reference },
            candidates: materials,
            attributions: Object.fromEntries(
              Object.entries(dependencies)
                .filter(([label, r]) => r?.taskId === task.dependencies[label] && r?.status === "succeeded")
                .map(([label, r]) => [label, blind!.attribution(r!.evaluation as AttributionResult)]),
            ),
          },
      sources,
    },
  };
}
export const comparisonWorkflow: WorkflowDefinition = {
  id: "comparison",
  plan: (config, options) => buildPlan(config as EvalConfig, undefined, options as PlanOptions),
  reconcile: reconcileRun,
  bind: bindTask,
};
