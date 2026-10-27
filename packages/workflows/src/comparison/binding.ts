import { modelMaterial } from "../review/attribution.js";
import { isToolSpan } from "../inputs/adapters.js";
import { isDeepStrictEqual } from "node:util";
import { workflowText } from "@eval/prompts";
import { canonical, presentSource, type AgentBinding, type PlannedTask, type SubmissionReceipt, type TaskAnalysis } from "@eval/contracts";
import { cite, evidenceSources, messageContentSources, instructionSources, normativeSources } from "@eval/tools";
import { projectComparisonEvidence } from "../review/evidence-presentation.js";
import { contentText } from "../inputs/records.js";
import { sessionComparisonInput, sessionQas } from "../inputs/session.js";
import type { TaskData, ComparisonResult } from "./types.js";
import type { RawInput } from "../inputs/types.js";
import { bindInstructionReview } from "../review/instruction.js";
import { display } from "./results.js";
import { sourceSlots } from "./commentary.js";
import { taskObservations, requestItems } from "./observations.js";
import { normalizeLabel } from "@eval/agents/clustering";
import { blindMaterials } from "./blind.js";
import type { SessionAttributionResult } from "@eval/agents/attribution";
import { originalAnswerUsage } from "./experience.js";
import { traceCatalog } from "../review/catalog.js";
import { citationInventory } from "../review/citations.js";
import { criterionInstructionSources } from "../review/instruction-bindings.js";
import { bindRewriteItems } from "./rewrite-presentation.js";
import { comparisonScope, comparisonSlotChoices } from "@eval/agents/comparison";
import { taskAnalysisPresentation, taskFocus } from "../review/task-focus.js";
import { verificationPresentation, verificationInspectionPresentation } from "./verification-presentation.js";
import { getAnswerGeneration } from "../review/answer-generation.js";
import { comparisonAttribution } from "./comparison-attribution.js";
import { bindAttribution } from "@eval/workflows/attribution";

export function bindTask(
  task: PlannedTask,
  inputs: Record<string, unknown>,
  dependencies: Record<string, SubmissionReceipt | undefined>,
  context: { tasks: readonly PlannedTask[] },
): AgentBinding {
  if (task.stage.startsWith("attribution-")) return bindAttribution(task, inputs, dependencies);
  return bindSourceTask(task, inputs, dependencies, context);
}

/** The accepted analysis is the original Criteria mirror, never a newly submitted judgment. */
export function bindAcceptedAttribution(task: PlannedTask, receipt: SubmissionReceipt, inputs: Record<string, unknown>,
  context: { tasks: readonly PlannedTask[] }, analysis:TaskAnalysis): AgentBinding {
  if (task.stage !== "attribution" || receipt.taskId !== task.id || receipt.status !== "succeeded")
    throw new Error("程序来源视图必须绑定同一已接受归因任务。");
  return bindSourceTask(task, inputs, {}, context, analysis);
}

function bindSourceTask(
  task: PlannedTask, inputs: Record<string, unknown>,
  dependencies: Record<string, SubmissionReceipt | undefined>, context: { tasks: readonly PlannedTask[] },
  acceptedAnalysis?: TaskAnalysis,
): AgentBinding {
  const data = task.data as TaskData;
  if (task.stage === "instruction-review") {
    const candidate = data.candidates.A ?? Object.values(data.candidates)[0];
    return bindInstructionReview(candidate, inputs[candidate.input_id] as RawInput);
  }
  if ((data.verificationAudit || data.verificationOf) &&
    (task.stage !== "comparison" || data.stage !== "comparison" || data.verificationAudit !== true || !data.verificationOf?.taskId))
    throw new Error("可选核验必须同时声明核验标记与正式对比来源。");
  if (data.stage === "criteria") {
    const blind = blindMaterials(data.candidates);
    const first = Object.values(data.candidates)[0]!;
    const sources = Object.fromEntries(Object.entries(task.inputIds).map(([label, id]) => [label, {
      id, value: inputs[id], presentation: blind.presentation,
    }]));
    return { agent: "criteria", profile: "default", request: { sources, input: {
      question: first.question,
      candidates: Object.values(data.candidates).map((candidate) => {
        const raw = inputs[candidate.input_id] as RawInput;
        return {
          candidate_id: candidate.input_id,
          instructions: [],
          context: normativeSources(raw, candidate.input_id, candidate.final_index).filter(source => source.role === "user" && source.path === "/content")
            .map(({ message_index, content }) => ({ message_index, role: "user" as const, content })),
        };
      }),
    } }, projectModelInput: input => presentSource(input, blind.presentation) };
  }
  if (data.stage === "clustering") {
    const scope = data.scope;
    if (!scope) throw new Error("clustering task is missing its scope");
    const library = data.projection ?? { components: [] };
    const dependencyKeys = new Map(Object.entries(task.dependencies).map(([label, taskId]) => [taskId, label]));
    const items = requestItems(taskObservations(task, (taskId) => dependencies[dependencyKeys.get(taskId)!]));
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
          batch_ids: [scope.batch_id],
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
    if (data.rewriteOf.stage === "comparison") {
      const relative = (source.submitted as { relative_preference?: unknown } | undefined)?.relative_preference;
      // Formal preferences come from comparisonSlots; relative identity comes only from the accepted submission.
      if (relative === "A" || relative === "B") for (const item of slots)
        if (item.preference === "双方都好" || item.preference === "双方都差")
          item.preference += `；相对更倾向【候选${relative}】`;
    }
    const identityContext = data.rewriteOf.stage === "comparison"
      ? JSON.stringify(Object.fromEntries(Object.entries(data.rewriteNames!).map(([label, name]) => [`候选${label}`, name])))
      : undefined;
    if (data.rewriteSlotIds && (!data.rewriteSlotIds.length || new Set(data.rewriteSlotIds).size !== data.rewriteSlotIds.length ||
      data.rewriteSlotIds.some((id) => !slots.some((item) => item.id === id))))
      throw new Error("改写任务含未知、重复或空槽位选择：" + task.id);
    const request = {
      input: {
        kind: data.rewriteOf.stage,
        ...(data.rewriteScope ? { scope: { batch_ids: [data.rewriteScope.batch_id], model: data.rewriteScope.model } } : { case: {
          batch_id: data.case!.batch_id, case_id: data.case!.case_id,
        } }),
        items: slots.filter((item) => !data.rewriteSlotIds || data.rewriteSlotIds.includes(item.id)).map((item) => ({
          ...item,
          label: data.rewriteOf!.stage === "attribution"
            ? `${data.rewriteNames!.A} ${item.label}`
            : display(item.label, data.rewriteNames!),
          text: display(item.text, data.rewriteNames!),
          ...(identityContext || item.context ? {
            context: [identityContext, item.context && display(item.context, data.rewriteNames!)].filter(Boolean).join("\n"),
          } : {}),
          ...(item.forbiddenPrefixes ? { forbiddenPrefixes: display(item.forbiddenPrefixes, data.rewriteNames!) } : {}),
          ...(item.preference ? { preference: display(item.preference, data.rewriteNames!) } : {}),
        })),
      },
      sources: {},
    };
    return bindRewriteItems(request.input);
  }
  if (data.stage === "comparison" && (data.group?.length ?? 0) < 2)
    throw new Error("对比组至少需要两个候选");
  const criteria = dependencies.criteria;
  if (!acceptedAnalysis && (!criteria || criteria.taskId !== task.dependencies.criteria || criteria.status !== "succeeded"))
    throw new Error("缺少已接受的共同验收基准");
  const criteriaTask = task.dependencies.criteria
    ? context.tasks.find(item => item.id === task.dependencies.criteria && item.stage === "criteria") : undefined;
  if (!criteriaTask) throw new Error("缺少共同验收基准的任务上下文");
  const blind = criteriaTask ? blindMaterials((criteriaTask.data as TaskData).candidates) : undefined;
  const reference = structuredClone(data.reference);
  const task_analysis = acceptedAnalysis ? structuredClone(acceptedAnalysis)
    : criteriaTask && criteria ? structuredClone(criteria.evaluation) : undefined;
  const sources = Object.fromEntries(
    Object.entries(task.inputIds).map(([label, id]) => [label, {
      id,
      value: sessionComparisonInput(inputs[id] as RawInput, data.candidates[label]!),
      ...(blind ? { presentation: blind.presentation } : {}),
    }]),
  );
  const materials = Object.fromEntries(
    Object.entries(data.candidates).map(([label, candidate]) => {
      const raw = sources[label].value as RawInput;
      const finalIndex = raw.messages.length - 1;
      const finalSources = messageContentSources(raw.messages[finalIndex]);
      const finalBlockLimit = Math.max(16000, data.initialContextChars ?? 16000);
      // Comparison already owns the session's QA text. Present it once, including long
      // answers, instead of requiring tool round trips to read the same delivery again.
      const deferred = data.verificationAudit ? finalSources.filter((source) => source.text.length > finalBlockLimit) : [];
      const final = deferred.reduce(
        (text, source) => text.replaceAll(source.text, ""),
        contentText(raw.messages[finalIndex].content),
      );
      const question = contentText(raw.messages[0]?.content);
      const instructions = instructionSources(raw, candidate.input_id, finalIndex);
      const citations = citationInventory(raw, candidate.input_id, finalIndex);
      // Question, answer and instructions are already separate required material.
      // Keep this budget available for the evidence needed to judge that answer.
      let used = 0;
      const initial: {
        message_index: number;
        value: unknown;
        evidence: ReturnType<typeof cite>[];
      }[] = [];
      const addInitial = (message_index: number, value: unknown, evidence: ReturnType<typeof cite>[]) => {
        const text = canonical(value);
        const cost = text.length + evidence.reduce((total, item) => total + item.quote.length, 0);
        if (used + cost > (data.initialContextChars ?? 16000) || text.includes("data:image/")) return;
        initial.push({ message_index, value, evidence });
        used += cost;
      };
      // A citation may identify a small complete source inside a very large return.
      // Prefer original returns over duplicate renderer projections; neither proves the claim.
      const cited = new Map(citations.references.flatMap(reference => {
        const returned = reference.sources.filter(source => source.origin === "tool_return");
        return (returned.length ? returned : reference.sources).map(source => [source.evidence_id, source] as const);
      }));
      for (const { evidence_id, message_index, quote } of cited.values())
        addInitial(message_index, quote, [{ evidence_id, message_index, quote }]);
      const priority = raw.messages
        .map((message, index) => ({ index, returned: isToolSpan(message) || message.role === "tool" ||
          ["function_call_output", "tool_result"].includes(message.type || "") }))
        .sort((a, b) => Number(b.returned) - Number(a.returned) || b.index - a.index)
        .map(item => item.index);
      for (const i of priority) {
        if (i === finalIndex) continue;
        if (["system", "developer"].includes(raw.messages[i].role || "")) continue;
        const value = Object.fromEntries(
          Object.entries(raw.messages[i]).filter(
            ([key]) => !["input_messages", "model", "model_parameters"].includes(key),
          ),
        );
        // Evidence must describe the projected material actually shown, and its quotes count
        // against the same budget. Raw-only fields stay behind read_trace for progressive
        // disclosure instead of inflating the first prompt with quotes from hidden content.
        const evidence = evidenceSources(value)
          .filter((source) => source.kind === "text" && source.text.length && source.text.length <= 2000)
          .map((source) => cite(candidate.input_id, i, source, 0, source.text.length));
        addInitial(i, value, evidence);
      }
      initial.sort((a, b) => a.message_index - b.message_index);
      return [
        label,
        {
          question,
          turns: sessionQas(inputs[candidate.input_id] as RawInput, candidate),
          candidate_id: candidate.input_id,
          final_message_index: finalIndex,
          answer_generation: getAnswerGeneration(raw, candidate.input_id, finalIndex),
          final_answer: final,
          final_evidence: finalSources
            .filter((source) => source.text.length <= finalBlockLimit)
            .map((source) => cite(candidate.input_id, finalIndex, source, 0, source.text.length)),
          deferred_final_material: deferred.map((source) => ({
            message_index: finalIndex, path: source.path, total_chars: source.text.length,
          })),
          initial_material: initial,
          instruction_sources: instructions,
          citation_inventory: citations,
          catalog: traceCatalog(raw),
          input_file: `inputs/${label}.json`,
          original_answer_timing: { finish_seconds: candidate.answer_timing.finish_seconds },
          original_answer_usage: originalAnswerUsage(inputs[candidate.input_id] as RawInput),
          note: workflowText("attribution-material"),
        },
      ];
    }),
  );

  const acceptedAttributions = Object.fromEntries(
    Object.entries(dependencies)
      .filter(([label, r]) => Object.hasOwn(data.candidates, label) && r?.taskId === task.dependencies[label] && r?.status === "succeeded")
      .map(([label, r]) => {
        const sourceTask = context.tasks.find(source => source.id === r!.taskId && source.stage === "attribution-session");
        if (!sourceTask || (r!.evaluation as { session_meta?: unknown }).session_meta === undefined)
          throw new Error("Comparison 缺少 canonical attribution-session 来源：" + r!.taskId);
        const result = r!.evaluation as SessionAttributionResult;
        return [label, result];
      }),
  );
  const attributions = Object.fromEntries(Object.entries(acceptedAttributions).map(([label, result]) =>
    [label, comparisonAttribution(result)]));
  let comparisonDraft: ComparisonResult | undefined;
  if (data.verificationAudit) {
    const draftTask = context.tasks.find(item => item.id === data.verificationOf!.taskId);
    const draft = dependencies.draft;
    if (task.dependencies.draft !== data.verificationOf!.taskId || !draftTask || draftTask.stage !== "comparison" ||
      (draftTask.data as TaskData).verificationAudit || (draftTask.data as TaskData).verificationOf ||
      (draft?.evaluation as ComparisonResult)?.status !== "decided" ||
      draft?.taskId !== draftTask.id || draft.status !== "succeeded" ||
      !isDeepStrictEqual(draftTask.inputIds, task.inputIds) ||
      !isDeepStrictEqual(Object.fromEntries(Object.entries(task.dependencies).filter(([key]) => key !== "draft")), draftTask.dependencies))
      throw new Error("可选核验缺少匹配的已接受正式对比：" + data.verificationOf!.taskId);
    comparisonDraft = structuredClone(draft?.evaluation as ComparisonResult);
  }
  const input = { task_analysis, ground_truth: { available: data.reference !== null, value: reference }, candidates: materials,
    ...(comparisonDraft ? { comparison_draft: comparisonDraft } : {}), attributions };
  const focus = taskFocus(materials, input.ground_truth,
    Object.fromEntries(Object.entries(data.candidates).map(([label, candidate]) =>
      [label, inputs[candidate.input_id] as RawInput])));
  for (const answer of Object.values(focus.answers)) delete answer.final_answer;
  const binding: AgentBinding = {
    agent: "comparison",
    profile: data.verificationAudit ? "verification" : "default",
    projectModelInput: projectComparisonEvidence,
    request: { input, sources },
    modelInput: data.verificationAudit ? verificationPresentation({ ...input, candidates: Object.fromEntries(Object.entries(materials).map(([label, material]) => {
          const projected = modelMaterial(material, label, sources[label].value as RawInput, sources[label].id);
          return [label, { ...material, citation_inventory: projected.citation_inventory, answer_generation: projected.answer_generation,
            criterion_instruction_sources: criterionInstructionSources(sources[label].value as RawInput,
              data.candidates[label].final_index, task_analysis as TaskAnalysis, data.candidates[label].input_id) }];
        })) }, sources, task_analysis as TaskAnalysis)
      : { ...input, task_analysis: taskAnalysisPresentation(task_analysis as TaskAnalysis,
          Object.fromEntries(Object.entries(sources).map(([label,source]) => [label,source.id]))),
        task_focus: focus,
        comparison_scope: comparisonScope({ input, sources }),
        comparison_slots: comparisonSlotChoices({ input, sources }),
        attributions,
        candidates: Object.fromEntries(Object.entries(materials).map(([label, material]) => {
          const { turns: _turns, final_evidence: _evidence, initial_material: _initial,
            citation_inventory: _citations, answer_generation: _generation, note: _note, ...delivery } =
            { ...material, ...modelMaterial(material, label, sources[label].value as RawInput, sources[label].id) };
          return [label, delivery];
        })) },
  };
  if (data.prediction && binding.modelInput)
    binding.modelInput.prediction_evaluation = workflowText("prediction-evaluation");
  if (blind && binding.modelInput) binding.modelInput = presentSource(binding.modelInput, blind.presentation);
  if (data.verificationAudit) {
    binding.inspectionInput = binding.modelInput;
    binding.modelInput = verificationInspectionPresentation(binding.modelInput as ReturnType<typeof verificationPresentation>, task_analysis as TaskAnalysis);
  }
  return binding;
}
