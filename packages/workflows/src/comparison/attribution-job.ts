import path from "node:path";
import { randomUUID } from "node:crypto";
import { canonical, type PlannedTask, type RunManifest, type TaskPlan, type WorkflowDefinition } from "@eval/contracts";
import { fileSourceReader, locateRun, readJson } from "@eval/data";
import type { Checkpoint } from "./codec.js";
import { adapt, candidateKey, inputSources } from "./input.js";
import { bindTask } from "./binding.js";
import { advanceReview } from "./review.js";
import { attributionRewritePlaceholder, reconcileAttributionRewriteGroups } from "./attribution-rewrite-planning.js";
import type { Candidate, EvalConfig, RawInput, TaskData, VersionConfig } from "./types.js";

export interface AttributionJobConfig extends EvalConfig {
  attributionJob: { runs: string[]; fromBatch?: string };
}
export interface AttributionJobOptions { fromBatch?: string; pilotAnswers?: number }
type IndexedAnswer = { candidate: Candidate; version: VersionConfig; acceptedAt: number; run: string };
const questionKey = (candidate: Candidate) => canonical([candidate.batch_id, candidate.case_id, candidate.question.replace(/\s+/gu, "")]);

/** Read only the selection indices of accepted formal comparisons, never their old judgments. */
async function comparisonAnswers(runs: string[], fromBatch?: string) {
  const answers = new Map<string, IndexedAnswer>();
  let comparisons = 0, duplicates = 0;
  for (const run of runs) {
    const layout = locateRun(run), revision = await fileSourceReader.revision(layout.stateFile);
    const checkpoint = await readJson<Checkpoint>(layout.stateFile);
    if (checkpoint.format !== "evaluation-run" || !checkpoint.inputs || !checkpoint.tasks)
      throw new Error("重归因来源必须有评测任务与输入索引：" + run);
    const formal = new Map<string, { batch_id: string; case_id: string; versions: string[] }>();
    for await (const { line } of fileSourceReader.lines(path.join(layout.results, "comparison.jsonl"))) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as { comparison_id: string; case: { batch_id: string; case_id: string }; models: Record<string, unknown> };
      if (!row.comparison_id || !row.case?.batch_id || !row.case.case_id || !row.models || Object.keys(row.models).length < 2)
        throw new Error("正式对比缺少回答选择索引：" + run);
      if (formal.has(row.comparison_id)) throw new Error("正式对比 ID 重复：" + row.comparison_id);
      formal.set(row.comparison_id, { ...row.case, versions: Object.keys(row.models).sort() });
    }
    const matched = new Set<string>();
    for (const [taskId, task] of Object.entries(checkpoint.tasks)) {
      if (task.stage !== "comparison" || task.data.verificationAudit) continue;
      const id = task.data.comparisonId, row = id && formal.get(id);
      if (!row) continue;
      if (task.status !== "succeeded" || task.receipt?.status !== "succeeded" || task.receipt.taskId !== taskId)
        throw new Error("正式对比缺少已接受任务收据：" + id);
      if (matched.has(id)) throw new Error("多个任务引用同一正式对比：" + id);
      matched.add(id);
      const selected = Object.values(task.inputIds).map(inputId => {
        const saved = checkpoint.inputs[inputId];
        if (!saved) throw new Error("正式对比缺少原始回答索引：" + id);
        const candidate: Candidate = { ...saved, input_id: inputId };
        if (candidate.batch_id !== row.batch_id || candidate.case_id !== row.case_id)
          throw new Error("正式对比与回答业务标识不一致：" + id);
        return candidate;
      });
      if (canonical(selected.map(candidate => candidate.version).sort()) !== canonical(row.versions))
        throw new Error("正式对比与回答模型不一致：" + id);
      if (fromBatch && row.batch_id < fromBatch) continue;
      comparisons++;
      for (const candidate of selected) {
        const version = (checkpoint.config as EvalConfig).inputs.versions.find(item => item.id === candidate.version);
        if (!version) throw new Error("回答缺少输入适配器配置：" + candidate.version);
        const key = candidateKey(candidate), previous = answers.get(key);
        if (previous) duplicates++;
        if (!previous || previous.acceptedAt <= task.receipt.acceptedAt)
          answers.set(key, { candidate, version, acceptedAt: task.receipt.acceptedAt, run });
      }
    }
    if ([...formal.keys()].some(id => !matched.has(id))) throw new Error("正式对比存在未登记任务：" + run);
    if (await fileSourceReader.revision(layout.stateFile) !== revision) throw new Error("读取期间来源运行发生变化：" + run);
  }
  return { answers: [...answers.values()].sort((a, b) => candidateKey(a.candidate).localeCompare(candidateKey(b.candidate))), comparisons, duplicates };
}

/** Resolve all requested answers in one pass per source; byte coordinates stay in memory only. */
export async function loadAttributionJobInputs(
  manifest: Pick<RunManifest, "tasks" | "config" | "inputCatalog">, taskIds?: ReadonlySet<string>,
): Promise<Record<string, unknown>> {
  const config = manifest.config as AttributionJobConfig, inputs: Record<string, unknown> = {};
  const needed = new Set(manifest.tasks.filter(task => !taskIds || taskIds.has(task.id)).flatMap(task => Object.values(task.inputIds)));
  const candidates = (manifest.inputCatalog as Candidate[]).filter(candidate => needed.has(candidate.input_id));
  for (const [file, selected] of inputSources(candidates)) {
    const revision = await fileSourceReader.revision(file), located = new Set<string>();
    const byCase = new Map<string, Candidate[]>();
    for (const candidate of selected) byCase.set(candidate.case_id, [...(byCase.get(candidate.case_id) ?? []), candidate]);
    for await (const { line, index, byteOffset, byteLength } of fileSourceReader.lines(file, revision)) {
      if (!line.trim()) continue;
      const raw = JSON.parse(line) as RawInput;
      const caseId = raw.case_id ?? raw.meta?.case_id;
      if (typeof caseId !== "string") continue;
      for (const candidate of byCase.get(caseId) ?? []) {
        const version = config.inputs.versions.find(item => item.id === candidate.version)!;
        const record = adapt(raw, version, file, index, candidate.batch_id);
        if (candidateKey(record) !== candidateKey(candidate)) continue;
        if (located.has(candidate.input_id)) throw new Error("原始回答业务标识重复：" + candidateKey(candidate));
        if (record.question !== candidate.question || canonical(record.reference) !== canonical(candidate.reference))
          throw new Error("原始问题或标准答案与选择索引不一致：" + candidateKey(candidate));
        candidate.line = index;
        candidate.final_index = record.final_index;
        candidate.answer_timing = record.answer_timing;
        candidate.trace_id = record.trace_id;
        candidate.llm = record.llm;
        located.add(candidate.input_id);
        Object.defineProperty(inputs, candidate.input_id, { enumerable: true, configurable: true,
          get: () => JSON.parse(fileSourceReader.record(file, byteOffset, byteLength, revision)) });
      }
    }
    const missing = selected.filter(candidate => !located.has(candidate.input_id));
    if (missing.length) throw new Error("原始回答未找到：" + missing.map(candidateKey).join("、"));
  }
  return inputs;
}

/** Freeze the complete new plan. Pilot scope counts answers, with their criteria and polish dependencies. */
export async function prepareAttributionJob(
  suppliedRuns: string[], base: EvalConfig, options: AttributionJobOptions = {},
): Promise<{ config: AttributionJobConfig; plan: TaskPlan; executionScope?: string[] }> {
  if (options.fromBatch && !/^\d{4}-\d{2}-\d{2}$/u.test(options.fromBatch)) throw new Error("fromBatch 必须为 YYYY-MM-DD");
  if (options.pilotAnswers !== undefined && (!Number.isInteger(options.pilotAnswers) || options.pilotAnswers < 1))
    throw new Error("pilotAnswers 必须为正整数回答数");
  const runs = [...new Set(suppliedRuns.map(run => path.resolve(run)))].sort();
  if (!runs.length) throw new Error("重归因至少需要一个正式评测来源");
  const inventory = await comparisonAnswers(runs, options.fromBatch);
  if (!inventory.answers.length) throw new Error("选择范围内没有已接受正式对比回答");
  const versions = new Map<string, VersionConfig>();
  for (const { candidate, version } of inventory.answers) {
    const existing = versions.get(version.id);
    if (existing && canonical([existing.name, existing.adapter, existing.timing_unit]) !== canonical([version.name, version.adapter, version.timing_unit]))
      throw new Error("同模型的原始输入配置不一致：" + version.id);
    if (!existing) versions.set(version.id, { ...version, sources: [] });
    const sources = versions.get(version.id)!.sources;
    if (!sources.some(source => source.path === candidate.source)) sources.push({ kind: "file", path: candidate.source });
  }
  const catalog = inventory.answers.map(({ candidate }) => candidate);
  if (new Set(catalog.map(candidate => candidate.input_id)).size !== catalog.length) throw new Error("输入 UUID 对应多个不同回答");
  const config: AttributionJobConfig = { ...base, comparisons: [], inputs: { versions: [...versions.values()] },
    clustering: { ...base.clustering, enabled: false },
    attributionJob: { runs, ...(options.fromBatch ? { fromBatch: options.fromBatch } : {}) } };
  const grouped = new Map<string, Candidate[]>();
  for (const candidate of catalog) grouped.set(questionKey(candidate), [...(grouped.get(questionKey(candidate)) ?? []), candidate]);
  const tasks: PlannedTask[] = [], answerTasks: { candidate: Candidate; task: PlannedTask; standard: boolean }[] = [];
  for (const sameQuestion of grouped.values()) {
    const references = new Map(sameQuestion.filter(candidate => candidate.reference !== null).map(candidate => [canonical(candidate.reference), candidate.reference]));
    const scopes = new Map<string, Candidate[]>();
    for (const candidate of sameQuestion) {
      const reference = references.size === 1 ? references.values().next().value : candidate.reference;
      const key = canonical(reference);
      scopes.set(key, [...(scopes.get(key) ?? []), candidate]);
    }
    for (const scope of scopes.values()) {
      const reference = references.size === 1 ? references.values().next().value : scope[0]!.reference;
      const criteriaScope = randomUUID(), candidates = Object.fromEntries(scope.map((candidate, index) => [String.fromCharCode(65 + index), candidate]));
      const criteria: PlannedTask = { id: randomUUID(), stage: "criteria", dependencies: {},
        inputIds: Object.fromEntries(Object.entries(candidates).map(([label, candidate]) => [label, candidate.input_id])),
        data: { stage: "criteria", candidates, reference, criteriaScope } satisfies TaskData };
      tasks.push(criteria);
      for (const candidate of scope) {
        const attribution: PlannedTask = { id: randomUUID(), stage: "attribution", dependencies: { criteria: criteria.id }, inputIds: { answer: candidate.input_id },
          data: { stage: "attribution", candidates: { A: candidate }, reference, criteriaScope,
            initialContextChars: config.execution.initialContextChars } satisfies TaskData };
        tasks.push(attribution); answerTasks.push({ candidate, task: attribution, standard: reference !== null });
        if (config.rewrite.attribution) tasks.push(attributionRewritePlaceholder(attribution.id, {
          rewriteNames: { A: candidate.name }, case: { batch_id: candidate.batch_id, case_id: candidate.case_id, question: candidate.question },
        }));
      }
    }
  }
  const strata = new Map<string, typeof answerTasks>();
  for (const answer of answerTasks) {
    const key = canonical([answer.candidate.batch_id, answer.candidate.version, answer.standard]);
    strata.set(key, [...(strata.get(key) ?? []), answer]);
  }
  const selected: typeof answerTasks = [];
  const queues = [...strata.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, answers]) => ({ key, answers: [...answers] }));
  const dates = new Map<string, number>(), models = new Map<string, number>(), standards = new Map<boolean, number>(), cases = new Map<string, number>();
  const target = Math.min(options.pilotAnswers ?? answerTasks.length, answerTasks.length);
  while (selected.length < target) {
    const queue = queues.filter(queue => queue.answers.length).sort((a, b) => {
      const first = a.answers[0]!, second = b.answers[0]!;
      return (dates.get(first.candidate.batch_id) ?? 0) - (dates.get(second.candidate.batch_id) ?? 0) ||
        (models.get(first.candidate.version) ?? 0) - (models.get(second.candidate.version) ?? 0) ||
        (standards.get(first.standard) ?? 0) - (standards.get(second.standard) ?? 0) || a.key.localeCompare(b.key);
    })[0]!;
    const caseCount = (answer: typeof answerTasks[number]) => cases.get(canonical([answer.candidate.batch_id, answer.candidate.case_id])) ?? 0;
    const minimum = Math.min(...queue.answers.map(caseCount));
    const eligible = queue.answers.filter(answer => caseCount(answer) === minimum);
    const answer = eligible[Math.floor(eligible.length / 2)]!;
    queue.answers.splice(queue.answers.indexOf(answer), 1);
    selected.push(answer);
    dates.set(answer.candidate.batch_id, (dates.get(answer.candidate.batch_id) ?? 0) + 1);
    models.set(answer.candidate.version, (models.get(answer.candidate.version) ?? 0) + 1);
    standards.set(answer.standard, (standards.get(answer.standard) ?? 0) + 1);
    const caseKey = canonical([answer.candidate.batch_id, answer.candidate.case_id]);
    cases.set(caseKey, (cases.get(caseKey) ?? 0) + 1);
  }
  const selectedIds = new Set(selected.map(answer => answer.task.id));
  selected.forEach(answer => selectedIds.add(answer.task.dependencies.criteria!));
  tasks.filter(task => task.stage === "rewrite" && selectedIds.has(task.dependencies.source!)).forEach(task => selectedIds.add(task.id));
  const executionScope = options.pilotAnswers === undefined ? undefined : tasks.filter(task => selectedIds.has(task.id)).map(task => task.id);
  const summary = { workflow: "attribution-job", source_runs: runs, from_batch: options.fromBatch ?? null,
    source_comparisons: inventory.comparisons, duplicate_answers: inventory.duplicates, attribution_answers: answerTasks.length,
    criteria_tasks: tasks.filter(task => task.stage === "criteria").length, attribution_tasks: answerTasks.length,
    rewrite_tasks: tasks.filter(task => task.stage === "rewrite").length, comparison_tasks: 0, clustering_tasks: 0,
    pilot_answers: options.pilotAnswers === undefined ? null : selected.length,
    selected_answers: selected.map(({ candidate, task, standard }) => ({ batch_id: candidate.batch_id, case_id: candidate.case_id,
      version: candidate.version, input_id: candidate.input_id, task_id: task.id, has_standard_answer: standard, source: { file: candidate.source, line: candidate.line } })),
    selection_method: "按日期、模型、标准答案覆盖均衡选取，避免重复同题；试跑样本不代表全量准确率",
    strata: [...strata.entries()].map(([key, answers]) => ({ key, total: answers.length, selected: answers.filter(answer => selectedIds.has(answer.task.id)).length })) };
  const inputs = await loadAttributionJobInputs({ tasks, config, inputCatalog: catalog }, executionScope ? new Set(executionScope) : undefined);
  // Source rows may have been reordered since the original evaluation. Report the verified coordinates.
  summary.selected_answers.forEach(answer => { answer.source.line = catalog.find(candidate => candidate.input_id === answer.input_id)!.line; });
  return { config, plan: { tasks, inputs, catalog, summary }, ...(executionScope ? { executionScope } : {}) };
}

export const attributionJobWorkflow: WorkflowDefinition = {
  id: "attribution-job",
  plan: async () => { throw new Error("使用 prepareAttributionJob 选择已有正式对比回答"); },
  bind: bindTask,
  advance: advanceReview,
  async reconcile(_run, state, supplied) {
    const saved = state.manifest.config as AttributionJobConfig, current = supplied as EvalConfig;
    if (!saved.attributionJob) throw new Error("该运行不是独立重归因作业");
    state.manifest.config = { ...saved, execution: current.execution };
    reconcileAttributionRewriteGroups(state);
    const inScope = state.manifest.executionScope && new Set(state.manifest.executionScope);
    const pending = new Set(state.manifest.tasks.filter(task => (!inScope || inScope.has(task.id)) && !state.receipts[task.id]).map(task => task.id));
    const inputs = await loadAttributionJobInputs(state.manifest, pending);
    return { tasks: state.manifest.tasks, inputs, catalog: state.manifest.inputCatalog, summary: state.manifest.preflight };
  },
};
