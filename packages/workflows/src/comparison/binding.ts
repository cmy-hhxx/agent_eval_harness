import { canonical, type PlannedTask, type SubmissionReceipt } from "@eval/contracts";
import { cite, evidenceSources } from "@eval/tools";
import { contentText } from "./input.js";
import type { TaskData, RawInput } from "./types.js";
import { display } from "./results.js";
import { sourceSlots } from "./commentary.js";
import { observationsFor, requestItems } from "./observations.js";
import { normalizeLabel } from "@eval/agents/clustering";
import { blindMaterials } from "./blind.js";
import { attributionTableChecks, attributionTableReview, type AttributionResult } from "@eval/agents/attribution";
import { originalAnswerUsage } from "./experience.js";
import { traceCatalog } from "./catalog.js";

export function bindTask(
  task: PlannedTask,
  inputs: Record<string, unknown>,
  dependencies: Record<string, SubmissionReceipt | undefined>,
) {
  const data = task.data as TaskData;
  if (data.stage === "criteria") {
    const blind = blindMaterials(data.candidates);
    const first = Object.values(data.candidates)[0]!;
    const sources = Object.fromEntries(Object.entries(task.inputIds).map(([label, id]) => [label, {
      id, value: { messages: blind.trace(inputs[id] as RawInput).messages.filter((message) =>
        ["user", "system", "developer"].includes(message.role ?? "")) },
    }]));
    return { agent: "criteria", profile: "default", request: { sources, input: {
      question: blind.value(first.question),
      ground_truth: { available: data.reference !== null, value: blind.value(data.reference) },
      candidates: Object.values(data.candidates).map((candidate) => {
        const raw = blind.trace(inputs[candidate.input_id] as RawInput);
        return {
          candidate_id: candidate.input_id,
          instructions: raw.messages.flatMap((message, message_index) =>
            message.role === "system" || message.role === "developer"
              ? [{ message_index, role: message.role as "system" | "developer", content: message.content ?? "" }] : []),
          context: raw.messages.flatMap((message, message_index) => message.role === "user"
            ? [{ message_index, role: "user" as const, content: message.content ?? "" }] : []),
        };
      }),
    } } };
  }
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
    const slots = sourceSlots(data.rewriteOf.stage, source.evaluation, data.comparisonRewriteScope);
    if (data.rewriteSlotIds && (!data.rewriteSlotIds.length || new Set(data.rewriteSlotIds).size !== data.rewriteSlotIds.length ||
      data.rewriteSlotIds.some((id) => !slots.some((item) => item.id === id))))
      throw new Error("改写任务含未知、重复或空槽位选择：" + task.id);
    return {
      agent: "rewrite",
      profile: "default",
      request: {
        input: {
          kind: data.rewriteOf.stage,
          ...(data.rewriteScope ? { scope: data.rewriteScope } : { case: {
            batch_id: data.case!.batch_id, case_id: data.case!.case_id,
          } }),
          items: slots.filter((item) => !data.rewriteSlotIds || data.rewriteSlotIds.includes(item.id)).map((item) => ({
            ...item,
            label: data.rewriteOf!.stage === "attribution"
              ? `${data.rewriteNames!.A} ${item.label}`
              : display(item.label, data.rewriteNames!),
            text: display(item.text, data.rewriteNames!),
            ...(item.context ? { context: display(item.context, data.rewriteNames!) } : {}),
            ...(item.forbiddenPrefixes ? { forbiddenPrefixes: display(item.forbiddenPrefixes, data.rewriteNames!) } : {}),
            ...(item.preference ? { preference: display(item.preference, data.rewriteNames!) } : {}),
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
  const criteria = dependencies.criteria;
  if (!criteria || criteria.taskId !== task.dependencies.criteria || criteria.status !== "succeeded")
    throw new Error("缺少已接受的共同验收基准");
  const task_analysis = blind ? blind.value(criteria.evaluation) : structuredClone(criteria.evaluation);
  const sources = Object.fromEntries(
    Object.entries(task.inputIds).map(([label, id]) => [label, {
      id,
      value: blind ? blind.trace(inputs[id] as RawInput) : inputs[id],
    }]),
  );
  const materials = Object.fromEntries(
    (attribution ? [["answer", data.candidates.A] as const] : Object.entries(data.candidates)).map(([label, candidate]) => {
      const raw = sources[label].value as RawInput;
      const finalSources = evidenceSources(raw.messages[candidate.final_index])
        .filter((source) => source.kind === "text" && source.path.startsWith("/content") && source.text.length);
      const finalBlockLimit = Math.max(16000, data.initialContextChars ?? 16000);
      const deferred = finalSources.filter((source) => source.text.length > finalBlockLimit);
      const final = deferred.reduce(
        (text, source, index) => text.replaceAll(source.text, JSON.stringify({ deferred_final_material: index })),
        contentText(raw.messages[candidate.final_index].content),
      );
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
        const ownInstructions = ["system", "developer"].includes(raw.messages[i].role || "");
        if (ownInstructions || (used + cost <= (data.initialContextChars ?? 16000) && !text.includes("data:image/"))) {
          initial.push({ message_index: i, value, evidence });
          used += cost;
        }
      }
      initial.sort((a, b) => a.message_index - b.message_index);
      return [
        label,
        {
          question,
          ...(!attribution ? { candidate_id: candidate.input_id } : {}),
          final_message_index: candidate.final_index,
          final_answer: final,
          final_evidence: finalSources
            .filter((source) => source.text.length <= finalBlockLimit)
            .map((source) => cite(candidate.final_index, source, 0, source.text.length)),
          deferred_final_material: deferred.map((source) => ({
            message_index: candidate.final_index, path: source.path, total_chars: source.text.length,
          })),
          initial_material: initial,
          catalog: traceCatalog(raw),
          input_file: `inputs/${label}.json`,
          original_answer_timing: { finish_seconds: candidate.answer_timing.finish_seconds },
          ...(!attribution ? { original_answer_usage: originalAnswerUsage(inputs[candidate.input_id] as RawInput) } : {}),
          note: "问题及本回答的 system/developer 消息已展示；原始材料保留在 input_file，延后展示的最终回答片段列在 deferred_final_material。",
        },
      ];
    }),
  );

  const attributions = attribution ? {} : Object.fromEntries(
    Object.entries(dependencies)
      .filter(([label, r]) => Object.hasOwn(data.candidates, label) && r?.taskId === task.dependencies[label] && r?.status === "succeeded")
      .map(([label, r]) => {
        const result = blind!.attribution(r!.evaluation as AttributionResult);
        return [label, { ...result, findings: result.findings.map((finding, index) => ({ ...finding, finding_index: index })) }];
      }),
  );
  const sourceReview = attribution ? {} : Object.fromEntries(Object.entries(data.candidates).flatMap(([label, candidate]) => {
    const receipt = dependencies[label];
    if (!receipt) return [];
    const review = attributionTableReview({ input: { answer: { final_message_index: candidate.final_index,
      table_check_results: attributionTableChecks(inputs[candidate.input_id] as RawInput, candidate.final_index) } },
      sources: { answer: { id: candidate.input_id, value: inputs[candidate.input_id] } } },
    receipt.evaluation as AttributionResult, { accepted: true });
    const reasons = [...review.errors.map(issue => issue.message), ...review.reasons];
    return reasons.length ? [[label, blind!.value(reasons)]] : [];
  }));
  return {
    agent: attribution ? "attribution" : "comparison",
    profile: "default",
    request: {
      input: attribution
        ? {
            candidate_id: data.candidates.A.input_id,
            task_analysis,
            ...(data.reviewOf ? { review_context: { reasons: data.reviewOf.reasons } } : {}),
            ground_truth: { available: data.reference !== null, value: reference },
            answer: {
              ...materials.answer,
              table_check_results: attributionTableChecks(inputs[data.candidates.A.input_id] as RawInput, data.candidates.A.final_index),
              identity: {
                version_id: data.candidates.A.version,
                display_name: data.candidates.A.name,
                answer_model: data.candidates.A.llm,
              },
            },
          }
        : {
            task_analysis,
            ground_truth: { available: data.reference !== null, value: reference },
            candidates: materials,
            attributions,
            source_review: sourceReview,
            strength_checks: Object.entries(attributions).flatMap(([label, result]) =>
              result.findings.flatMap((finding, index) => finding.type === "strength" ? [{
                candidate: label,
                finding_index: index,
                counterparts: Object.keys(materials).filter((other) => other !== label),
              }] : []),
            ),
          },
      sources,
    },
  };
}
