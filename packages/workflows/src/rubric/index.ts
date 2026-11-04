import { randomUUID } from "node:crypto";
import { completedCaseKey, readCompletedCases } from "@eval/data";
import { type AgentBinding, type JsonObject, type PlannedTask, type SubmissionReceipt, type TaskPlan, type WorkflowDefinition } from "@eval/contracts";
import { collectInputs, createInputBindings, normalizeInput, sessionSource, type Candidate, type EvaluationConfig } from "@eval/workflows/inputs";
import type { RubricCaseMaterial, RubricResult, RubricState, RubricVerdict } from "@eval/agents/rubric";
import { buildChecklist, loadRubricStandard } from "./catalog.js";
import { inlineCategory, labelFor, readRubricLabels, resolveCategory, type RubricLabelSource } from "./labels.js";
import { rubricMaterial } from "./material.js";
import { attributionIndex, attributionMaterial, type AttributionLocation } from "./attribution.js";

export interface RubricConfig extends EvaluationConfig {
  workflow: "rubric";
  rubric: {
    standard: string;
    labels: RubricLabelSource;
    batchSize: number;
    /** Accepted attribution is required for the generic checklist. */
    attribution: string;
  };
}

interface RubricTaskData {
  candidate: Candidate;
  traceIndex: number;
  categoryId: string;
  standardPath: string;
  attribution: AttributionLocation;
  group: "generic" | "category";
  itemIndices: number[];
}

const turnsOf = (candidate: Candidate) => candidate.turns?.length ? candidate.turns
  : [{trace_index: 0, trace_id: candidate.trace_id, question: candidate.question, final_index: candidate.final_index}];

/** Generic and category batches never share judge material. */
export async function planRubric(config: RubricConfig): Promise<TaskPlan> {
  const standard = loadRubricStandard(config.rubric.standard);
  const labels = config.rubric.labels.mode === "file" ? readRubricLabels(config.rubric.labels.path, standard) : undefined;
  if (!Number.isSafeInteger(config.rubric.batchSize) || config.rubric.batchSize < 1) throw new Error("rubric.batchSize 必须是正整数");
  const collected = await collectInputs(config);
  if (collected.issues.length) throw new Error("rubric 输入预检失败：" + JSON.stringify(collected.issues));
  const catalog = collected.catalog as Candidate[], inputs = createInputBindings(config)(catalog);
  const completed = await readCompletedCases(config.output.path, config.inputs.versions.map(version => version.id), [], true);
  const attributions = catalog.some(candidate => !completed.has(completedCaseKey("rubric-case", [candidate.version], candidate.batch_id, candidate.case_id)))
    ? await attributionIndex(config.rubric.attribution) : new Map<string, AttributionLocation>();
  const tasks: PlannedTask[] = [];
  let skipped = 0, traces = 0;
  for (const candidate of catalog) {
    if (completed.has(completedCaseKey("rubric-case", [candidate.version], candidate.batch_id, candidate.case_id))) { skipped++; continue; }
    const raw = normalizeInput(inputs[candidate.input_id]);
    const location = attributions.get(candidate.session_id ?? candidate.case_id);
    if (!location) throw new Error(`缺少归因，请先补齐：${candidate.case_id}`);
    const batches: PlannedTask[] = [];
    for (const turn of turnsOf(candidate)) {
      const source = config.rubric.labels;
      const categoryId = source.mode === "file" ? labelFor(labels!, candidate.case_id, turn.trace_index)
        : inlineCategory(standard, raw, turn.trace_index, source.paths);
      if (!categoryId) throw new Error(`缺少有效 L2 标签：${candidate.case_id}#${turn.trace_index}`);
      const category = standard.categories.get(categoryId)!, meta = raw.turns?.[turn.trace_index]?.meta ?? raw.meta;
      if (resolveCategory(standard, meta?.subtask) !== categoryId || ![category.l1, category.l1_name].includes(String(meta?.task)))
        throw new Error(`输入 L1/L2 与标准不一致：${candidate.case_id}#${turn.trace_index}`);
      attributionMaterial(location, candidate, turn.trace_index, category);
      const checklist = buildChecklist(standard, categoryId);
      for (const group of ["generic", "category"] as const) {
        const items = checklist.filter(item => item.source === group);
        for (let start = 0; start < items.length; start += config.rubric.batchSize) {
          const data: RubricTaskData = {candidate, traceIndex: turn.trace_index, categoryId, standardPath: config.rubric.standard,
            attribution: location, group, itemIndices: items.slice(start, start + config.rubric.batchSize).map(item => item.index)};
          batches.push({id: randomUUID(), stage: "rubric-batch", dependencies: {}, inputIds: {answer: candidate.input_id}, data});
        }
      }
      traces++;
    }
    tasks.push(...batches, {id: randomUUID(), stage: "rubric-case",
      dependencies: Object.fromEntries(batches.map((task, index) => [`batch${index}`, task.id])),
      inputIds: {answer: candidate.input_id}, data: batches[0]!.data});
  }
  return {tasks, inputs, catalog, summary: {workflow: "rubric", cases: catalog.length, traces,
    batches: tasks.filter(task => task.stage === "rubric-batch").length, skipped_cases: skipped,
    batch_size: config.rubric.batchSize, label_mode: config.rubric.labels.mode}};
}

function mergeTrace(receipts: SubmissionReceipt[], data: RubricTaskData) {
  const standard = loadRubricStandard(data.standardPath), checklist = buildChecklist(standard, data.categoryId);
  const category = standard.categories.get(data.categoryId)!;
  const verdicts: RubricVerdict[] = receipts.flatMap(receipt => (receipt.evaluation as RubricResult).verdicts)
    .sort((left, right) => left.item_index - right.item_index);
  const counts: Record<RubricState, number> = {pass: 0, partial: 0, fail: 0, na: 0};
  for (const verdict of verdicts) counts[verdict.state] += 1;
  const result: RubricResult = {case_id: data.candidate.case_id, trace_index: data.traceIndex, batch_id: data.candidate.batch_id,
    version: data.candidate.version, category_id: category.id, category_name: category.name, l1_id: category.l1, l1_name: category.l1_name,
    checklist_size: checklist.length, counts, verdicts};
  return {result, category, checklist};
}

export const rubricWorkflow: WorkflowDefinition = {
  id: "rubric",
  plan: config => planRubric(config as RubricConfig),
  isComputedTask: task => task.stage === "rubric-case",
  async reconcile(_run, state, current) {
    const config = current as RubricConfig, manifest = state.manifest;
    manifest.config = config;
    const catalog = manifest.inputCatalog as Candidate[];
    const attributions = await attributionIndex(config.rubric.attribution);
    for (const task of manifest.tasks) {
      const data = task.data as RubricTaskData;
      data.standardPath = config.rubric.standard;
      const location = attributions.get(data.candidate.session_id ?? data.candidate.case_id);
      if (!state.receipts[task.id]) {
        if (!location) throw new Error(`缺少归因，请先补齐：${data.candidate.case_id}`);
        data.attribution = location;
      }
    }
    return {tasks: manifest.tasks, inputs: createInputBindings(config)(catalog), catalog, summary: manifest.preflight};
  },
  bind(task, inputs, dependencies, context): AgentBinding {
    const data = task.data as RubricTaskData, raw = normalizeInput(inputs[data.candidate.input_id]);
    if (task.stage === "rubric-case") {
      const siblings = context.tasks.filter(item => item.stage === "rubric-batch" &&
        (item.data as RubricTaskData).candidate.input_id === data.candidate.input_id);
      const byTask = new Map(Object.values(dependencies).filter((receipt): receipt is SubmissionReceipt => !!receipt).map(receipt => [receipt.taskId, receipt]));
      const traces = turnsOf(data.candidate).map(turn => {
        const items = siblings.filter(task => (task.data as RubricTaskData).traceIndex === turn.trace_index);
        if (!items.length || items.some(item => !byTask.has(item.id))) throw new Error("rubric 合并缺少完整批次");
        return mergeTrace(items.map(item => byTask.get(item.id)!), items[0]!.data as RubricTaskData);
      });
      const counts: Record<RubricState, number> = {pass: 0, partial: 0, fail: 0, na: 0};
      for (const trace of traces) for (const state of Object.keys(counts) as RubricState[]) counts[state] += trace.result.counts[state];
      const material: RubricCaseMaterial = {case_id: data.candidate.case_id, batch_id: data.candidate.batch_id,
        version: data.candidate.version,
        traces: traces.map(trace => ({trace_index: trace.result.trace_index, category: trace.category, checklist: trace.checklist}))};
      return {agent: "rubric", profile: "merge",
        request: {sources: {answer: {id: data.candidate.input_id, value: sessionSource(raw).raw}}, input: material as unknown as JsonObject},
        computedResult: {case_id: data.candidate.case_id, batch_id: data.candidate.batch_id, version: data.candidate.version,
          counts, traces: traces.map(trace => trace.result)}};
    }
    const session = sessionSource(raw), standard = loadRubricStandard(data.standardPath);
    const category = standard.categories.get(data.categoryId)!;
    const checklist = buildChecklist(standard, data.categoryId).filter(item => data.itemIndices.includes(item.index));
    // Preserve original message indices while removing forbidden bodies from tool access.
    const messages = session.raw.messages.map((message, index) => {
      const point = session.positions[index]!;
      if (data.group === "generic") return point.trace_index === data.traceIndex ? message : {};
      const question = message.type === "user_question" || message.role === "user";
      const answer = point.trace_index === data.traceIndex && message.type === "final_answer";
      return point.trace_index <= data.traceIndex && (question || answer) ? message : {};
    });
    const material = rubricMaterial({candidate: data.candidate, traceIndex: data.traceIndex, category, checklist,
      messages, positions: session.positions,
      ...(data.group === "generic" ? {attribution: attributionMaterial(data.attribution, data.candidate, data.traceIndex, category)} : {})});
    return {agent: "rubric", profile: "default", projectModelInput: input => input,
      request: {sources: {answer: {id: data.candidate.input_id, value: {messages}}},
        input: {...material, group: data.group,
          user_context: messages.flatMap((message, index) => message.type === "user_question" || message.role === "user"
            ? [{message_index: index, content: message.content}] : []),
          message_directory: messages.flatMap((message, index) => Object.keys(message).length
            ? [{message_index: index, type: message.type, role: message.role}] : []),
        } as unknown as JsonObject}};
  },
};

export type {RubricTaskData};
export type {RubricLabelSource} from "./labels.js";
export {rubricRepository} from "./repository.js";
