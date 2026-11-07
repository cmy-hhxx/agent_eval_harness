import { randomUUID } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import { canonical, difference, restore, projectEvidenceReferences, resolveEvidenceSelection, type AgentBinding, type JsonObject, type PlannedTask, type RunManifest, type RunState, type ShardSource, type SubmissionReceipt, type TaskAnalysis, type WorkflowDefinition, type WorkflowScheduling } from "@eval/contracts";
import { cite, displayEvidence, evidenceSources, parseEvidenceCoordinates, resolveEvidence, traceCallOrigins } from "@eval/tools";
import { createRunRepository, type RunCodec, type SourceCursor } from "@eval/data";
import { compactFields, compactResultSchema, type SessionCompact } from "@eval/agents/compact";
import type { TraceAttributionResult } from "@eval/agents/attribution";
import { candidateKey, contentText, createInputBindings, createInputShardScan, normalizeInput, normalizeTraceInput, type Candidate, type EvaluationConfig, type RawInput } from "@eval/workflows/inputs";
import { attributionSessionSource, bindAttributionMaterial, processMaterial, processExecutionFacts, executionFactsView, processComponents, actorCatalog, presentedMaterialReads, projectComparisonEvidence, projectCompactEvidence, verifiedCompact, compactPresentedReads, validateOriginalAttributionEvidence } from "@eval/workflows/review";
import problemSchema from "../../../../schemas/attribution/problem.schema.json" with { type: "json" };
import traceResultSchema from "../../../../schemas/attribution/trace-result.schema.json" with { type: "json" };
import sessionResultSchema from "../../../../schemas/attribution/session-result.schema.json" with { type: "json" };
import { componentMaterial } from "./component-material.js";
import { investigationGroups } from "./component-groups.js";
import { compactFinalMaterial, compactProcessExcerpts, compactTextRanges } from "./compact-material.js";

/** Trace tasks summarize accepted component investigations. */
export function isTraceAttributionTask(task: PlannedTask): boolean { return task.stage === "attribution-trace"; }
export interface AttributionConfig extends EvaluationConfig { workflow: "attribution" }
export type AttributionStage = "attribution-compact-field" | "attribution-compact" | "attribution-component" | "attribution-trace" | "attribution-session";
export interface AttributionTaskData {
  stage: AttributionStage; candidate: Candidate; traceIndex?: number; traceCount?: number;
  compactField?: string; compactTaskId?: string; componentGroup?: string;
}
/** Previous attribution tasks grouped by candidate and attribution identity. */
export type AttributionTaskIndex = ReadonlyMap<string, readonly PlannedTask[]>;
const attributionTaskKey = (inputId: string, identity?: string) => canonical([inputId, identity ?? null]);
/** Resume planning must not rescan every planned task for every candidate. */
export function indexAttributionTasks(tasks: readonly PlannedTask[]): AttributionTaskIndex {
  const index = new Map<string, PlannedTask[]>();
  for (const task of tasks) {
    if (!task.stage.startsWith("attribution-")) continue;
    const data = task.data as AttributionTaskData & { attributionIdentity?: string };
    const key = attributionTaskKey(data.candidate.input_id, data.attributionIdentity);
    const group = index.get(key);
    if (group) group.push(task);
    else index.set(key, [task]);
  }
  return index;
}
export interface AttributionUnitOptions {
  data?: Record<string, unknown>;
  dependencies?: Record<string, string>;
  previousTasks?: AttributionTaskIndex;
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

/** One live Compact stage, component investigations, trace summaries, then session review. */
export function planAttributionUnit(candidate: Candidate, options: AttributionUnitOptions = {}) {
  const previous = options.previousTasks?.get(attributionTaskKey(candidate.input_id, options.identity)) ?? [];
  const id = (stage: AttributionStage, traceIndex?: number) => previous.find(task => task.stage === stage &&
    (task.data as AttributionTaskData).traceIndex === traceIndex)?.id ?? randomUUID();
  const traceList = turns(candidate), upstream = options.dependencies ?? {};
  const base = { ...options.data, ...(options.identity ? { attributionIdentity: options.identity } : {}) };
  const compact: PlannedTask = { id: id("attribution-compact"), stage: "attribution-compact",
    inputIds: { answer: candidate.input_id }, dependencies: {},
    data: { ...base, stage: "attribution-compact", candidate, traceCount: traceList.length } satisfies AttributionTaskData };
  const fields: PlannedTask[] = options.acceptedTaskIds?.has(compact.id)
    ? previous.filter(task => task.stage === "attribution-compact-field")
    : Object.entries(compactFields).flatMap(([field, definition]) =>
      (definition.scope === "session" ? [undefined] : traceList.map(trace => trace.trace_index)).map(traceIndex => ({
      id: previous.find(task => (task.data as AttributionTaskData).compactField === field && (task.data as AttributionTaskData).traceIndex === traceIndex)?.id ?? randomUUID(),
      stage: "attribution-compact-field", inputIds: { answer: candidate.input_id }, dependencies: {},
      data: { ...base, stage: "attribution-compact-field", candidate, compactField: field, compactTaskId: compact.id,
        traceIndex, traceCount: traceList.length } satisfies AttributionTaskData,
    })));
  compact.dependencies = Object.fromEntries(fields.map(task => { const info = task.data as AttributionTaskData;
    return [info.traceIndex === undefined ? info.compactField! : `${info.traceIndex}:${info.compactField}`, task.id]; }));
  const preparation = [...fields, compact];
  const acceptedSession = previous.find(task => task.stage === "attribution-session" && options.acceptedTaskIds?.has(task.id));
  if (acceptedSession) return { tasks: [...preparation, ...previous.filter(task => !task.stage.startsWith("attribution-compact"))
    .map(task => ({ ...task, data: { ...task.data as object, candidate } }))], session: acceptedSession };
  const components = previous.filter(task => task.stage === "attribution-component")
    .map(task => ({ ...task, data: { ...task.data as object, candidate } }));
  const traceTasks: PlannedTask[] = traceList.map(trace => {
    const children = components.filter(task => (task.data as AttributionTaskData).traceIndex === trace.trace_index);
    const labels = children.map(task => `group:${(task.data as AttributionTaskData).componentGroup}`);
    return { id: id("attribution-trace", trace.trace_index), stage: "attribution-trace", inputIds: { answer: candidate.input_id },
      dependencies: { ...upstream, compact: compact.id, ...Object.fromEntries(children.map((task, index) => [labels[index]!, task.id])) },
      settledDependencies: labels,
      data: { ...base, stage: "attribution-trace", candidate, traceIndex: trace.trace_index, traceCount: traceList.length } satisfies AttributionTaskData };
  });
  const session: PlannedTask = { id: id("attribution-session"), stage: "attribution-session",
    inputIds: { answer: candidate.input_id }, dependencies: { ...upstream, compact: compact.id,
      ...Object.fromEntries(traceTasks.map((task, index) => [`trace${index}`, task.id])) },
    data: { ...base, stage: "attribution-session", candidate, traceCount: traceList.length } satisfies AttributionTaskData };
  return { tasks: [...preparation, ...components, ...traceTasks, session], session };
}

/** Investigation groups fan out only after the live Compact directory is accepted. */
function componentFollowups(task: PlannedTask, compact: SessionCompact, state: RunState, inputs: Record<string, unknown>) {
  const data = task.data as AttributionTaskData, tasks: PlannedTask[] = [], replace: PlannedTask[] = [];
  const source = sourceFor(inputs, data.candidate);
  for (const turn of compact.turns) {
    const trace = state.manifest.tasks.find(item => item.stage === "attribution-trace" &&
      (item.data as AttributionTaskData).candidate.input_id === data.candidate.input_id && (item.data as AttributionTaskData).traceIndex === turn.turn_idx &&
      item.dependencies.compact === task.id)!;
    if (!trace || state.receipts[trace.id]) continue;
    const upstream = Object.fromEntries(Object.entries(trace.dependencies).filter(([label]) => !label.startsWith("group:")));
    const children = turnInvestigation(source, data.candidate, turn.turn_idx, turn).groups.map(group => {
      const old = state.manifest.tasks.find(item => item.stage === "attribution-component" && (item.data as AttributionTaskData).compactTaskId === task.id &&
        (item.data as AttributionTaskData).traceIndex === turn.turn_idx && (item.data as AttributionTaskData).componentGroup === group.key);
      if (old) return old;
      const child: PlannedTask = { id: randomUUID(), stage: "attribution-component", inputIds: task.inputIds,
        dependencies: upstream, data: { ...trace.data as object, stage: "attribution-component", compactTaskId: task.id,
          componentGroup: group.key } };
      tasks.push(child); return child;
    });
    const labels = children.map(child => `group:${(child.data as AttributionTaskData).componentGroup}`);
    replace.push({ ...trace, dependencies: { ...upstream, ...Object.fromEntries(children.map((child, index) => [labels[index]!, child.id])) },
      settledDependencies: labels });
  }
  return { tasks, replace };
}

/** Planning reads no input bodies: every physical file is planned, bound and released in turn. */
export async function planAttribution(config: AttributionConfig) {
  if (!Number.isSafeInteger(config.execution.sessionWindow) || config.execution.sessionWindow < 1)
    throw new Error("execution.sessionWindow must be a positive integer");
  return { tasks: [] as PlannedTask[], inputs: {}, catalog: [], summary: { workflow: "attribution", sharded: true } };
}
const bindings = new WeakMap<object, ReturnType<typeof createInputBindings>>();
function inputBindings(state: RunState) {
  const key = state.manifest;
  let bind = bindings.get(key);
  if (!bind) bindings.set(key, bind = createInputBindings(key.config as AttributionConfig));
  return bind;
}
/** Bounded row batches start evaluation before even the first physical file is fully read. */
export function attributionShards(config: AttributionConfig, state: RunState): ShardSource {
  const manifest = state.manifest, bind = inputBindings(state);
  const catalog = () => manifest.inputCatalog as Candidate[];
  const window = config.execution.sessionWindow;
  const cursors = (manifest.preflight.shardCursors ??= {}) as Record<string, SourceCursor & { revision: string }>;
  const scan = createInputShardScan(config, { catalog, admitted: new Set(catalog().map(candidateKey)),
    foundScope: config.inputs.records ? new Set<string>() : undefined,
    completed: manifest.preflight.shards as Record<string, string> | undefined, cursors });
  // Successful inputs occupy the window until delivery releases them. Permanently failed
  // sessions retain recovery detail without preventing other inputs from being read.
  const available = (version: string) => {
    const pending = new Set(manifest.tasks.filter(task => ["pending", "running"].includes(manifest.states[task.id]?.status))
      .flatMap(task => Object.values(task.inputIds)));
    const failed = new Set(manifest.tasks.filter(task => task.stage === "attribution-session" &&
      ["failed", "blocked", "cancelled", "timed_out"].includes(manifest.states[task.id]?.status))
      .flatMap(task => Object.values(task.inputIds)));
    return catalog().filter(candidate => !candidate.released && candidate.version === version &&
      (!failed.has(candidate.input_id) || pending.has(candidate.input_id))).length < window;
  };
  return {
    done: () => scan.done(),
    async next() {
      const shard = await scan.next(available);
      if (!shard) return undefined;
      if (cursors[shard.source]?.done && !shard.candidates.length && !catalog().some(candidate => candidate.source === shard.source))
        ((manifest.preflight.shards ??= {}) as JsonObject)[shard.source] = shard.revision;
      const previous = indexAttributionTasks(manifest.tasks),
        accepted = new Set(Object.keys(state.receipts)), tasks: PlannedTask[] = [];
      for (const candidate of shard.candidates)
        tasks.push(...planAttributionUnit(candidate, { previousTasks: previous, acceptedTaskIds: accepted }).tasks);
      return { ...shard, tasks, inputs: bind(shard.candidates) };
    },
  };
}
/** Finished inputs leave the checkpoint; their file stays recorded by revision. */
export function releaseAttribution(state: RunState, inputs: Record<string, unknown>) {
  const manifest = state.manifest, catalog = manifest.inputCatalog as Candidate[] | undefined;
  if (!catalog?.length) return;
  const accepted = new Set(catalog.filter(candidate => candidate.released).map(candidate => candidate.input_id));
  for (const task of manifest.tasks)
    if (task.stage === "attribution-session" && state.receipts[task.id]?.exported)
      accepted.add((task.data as AttributionTaskData).candidate.input_id);
  if (!accepted.size) return;
  const released: Candidate[] = [];
  for (const candidate of catalog) if (accepted.has(candidate.input_id)) { candidate.released = true; released.push(candidate); }
  if (!released.length) return;
  const freed = new Set(released.map(candidate => candidate.input_id));
  manifest.tasks = manifest.tasks.filter(task => {
    const id = (task.data as AttributionTaskData).candidate.input_id;
    if (!freed.has(id)) return true;
    delete manifest.states[task.id];
    delete state.receipts[task.id];
    return false;
  });
  for (const id of freed) { delete inputs[id]; delete manifest.inputs[id]; }
  const retained = catalog.filter(candidate => !candidate.released);
  for (const candidate of released)
    if ((manifest.preflight.shardCursors as Record<string, SourceCursor> | undefined)?.[candidate.source]?.done &&
        !retained.some(other => other.source === candidate.source)) {
      const shards = (manifest.preflight.shards ??= {}) as JsonObject;
      shards[candidate.source] = candidate.source_revision!;
    }
  manifest.inputCatalog = retained;
}
type TurnInvestigation = { finalIndex: number; actors: JsonObject[]; facts: JsonObject;
  groups: ReturnType<typeof investigationGroups> };
interface AttributionSource extends ReturnType<typeof attributionSessionSource> {
  session: RawInput; compactMaterial?: JsonObject; traceMaterial?: Map<number, AgentBinding>;
  investigations?: Map<number, { turn: JsonObject; components: unknown; result: TurnInvestigation }>;
}
const sourceCache = new WeakMap<object, Map<string, AttributionSource>>();
function sourceFor(inputs: Record<string, unknown>, candidate: Candidate): AttributionSource {
  // The input reader owns window eviction and revision checks. Cache by its immutable
  // record object, so preparing fields neither reparses a session nor retains the whole run.
  const value = inputs[candidate.input_id] as object;
  let window = sourceCache.get(value);
  if (!window) sourceCache.set(value, window = new Map());
  let source = window.get(candidate.input_id);
  if (!source) {
    const session = normalizeInput(value);
    source = { ...attributionSessionSource(session), session };
    window.set(candidate.input_id, source);
  }
  return source;
}
/** Groups come from the accepted Compact directory and recorded invocations; the model never forms them. */
function turnInvestigation(source: AttributionSource, candidate: Candidate, traceIndex: number, turn: JsonObject): TurnInvestigation {
  // One session plans a group task per component group and one trace task; all of them read the
  // same turn directory. Reuse that derivation until the accepted components change.
  const cache = source.investigations ??= new Map();
  const previous = cache.get(traceIndex);
  if (previous && previous.turn === turn && previous.components === turn.components) return previous.result;
  const result = deriveTurnInvestigation(source, candidate, traceIndex, turn);
  cache.set(traceIndex, { turn, components: turn.components, result });
  return result;
}
function deriveTurnInvestigation(source: AttributionSource, candidate: Candidate, traceIndex: number, turn: JsonObject): TurnInvestigation {
  const { raw, original, positions } = source, trace = turns(candidate)[traceIndex]!;
  const finalIndex = positions.findIndex(point => point.trace_index === traceIndex && point.message_index === (trace.final_index ?? candidate.final_index));
  const actors = processComponents(raw, original, candidate.input_id, positions, turn.components as JsonObject[]);
  const recorded = processExecutionFacts(raw, original, candidate.input_id, positions, traceIndex)[0]!;
  const indices = positions.flatMap((point, index) => point.trace_index === traceIndex ? [index] : []);
  // Span links miss a main loop that emits tool calls directly; its exact generated arguments still identify the generator.
  const origins = new Map(traceCallOrigins(indices.map(index => raw.messages[index]!)).map(origin => [indices[origin.request_index]!, indices[origin.planner_index]!]));
  const facts = { ...recorded, execution_links: (recorded.execution_links as JsonObject[]).map(link => link.invoking_model_message_index === null &&
    origins.has(Number(link.request_message_index)) ? { ...link, invoking_model_message_index: origins.get(Number(link.request_message_index))! } : link) };
  const modelIndices = indices.filter(index => raw.messages[index]?.type === "llm_turn");
  return { finalIndex, actors, facts,
    groups: investigationGroups(raw, actors, facts.execution_links, turn.tool_errors as JsonObject[], finalIndex, modelIndices) };
}
export function compactFieldResult(compact: JsonObject, field: string, traceIndex?: number): JsonObject {
  if (field === "session_overview") {
    const overview = compact.session_overview as string[];
    return { value: [overview[0], overview[2]] };
  }
  return { value: (compact.turns as JsonObject[])[traceIndex!]![field] };
}
/** Only a provable absence short-circuits a Compact field; "found nothing" stays a model judgment. */
function structurallyEmpty(field: string, raw: RawInput, positions: { trace_index: number }[], material: JsonObject, traceIndex: number): boolean {
  if (!["execution_chain", "tool_errors"].includes(field)) return false;
  const facts = (material.turns as JsonObject[])[traceIndex]?.execution_facts as JsonObject | undefined;
  if (!facts) return false;
  // Both the recorded invocation index and the raw transcript must agree: a schema variant this
  // code does not recognize keeps the field live rather than claiming the turn made no call.
  if ((facts.tool_calls as JsonObject[] | undefined)?.length || (facts.execution_links as JsonObject[] | undefined)?.length) return false;
  return !positions.some((point, index) => point.trace_index === traceIndex && (raw.messages[index]!.role === "tool" ||
    ["tool_call", "function_call", "tool_result", "function_call_output"].includes(String(raw.messages[index]!.type))));
}
export function bindAttribution(task: PlannedTask, inputs: Record<string, unknown>, dependencies: Record<string, SubmissionReceipt | undefined>,
  options: { reference?: unknown } = {}): AgentBinding {
  const data = task.data as AttributionTaskData, candidate = data.candidate;
  const source = sourceFor(inputs, candidate), { session, raw, original, positions } = source, traceList = turns(candidate);
  if (task.stage === "attribution-compact") {
    const compact: SessionCompact = { session_overview: [], session_meta: session.session_meta ?? session.meta ?? {},
      trace_meta: traceList.map(trace => session.turns?.[trace.trace_index]?.meta ?? session.meta ?? {}),
      turns: traceList.map(trace => {
        const finalIndex = positions.findIndex(point => point.trace_index === trace.trace_index &&
          point.message_index === (trace.final_index ?? candidate.final_index));
        return { turn_idx: trace.trace_index, plans: [], reasoning_chain: [], execution_chain: [], reflections: [], tool_errors: [],
          final_answer: contentText(raw.messages[finalIndex]?.content), components: [], key_data: [], artifacts: [] };
      }) };
    for (const label of Object.keys(task.dependencies)) {
      const result = dependencies[label]?.evaluation as JsonObject | undefined;
      if (!result) throw new Error("Compact 字段尚未完成：" + label);
      const [index, field] = label.includes(":") ? label.split(":") : [undefined, label];
      if (index === undefined) compact[field!] = [...result.value as string[]];
      else compact.turns[Number(index)]![field!] = result.value;
    }
    for (const turn of compact.turns) {
      const described = processComponents(raw, original, candidate.input_id, positions, turn.components as JsonObject[]);
      turn.components = described.map((entry, index) => ({
        components_idx: index + 1, components_name: entry.name, components_kind: entry.kind,
        components_content: entry.components_content,
        evidence: entry.source_evidence.filter(item => positions[item.message_index as number]!.trace_index === turn.turn_idx)
          .map(item => ({ evidence_id: (item.reference as JsonObject).evidence_id, quote: item.quote })),
      }));
    }
    const calls = new Map<string, number>();
    for (const facts of processExecutionFacts(raw, original, candidate.input_id, positions))
      for (const call of facts.tool_calls) calls.set(call.name, (calls.get(call.name) ?? 0) + call.count);
    const count = [...calls.values()].reduce((sum, value) => sum + value, 0);
    const errors = compact.turns.reduce((sum, turn) => sum + (turn.tool_errors as JsonObject[]).length, 0);
    compact.session_overview.splice(1, 0, "实际调用工具 " + count + " 次：" + ([...calls].map(([name, count]) => name + " " + count + " 次").join("；") || "无") + "；实际工具报错 " + errors + " 次。");
    return { agent: "compact", profile: "default", computedResult: compact,
      request: { sources: { answer: { id: candidate.input_id, value: raw } }, input: {
        turn_count: traceList.length, session_meta: compact.session_meta, trace_meta: compact.trace_meta } } };
  }
  if (task.stage === "attribution-compact-field") {
    const field = data.compactField!;
    if (!Object.hasOwn(compactFields, field)) throw new Error("未知 Compact 字段：" + field);
    if (!source.compactMaterial) {
      source.compactMaterial = { turns: traceList.map(trace => {
        const process = processMaterial(raw, original, candidate.input_id, "answer", 0, positions, trace.trace_index);
        const finalIndex = positions.findIndex(point => point.trace_index === trace.trace_index &&
          point.message_index === (trace.final_index ?? candidate.final_index));
        // The final answer is the single most load-bearing material for every turn field, so it
        // gets room for a full structured reply; partial stays flagged when even that is exceeded.
        const delivery = compactFinalMaterial(finalIndex, raw, candidate.input_id, 6000);
        return { turn_index: trace.trace_index, final_message_index: finalIndex, question: trace.question,
          source_directory: process.source_directory, execution_facts: process.execution_facts[0],
          final_evidence: delivery.final_evidence, final_context: delivery.final_context,
      }; }), recorded_components: processComponents(raw, original, candidate.input_id, positions) };
    }
    const selected = data.traceIndex === undefined ? traceList : [traceList[data.traceIndex]!];
    const material = source.compactMaterial;
    // A turn with no tool call has no execution chain and no tool error by construction. Only
    // that structural emptiness short-circuits; a field the model found nothing for stays live.
    if (data.traceIndex !== undefined && structurallyEmpty(field, raw, positions, material, data.traceIndex))
      return { agent: "compact", profile: field, computedResult: { value: [] },
        request: { sources: { answer: { id: candidate.input_id, value: raw } }, input: { source_positions: positions, trace_index: data.traceIndex } } };
    const brief = field === "session_overview";
    const processOnly = ["plans", "reasoning_chain", "execution_chain", "reflections", "tool_errors"].includes(field);
    const recorded: JsonObject[] = (material.recorded_components as JsonObject[]).filter(actor => (actor.positions as JsonObject[]).some(point => point.trace_index === data.traceIndex))
      .map(actor => ({ ...actor, source_evidence: (actor.source_evidence as JsonObject[]).filter(item => positions[item.message_index as number]!.trace_index === data.traceIndex) }));
    const modelInput: JsonObject = { source_input_id: candidate.input_id,
      ...(field === "components" ? { recorded_components: actorCatalog(recorded) } : {}),
      turns: selected.map(trace => {
        const turn = (material.turns as JsonObject[])[trace.trace_index]!;
        const delivery = field === "key_data" ? compactFinalMaterial(Number(turn.final_message_index), raw, candidate.input_id, 12000) : turn;
        const finalEvidence = delivery.final_evidence as JsonObject[];
        const excerpt = ({ read_request: _read, ...source }: JsonObject) => source;
        const finalIds = new Set(finalEvidence.map(entry => (entry.reference as JsonObject).evidence_id));
        const facts = turn.execution_facts as JsonObject;
        const excerpts = brief || field === "key_data" ? [] : compactProcessExcerpts(field, raw, original, candidate.input_id, positions, trace.trace_index, Number(turn.final_message_index))
          .filter(entry => !finalIds.has((entry.reference as JsonObject).evidence_id));
        if (field === "components") {
          const append = (index: number, source: ReturnType<typeof evidenceSources>[number], start: number) => {
            const message = raw.messages[index]!;
            const ranges = compactTextRanges(source.text);
            const range = ranges.find(range => range.start <= start && start < range.end);
            if (range) excerpts.push({ ...displayEvidence(cite(candidate.input_id, index, source, range.start, range.end)),
              origin: { type: message.type, name: message.name, field_path: source.path } });
          };
          for (const actor of recorded.filter(actor => actor.kind === "script" || actor.kind === "skill")) {
            const proofs = actor.source_evidence as JsonObject[];
            for (const proof of [proofs[0], proofs.at(-1)].filter((item): item is JsonObject => !!item)) {
              const point = parseEvidenceCoordinates((proof.reference as JsonObject).evidence_id as string)!;
              if (point.kind === "image") continue;
              const source = evidenceSources(raw.messages[point.message_index]).find(source => source.kind === point.kind && source.path === point.path)!;
              append(point.message_index, source, point.start);
              const link = (facts.execution_links as JsonObject[]).find(link => link.request_message_index === point.message_index);
              for (const index of link?.return_message_indices as number[] ?? []) {
                const originals = evidenceSources(original.messages[index]);
                const sources = evidenceSources(raw.messages[index]).filter(source => source.text.length && source.quotable !== false &&
                  originals.some(other => other.kind === source.kind && other.path === source.path && other.text === source.text));
                const output = sources.find(source => /\/(?:stdout|content)$/u.test(source.path)) ??
                  sources.find(source => /\/(?:output|result)$/u.test(source.path)) ?? sources.find(source => source.kind === "json");
                if (output) for (const start of new Set([0, Math.max(0, output.text.length - 1)])) append(index, output, start);
              }
            }
          }
        }
        const visibleMessages = new Set(excerpts.map(entry => entry.message_index));
        const measured = executionFactsView(facts);
        return { turn_index: trace.trace_index, ...(field !== "key_data" ? { question: trace.question } : {}),
          ...(["execution_chain", "tool_errors", "components"].includes(field) ? { execution_facts: { tool_calls: measured.tool_calls, execution_links: measured.execution_links } } : {}),
          ...(!processOnly ? { final_context: { partial: (delivery.final_context as JsonObject).partial }, final_evidence: finalEvidence.map(excerpt) } : {}),
          ...(!brief && field !== "key_data" ? {
            source_directory: (turn.source_directory as JsonObject[]).filter(row => visibleMessages.has(row.message_index)).map(({ type: _type, role: _role, chars: _chars, position: _position,
              usage: _usage, start_time: _start, end_time: _end, view_request: _view, generated_arguments, ...entry }) => ({ ...entry,
              ...(Array.isArray(generated_arguments) && generated_arguments.length ? { generated_arguments } : {}) })),
            process_excerpts: [...new Map(excerpts.map(entry => [(entry.reference as JsonObject).evidence_id, entry])).values()].map(excerpt),
          } : {}) };
      }) };
    return { agent: "compact", profile: field, request: { sources: { answer: { id: candidate.input_id, value: raw } },
      input: { source_positions: positions, trace_index: data.traceIndex,
        ...(field === "key_data" ? { final_message_index: (material.turns as JsonObject[])[data.traceIndex!]!.final_message_index } : {}),
        ...(field === "components" ? { recorded_components: recorded } : {}) } }, modelInput,
      projectModelInput(input, bank) {
        return { ...input, ...(Array.isArray(input.recorded_components) ? { recorded_components: projectEvidenceReferences(input.recorded_components, bank, 400) } : {}),
          turns: (input.turns as JsonObject[]).map(turn => {
          const projected = projectComparisonEvidence({ answer: { ...turn, process_evidence: turn.process_excerpts } }, bank, 400).answer as JsonObject;
          const { process_evidence, ...rest } = projected;
          return { ...rest, execution_facts: projectEvidenceReferences(turn.execution_facts, bank), process_excerpts: process_evidence };
        }) };
      } };
  }
  const compactReceipt = dependencies.compact;
  if (!compactReceipt || compactReceipt.status !== "succeeded") throw new Error("Attribution 必须先接受本 session 的 compact。");
  const compact = verifiedCompact(compactReceipt.evaluation as SessionCompact, raw, original, candidate.input_id);
  if (task.stage === "attribution-component") {
    const traceIndex = data.traceIndex!, trace = traceList[traceIndex]!, turn = compact.turns[traceIndex]!;
    const { finalIndex, actors, facts, groups } = turnInvestigation(source, candidate, traceIndex, turn);
    const group = groups.find(group => group.key === data.componentGroup);
    if (!group) throw new Error("组件任务缺少 Compact 调查分组：" + data.componentGroup);
    let finalSources: JsonObject | undefined;
    if (group.delivery) {
      source.traceMaterial ??= new Map();
      let prepared = source.traceMaterial.get(traceIndex);
      if (!prepared) {
        prepared = bindAttributionMaterial({ ...candidate, trace_id: trace.trace_id, question: trace.question, final_index: finalIndex }, original,
          dependencies.criteria?.evaluation as TaskAnalysis | undefined, { ...options, compact: { ...compact, turns: [turn] }, source: { raw, positions, traceIndex } });
        source.traceMaterial.set(traceIndex, prepared);
      }
      finalSources = prepared.modelInput!.answer as JsonObject;
    }
    const material = componentMaterial(raw, original, candidate.input_id, positions, traceIndex, finalIndex, group, turn, facts, finalSources, actors);
    const reference = options.reference === undefined ? candidate.reference : options.reference;
    const modelInput = { ...material.modelInput, ...(reference !== null ? { ground_truth: { available: true, value: reference } } : {}) };
    return { agent: "attribution", profile: "component", request: { sources: { answer: { id: candidate.input_id, value: raw } },
      input: { components: group.members, tool_errors: material.errors, source_positions: positions, trace_index: traceIndex,
        final_message_indices: finalIndex < 0 ? [] : [finalIndex] } }, modelInput,
      projectModelInput(input, bank) {
        const { ground_truth, tool_errors, upstream_error_context, final_claims, ...material } = input;
        return { ...projectEvidenceReferences(material, bank, 400),
          tool_errors: projectCompactEvidence(tool_errors, bank), upstream_error_context: projectCompactEvidence(upstream_error_context, bank),
          ...(final_claims ? { final_claims: projectCompactEvidence(final_claims, bank) } : {}), ...(ground_truth ? { ground_truth } : {}) };
      }, presentedReads: [...presentedMaterialReads({ component_scene: material.modelInput }, "answer", candidate.input_id),
        ...compactPresentedReads(material.modelInput, "answer", candidate.input_id)] };
  }
  if (task.stage === "attribution-trace") {
    const traceIndex = data.traceIndex!, trace = traceList[traceIndex]!, turn = compact.turns[traceIndex]!;
    const results = turnInvestigation(source, candidate, traceIndex, turn).groups.map(group => ({ group, receipt: dependencies[`group:${group.key}`] }));
    const accepted = results.filter(item => item.receipt?.status === "succeeded");
    const problems = accepted.flatMap(item => (item.receipt!.evaluation as { problem: JsonObject[] }).problem);
    const failed = [...new Set(results.filter(item => !item.receipt).flatMap(item => item.group.members.map(member => String(member.name))))];
    const reference = options.reference === undefined ? candidate.reference : options.reference;
    const ground_truth = { available: reference !== null, value: reference };
    return { agent: "attribution", profile: "trace", request: { sources: { answer: { id: candidate.input_id, value: raw } }, input: {
      trace_meta: session.turns?.[traceIndex]?.meta ?? normalizeTraceInput(session, traceIndex).meta ?? {}, ground_truth, problem: problems, failed_components: failed } },
      modelInput: { question: trace.question, ground_truth, final_answer: turn.final_answer,
        component_results: accepted.map(item => ({ components: (item.receipt!.evaluation as JsonObject).components, content: (item.receipt!.evaluation as JsonObject).content })),
        failed_components: failed, merged_problems: problems.map(({ component, label, problem_phenomena, reason, severity }) => ({ component, label, problem_phenomena, reason, severity })) } };
  }
  if (task.stage !== "attribution-session") throw new Error("未知 Attribution 任务阶段：" + task.stage);
  const reviewedTurns = traceList.map((_, index) => dependencies[`trace${index}`]!.evaluation as TraceAttributionResult);
  const sessionMeta = session.session_meta ?? session.meta ?? {};
  if (traceList.length === 1) return { agent: "attribution", profile: "assembly", request: { sources: { answer: { id: candidate.input_id, value: raw } }, input: { session_meta: sessionMeta, turns: reviewedTurns } }, modelInput: {},
    computedResult: { session_meta: sessionMeta, turns: reviewedTurns, session_summary: reviewedTurns[0]!.summary, session_problem: [] } };
  const components = processComponents(raw, original, candidate.input_id, positions, compact.turns.flatMap(turn => turn.components as JsonObject[]));
  const finalMessageIndices: number[] = [];
  const qa = traceList.map((trace, trace_index) => {
    const finalIndex = positions.findIndex(point => point.trace_index === trace_index && point.message_index === (trace.final_index ?? candidate.final_index));
    if (finalIndex >= 0) finalMessageIndices.push(finalIndex);
    const questionIndex = positions.findIndex((point, index) => point.trace_index === trace_index && index < finalIndex &&
      (raw.messages[index]?.role === "user" || raw.messages[index]?.type === "user_question"));
    const question = questionIndex < 0 ? [] : compactFinalMaterial(questionIndex, raw, candidate.input_id, 1600, true).final_evidence;
    const answer = compactFinalMaterial(finalIndex, raw, candidate.input_id, 1600).final_evidence;
    return { trace_index, question, answer, key_data: compact.turns[trace_index]!.key_data,
      read_request: { candidate: "answer", message_index: finalIndex, path: "/content", offset: 0, max_chars: 16000 } };
  });
  const modelInput = { ordered_turns: reviewedTurns.map((turn, index) => ({ trace_index: index, summary: turn.summary,
    problems: turn.problem.map(({ component, label, problem_phenomena, reason }) => ({ component, label, problem_phenomena, reason })) })), qa,
    actor_catalog: components.map(actor => ({ actor_index: actor.component_index, name: actor.name, kind: actor.kind })) };
  return { agent: "attribution", profile: "session", request: { sources: { answer: { id: candidate.input_id, value: raw } }, input: {
    session_meta: sessionMeta, qa, source_positions: positions, turns: reviewedTurns, components,
    final_message_indices: finalMessageIndices } }, modelInput,
    projectModelInput: (input, bank) => ({ ...projectEvidenceReferences({ ...input, qa: undefined }, bank, 400),
      qa: (input.qa as JsonObject[]).map(({ key_data, ...qa }) => ({ ...projectEvidenceReferences(qa, bank, 400), key_data: projectCompactEvidence(key_data, bank) })) }),
    presentedReads: [...presentedMaterialReads({ component_scene: modelInput }, "answer", candidate.input_id), ...compactPresentedReads(modelInput, "answer", candidate.input_id)] };
}

export const attributionScheduling: WorkflowScheduling = {
  sessionAdmission: { id: task => (task.data as AttributionTaskData).candidate.input_id,
    window: manifest => {
      const value = (manifest.config as AttributionConfig).execution.sessionWindow;
      if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error("execution.sessionWindow must be a positive integer");
      return Number(value);
    }, completed: task => task.stage === "attribution-session",
    group: task => (task.data as AttributionTaskData).candidate.version },
  // Compact gates every downstream stage, and a trace or session is always closer to finishing
  // its candidate than the component groups that feed it, so both outrank component work.
  stagePriority: stage => stage === "attribution-compact" ? -2 : ["attribution-trace", "attribution-session"].includes(stage) ? -1
    : stage === "attribution-compact-field" ? 1 : 0,
};
export const attributionWorkflow: WorkflowDefinition = {
  id: "attribution", plan: config => planAttribution(config as AttributionConfig),
  shards: (config, state) => attributionShards(config as AttributionConfig, state),
  release: (state, inputs) => releaseAttribution(state, inputs),
  isComputedTask: task => task.stage === "attribution-compact" || task.stage === "attribution-session" && (task.data as AttributionTaskData).traceCount === 1,
  bind: (task, inputs, dependencies) => bindAttribution(task, inputs, dependencies), observesFailures: task => task.stage !== "attribution-component",
  performanceIdentity(task) {
    const data = task.data as AttributionTaskData;
    return { version: data.candidate.version, batch_id: data.candidate.batch_id, case_id: data.candidate.case_id,
      session_id: data.candidate.session_id ?? null, trace_index: data.traceIndex ?? null,
      compact_field: data.compactField ?? null, component_group: data.componentGroup ?? null,
      attribution_identity: (task.data as JsonObject).attributionIdentity ?? null };
  },
  scheduling: attributionScheduling,
  advance(task, receipt, _state, inputs) {
    if (task.stage === "attribution-compact-field") {
      const data = task.data as AttributionTaskData, source = sourceFor(inputs, data.candidate);
      verifiedCompact((receipt.evaluation as JsonObject).value, source.raw, source.original, data.candidate.input_id);
    }
    if (task.stage === "attribution-compact") return componentFollowups(task, receipt.evaluation as SessionCompact, _state, inputs);
    if (task.stage === "attribution-component" || task.stage === "attribution-session" && (task.data as AttributionTaskData).traceCount! > 1) {
      const data = task.data as AttributionTaskData, source = sourceFor(inputs, data.candidate);
      const visit = (value: unknown, path = ""): unknown => {
        if (Array.isArray(value)) return value.map((child, index) => visit(child, `${path}/${index}`));
        if (!value || typeof value !== "object") return value;
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, key === "evidence" && Array.isArray(child)
          ? child.map((selection, index) => {
            const location = `${path}/evidence/${index}`;
            const reference = resolveEvidenceSelection(receipt.audit.evidenceBank ?? [],
              { evidence_index: typeof selection === "number" ? selection : selection.index }, location);
            return { ...reference, quote: resolveEvidence(source.raw, reference, "answer", receipt.audit, location, data.candidate.input_id).quote };
          }) : visit(child, `${path}/${key}`)]));
      };
      validateOriginalAttributionEvidence(visit(receipt.submitted), { [data.candidate.input_id]: source.original }, receipt.audit, receipt.submitted);
    }
    return { tasks: [] };
  },
  async reconcile(_run, state, current) {
    const config = current as AttributionConfig, manifest = state.manifest;
    manifest.config = { ...manifest.config as AttributionConfig, execution: config.execution, inputs: config.inputs };
    // Pending inputs keep their source coordinates in the checkpoint; resuming re-reads
    // only those rows, never the completed files.
    const catalog = manifest.inputCatalog as Candidate[];
    const previous = indexAttributionTasks(manifest.tasks);
    const acceptedTaskIds = new Set(Object.keys(state.receipts));
    const tasks = catalog.flatMap(candidate => planAttributionUnit(candidate, { previousTasks: previous, acceptedTaskIds }).tasks);
    manifest.tasks = tasks;
    return { tasks, inputs: inputBindings(state)(catalog), catalog, summary: manifest.preflight };
  },
};

/** Captured records may share a conversation; only the same ordered traces share a result identity. */
function attributionResultId(row: JsonObject): string {
  if (row.session_overview) {
    return canonical(["compact", row.session_meta, row.trace_meta]);
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
    const terminals = new Map(tasks.filter(task => task.stage === "attribution-session").map(task => [
      canonical([(task.data as AttributionTaskData).candidate.input_id, (task.data as JsonObject).attributionIdentity]), state.receipts[task.id]?.exported,
    ]));
    return { workflow: "attribution", manifest, inputs: Object.fromEntries((inputCatalog as Candidate[]).map(candidate => [candidate.input_id, candidate])), usage: state.usage, recordedAttempts: state.recordedAttempts,
      tasks: Object.fromEntries(tasks.map(task => { const { id, data, ...definition } = task, info = data as AttributionTaskData, receipt = state.receipts[id]; let saved: any;
        if (receipt) { const { evaluation, submitted: _submitted, exported, ...rest } = receipt;
          const compact = info.compactField && info.compactTaskId && state.receipts[info.compactTaskId]?.exported;
          const attribution = ["attribution-component", "attribution-trace"].includes(task.stage) && terminals.get(
            canonical([info.candidate.input_id, (task.data as JsonObject).attributionIdentity]));
          saved = { ...rest, ...(compact ? { compact: { id: compact.id, file: compact.file, line: compact.line },
            evaluationPatch: difference(compactFieldResult(compact.row, info.compactField!, info.traceIndex), evaluation),
            ...(receipt.submitted !== undefined ? { submittedPatch: difference(evaluation, receipt.submitted) } : {}) }
            : attribution ? { attribution: { id: attribution.id, file: attribution.file, line: attribution.line }, evaluationPatch: difference((attribution.row.turns as unknown[])[info.traceIndex!], evaluation) }
            : exported ? { exported: { id: exported.id, file: exported.file, line: exported.line } } : { evaluation }),
            ...(receipt.submitted !== undefined ? { submittedPatch: difference(evaluation, receipt.submitted) } : {}) }; }
        const { candidate, ...coordinates } = info;
        return [id, { task: definition, data: { ...coordinates, input_id: candidate.input_id }, state: states[id], ...(saved ? { receipt: saved } : {}) }]; })) };
  },
  references(checkpoint, ids) { return Object.entries(checkpoint.tasks).flatMap(([id, row]) => (!ids || ids.has(id))
    ? row.receipt?.compact ? [row.receipt.compact] : row.receipt?.attribution ? [row.receipt.attribution] : row.receipt?.exported ? [resultReference(checkpoint, row)] : [] : []); },
  resultId: attributionResultId,
  decode(checkpoint, read, ids) {
    const tasks: PlannedTask[] = [], receipts: RunState["receipts"] = {}, states: RunManifest["states"] = {};
    for (const [id, row] of Object.entries(checkpoint.tasks)) {
      tasks.push({ id, ...row.task, data: { ...row.data, candidate: checkpoint.inputs[row.data.input_id] } }); states[id] = row.state;
      if (row.receipt && (!ids || ids.has(id))) { const saved = row.receipt, reference = saved.exported ? resultReference(checkpoint, row) : undefined,
        exported = reference ? { ...reference, row: read(reference) } : undefined;
        const { compact, attribution, evaluationPatch, submittedPatch, ...receipt } = saved;
        const evaluation = compact ? restore(compactFieldResult(read(compact), row.data.compactField!, row.data.traceIndex), evaluationPatch) : attribution ? restore((read(attribution).turns as unknown[])[row.data.traceIndex!], evaluationPatch) : saved.evaluation ?? structuredClone(exported!.row);
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
