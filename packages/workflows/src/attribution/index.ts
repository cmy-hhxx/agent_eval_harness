import path from "node:path";
import { randomUUID } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import { canonical, projectEvidenceReferences, resolveEvidenceSelection, type AgentBinding, type JsonObject, type PlannedTask, type RunManifest, type RunState, type SubmissionReceipt, type TaskAnalysis, type WorkflowDefinition, type WorkflowScheduling } from "@eval/contracts";
import { cite, messageContentSources, parseEvidenceCoordinates } from "@eval/tools";
import { createRunRepository, readJson, type RunCodec } from "@eval/data";
import { attributionComponentLabel, type ComponentReviewResult, type TraceAttributionResult } from "@eval/agents/attribution";
import { collectInputs, contentText, loadRunInputs, normalizeInput, normalizeTraceInput, type Candidate, type ComponentReviewScope, type EvaluationConfig } from "@eval/workflows/inputs";
import { bindAttributionMaterial, validateOriginalAttributionEvidence } from "@eval/workflows/review";
import problemSchema from "../../../../schemas/attribution/problem.schema.json" with { type: "json" };
import traceResultSchema from "../../../../schemas/attribution/trace-result.schema.json" with { type: "json" };
import sessionResultSchema from "../../../../schemas/attribution/session-result.schema.json" with { type: "json" };

export interface AttributionConfig extends EvaluationConfig { workflow: "attribution" }
export type AttributionStage = "attribution-component" | "attribution-trace" | "attribution-session";
export interface AttributionTaskData {
  stage: AttributionStage; candidate: Candidate; traceIndex?: number; traceCount?: number; component?: string;
  reviewScope?: ComponentReviewScope;
}
export interface AttributionUnitOptions {
  /** Workflow-owned data copied onto every task in this answer's attribution unit. */
  data?: Record<string, unknown>;
  /** Accepted upstream dependencies, such as comparison criteria, shared by every canonical stage. */
  dependencies?: Record<string, string>;
  /** Reuse unfinished task ids while reconciling the same run. */
  previousTasks?: readonly PlannedTask[];
  /** Changes the unit identity when upstream material changes, such as a revised criteria task. */
  identity?: string;
}
const validateSession = new Ajv2020({ allErrors: true, strict: false })
  .addSchema(problemSchema).addSchema(traceResultSchema).compile(sessionResultSchema);

function turns(candidate: Candidate) {
  return candidate.turns ?? [{ trace_index: 0, trace_id: candidate.trace_id, question: candidate.question,
    final_index: candidate.final_index, component_scopes: [] }];
}

function unitTaskKey(candidate: Candidate, stage: AttributionStage, traceIndex?: number, scope?: ComponentReviewScope, identity?: string): string {
  return canonical([candidate.input_id, stage, traceIndex ?? null, scope ?? null, identity ?? null]);
}

/** Build one answer's canonical component -> trace -> session unit. */
export function planAttributionUnit(candidate: Candidate, options: AttributionUnitOptions = {}) {
  // A persisted unit is already the run's recovery boundary. Reuse its complete DAG,
  // including accepted work, rather than expanding it again after a code change.
  const retained = (options.previousTasks ?? []).filter(task => task.stage.startsWith("attribution-") &&
    (task.data as AttributionTaskData).candidate.input_id === candidate.input_id &&
    (task.data as Record<string, unknown>).attributionIdentity === options.identity);
  const retainedSession = retained.find(task => task.stage === "attribution-session");
  if (retainedSession) {
    const tasks = retained.map(task => ({ ...task,
      ...(task.stage === "attribution-session" ? { inputIds: { answer: candidate.input_id } } : {}),
      ...(task.stage === "attribution-trace" ? { settledDependencies: Object.keys(task.dependencies).filter(label => label.startsWith("component")) } : {}),
      data: { ...(task.data as AttributionTaskData), candidate } }));
    return { tasks, session: tasks.find(task => task.id === retainedSession.id)! };
  }
  const traceList = turns(candidate), previous = new Map((options.previousTasks ?? [])
    .filter(task => task.stage.startsWith("attribution-") &&
      (task.data as AttributionTaskData).candidate.input_id === candidate.input_id)
    .map(task => [unitTaskKey((task.data as AttributionTaskData).candidate, task.stage as AttributionStage,
      (task.data as AttributionTaskData).traceIndex, (task.data as AttributionTaskData).reviewScope,
      (task.data as Record<string, unknown>).attributionIdentity as string | undefined), task]));
  const id = (stage: AttributionStage, traceIndex?: number, scope?: ComponentReviewScope) =>
    previous.get(unitTaskKey(candidate, stage, traceIndex, scope, options.identity))?.id ?? randomUUID();
  const base = { ...options.data, ...(options.identity ? { attributionIdentity: options.identity } : {}) },
    upstream = options.dependencies ?? {}, tasks: PlannedTask[] = [], traceTasks: PlannedTask[] = [];
  for (const trace of traceList) {
    const byComponent = new Map<string, ComponentReviewScope>();
    for (const scope of trace.component_scopes) {
      const component = attributionComponentLabel(scope.component), previous = byComponent.get(component);
      if (previous) previous.message_indices.push(...scope.message_indices);
      else byComponent.set(component, { ...scope, component, message_indices: [...scope.message_indices] });
    }
    const scopes = [...byComponent.values()].map(scope => ({ ...scope,
      message_indices: [...new Set(scope.message_indices)].sort((a, b) => a - b) }));
    if (!scopes.some(scope => scope.component === "终稿生成轮")) scopes.push({ component: "终稿生成轮",
      message_indices: [trace.final_index ?? candidate.final_index] });
    const componentTasks = scopes.map(scope => ({ id: id("attribution-component", trace.trace_index, scope),
      stage: "attribution-component", inputIds: { answer: candidate.input_id }, dependencies: upstream,
      data: { ...base, stage: "attribution-component", candidate, traceIndex: trace.trace_index,
        traceCount: traceList.length, component: scope.component, reviewScope: scope } satisfies AttributionTaskData }));
    tasks.push(...componentTasks);
    const traceTask: PlannedTask = { id: id("attribution-trace", trace.trace_index), stage: "attribution-trace",
      settledDependencies: componentTasks.map((_, index) => `component${index}`),
      inputIds: {}, dependencies: { ...upstream,
        ...Object.fromEntries(componentTasks.map((task, index) => [`component${index}`, task.id])) },
      data: { ...base, stage: "attribution-trace", candidate, traceIndex: trace.trace_index,
        traceCount: traceList.length } satisfies AttributionTaskData };
    tasks.push(traceTask); traceTasks.push(traceTask);
  }
  const session: PlannedTask = { id: id("attribution-session"), stage: "attribution-session",
    inputIds: { answer: candidate.input_id }, dependencies: { ...upstream,
      ...Object.fromEntries(traceTasks.map((task, index) => [`trace${index}`, task.id])) },
    data: { ...base, stage: "attribution-session", candidate, traceCount: traceList.length } satisfies AttributionTaskData };
  tasks.push(session);
  return { tasks, session };
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
  const manifest = { config, tasks, inputCatalog: catalog } as RunManifest;
  const inputs = await loadRunInputs(manifest, undefined, undefined, undefined, normalizeInput);
  return { tasks, inputs, catalog, summary: { workflow: "attribution", sessions: catalog.length,
    component_tasks: tasks.filter(task => task.stage === "attribution-component").length,
    trace_tasks: tasks.filter(task => task.stage === "attribution-trace").length,
    session_tasks: tasks.filter(task => task.stage === "attribution-session").length, issues: indexed.issues } };
}

export function bindAttribution(task: PlannedTask, inputs: Record<string, unknown>, dependencies: Record<string, SubmissionReceipt | undefined>,
  options: { reference?: unknown } = {}): AgentBinding {
  const data = task.data as AttributionTaskData;
  const session = normalizeInput(inputs[data.candidate.input_id]), analysis = dependencies.criteria?.status === "succeeded"
    ? dependencies.criteria.evaluation as TaskAnalysis : undefined;
  const traceIndex = data.traceIndex ?? 0, traceRaw = normalizeTraceInput(session, traceIndex), trace = turns(data.candidate)[traceIndex];
  const traceCandidate = trace ? { ...data.candidate, trace_id: trace.trace_id, question: trace.question,
    final_index: trace.final_index ?? data.candidate.final_index } : data.candidate;
  const reference = options.reference === undefined ? traceCandidate.reference : options.reference;
  if (task.stage === "attribution-component") {
    const binding = bindAttributionMaterial(traceCandidate, traceRaw, analysis, { component: data.component, scope: data.reviewScope, reference });
    return { ...binding, request: { ...binding.request, input: { ...binding.request.input, trace_index: traceIndex } },
      modelInput: { ...binding.modelInput!, task_focus: { question: traceCandidate.question,
        review_target: { component: data.component, ...data.reviewScope } } } };
  }

  if (task.stage === "attribution-trace") {
    const unreviewed = Object.entries(task.dependencies).filter(([label]) => label.startsWith("component") && !dependencies[label])
      .map(([, id]) => id);
    const input = {
      ...(analysis ? { task_analysis: analysis } : {}),
      trace_meta: session.turns?.[traceIndex]?.meta ?? traceRaw.meta ?? {}, trace_index: traceIndex,
      ground_truth: { available: reference !== null, value: reference },
      question: traceCandidate.question, answer: contentText(traceRaw.messages[traceCandidate.final_index]?.content),
      review_coverage: { complete: !unreviewed.length, unreviewed_count: unreviewed.length },
      problems: Object.entries(dependencies).filter(([label]) => label.startsWith("component"))
        .flatMap(([, receipt]) => (receipt?.evaluation as ComponentReviewResult | undefined)?.problems ?? [])
        .map((problem, index) => ({ ...problem, problem_id: `p${index + 1}` })) };
    const { trace_meta: _meta, ...modelInput } = input;
    return { agent: "attribution", profile: "trace", request: { sources: {}, input }, modelInput };
  }
  if (task.stage === "attribution-session") {
    const messages: typeof traceRaw.messages = [], qa_positions: { trace_index: number; message_index: number }[] = [];
    const qa = turns(data.candidate).map((trace, trace_index) => {
      const raw = normalizeTraceInput(session, trace_index), final = trace.final_index ?? data.candidate.final_index;
      const question = raw.messages.findLastIndex((message, index) => index < final &&
        (message.role === "user" || message.role === undefined && message.type === "user_question"));
      const evidence = [question, final].flatMap(message_index => {
        const message = raw.messages[message_index]!, sourceIndex = messages.length;
        messages.push(message);
        qa_positions.push({ trace_index, message_index });
        return messageContentSources(message).flatMap(source => {
          const excerpts = [];
          for (let start = 0; start < source.text.length; start += 400) {
            const { evidence_id, quote } = cite(data.candidate.input_id, sourceIndex, source, start, Math.min(start + 400, source.text.length));
            excerpts.push({ quote, reference: { evidence_id } });
          }
          return excerpts;
        });
      });
      return { trace_index, question: contentText(raw.messages[question]!.content), answer: contentText(raw.messages[final]!.content), evidence };
    });
    const input = {
      session_meta: session.session_meta ?? session.meta ?? {},
      qa, qa_positions,
      turns: Object.entries(dependencies).filter(([label]) => label.startsWith("trace"))
        .map(([, receipt]) => receipt!.evaluation as TraceAttributionResult) };
    return { agent: "attribution", profile: "session", request: {
      sources: { answer: { id: data.candidate.input_id, value: { messages } } }, input }, modelInput: { qa },
      projectModelInput: (material, bank) => ({ ...material, qa: (material.qa as typeof qa).map(row => ({ ...row,
        evidence: projectEvidenceReferences(row.evidence, bank, 400) })) }),
      presentedReads: qa.flatMap(row => row.evidence.map(item => {
        const point = parseEvidenceCoordinates(item.reference.evidence_id)!;
        if (point.kind === "image") throw new Error("Session QA evidence must be text");
        return { candidate: "answer", message_index: point.message_index, kind: point.kind, path: point.path, start: point.start, end: point.end };
      })) };
  }
  throw new Error("未知 Attribution 任务阶段：" + task.stage);
}

export const attributionScheduling: WorkflowScheduling = {
  sessionAdmission: {
    id: task => (task.data as AttributionTaskData).candidate.input_id,
    window: manifest => {
      const value = (manifest.config as AttributionConfig | undefined)?.execution?.sessionWindow;
      if (!Number.isSafeInteger(value) || Number(value) < 1)
        throw new Error("execution.sessionWindow must be a positive integer");
      return Number(value);
    },
    completed: task => task.stage === "attribution-session",
  },
  stagePriority: stage => stage === "attribution-session" ? 0 : stage === "attribution-trace" ? 1 : 2,
};

export const attributionWorkflow: WorkflowDefinition = {
  id: "attribution",
  plan: config => planAttribution(config as AttributionConfig),
  bind: (task, inputs, dependencies) => bindAttribution(task, inputs, dependencies),
  observesFailures: () => true,
  scheduling: attributionScheduling,
  advance(task, receipt, _state, inputs) {
    if (task.stage === "attribution-component") {
      const data = task.data as AttributionTaskData, session = inputs[data.candidate.input_id];
      const submitted = receipt.submitted as { problems: { evidence: { index: number }[] }[] };
      const evaluation = receipt.evaluation as ComponentReviewResult;
      // Public results omit internal IDs; recover them from the submitted selections before checking original bytes.
      const evidence = { problems: evaluation.problems.map((problem, i) => ({ evidence: problem.evidence.map((item, j) => ({
        ...item, ...resolveEvidenceSelection(receipt.audit.evidenceBank ?? [],
          { evidence_index: submitted.problems[i].evidence[j].index }, `/problems/${i}/evidence/${j}/index`),
      })) })) };
      validateOriginalAttributionEvidence(evidence, { [data.candidate.input_id]: normalizeTraceInput(session, data.traceIndex ?? 0) }, receipt.audit, receipt.submitted);
    }
    return { tasks: [] };
  },
  async reconcile(_run, state, current) {
    const config = current as AttributionConfig, manifest = state.manifest;
    manifest.config = { ...(manifest.config as AttributionConfig), execution: config.execution, inputs: config.inputs };
    const records = new Map<string, Candidate>();
    const inputs = await loadRunInputs(manifest, undefined, undefined, records, source => normalizeInput(source));
    const catalog = (manifest.inputCatalog as Candidate[]).map(candidate => ({ ...records.get(candidate.input_id)!, input_id: candidate.input_id }));
    for (const task of manifest.tasks) {
      (task.data as AttributionTaskData).candidate = catalog.find(candidate => candidate.input_id === (task.data as AttributionTaskData).candidate.input_id)!;
      if (task.stage === "attribution-trace") task.settledDependencies = Object.keys(task.dependencies).filter(label => label.startsWith("component"));
      if (task.stage === "attribution-session") task.inputIds = { answer: (task.data as AttributionTaskData).candidate.input_id };
    }
    manifest.inputCatalog = catalog;
    return { tasks: manifest.tasks, inputs, catalog, summary: manifest.preflight };
  },
};

/** Captured records may share a conversation; only the same ordered traces share a result identity. */
function attributionResultId(row: JsonObject): string {
  const meta = row.session_meta as JsonObject;
  const traces = (row.turns as { meta: JsonObject }[]).map(turn => turn.meta.trace_id ?? null);
  if (!meta.session_id && !meta.case_id && traces.every(id => id === null))
    throw new Error("Attribution 结果缺少 session、case 或 trace 身份");
  return canonical([meta.session_id ?? meta.case_id ?? null, traces]);
}

interface Checkpoint { workflow: "attribution"; manifest: Omit<RunManifest, "tasks" | "states" | "inputs" | "inputCatalog">; inputs: Record<string, Candidate>; tasks: Record<string, { task: Omit<PlannedTask, "id" | "data">; data: Omit<AttributionTaskData, "candidate"> & { input_id: string }; state: RunManifest["states"][string]; receipt?: any }>; usage: RunState["usage"]; recordedAttempts: number }
function resultReference(checkpoint: Checkpoint, row: Checkpoint["tasks"][string]) {
  const candidate = checkpoint.inputs[row.data.input_id];
  return { ...row.receipt.exported, id: canonical([candidate.session_id ?? candidate.case_id,
    turns(candidate).map(trace => trace.trace_id)]) };
}
const codec: RunCodec<Checkpoint> = {
  encode(state) {
    const { tasks, states, inputs: _inputs, inputCatalog, ...manifest } = state.manifest;
    return { workflow: "attribution", manifest, inputs: Object.fromEntries((inputCatalog as Candidate[]).map(candidate => [candidate.input_id, candidate])), usage: state.usage, recordedAttempts: state.recordedAttempts,
      tasks: Object.fromEntries(tasks.map(task => { const { id, data, ...definition } = task, info = data as AttributionTaskData, receipt = state.receipts[id]; let saved: any;
        if (receipt) { const { evaluation, submitted: _submitted, exported, ...rest } = receipt; saved = { ...rest, ...(exported ? { exported: { id: exported.id, file: exported.file } } : { evaluation }) }; }
        return [id, { task: definition, data: { ...info, input_id: info.candidate.input_id }, state: states[id], ...(saved ? { receipt: saved } : {}) }]; })) };
  },
  references(checkpoint, ids) { return Object.entries(checkpoint.tasks).flatMap(([id, row]) => (!ids || ids.has(id)) && row.receipt?.exported ? [resultReference(checkpoint, row)] : []); },
  resultId: attributionResultId,
  decode(checkpoint, read, ids) {
    const tasks: PlannedTask[] = [], receipts: RunState["receipts"] = {}, states: RunManifest["states"] = {};
    for (const [id, row] of Object.entries(checkpoint.tasks)) {
      tasks.push({ id, ...row.task, data: { ...row.data, candidate: checkpoint.inputs[row.data.input_id] } }); states[id] = row.state;
      if (row.receipt && (!ids || ids.has(id))) { const saved = row.receipt, reference = saved.exported ? resultReference(checkpoint, row) : undefined,
        exported = reference ? { ...reference, row: read(reference) } : undefined;
        receipts[id] = { ...saved, evaluation: saved.evaluation ?? structuredClone(exported!.row), audit: saved.audit ?? { calls: 0, requiredReadCalls: 0, traceReads: [], viewedImages: [], calculations: [], artifacts: [] }, ...(exported ? { exported } : {}) }; }
    }
    return { manifest: { ...checkpoint.manifest, tasks, states,
      inputs: Object.fromEntries(Object.keys(checkpoint.inputs).map(id => [id, { id, name: id }])),
      inputCatalog: Object.values(checkpoint.inputs) }, receipts,
      usage: checkpoint.usage, recordedAttempts: checkpoint.recordedAttempts };
  },
};
const repository = createRunRepository(codec, (task, state) => {
  if (task.stage !== "attribution-session") return null;
  const row = structuredClone(state.receipts[task.id]!.evaluation) as JsonObject;
  if (!validateSession(row)) throw new Error("Attribution session 导出契约无效：" + JSON.stringify(validateSession.errors));
  return { id: attributionResultId(row), file: "attribution.jsonl", row };
}, { appendOnly: true });
export const attributionRepository = { ...repository, createResultWriter(run: string, inputs: Record<string, unknown>) { return repository.createResultWriter(run, inputs); } };

export async function validateAttributionRun(state: RunState) {
  for (const task of state.manifest.tasks) { const receipt = state.receipts[task.id]; if (!receipt) continue;
    if (receipt.taskId !== task.id) throw new Error("Attribution 收据身份不一致");
    if (task.stage !== "attribution-session" && receipt.exported) throw new Error("内部任务不能导出正式行");
    if (task.stage === "attribution-session" && !receipt.exported) throw new Error("session 任务缺少正式导出"); }
  return { valid: true, receipts: Object.keys(state.receipts).length };
}

export async function attributionProgress(run: string) {
  const checkpoint = await readJson<Checkpoint>(path.join(run, "state.json"));
  return Object.entries(checkpoint.tasks).map(([id, task]) => ({ id, stage: task.task.stage,
    inputId: task.data.input_id, status: task.state.status, attempts: task.state.attempts }));
}
