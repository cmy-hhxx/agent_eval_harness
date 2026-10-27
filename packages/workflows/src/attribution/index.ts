import path from "node:path";
import { randomUUID } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import { canonical, resolveEvidenceSelection, type AgentBinding, type JsonObject, type PlannedTask, type RunManifest, type RunState, type SubmissionReceipt, type TaskAnalysis, type WorkflowDefinition, type WorkflowScheduling } from "@eval/contracts";
import { createRunRepository, readJson, type RunCodec } from "@eval/data";
import { attributionComponentLabel, type ComponentReviewResult, type TraceAttributionResult } from "@eval/agents/attribution";
import { collectInputs, contentText, loadRunInputs, normalizeInput, normalizeTraceInput, type Candidate, type EvaluationConfig } from "@eval/workflows/inputs";
import { bindAttributionMaterial, validateOriginalAttributionEvidence } from "@eval/workflows/review";
import problemSchema from "../../../../schemas/attribution/problem.schema.json" with { type: "json" };
import traceResultSchema from "../../../../schemas/attribution/trace-result.schema.json" with { type: "json" };
import sessionResultSchema from "../../../../schemas/attribution/session-result.schema.json" with { type: "json" };

export interface AttributionConfig extends EvaluationConfig { workflow: "attribution" }
export type AttributionStage = "attribution-component" | "attribution-trace" | "attribution-session";
export interface AttributionTaskData {
  stage: AttributionStage; candidate: Candidate; traceIndex?: number; traceCount?: number; component?: string;
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
    final_index: candidate.final_index, component_names: [] }];
}

function unitTaskKey(candidate: Candidate, stage: AttributionStage, traceIndex?: number, component?: string, identity?: string): string {
  return canonical([candidate.input_id, stage, traceIndex ?? null, component ?? null, identity ?? null]);
}

/** Build one answer's canonical component -> trace -> session unit. */
export function planAttributionUnit(candidate: Candidate, options: AttributionUnitOptions = {}) {
  const traceList = turns(candidate), previous = new Map((options.previousTasks ?? [])
    .filter(task => task.stage.startsWith("attribution-"))
    .map(task => [unitTaskKey((task.data as AttributionTaskData).candidate, task.stage as AttributionStage,
      (task.data as AttributionTaskData).traceIndex, (task.data as AttributionTaskData).component,
      (task.data as Record<string, unknown>).attributionIdentity as string | undefined), task]));
  const id = (stage: AttributionStage, traceIndex?: number, component?: string) =>
    previous.get(unitTaskKey(candidate, stage, traceIndex, component, options.identity))?.id ?? randomUUID();
  const base = { ...options.data, ...(options.identity ? { attributionIdentity: options.identity } : {}) },
    upstream = options.dependencies ?? {}, tasks: PlannedTask[] = [], traceTasks: PlannedTask[] = [];
  for (const trace of traceList) {
    const components = [...new Set([...trace.component_names.map(attributionComponentLabel), "终稿生成轮"].filter(Boolean))];
    const componentTasks = components.map(component => ({ id: id("attribution-component", trace.trace_index, component),
      stage: "attribution-component", inputIds: { answer: candidate.input_id }, dependencies: upstream,
      data: { ...base, stage: "attribution-component", candidate, traceIndex: trace.trace_index,
        traceCount: traceList.length, component } satisfies AttributionTaskData }));
    tasks.push(...componentTasks);
    const traceTask: PlannedTask = { id: id("attribution-trace", trace.trace_index), stage: "attribution-trace",
      inputIds: {}, dependencies: { ...upstream,
        ...Object.fromEntries(componentTasks.map((task, index) => [`component${index}`, task.id])) },
      data: { ...base, stage: "attribution-trace", candidate, traceIndex: trace.trace_index,
        traceCount: traceList.length } satisfies AttributionTaskData };
    tasks.push(traceTask); traceTasks.push(traceTask);
  }
  const session: PlannedTask = { id: id("attribution-session"), stage: "attribution-session",
    inputIds: {}, dependencies: { ...upstream,
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

export function bindAttribution(task: PlannedTask, inputs: Record<string, unknown>, dependencies: Record<string, SubmissionReceipt | undefined>): AgentBinding {
  const data = task.data as AttributionTaskData;
  const session = normalizeInput(inputs[data.candidate.input_id]), analysis = dependencies.criteria?.status === "succeeded"
    ? dependencies.criteria.evaluation as TaskAnalysis : undefined;
  const traceIndex = data.traceIndex ?? 0, traceRaw = normalizeTraceInput(session, traceIndex), trace = turns(data.candidate)[traceIndex];
  const traceCandidate = trace ? { ...data.candidate, trace_id: trace.trace_id, question: trace.question,
    final_index: trace.final_index ?? data.candidate.final_index } : data.candidate;
  if (task.stage === "attribution-component") {
    const binding = bindAttributionMaterial(traceCandidate, traceRaw, analysis, { component: data.component });
    const navigation = binding.materialNavigation!.answer as { responsibility_choices: {
      component: string; kind: string; message_index: number | null; transition_index: number;
    }[] };
    const choices = navigation.responsibility_choices.filter(choice => choice.component === data.component);
    const entrypoints = choices.slice(0, 8).map(choice => ({ component: choice.component, kind: choice.kind, message_index: choice.message_index,
        read_request: { tool: "read_responsibility_chain", arguments: { candidate: "answer", transition_index: choice.transition_index } } }));
    return { ...binding, profile: "component", request: { ...binding.request, input: { ...binding.request.input,
      component: data.component, trace_index: traceIndex } }, modelInput: { ...(binding.modelInput ?? binding.request.input),
      component: data.component, trace_index: traceIndex, component_entrypoints: entrypoints,
      component_entrypoints_total: choices.length } };
  }
  if (task.stage === "attribution-trace") {
    return { agent: "attribution", profile: "trace", request: { sources: {}, input: {
      ...(analysis ? { task_analysis: analysis } : {}),
      trace_meta: session.turns?.[traceIndex]?.meta ?? traceRaw.meta ?? {}, trace_index: traceIndex,
      question: traceCandidate.question, answer: contentText(traceRaw.messages[traceCandidate.final_index]?.content),
      problems: Object.entries(dependencies).filter(([label]) => label.startsWith("component"))
        .flatMap(([, receipt]) => (receipt?.evaluation as ComponentReviewResult | undefined)?.problems ?? []) } } };
  }
  if (task.stage === "attribution-session") {
    return { agent: "attribution", profile: "session", request: { sources: {}, input: {
      ...(analysis ? { task_analysis: analysis } : {}),
      session_meta: session.session_meta ?? session.meta ?? {},
      qa: turns(data.candidate).map((trace, index) => ({ trace_index: index, question: trace.question,
        answer: contentText(normalizeTraceInput(session, index).messages[trace.final_index ?? 0]?.content) })),
      turns: Object.entries(dependencies).filter(([label]) => label.startsWith("trace"))
        .map(([, receipt]) => receipt!.evaluation as TraceAttributionResult) } } };
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
  bind: bindAttribution,
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
    for (const task of manifest.tasks) (task.data as AttributionTaskData).candidate = catalog.find(candidate => candidate.input_id === (task.data as AttributionTaskData).candidate.input_id)!;
    manifest.inputCatalog = catalog;
    return { tasks: manifest.tasks, inputs, catalog, summary: manifest.preflight };
  },
};

interface Checkpoint { workflow: "attribution"; manifest: Omit<RunManifest, "tasks" | "states" | "inputs" | "inputCatalog">; inputs: Record<string, Candidate>; tasks: Record<string, { task: Omit<PlannedTask, "id" | "data">; data: Omit<AttributionTaskData, "candidate"> & { input_id: string }; state: RunManifest["states"][string]; receipt?: any }>; usage: RunState["usage"]; recordedAttempts: number }
const codec: RunCodec<Checkpoint> = {
  encode(state) {
    const { tasks, states, inputs: _inputs, inputCatalog, ...manifest } = state.manifest;
    return { workflow: "attribution", manifest, inputs: Object.fromEntries((inputCatalog as Candidate[]).map(candidate => [candidate.input_id, candidate])), usage: state.usage, recordedAttempts: state.recordedAttempts,
      tasks: Object.fromEntries(tasks.map(task => { const { id, data, ...definition } = task, info = data as AttributionTaskData, receipt = state.receipts[id]; let saved: any;
        if (receipt) { const { evaluation, submitted: _submitted, exported, ...rest } = receipt; saved = { ...rest, ...(exported ? { exported: { id: exported.id, file: exported.file } } : { evaluation }) }; }
        return [id, { task: definition, data: { ...info, input_id: info.candidate.input_id }, state: states[id], ...(saved ? { receipt: saved } : {}) }]; })) };
  },
  references(checkpoint, ids) { return Object.entries(checkpoint.tasks).flatMap(([id, row]) => (!ids || ids.has(id)) && row.receipt?.exported ? [row.receipt.exported] : []); },
  resultId: row => String((row.session_meta as JsonObject).session_id ?? (row.session_meta as JsonObject).case_id),
  decode(checkpoint, read, ids) {
    const tasks: PlannedTask[] = [], receipts: RunState["receipts"] = {}, states: RunManifest["states"] = {};
    for (const [id, row] of Object.entries(checkpoint.tasks)) {
      tasks.push({ id, ...row.task, data: { ...row.data, candidate: checkpoint.inputs[row.data.input_id] } }); states[id] = row.state;
      if (row.receipt && (!ids || ids.has(id))) { const saved = row.receipt, exported = saved.exported ? { ...saved.exported, row: read(saved.exported) } : undefined;
        receipts[id] = { ...saved, evaluation: saved.evaluation ?? structuredClone(exported!.row), audit: saved.audit ?? { calls: 0, requiredReadCalls: 0, traceReads: [], viewedImages: [], calculations: [], artifacts: [] }, ...(exported ? { exported } : {}) }; }
    }
    return { manifest: { ...checkpoint.manifest, tasks, states, inputs: {}, inputCatalog: Object.values(checkpoint.inputs) }, receipts,
      usage: checkpoint.usage, recordedAttempts: checkpoint.recordedAttempts };
  },
};
const repository = createRunRepository(codec, (task, state) => {
  if (task.stage !== "attribution-session") return null;
  const row = structuredClone(state.receipts[task.id]!.evaluation) as JsonObject;
  if (!validateSession(row)) throw new Error("Attribution session 导出契约无效：" + JSON.stringify(validateSession.errors));
  return { id: String((row.session_meta as JsonObject).session_id ?? (task.data as AttributionTaskData).candidate.case_id), file: "attribution.jsonl", row };
});
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
