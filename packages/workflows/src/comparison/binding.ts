import { isDeepStrictEqual } from "node:util";
import { workflowText } from "@eval/prompts";
import { canonical, presentSource, type AgentBinding, type PlannedTask, type SubmissionReceipt, type TaskAnalysis } from "@eval/contracts";
import { cite, images, originalUserTimestamp, displayEvidence, evidenceSources, messageContentSources, parseEvidenceCoordinates, instructionSources, normativeSources, type InstructionSource, type TableCheckResult } from "@eval/tools";
import { acceptedAttributionView } from "./accepted-attribution.js";
import { projectComparisonEvidence } from "./evidence-presentation.js";
import { contentText } from "./input.js";
import type { TaskData, RawInput, ComparisonResult } from "./types.js";
import { display } from "./results.js";
import { sourceSlots } from "./commentary.js";
import { taskObservations, requestItems } from "./observations.js";
import { normalizeLabel } from "@eval/agents/clustering";
import { blindMaterials } from "./blind.js";
import { attributionNormDirectory, attributionTableChecks, attributionTableReview, type AttributionResult } from "@eval/agents/attribution";
import { originalAnswerUsage } from "./experience.js";
import { traceCatalog } from "./catalog.js";
import { citationInventory, type CitationContext, type CitationInventory } from "./citations.js";
import { criterionInstructionSources } from "./instruction-bindings.js";
import { bindRewriteItems } from "./rewrite-presentation.js";
import { comparisonScope, comparisonSlotChoices } from "@eval/agents/comparison";
import { attributionPresentation, tableChecksPresentation } from "./attribution-presentation.js";
import { comparisonSourceReview } from "./source-review.js";
import { taskAnalysisPresentation, taskFocus } from "./task-focus.js";
import { verificationPresentation, verificationInspectionPresentation } from "./verification-presentation.js";
import { getAnswerGeneration, answerGenerationPresentation, type AnswerGeneration } from "./answer-generation.js";

/** Project only generated evidence directories; original message values stay untouched. */
function modelMaterial(material: Record<string, unknown>, candidate: string, raw: RawInput, inputId: string) {
  const { identity: _identity, ...anonymous } = material;
  const shown = <T extends { evidence_id: string }>(value: T) => displayEvidence(value);
  const finalEvidence = material.final_evidence as ReturnType<typeof cite>[];
  const initial = material.initial_material as { message_index: number; value: unknown; evidence: ReturnType<typeof cite>[] }[];
  const tables = material.table_check_results as TableCheckResult[] | undefined;
  const instructions = material.instruction_sources as InstructionSource[];
  const citations = material.citation_inventory as CitationInventory;
  const normBindings = material.criterion_instruction_sources as Record<string, {
    evidence_id: string; message_index: number; path: string; quote: string;
  }[]> | undefined;
  const norms = material.norm_directory as ReturnType<typeof attributionNormDirectory> | undefined;
  const finalIndex = material.final_message_index as number, imageCount = images(raw.messages[finalIndex]).length;
  const citationRange = (source: CitationContext) => {
    const { quote, ...coordinates } = source;
    const displayed = shown(quote.length <= 200 ? source : {
      ...coordinates, quote_preview: quote.slice(0, 200), has_more: true,
    });
    return { ...displayed, read_request: { ...source.read_request, candidate } };
  };
  return {
    ...anonymous,
    ...(imageCount ? { final_images: { image_count: imageCount,
      view_request: { candidate, message_index: finalIndex } } } : {}),
    deferred_final_material: (material.deferred_final_material as { message_index: number; path: string; total_chars: number }[])
      .map(source => ({ ...source, read_request: { candidate, message_index: source.message_index,
        path: source.path, offset: 0, max_chars: 16000 } })),
    ...(norms ? { norm_directory: norms.map(norm => ({ ...norm,
      evidence: norm.evidence.map(item => {
        const point = parseEvidenceCoordinates(item.evidence_id);
        if (!point || point.kind !== "text" || point.input_id !== inputId)
          throw new Error("规范目录的完整坐标不属于本方原始来源。");
        const source = evidenceSources(raw.messages[point.message_index]).find(source => source.kind === "text" && source.path === point.path);
        if (!source || cite(inputId, point.message_index, source, point.start, point.end).quote !== item.quote)
          throw new Error("规范目录的完整坐标与原文不一致。");
        const { quote, ...coordinates } = item;
        return { ...shown(quote.length <= 200 ? item : { ...coordinates, quote_preview: quote.slice(0, 200), has_more: true }),
          read_request: { candidate, message_index: point.message_index, path: point.path,
            offset: point.start, max_chars: Math.min(16000, point.end - point.start) }, end_offset: point.end };
      }) })) } : {}),
    final_evidence: finalEvidence.map(shown),
    ...(Object.hasOwn(material, "answer_generation") ? { answer_generation: (() => {
      const generation = answerGenerationPresentation(material.answer_generation as AnswerGeneration | null, candidate);
      return generation;
    })() } : {}),
    initial_material: initial.map((entry) => ({ ...entry, evidence: entry.evidence.map(shown) })),
    instruction_sources: instructions.map(source => ({ ...source, evidence: source.evidence.map(item => {
      const { quote, ...coordinates } = item;
      return shown(quote.length <= 200 ? item : { ...coordinates, quote_preview: quote.slice(0, 200), has_more: true });
    }) })),
    citation_inventory: { ...citations, references: citations.references.map(item => ({ ...item,
      occurrences: item.occurrences.map(({ context, ...marker }) => ({
        ...shown(marker), context: citationRange(context),
      })), sources: item.sources.map(citationRange),
    })) },
    ...(normBindings ? { criterion_instruction_sources: Object.fromEntries(Object.entries(normBindings).map(([id, entries]) =>
      [id, entries.map(entry => {
        const location = parseEvidenceCoordinates(entry.evidence_id);
        if (!location || location.kind !== "text" || location.input_id !== inputId ||
          location.message_index !== entry.message_index || location.path !== entry.path)
          throw new Error("规范关联的完整坐标不属于原始来源。");
        const source = evidenceSources(raw.messages[entry.message_index]).find(item => item.kind === "text" && item.path === entry.path)!;
        const full = cite(inputId, entry.message_index, source, location.start, location.end);
        if (full.quote !== entry.quote) throw new Error("规范关联的完整坐标与原文不一致。");
        const { quote: _quote, ...coordinates } = entry;
        const { evidence_id: _id, ...display } = coordinates;
        return { ...display, ...(full.quote.length <= 200 ? { quote: full.quote } : {
          quote_preview: full.quote.slice(0, 200), has_more: true }),
          reference: { evidence_id: full.evidence_id }, read_request: { candidate, message_index: entry.message_index,
            path: entry.path, offset: location.start, max_chars: Math.min(16000, location.end - location.start) }, end_offset: location.end };
      })])) } : {}),
    ...(tables ? { table_check_results: tableChecksPresentation(tables, raw, inputId).map((table) => ({
      ...table,
      rows: table.rows.map((row) => ({
        ...row,
        answer: { ...row.answer, evidence: shown(row.answer.evidence) },
        sources: row.sources.map((source) => ({ ...source, evidence: shown(source.evidence) })),
      })),
    })) } : {}),
  };
}

export function bindTask(
  task: PlannedTask,
  inputs: Record<string, unknown>,
  dependencies: Record<string, SubmissionReceipt | undefined>,
  context: { tasks: readonly PlannedTask[] },
): AgentBinding {
  return bindSourceTask(task, inputs, dependencies, context);
}

/** The accepted analysis is the original Criteria mirror, never a newly submitted judgment. */
export function bindAcceptedAttribution(task: PlannedTask, receipt: SubmissionReceipt, inputs: Record<string, unknown>,
  context: { tasks: readonly PlannedTask[] }): AgentBinding {
  if (task.stage !== "attribution" || receipt.taskId !== task.id || receipt.status !== "succeeded")
    throw new Error("程序来源视图必须绑定同一已接受归因任务。");
  return bindSourceTask(task, inputs, {}, context, (receipt.evaluation as AttributionResult).task_analysis);
}

function bindSourceTask(
  task: PlannedTask, inputs: Record<string, unknown>,
  dependencies: Record<string, SubmissionReceipt | undefined>, context: { tasks: readonly PlannedTask[] },
  acceptedAnalysis?: TaskAnalysis,
): AgentBinding {
  const data = task.data as TaskData;
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
      ground_truth: { available: data.reference !== null, value: structuredClone(data.reference) },
      candidates: Object.values(data.candidates).map((candidate) => {
        const raw = inputs[candidate.input_id] as RawInput;
        return {
          candidate_id: candidate.input_id,
          instructions: instructionSources(raw, candidate.input_id, candidate.final_index)
            .map(({ message_index, role, content }) => ({ message_index, role, content })),
          context: normativeSources(raw, candidate.input_id, candidate.final_index).filter(source => source.role === "user")
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
  const attribution = data.stage === "attribution";
  const criteria = dependencies.criteria;
  if (!acceptedAnalysis && (!criteria || criteria.taskId !== task.dependencies.criteria || criteria.status !== "succeeded"))
    throw new Error("缺少已接受的共同验收基准");
  const criteriaTask = context.tasks.find(item => item.id === task.dependencies.criteria && item.stage === "criteria");
  if (!criteriaTask) throw new Error("缺少共同验收基准的任务上下文");
  const criteriaBlind = blindMaterials((criteriaTask.data as TaskData).candidates);
  const blind = criteriaBlind;
  const reference = structuredClone(data.reference);
  const task_analysis = structuredClone(acceptedAnalysis ?? criteria!.evaluation);
  if (attribution) for (const [key, peer] of Object.entries(data.referenceCandidates ?? {})) {
    const own = data.candidates.A;
    const registered = context.tasks.flatMap(item => Object.values((item.data as TaskData).candidates))
      .find(candidate => candidate.input_id === peer.input_id);
    if (key === "answer" || task.inputIds[key] !== peer.input_id || !registered || !isDeepStrictEqual(registered, peer) ||
      own.batch_id !== peer.batch_id || own.case_id !== peer.case_id || own.question.replace(/\s+/gu, "") !== peer.question.replace(/\s+/gu, "") ||
      !inputs[peer.input_id] || !data.reviewOf || !context.tasks.some(item => item.stage === "comparison" &&
        Object.values(item.inputIds).includes(own.input_id) && Object.values(item.inputIds).includes(peer.input_id) &&
        Object.values(item.dependencies).some(id => id === task.id || id === data.reviewOf!.taskId)))
      throw new Error("事实复核来源与登记的同题材料不一致：" + key);
  }
  const sources = Object.fromEntries(
    Object.entries(task.inputIds).map(([label, id]) => [label, {
      id,
      value: inputs[id],
      ...(blind ? { presentation: blind.presentation } : {}),
    }]),
  );
  const materials = Object.fromEntries(
    (attribution ? [["answer", data.candidates.A] as const, ...Object.entries(data.referenceCandidates ?? {})] : Object.entries(data.candidates)).map(([label, candidate]) => {
      const raw = sources[label].value as RawInput;
      const finalSources = messageContentSources(raw.messages[candidate.final_index]);
      const finalBlockLimit = Math.max(16000, data.initialContextChars ?? 16000);
      const deferred = finalSources.filter((source) => source.text.length > finalBlockLimit);
      const final = deferred.reduce(
        (text, source) => text.replaceAll(source.text, ""),
        contentText(raw.messages[candidate.final_index].content),
      );
      const question = candidate.question;
      const instructions = instructionSources(raw, candidate.input_id, candidate.final_index);
      const citations = citationInventory(raw, candidate.input_id, candidate.final_index);
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
        .map((message, index) => ({ index, returned: message.role === "tool" ||
          ["function_call_output", "tool_result"].includes(message.type || "") }))
        .sort((a, b) => Number(b.returned) - Number(a.returned) || b.index - a.index)
        .map(item => item.index);
      for (const i of priority) {
        if (i === candidate.final_index) continue;
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
          ...(!attribution ? { candidate_id: candidate.input_id } : {}),
          final_message_index: candidate.final_index,
          answer_generation: getAnswerGeneration(raw, candidate.input_id, candidate.final_index),
          final_answer: final,
          final_evidence: finalSources
            .filter((source) => source.text.length <= finalBlockLimit)
            .map((source) => cite(candidate.input_id, candidate.final_index, source, 0, source.text.length)),
          deferred_final_material: deferred.map((source) => ({
            message_index: candidate.final_index, path: source.path, total_chars: source.text.length,
          })),
          initial_material: initial,
          instruction_sources: instructions,
          citation_inventory: citations,
          catalog: traceCatalog(raw),
          input_file: `inputs/${label}.json`,
          original_answer_timing: { finish_seconds: candidate.answer_timing.finish_seconds },
          ...(!attribution ? { original_answer_usage: originalAnswerUsage(inputs[candidate.input_id] as RawInput) } : {}),
          note: workflowText("attribution-material"),
        },
      ];
    }),
  );

  const attributions = attribution ? {} : Object.fromEntries(
    Object.entries(dependencies)
      .filter(([label, r]) => Object.hasOwn(data.candidates, label) && r?.taskId === task.dependencies[label] && r?.status === "succeeded")
      .map(([label, r]) => {
        const sourceTask = context.tasks.find(source => source.id === r!.taskId && source.stage === "attribution");
        let sourceRequest: AgentBinding["request"] = { sources: { answer: sources[label] }, input: {} };
        if (sourceTask) {
          sourceRequest = bindAcceptedAttribution(sourceTask, r!, inputs, context).request;
        } else if (r!.submitted !== undefined && Array.isArray(r!.audit.evidenceBank)) {
          throw new Error("缺少已接受归因的原任务上下文，不能重建程序证据来源：" + r!.taskId);
        }
        const result = acceptedAttributionView(r!, sourceRequest);
        return [label, { ...result, findings: result.findings.map((finding, index) => ({ ...finding, finding_index: index })) }];
      }),
  );
  const tableReviews = attribution ? {} : Object.fromEntries(Object.entries(data.candidates).flatMap(([label, candidate]) => {
    const receipt = dependencies[label];
    if (!receipt) return [];
    const review = attributionTableReview({ input: { answer: { final_message_index: candidate.final_index,
      table_check_results: attributionTableChecks(inputs[candidate.input_id] as RawInput, candidate.input_id, candidate.final_index) } },
      sources: { answer: { id: candidate.input_id, value: inputs[candidate.input_id] } } },
    attributions[label] as AttributionResult);
    return [[label, review]];
  }));
  const sourceReview = attribution ? {} : comparisonSourceReview({ sources,
    input: { task_analysis, candidates: materials, attributions } }, tableReviews);
  const answer = attribution ? {
    ...materials.answer,
    criterion_instruction_sources: criterionInstructionSources(inputs[data.candidates.A.input_id] as RawInput,
      data.candidates.A.final_index, task_analysis as TaskAnalysis, data.candidates.A.input_id),
    table_check_results: attributionTableChecks(inputs[data.candidates.A.input_id] as RawInput, data.candidates.A.input_id, data.candidates.A.final_index),
    identity: {
      version_id: data.candidates.A.version,
      display_name: data.candidates.A.name,
      answer_model: data.candidates.A.llm,
    },
  } : undefined;
  const referenceMaterials = attribution && Object.keys(data.referenceCandidates ?? {}).length ? Object.fromEntries(
    Object.entries(data.referenceCandidates!).map(([key, candidate]) => {
      const { instruction_sources: _instructions, ...factual } = materials[key];
      return [key, { ...factual, table_check_results: attributionTableChecks(inputs[candidate.input_id] as RawInput, candidate.input_id, candidate.final_index),
        grader_only: true, source_input_id: candidate.input_id,
        original_user_timestamp: originalUserTimestamp(inputs[candidate.input_id] as RawInput) }];
    })) : undefined;
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
  const reviewReasons = [...(data.reviewOf?.reasons ?? []), ...(data.reviewQuestions ?? [])];
  const reviewContext = reviewReasons.length ? { reasons: reviewReasons } : undefined;
  const input = attribution
    ? {
      candidate_id: data.candidates.A.input_id,
      allow_standard_conflict: data.standardAnswerReview === true,
      task_analysis,
      ...(reviewContext ? { review_context: reviewContext } : {}),
      ground_truth: { available: data.reference !== null, value: reference },
      answer,
      ...(referenceMaterials ? { reference_materials: referenceMaterials } : {}),
    }
    : {
      task_analysis,
      ground_truth: { available: data.reference !== null, value: reference },
      candidates: materials,
      ...(comparisonDraft ? { comparison_draft: comparisonDraft } : {}),
      attributions,
      source_review: sourceReview,
    };
  if (answer) Object.assign(answer, { norm_directory: attributionNormDirectory({ input, sources }) });
  const binding: AgentBinding = {
    agent: attribution ? "attribution" : "comparison",
    profile: data.verificationAudit ? "verification" : "default",
    projectModelInput: projectComparisonEvidence,
    request: { input, sources },
    modelInput: attribution
      ? { ...input,
        ...(reviewContext ? { review_context: { ...reviewContext, kind: "unverified_concerns" } } : {}),
        task_analysis: taskAnalysisPresentation(task_analysis as TaskAnalysis, { answer: sources.answer.id }),
        task_focus: taskFocus({ answer: materials.answer }, task_analysis as TaskAnalysis, input.ground_truth,
          Object.values((criteriaTask.data as TaskData).candidates).map(candidate => candidate.input_id),
          { answer: inputs[data.candidates.A.input_id] as RawInput }),
        answer: modelMaterial(answer!, "answer", sources.answer.value as RawInput, sources.answer.id),
        ...(referenceMaterials ? { reference_materials: Object.fromEntries(Object.entries(referenceMaterials).map(([key, material]) => {
          const projected = modelMaterial({ ...material, instruction_sources: [] }, key, sources[key].value as RawInput, sources[key].id);
          const { instruction_sources: _instructions, ...factual } = projected;
          return [key, factual];
        })) } : {}) }
      : data.verificationAudit ? verificationPresentation({ ...input, candidates: Object.fromEntries(Object.entries(materials).map(([label, material]) => {
          const projected = modelMaterial(material, label, sources[label].value as RawInput, sources[label].id);
          return [label, { ...material, citation_inventory: projected.citation_inventory, answer_generation: projected.answer_generation,
            criterion_instruction_sources: criterionInstructionSources(sources[label].value as RawInput,
              data.candidates[label].final_index, task_analysis as TaskAnalysis, data.candidates[label].input_id) }];
        })) }, sources, task_analysis as TaskAnalysis)
      : { ...input, task_analysis: taskAnalysisPresentation(task_analysis as TaskAnalysis,
          Object.fromEntries(Object.entries(sources).map(([label,source]) => [label,source.id]))),
        task_focus: taskFocus(materials, task_analysis as TaskAnalysis, input.ground_truth,
          Object.values((criteriaTask.data as TaskData).candidates).map(candidate => candidate.input_id),
          Object.fromEntries(Object.entries(data.candidates).map(([label, candidate]) =>
            [label, inputs[candidate.input_id] as RawInput]))),
        comparison_scope: comparisonScope({ input, sources }),
        comparison_slots: comparisonSlotChoices({ input, sources }),
        attributions: Object.fromEntries(Object.entries(attributions).map(([label, result]) => {
          const { task_analysis: _duplicate, ...shown } = attributionPresentation(result, label, sources[label].value as RawInput, sources[label].id,
            Object.fromEntries(Object.entries(sources).map(([key, source]) => [key, source.value as RawInput])),
            Object.fromEntries(Object.entries(sources).map(([key, source]) => [key, source.id])));
          return [label, shown];
        })),
        candidates: Object.fromEntries(Object.entries(materials).map(([label, material]) =>
        [label, modelMaterial(material, label, sources[label].value as RawInput, sources[label].id)])) },
  };
  if (blind && binding.modelInput) binding.modelInput = presentSource(binding.modelInput, blind.presentation);
  if (data.verificationAudit) {
    binding.inspectionInput = binding.modelInput;
    binding.modelInput = verificationInspectionPresentation(binding.modelInput as ReturnType<typeof verificationPresentation>, task_analysis as TaskAnalysis);
  }
  return binding;
}
