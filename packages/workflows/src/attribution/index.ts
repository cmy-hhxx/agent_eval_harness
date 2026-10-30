import { randomUUID } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import { canonical, difference, restore, projectEvidenceReferences, resolveEvidenceSelection, type AgentBinding, type JsonObject, type PlannedTask, type RunManifest, type RunState, type SubmissionReceipt, type TaskAnalysis, type WorkflowDefinition, type WorkflowScheduling } from "@eval/contracts";
import { cite, messageContentSources, parseEvidenceCoordinates } from "@eval/tools";
import { createRunRepository, type RunCodec } from "@eval/data";
import { compactFields, compactResultSchema, type SessionCompact } from "@eval/agents/compact";
import type { TraceAttributionResult } from "@eval/agents/attribution";
import { collectInputs, contentText, structuredQuestion, loadRunInputs, normalizeInput, normalizeTraceInput, sessionSource, type Candidate, type EvaluationConfig, type RawInput } from "@eval/workflows/inputs";
import { attributionSessionSource, bindAttributionMaterial, processMaterial, processExecutionFacts, executionFactsView, processComponents, actorCatalog, referencedProcessFacts, presentedMaterialReads, projectComparisonEvidence, compactNavigation, verifiedCompact, compactPresentedReads, validateOriginalAttributionEvidence } from "@eval/workflows/review";
import problemSchema from "../../../../schemas/attribution/problem.schema.json" with { type: "json" };
import traceResultSchema from "../../../../schemas/attribution/trace-result.schema.json" with { type: "json" };
import sessionResultSchema from "../../../../schemas/attribution/session-result.schema.json" with { type: "json" };
import { initialAttributionMaterial } from "../review/attribution-navigation.js";

/** Process reviews include the terminal review that also assembles a single-turn session. */
export function isTraceAttributionTask(task: PlannedTask): boolean {
  return task.stage === "attribution-trace" || task.stage === "attribution-session" &&
    typeof (task.data as AttributionTaskData).traceIndex === "number";
}
export interface AttributionConfig extends EvaluationConfig { workflow: "attribution" }
export type AttributionStage = "attribution-compact-field" | "attribution-compact" | "attribution-trace" | "attribution-session";
export interface AttributionTaskData {
  stage: AttributionStage; candidate: Candidate; traceIndex?: number; traceCount?: number;
  compactField?: string; compactTaskId?: string;
}
export interface AttributionUnitOptions {
  data?: Record<string, unknown>;
  dependencies?: Record<string, string>;
  previousTasks?: readonly PlannedTask[];
  acceptedTaskIds?: ReadonlySet<string>;
  identity?: string;
}
const validateSession = new Ajv2020({ allErrors: true, strict: false })
  .addSchema(problemSchema).addSchema(traceResultSchema).compile(sessionResultSchema);
const validateCompact = new Ajv2020({ allErrors: true, strict: false }).compile(compactResultSchema);
function turns(candidate: Candidate) {
  return candidate.turns ?? [{ trace_index: 0, trace_id: candidate.trace_id, question: candidate.question,
    final_index: candidate.final_index }];
}

/** One compact session, one process review per received trace, then cross-turn review. */
export function planAttributionUnit(candidate: Candidate, options: AttributionUnitOptions = {}) {
  const previous = (options.previousTasks ?? []).filter(task => task.stage.startsWith("attribution-") &&
    (task.data as AttributionTaskData).candidate.input_id === candidate.input_id &&
    (task.data as Record<string, unknown>).attributionIdentity === options.identity);
  const id = (stage: AttributionStage, traceIndex?: number) => previous.find(task => task.stage === stage &&
    (task.data as AttributionTaskData).traceIndex === traceIndex)?.id ?? randomUUID();
  const traceList = turns(candidate), upstream = options.dependencies ?? {};
  const base = { ...options.data, ...(options.identity ? { attributionIdentity: options.identity } : {}) };
  const compact: PlannedTask = { id: id("attribution-compact"), stage: "attribution-compact",
    inputIds: { answer: candidate.input_id }, dependencies: {},
    data: { ...base, stage: "attribution-compact", candidate, traceCount: traceList.length } satisfies AttributionTaskData };
  const fields: PlannedTask[] = options.acceptedTaskIds?.has(compact.id)
    ? previous.filter(task => task.stage === "attribution-compact-field")
    : Object.entries(compactFields).filter(([field]) => field !== "cross_turn" || traceList.length > 1).flatMap(([field, definition]) =>
      (definition.scope === "session" ? [undefined] : traceList.map(trace => trace.trace_index)).map(traceIndex => ({
      id: previous.find(task => (task.data as AttributionTaskData).compactField === field && (task.data as AttributionTaskData).traceIndex === traceIndex)?.id ?? randomUUID(),
      stage: "attribution-compact-field", inputIds: { answer: candidate.input_id }, dependencies: {},
      data: { ...base, stage: "attribution-compact-field", candidate, compactField: field, compactTaskId: compact.id,
        traceIndex, traceCount: traceList.length } satisfies AttributionTaskData,
    })));
  compact.dependencies = Object.fromEntries(fields.map(task => { const info = task.data as AttributionTaskData;
    return [info.traceIndex === undefined ? info.compactField! : `${info.traceIndex}:${info.compactField}`, task.id]; }));
  const preparation = [...fields, compact];
  if (traceList.length === 1) {
    const oldTrace = previous.find(task => task.stage === "attribution-trace");
    const oldSession = previous.find(task => task.stage === "attribution-session");
    if ((oldTrace && options.acceptedTaskIds?.has(oldTrace.id)) || (oldSession && options.acceptedTaskIds?.has(oldSession.id)))
      return { tasks: [...preparation, ...previous.filter(task => !task.stage.startsWith("attribution-compact"))
        .map(task => ({ ...task, data: { ...task.data as object, candidate } }))], session: oldSession! };
    const session: PlannedTask = { id: oldTrace?.id ?? oldSession?.id ?? randomUUID(), stage: "attribution-session",
      inputIds: { answer: candidate.input_id }, dependencies: { ...upstream, compact: compact.id },
      data: { ...base, stage: "attribution-session", candidate, traceIndex: 0, traceCount: 1 } satisfies AttributionTaskData };
    return { tasks: [...preparation, session], session };
  }
  const traceTasks: PlannedTask[] = traceList.map(trace => ({ id: id("attribution-trace", trace.trace_index), stage: "attribution-trace",
    inputIds: { answer: candidate.input_id }, dependencies: { ...upstream, compact: compact.id },
    data: { ...base, stage: "attribution-trace", candidate, traceIndex: trace.trace_index,
      traceCount: traceList.length } satisfies AttributionTaskData }));
  const session: PlannedTask = { id: id("attribution-session"), stage: "attribution-session",
    inputIds: { answer: candidate.input_id }, dependencies: { ...upstream, compact: compact.id,
      ...Object.fromEntries(traceTasks.map((task, index) => [`trace${index}`, task.id])) },
    data: { ...base, stage: "attribution-session", candidate, traceCount: traceList.length } satisfies AttributionTaskData };
  return { tasks: [...preparation, ...traceTasks, session], session };
}

export async function planAttribution(config: AttributionConfig) {
  const indexed = await collectInputs(config, undefined, { materializeInputs: false });
  const catalog = indexed.catalog, tasks: PlannedTask[] = [];
  if (config.inputs.records) {
    const order = new Map(config.inputs.records.map((record, index) =>
      [canonical([record.model, record.input_file, record.input_index + 1]), index]));
    catalog.sort((a, b) => order.get(canonical([a.version, a.source, a.line]))! - order.get(canonical([b.version, b.source, b.line]))!);
  }
  for (const candidate of catalog) tasks.push(...planAttributionUnit(candidate).tasks);
  const inputs = await loadRunInputs({ config, tasks, inputCatalog: catalog } as RunManifest, undefined, undefined, undefined, normalizeInput);
  return { tasks, inputs, catalog, summary: { workflow: "attribution", sessions: catalog.length,
    compact_tasks: catalog.length, compact_field_tasks: tasks.filter(task => task.stage === "attribution-compact-field").length,
    trace_tasks: tasks.filter(task => task.stage === "attribution-trace").length,
    session_tasks: catalog.length, issues: indexed.issues } };
}
const sourceCache = new WeakMap<object, Map<string, ReturnType<typeof attributionSessionSource> & { session: RawInput; compactMaterial?: JsonObject }>>();
function sourceFor(inputs: Record<string, unknown>, candidate: Candidate) {
  // The input reader owns window eviction and revision checks. Cache by its immutable
  // record object, so preparing fields neither reparses a session nor retains the whole run.
  const value = inputs[candidate.input_id] as object;
  let window = sourceCache.get(value);
  if (!window) sourceCache.set(value, window = new Map());
  let source = window.get(candidate.input_id);
  if (!source) {
    const session = normalizeInput(value);
    source = { ...attributionSessionSource(session, candidate.input_id), session };
    window.set(candidate.input_id, source);
  }
  return source;
}
function compactMeta(session: RawInput, candidate: Candidate): JsonObject {
  return { batch_id: candidate.batch_id, case_id: candidate.case_id, model: candidate.version,
    source_input_id: candidate.input_id, summary_origin: "compact",
    trace_ids: turns(candidate).map(trace => trace.trace_id), session_meta: session.session_meta ?? session.meta ?? {} };
}
export function compactFieldResult(compact: JsonObject, field: string, traceIndex?: number): JsonObject {
  const value = traceIndex === undefined ? compact[field] : (compact.turns as JsonObject[])[traceIndex]![field];
  const array = ["reasoning_chain", "execution_chain", "reflections", "gaps", "artifacts", "components"].includes(field);
  return { value: value ?? (array ? [] : {}) };
}
export function bindAttribution(task: PlannedTask, inputs: Record<string, unknown>, dependencies: Record<string, SubmissionReceipt | undefined>,
  options: { reference?: unknown } = {}): AgentBinding {
  const data = task.data as AttributionTaskData, candidate = data.candidate;
  const source = sourceFor(inputs, candidate), { session, raw, original, positions } = source, traceList = turns(candidate);
  if (task.stage === "attribution-compact") {
    const compact: SessionCompact = { session_overview: {}, meta: compactMeta(session, candidate),
      turns: traceList.map(trace => ({ turn_index: trace.trace_index })) };
    for (const label of Object.keys(task.dependencies)) {
      const result = dependencies[label]?.evaluation as JsonObject | undefined;
      if (!result) throw new Error("Compact 字段尚未完成：" + label);
      const [index, field] = label.includes(":") ? label.split(":") : [undefined, label];
      const value = result.value;
      if (index === undefined) compact[field!] = value;
      else if (value && typeof value === "object" && Object.keys(value).length) compact.turns[Number(index)]![field!] = value;
    }
    processExecutionFacts(raw, original, candidate.input_id, positions).forEach((facts, index) => { compact.turns[index]!.execution_facts = facts; });
    compact.components = processComponents(raw, original, candidate.input_id, positions,
      compact.turns.flatMap(turn => turn.components as JsonObject[] ?? []));
    return { agent: "compact", profile: "default", computedResult: compact,
      request: { sources: { answer: { id: candidate.input_id, value: raw } }, input: { turn_count: traceList.length, meta: compact.meta } } };
  }
  if (task.stage === "attribution-compact-field") {
    const field = data.compactField!;
    if (!Object.hasOwn(compactFields, field)) throw new Error("未知 Compact 字段：" + field);
    if (!source.compactMaterial) {
      source.compactMaterial = { turns: traceList.map(trace => {
        const process = processMaterial(raw, original, candidate.input_id, "answer", 8000, positions, trace.trace_index);
        const finalIndex = positions.findIndex(point => point.trace_index === trace.trace_index &&
          point.message_index === (trace.final_index ?? candidate.final_index));
        const delivery = initialAttributionMaterial(finalIndex, raw, candidate.input_id);
        const finalTexts = new Set(messageContentSources(raw.messages[finalIndex]).map(source => source.text));
        const processOnly = process.process_evidence.filter(entry => {
          if (entry.message_index === finalIndex) return false;
          const message = raw.messages[entry.message_index]!;
          if (message.type !== "llm_turn" || !entry.read_request.path.startsWith("/output")) return true;
          const outputs = Array.isArray(message.output) ? message.output : [message.output];
          const rows: JsonObject[] = outputs.map(output => output && typeof output === "object" ? output as JsonObject : { content: output });
          return rows.some(row => Array.isArray(row.tool_calls) && row.tool_calls.length) ||
            !rows.some(row => finalTexts.has(contentText(row.content)));
        });
        return { turn_index: trace.trace_index, question: trace.question,
        source_directory: process.source_directory.filter(row => positions[row.message_index]!.trace_index === trace.trace_index),
        execution_facts: process.execution_facts[0],
        process_excerpts: process.process_evidence.filter(row => positions[row.message_index]!.trace_index === trace.trace_index),
        process_only_excerpts: processOnly,
        final_evidence: delivery.final_evidence, final_context: delivery.final_context,
      }; }), recorded_components: processComponents(raw, original, candidate.input_id, positions) };
    }
    const selected = data.traceIndex === undefined ? traceList : [traceList[data.traceIndex]!];
    const factsByTurn = (source.compactMaterial.facts ??= {}) as Record<number, JsonObject[]>;
    if (field === "key_data") for (const trace of selected)
      factsByTurn[trace.trace_index] ??= referencedProcessFacts(raw, original, candidate.input_id, positions, trace.trace_index);
    if (field === "key_data" && !source.compactMaterial.key_data_final)
      source.compactMaterial.key_data_final = traceList.map(trace => initialAttributionMaterial(positions.findIndex(point =>
        point.trace_index === trace.trace_index && point.message_index === (trace.final_index ?? candidate.final_index)), raw, candidate.input_id, 6400));
    const material = source.compactMaterial, facts = field === "key_data" ? selected.flatMap(trace => factsByTurn[trace.trace_index]!) : [];
    const brief = ["session_overview", "final_answer", "cross_turn"].includes(field);
    const processOnly = ["plan", "reasoning_chain", "execution_chain", "reflections", "components"].includes(field);
    const modelInput: JsonObject = { source_input_id: candidate.input_id,
      ...(field === "components" ? { recorded_components: actorCatalog(material.recorded_components as JsonObject[]) } : {}),
      turns: selected.map(trace => {
        const turn = (material.turns as JsonObject[])[trace.trace_index]!;
        const delivery = field === "key_data" ? (material.key_data_final as JsonObject[])[trace.trace_index]! : turn;
        const finalEvidence = delivery.final_evidence as JsonObject[];
        const excerpt = ({ read_request: _read, ...source }: JsonObject) => source;
        const finalIds = new Set(finalEvidence.map(entry => (entry.reference as JsonObject).evidence_id));
        const facts = turn.execution_facts as JsonObject;
        return { turn_index: trace.trace_index, question: trace.question,
          ...(!brief ? { execution_facts: executionFactsView(facts) } : {}),
          ...(!processOnly ? { final_context: { partial: (delivery.final_context as JsonObject).partial }, final_evidence: finalEvidence.map(excerpt) } : {}),
          ...(!brief ? {
            source_directory: (turn.source_directory as JsonObject[]).map(({ type: _type, role: _role, chars: _chars, position: _position,
              usage: _usage, start_time: _start, end_time: _end, view_request: _view, generated_arguments, ...entry }) => ({ ...entry,
              ...(Array.isArray(generated_arguments) && generated_arguments.length ? { generated_arguments } : {}) })),
            process_excerpts: ((processOnly ? turn.process_only_excerpts : turn.process_excerpts) as JsonObject[])
              .filter(entry => !finalIds.has((entry.reference as JsonObject).evidence_id)).map(excerpt),
          } : {}) };
      }), ...(field === "key_data" ? { facts: facts.map(fact => { const location = fact.location as JsonObject;
        return { value: fact.value, origin: fact.origin, reference: ((fact.source_evidence as JsonObject[])[0]!.reference),
          message_index: location.source_message_index, path: location.path, field_path: location.field_path }; }) } : {}) };
    return { agent: "compact", profile: field, request: { sources: { answer: { id: candidate.input_id, value: raw } },
      input: { facts, source_positions: positions, trace_index: data.traceIndex } }, modelInput,
      projectModelInput(input, bank) {
        return { ...input, ...(Array.isArray(input.recorded_components) ? { recorded_components: projectEvidenceReferences(input.recorded_components, bank, 400) } : {}),
          ...(Array.isArray(input.facts) ? { facts: projectEvidenceReferences(input.facts, bank) } : {}), turns: (input.turns as JsonObject[]).map(turn => {
          const projected = projectComparisonEvidence({ answer: { ...turn, process_evidence: turn.process_excerpts } }, bank, 400).answer as JsonObject;
          const { process_evidence, ...rest } = projected;
          return { ...rest, execution_facts: projectEvidenceReferences(turn.execution_facts, bank), process_excerpts: process_evidence };
        }) };
      } };
  }
  const compactReceipt = dependencies.compact;
  if (!compactReceipt || compactReceipt.status !== "succeeded") throw new Error("Attribution 必须先接受本 session 的 compact。");
  const compact = verifiedCompact(compactReceipt.evaluation as SessionCompact, raw, original, candidate.input_id);
  if (task.stage === "attribution-trace" || data.traceIndex !== undefined) {
    const traceIndex = data.traceIndex ?? 0, trace = traceList[traceIndex]!;
    const turnOriginal = normalizeTraceInput(session, traceIndex);
    const finalIndex = positions.findIndex(point => point.trace_index === traceIndex && point.message_index === (trace.final_index ?? candidate.final_index));
    const traceCandidate = { ...candidate, trace_id: trace.trace_id, question: trace.question,
      final_index: finalIndex };
    const analysis = dependencies.criteria?.status === "succeeded" ? dependencies.criteria.evaluation as TaskAnalysis : undefined;
    const turnCompact = { ...compact, turns: [compact.turns[traceIndex]] };
    const binding = bindAttributionMaterial(traceCandidate, original, analysis, { ...options, compact: turnCompact, source: { raw, positions, traceIndex } });
    const components = binding.request.input.components as ReturnType<typeof processComponents>;
    const input = { ...binding.request.input, components, trace_meta: session.turns?.[traceIndex]?.meta ?? turnOriginal.meta ?? {},
      trace_index: traceIndex, question: trace.question, answer: contentText(raw.messages[finalIndex]?.content), compact: turnCompact };
    const compactView = compactNavigation(turnCompact,
      !(binding.modelInput!.answer as { final_context: { partial: boolean } }).final_context.partial);
    return { ...binding, ...(task.stage === "attribution-session" ? { profile: "single" } : {}),
      presentedReads: [...binding.presentedReads ?? [], ...compactPresentedReads(compactView, "answer", candidate.input_id)],
      request: { ...binding.request, input: { ...input, session_meta: session.session_meta ?? session.meta ?? {} } }, modelInput: { ...binding.modelInput!, compact: compactView,
      task_focus: { question: trace.question, review_target: "本轮完整思考链、执行链与最终交付" } } };
  }
  if (task.stage !== "attribution-session") throw new Error("未知 Attribution 任务阶段：" + task.stage);
  const components = processComponents(raw, original, candidate.input_id, positions,
    compact.turns.flatMap(turn => turn.components as JsonObject[] ?? []));
  const qa = traceList.map((trace, trace_index) => {
    const source = normalizeTraceInput(session, trace_index), final = trace.final_index ?? candidate.final_index;
    const question = source.messages.findLastIndex((message, index) => index < final &&
      (message.role === "user" || message.role === undefined && message.type === "user_question"));
    const structured = structuredQuestion(source.messages[question]!.content);
    const evidence = [question, final].flatMap(message_index => {
      const flatIndex = positions.findIndex(point => point.trace_index === trace_index && point.message_index === message_index);
      const sources = message_index === question && structured ? structured.sources : messageContentSources(source.messages[message_index]!);
      return sources.flatMap(source => {
        const excerpts = [];
        for (let start = 0; start < source.text.length; start += 400) {
          const { evidence_id, quote } = cite(candidate.input_id, flatIndex, source, start, Math.min(start + 400, source.text.length));
          excerpts.push({ role: message_index === question ? "question" : "answer", quote, reference: { evidence_id } });
        }
        return excerpts;
      });
    });
    return { trace_index, question: structured?.text ?? contentText(source.messages[question]!.content),
      answer: contentText(source.messages[final]!.content), evidence };
  });
  const process = processMaterial(raw, original, candidate.input_id, "answer", 12000, positions);
  const qaMessages = new Set(qa.flatMap(turn => turn.evidence.map(item => parseEvidenceCoordinates(item.reference.evidence_id)!.message_index)));
  const { execution_facts: _facts, ...navigation } = process;
  const answer = { ...navigation, process_evidence: process.process_evidence.filter(item => !qaMessages.has(item.message_index)) };
  const input = { session_meta: session.session_meta ?? session.meta ?? {}, qa, source_positions: positions, compact, components,
    turns: traceList.map((_, index) => dependencies[`trace${index}`]!.evaluation as TraceAttributionResult) };
  const compactView = compactNavigation(compact, true);
  const catalog = actorCatalog(components);
  return { agent: "attribution", profile: "session", request: { sources: { answer: { id: candidate.input_id, value: raw } }, input },
    modelInput: { qa: qa.map(({ answer: _answer, ...turn }) => turn), compact: compactView, answer, actor_catalog: catalog },
    projectModelInput: (input, bank) => projectComparisonEvidence({ ...input,
      qa: (input.qa as typeof qa).map(turn => ({ ...turn, evidence: projectEvidenceReferences(turn.evidence, bank, 400) })) }, bank, 400),
    presentedReads: [...compactPresentedReads(compactView, "answer", candidate.input_id), ...presentedMaterialReads({ ...answer, actor_catalog: catalog }, "answer", candidate.input_id), ...qa.flatMap(turn => turn.evidence.map(item => {
      const point = parseEvidenceCoordinates(item.reference.evidence_id)!;
      if (point.kind === "image") throw new Error("Session QA evidence must be text");
      return { candidate: "answer", message_index: point.message_index, kind: point.kind, path: point.path, start: point.start, end: point.end };
    }))] };
}
export const attributionScheduling: WorkflowScheduling = {
  sessionAdmission: { id: task => (task.data as AttributionTaskData).candidate.input_id,
    window: manifest => {
      const value = (manifest.config as AttributionConfig).execution.sessionWindow;
      if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error("execution.sessionWindow must be a positive integer");
      return Number(value);
    }, completed: task => task.stage === "attribution-session" },
  stagePriority: stage => stage === "attribution-compact" ? -1 : stage === "attribution-compact-field" ? 1 : 0,
};
export const attributionWorkflow: WorkflowDefinition = {
  id: "attribution", plan: config => planAttribution(config as AttributionConfig),
  isComputedTask: task => task.stage === "attribution-compact",
  bind: (task, inputs, dependencies) => bindAttribution(task, inputs, dependencies), observesFailures: () => true,
  scheduling: attributionScheduling,
  advance(task, receipt, _state, inputs) {
    if (task.stage === "attribution-compact-field") {
      const data = task.data as AttributionTaskData, source = sourceFor(inputs, data.candidate);
      verifiedCompact((receipt.evaluation as JsonObject).value, source.raw, source.original, data.candidate.input_id);
    }
    if (task.stage === "attribution-trace" || task.stage === "attribution-session") {
      const data = task.data as AttributionTaskData, session = normalizeInput(inputs[data.candidate.input_id]);
      const submitted = receipt.submitted as Record<string, { evidence: { index: number }[] }[]>;
      const local = data.traceIndex !== undefined;
      const field = local ? "problems" : "session_problem";
      const result = receipt.evaluation as { turns?: TraceAttributionResult[]; problem?: { evidence: unknown[] }[]; session_problem?: { evidence: unknown[] }[] };
      const problems = local ? result.problem ?? result.turns![0]!.problem : result.session_problem!;
      const evidence = { [field]: problems.map((problem, i) => ({ evidence: problem.evidence.map((item, j) => ({
        ...item as object, ...resolveEvidenceSelection(receipt.audit.evidenceBank ?? [],
          { evidence_index: submitted[field]![i]!.evidence[j]!.index }, `/${field}/${i}/evidence/${j}/index`),
      })) })) };
      const original = sessionSource(session).raw;
      validateOriginalAttributionEvidence(evidence, { [data.candidate.input_id]: original }, receipt.audit, receipt.submitted);
    }
    return { tasks: [] };
  },
  async reconcile(_run, state, current) {
    const config = current as AttributionConfig, manifest = state.manifest;
    manifest.config = { ...manifest.config as AttributionConfig, execution: config.execution, inputs: config.inputs };
    const records = new Map<string, Candidate>();
    const inputs = await loadRunInputs(manifest, undefined, undefined, records, normalizeInput);
    const catalog = (manifest.inputCatalog as Candidate[]).map(candidate => ({ ...records.get(candidate.input_id)!, input_id: candidate.input_id }));
    const tasks = catalog.flatMap(candidate => planAttributionUnit(candidate, { previousTasks: manifest.tasks, acceptedTaskIds: new Set(Object.keys(state.receipts)) }).tasks);
    manifest.tasks = tasks; manifest.inputCatalog = catalog;
    return { tasks, inputs, catalog, summary: manifest.preflight };
  },
};

/** Captured records may share a conversation; only the same ordered traces share a result identity. */
function attributionResultId(row: JsonObject): string {
  if (row.session_overview) {
    const meta = row.meta as JsonObject;
    return canonical(["compact", meta.batch_id, meta.case_id, meta.model, meta.trace_ids]);
  }
  const meta = row.session_meta as JsonObject;
  const traces = (row.turns as { meta: JsonObject }[]).map(turn => turn.meta.trace_id ?? null);
  if (!meta.session_id && !meta.case_id && traces.every(id => id === null))
    throw new Error("Attribution 结果缺少 session、case 或 trace 身份");
  return canonical([meta.session_id ?? meta.case_id ?? null, traces]);
}

interface Checkpoint { workflow: "attribution"; manifest: Omit<RunManifest, "tasks" | "states" | "inputs" | "inputCatalog">; inputs: Record<string, Candidate>; tasks: Record<string, { task: Omit<PlannedTask, "id" | "data">; data: Omit<AttributionTaskData, "candidate"> & { input_id: string }; state: RunManifest["states"][string]; receipt?: any }>; usage: RunState["usage"]; recordedAttempts: number }
function resultReference(checkpoint: Checkpoint, row: Checkpoint["tasks"][string]) {
  if (!checkpoint.inputs[row.data.input_id]) throw new Error("归因结果缺少输入身份");
  return { ...row.receipt.exported };
}
const codec: RunCodec<Checkpoint> = {
  encode(state) {
    const { tasks, states, inputs: _inputs, inputCatalog, ...manifest } = state.manifest;
    return { workflow: "attribution", manifest, inputs: Object.fromEntries((inputCatalog as Candidate[]).map(candidate => [candidate.input_id, candidate])), usage: state.usage, recordedAttempts: state.recordedAttempts,
      tasks: Object.fromEntries(tasks.map(task => { const { id, data, ...definition } = task, info = data as AttributionTaskData, receipt = state.receipts[id]; let saved: any;
        if (receipt) { const { evaluation, submitted: _submitted, exported, ...rest } = receipt;
          const compact = info.compactTaskId && state.receipts[info.compactTaskId]?.exported;
          saved = { ...rest, ...(compact ? { compact: { id: compact.id, file: compact.file, line: compact.line },
            ...(receipt.submitted !== undefined ? { submittedPatch: difference(evaluation, receipt.submitted) } : {}) }
            : exported ? { exported: { id: exported.id, file: exported.file, line: exported.line } } : { evaluation }) }; }
        const { candidate, ...coordinates } = info;
        return [id, { task: definition, data: { ...coordinates, input_id: candidate.input_id }, state: states[id], ...(saved ? { receipt: saved } : {}) }]; })) };
  },
  references(checkpoint, ids) { return Object.entries(checkpoint.tasks).flatMap(([id, row]) => (!ids || ids.has(id))
    ? row.receipt?.compact ? [row.receipt.compact] : row.receipt?.exported ? [resultReference(checkpoint, row)] : [] : []); },
  resultId: attributionResultId,
  decode(checkpoint, read, ids) {
    const tasks: PlannedTask[] = [], receipts: RunState["receipts"] = {}, states: RunManifest["states"] = {};
    for (const [id, row] of Object.entries(checkpoint.tasks)) {
      tasks.push({ id, ...row.task, data: { ...row.data, candidate: checkpoint.inputs[row.data.input_id] } }); states[id] = row.state;
      if (row.receipt && (!ids || ids.has(id))) { const saved = row.receipt, reference = saved.exported ? resultReference(checkpoint, row) : undefined,
        exported = reference ? { ...reference, row: read(reference) } : undefined;
        const { compact, submittedPatch, ...receipt } = saved;
        const evaluation = compact ? compactFieldResult(read(compact), row.data.compactField!, row.data.traceIndex) : saved.evaluation ?? structuredClone(exported!.row);
        receipts[id] = { ...receipt, evaluation, ...(submittedPatch ? { submitted: restore(evaluation, submittedPatch) } : {}),
          audit: saved.audit ?? { calls: 0, requiredReadCalls: 0, traceReads: [], viewedImages: [], calculations: [], artifacts: [] }, ...(exported ? { exported } : {}) }; }
    }
    return { manifest: { ...checkpoint.manifest, tasks, states,
      inputs: Object.fromEntries(Object.keys(checkpoint.inputs).map(id => [id, { id, name: id }])),
      inputCatalog: Object.values(checkpoint.inputs) }, receipts,
      usage: checkpoint.usage, recordedAttempts: checkpoint.recordedAttempts };
  },
};
const repository = createRunRepository(codec, (task, state) => {
  if (task.stage !== "attribution-session" && task.stage !== "attribution-compact") return null;
  const accepted = state.receipts[task.id]!;
  if (accepted.exported && canonical(accepted.exported.row) !== canonical(accepted.evaluation))
    throw new Error("结果 ID 对应冲突结果：" + task.id);
  if (accepted.reusedFrom && accepted.exported) return { ...accepted.exported, id: task.id };
  const row = structuredClone(state.receipts[task.id]!.evaluation) as JsonObject;
  const validate = task.stage === "attribution-compact" ? validateCompact : validateSession;
  if (!validate(row)) throw new Error("Attribution session 导出契约无效：" + JSON.stringify(validate.errors));
  return { id: task.id, file: task.stage === "attribution-compact" ? "compact.jsonl" : "attribution.jsonl", row };
}, { appendOnly: true, indexedFiles: ["attribution.jsonl", "compact.jsonl"], semanticReferences: true });
export const attributionRepository = { ...repository, createResultWriter(run: string, inputs: Record<string, unknown>) { return repository.createResultWriter(run, inputs); } };

export async function validateAttributionRun(state: RunState) {
  for (const task of state.manifest.tasks) { const receipt = state.receipts[task.id]; if (!receipt) continue;
    if (receipt.taskId !== task.id) throw new Error("Attribution 收据身份不一致");
    if (task.stage === "attribution-compact" && !validateCompact(receipt.evaluation)) throw new Error("Compact 结果结构无效");
    if (!["attribution-session", "attribution-compact"].includes(task.stage) && receipt.exported) throw new Error("内部任务不能导出正式行");
    if (["attribution-session", "attribution-compact"].includes(task.stage) && !receipt.exported) throw new Error("session 任务缺少正式导出"); }
  return { valid: true, receipts: Object.keys(state.receipts).length };
}
