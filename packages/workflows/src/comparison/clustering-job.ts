import path from "node:path";
import { canonical, type PlannedTask, type ProblemObservationRef, type RunRepository, type RunState, type TaskPlan, type WorkflowDefinition } from "@eval/contracts";
import { fileSourceReader, locateRun, problemLibraryFile, readJson, readProblemLibrary, withProblemLibraryLock, writeProblemLibrary, writeJson, atomicWrite } from "@eval/data";
import { applyClustering, countProblemSamples, effectiveProblemOccurrences, emptyLibrary, normalizeLabel, problemSampleKey, projectLibrary, replacePendingObservations, type ClusteringResult } from "@eval/agents/clustering";
import { readRunTasks } from "./run-data.js";
import type { Checkpoint } from "./checkpoint.js";
import { groupObservations, requestItems } from "./observations.js";
import { clusteringSlots } from "./commentary.js";
import { bindRewriteItems } from "./rewrite-presentation.js";
import { clusteringJobStorage } from "./clustering-job-codec.js";
import { allClusteringJobSources, clusteringJobItems, jobBatchIds, jobMaterial, jobObservations, type ClusteringJobConfig, type ClusteringJobMaterial, type ClusteringJobSource, type ClusteringJobTask } from "./clustering-job-types.js";
import { planClusteringTasks, planDeferredRecall } from "./clustering-job-plan.js";
import type { AttributionResult, EvalConfig, TaskData } from "./types.js";
import { recallProblemLibrary } from "./problem-library-recall.js";

export { clusteringJobStorage } from "./clustering-job-codec.js";
export type { ClusteringJobConfig, ClusteringJobSource } from "./clustering-job-types.js";

/** Answer selection is frozen only by scopes containing attribution tasks, not rewrite or audit scopes. */
function clusteringAttributionIds(tasks: Pick<PlannedTask, "id" | "stage" | "inputIds">[], executionScope?: string[], inputIds?: ReadonlySet<string>): string[] {
  const ids = tasks.filter(task => task.stage === "attribution" && (!inputIds || inputIds.has(task.inputIds.answer))).map(task => task.id);
  if (inputIds) return ids;
  const selected = executionScope && new Set(executionScope);
  return selected && ids.some(id => selected.has(id)) ? ids.filter(id => selected.has(id)) : ids;
}

/** Only accepted source receipts are read; no raw answers or source state are copied or changed. */
async function stableSource(run: string, ids?: string[], inputIds?: ReadonlySet<string>) {
  const file = locateRun(run).stateFile, revision = await fileSourceReader.revision(file);
  if (!ids) {
    const checkpoint = await readJson<Checkpoint>(file);
    if (checkpoint.format !== "evaluation-run") throw new Error("聚类来源必须是评测 run：" + run);
    ids = clusteringAttributionIds(Object.entries(checkpoint.tasks).map(([id, task]) => ({ id, stage: task.stage, inputIds: task.inputIds })), checkpoint.executionScope, inputIds);
  }
  const state = await readRunTasks(run, ids);
  if (await fileSourceReader.revision(file) !== revision) throw new Error("读取期间来源 run 发生变化，请重试：" + run);
  return state;
}
export async function readClusteringJobSources(sources: ClusteringJobSource[]) {
  const states = new Map<string, RunState>();
  for (const run of [...new Set(sources.map(source => source.run))].sort())
    states.set(run, await stableSource(run, sources.filter(source => source.run === run).map(source => source.task_id)));
  for (const source of sources) {
    const state = states.get(source.run)!, task = state.manifest.tasks.find(task => task.id === source.task_id);
    const receipt = state.receipts[source.task_id], candidate = (task?.data as TaskData | undefined)?.candidates.A;
    if (state.manifest.runId !== source.run_id || task?.stage !== "attribution" || !receipt ||
      state.manifest.states[task.id].status !== "succeeded" || receipt.submissionId !== source.submission_id ||
      receipt.evaluatorVersion !== source.evaluator_version || candidate?.input_id !== source.input_id ||
      candidate.version !== source.model || candidate.batch_id !== source.batch_id || candidate.case_id !== source.case_id ||
      candidate.source !== source.source.file || candidate.line !== source.source.line)
      throw new Error("聚类作业的原归因引用已缺失或改变：" + source.run + "/" + source.task_id);
  }
  return states;
}
export async function loadClusteringJobInputs(config: ClusteringJobConfig): Promise<Record<string, unknown>> {
  const sources = allClusteringJobSources(config);
  const states = await readClusteringJobSources(sources), inputs: Record<string, unknown> = {};
  const primary = new Set(config.clusteringJob.sources.map(source => source.input_id));
  const recalled = new Set((config.clusteringJob.recall ?? []).map(problemSampleKey));
  for (const ref of config.clusteringJob.recall ?? []) {
    const finding = (states.get(ref.attribution.run)!.receipts[ref.attribution.task_id].evaluation as AttributionResult)
      .findings.find(item => item.finding_id === ref.finding_id);
    if (finding?.type !== "problem" || canonical(finding.problem?.component ?? []) !== canonical(ref.components) ||
        finding.assessment.evidence_status !== ref.evidence_status)
      throw new Error("待观察引用的原发现已缺失或改变：" + ref.input_id + "/" + ref.finding_id);
  }
  for (const model of [...new Set(config.clusteringJob.sources.map(source => source.model))].sort()) {
    const pending: ProblemObservationRef[] = [];
    const observations = groupObservations(sources.filter(source => source.model === model).map(source => {
      const findings = (states.get(source.run)!.receipts[source.task_id].evaluation as AttributionResult).findings
        .filter(finding => primary.has(source.input_id) || recalled.has(problemSampleKey({ input_id: source.input_id, finding_id: finding.finding_id })));
      for (const finding of findings) if (finding.type === "problem") pending.push({ version: model,
        input_id: source.input_id, finding_id: finding.finding_id, batch_id: source.batch_id, case_id: source.case_id,
        source: source.source, attribution: { run: source.run, run_id: source.run_id, task_id: source.task_id,
          submission_id: source.submission_id, evaluator_version: source.evaluator_version },
        components: finding.problem?.component ?? [], evidence_status: finding.assessment.evidence_status,
        importance: finding.importance, summary: finding.text });
      return {
      input_id: source.input_id, case_id: source.case_id, batch_id: source.batch_id, source: source.source,
      attribution: { run: source.run, run_id: source.run_id, task_id: source.task_id,
        submission_id: source.submission_id, evaluator_version: source.evaluator_version },
      findings,
    }; }));
    const library = await readProblemLibrary(problemLibraryFile(config.problemLibrary, model)) ?? emptyLibrary(model);
    if (library.model !== model) throw new Error("问题库模型身份不一致：" + model);
    inputs[model] = { observations, pending, library: await recallProblemLibrary(library, config.output.path), config } satisfies ClusteringJobMaterial;
  }
  return inputs;
}

/** Freeze the latest accepted answer per model/date/case across the explicit source selection. */
export async function prepareClusteringJob(runs: string[], base: EvalConfig, options: { inputIds?: string[]; assignmentOnly?: boolean } = {}): Promise<{ config: ClusteringJobConfig; plan: TaskPlan }> {
  const requested = options.inputIds && new Set(options.inputIds);
  if (requested && (!requested.size || options.inputIds!.some(id => !id.trim()))) throw new Error("聚类输入选择不能为空");
  if (requested && requested.size !== options.inputIds!.length) throw new Error("聚类输入选择包含重复 input_id");
  const directories = [...new Set(runs.map(run => path.resolve(run)))].sort();
  if (!directories.length) throw new Error("聚类作业至少需要一个 --run 来源");
  const latest = new Map<string, { source: ClusteringJobSource; acceptedAt: number }>();
  let excluded = 0, duplicates = 0, outsideScope = 0;
  for (const run of directories) {
    const state = await stableSource(run, undefined, requested), tasks = state.manifest.tasks;
    const selected = new Set(clusteringAttributionIds(tasks, state.manifest.executionScope, requested));
    const pending = tasks.filter(task => task.stage === "attribution" &&
      selected.has(task.id) &&
      ["pending", "running"].includes(state.manifest.states[task.id].status));
    if (pending.length) throw new Error("来源 run 的归因尚未全部结束：" + run);
    const proposals = new Set(tasks.filter(task => (task.data as TaskData).standardConflictReview)
      .map(task => (task.data as TaskData).reviewOf!.taskId));
    for (const task of tasks) {
      if (task.stage !== "attribution" || (!requested && proposals.has(task.id))) continue;
      if (!selected.has(task.id)) { outsideScope++; continue; }
      const receipt = state.receipts[task.id], candidate = (task.data as TaskData).candidates.A;
      if (!receipt || state.manifest.states[task.id].status !== "succeeded") { excluded++; continue; }
      const key = canonical([candidate.version, candidate.batch_id, candidate.case_id]), previous = latest.get(key);
      if (previous) duplicates++;
      if (previous && previous.acceptedAt > receipt.acceptedAt) continue;
      latest.set(key, { acceptedAt: receipt.acceptedAt, source: {
        run, run_id: state.manifest.runId, task_id: task.id, submission_id: receipt.submissionId,
        evaluator_version: receipt.evaluatorVersion, model: candidate.version, batch_id: candidate.batch_id,
        case_id: candidate.case_id, input_id: candidate.input_id, source: { file: candidate.source, line: candidate.line },
      } });
    }
  }
  const sources = [...latest.values()].map(item => item.source).sort((a, b) =>
    canonical([a.model, a.batch_id, a.case_id, a.input_id]).localeCompare(canonical([b.model, b.batch_id, b.case_id, b.input_id])));
  if (requested) {
    const acceptedInputs = new Set(sources.map(source => source.input_id));
    const missing = [...requested].filter(id => !acceptedInputs.has(id));
    if (missing.length) throw new Error("所选输入缺少已接受归因：" + missing.join(", "));
  }
  if (!sources.length) throw new Error("所选 run 没有已接受归因");
  if (new Set(sources.map(source => source.input_id)).size !== sources.length)
    throw new Error("跨 run 输入 UUID 对应多个不同案例，无法聚类");
  const config: ClusteringJobConfig = { ...base, comparisons: [],
    inputs: { versions: [] }, clusteringJob: { runs: directories, sources, ...(options.assignmentOnly ? { assignmentOnly: true } : {}) } };
  const chosen = new Set(sources.map(source => source.input_id));
  const recall: ProblemObservationRef[] = [];
  for (const model of new Set(sources.map(source => source.model))) {
    const library = await readProblemLibrary(problemLibraryFile(base.problemLibrary, model));
    recall.push(...(library?.pending_observations ?? []).filter(ref => ref.components.length && !chosen.has(ref.input_id)));
  }
  config.clusteringJob.recall = recall;
  const inputs = await loadClusteringJobInputs(config), tasks: PlannedTask[] = [];
  for (const model of Object.keys(inputs)) {
    const material = jobMaterial(inputs, model);
    tasks.push(...planClusteringTasks(model, material.observations, config));
  }
  return { config, plan: { tasks, inputs, summary: {
    runs: directories, attribution_answers: sources.length, excluded_attributions: excluded,
    out_of_scope_attributions: outsideScope, duplicate_answers: duplicates,
    recalled_problems: recall.length, recalled_answers: new Set(recall.map(ref => ref.input_id)).size,
    models: Object.fromEntries(Object.keys(inputs).map(model => [model, {
      answers: sources.filter(source => source.model === model).length,
      observations: jobMaterial(inputs, model).observations.length,
      dates: [...new Set(sources.filter(source => source.model === model).map(source => source.batch_id))].sort(),
    }])), clustering_tasks: tasks.filter(task => task.stage === "clustering").length,
    rewrite_tasks: tasks.filter(task => task.stage === "rewrite").length,
  } } };
}

/** Persist accepted decisions before releasing the next shard of the same model. */
async function syncJobLibrary(run: string, state: RunState, inputs: Record<string, unknown>) {
  const config = state.manifest.config as ClusteringJobConfig, stats: Record<string, unknown> = {};
  const models = Object.keys(inputs).sort();
  const writes: (() => Promise<void>)[] = [];
  const apply = async (index: number): Promise<void> => {
    if (index === models.length) {
      for (const write of writes) await write();
      return;
    }
    const model = models[index];
    await withProblemLibraryLock(config.problemLibrary, model, async () => {
      const file = problemLibraryFile(config.problemLibrary, model);
      const saved = await readProblemLibrary(file);
      let library = saved ?? emptyLibrary(model);
      if (library.model !== model) throw new Error("问题库模型身份不一致：" + model);
      const assigned = new Set<string>();
      for (const task of state.manifest.tasks) {
        const data = task.data as ClusteringJobTask, receipt = state.receipts[task.id];
        if (task.stage !== "clustering" || data.model !== model || !receipt) continue;
        const observations = jobObservations(inputs, data);
        if (receipt.exported && canonical(receipt.exported.row.items) !== canonical(clusteringJobItems(observations)))
          throw new Error("原归因与已接受聚类观察不一致：" + task.id);
        const result = receipt.evaluation as ClusteringResult;
        library = applyClustering(library, { run_id: state.manifest.runId, run_path: run,
          evaluator_version: receipt.evaluatorVersion, task_id: task.id, submission_id: receipt.submissionId,
          version: model, batch_id: "", observations, result, replace_assignments: data.reclassify });
        const selected = new Set(result.assignments.filter(item => !item.deferred_reason).map(item => item.item_id));
        for (const ref of observations.filter(item => selected.has(item.id)).flatMap(item => item.refs)) assigned.add(problemSampleKey(ref));
      }
      const projection = projectLibrary(library), classes = projection.components.reduce((sum, component) => sum + component.classes.length, 0);
      if (classes > config.clustering.maxClassesPerModel || projection.components.length > config.clustering.maxComponentsPerModel)
        throw new Error("聚类作业问题库超过类或组件上限：" + model);
      if (state.manifest.tasks.some(task => task.stage === "clustering" &&
          (task.data as ClusteringJobTask).model === model && (task.data as ClusteringJobTask).reclassify && state.receipts[task.id])) {
        const material = jobMaterial(inputs, model), processed = new Set(material.pending.map(problemSampleKey));
        const active = new Set(effectiveProblemOccurrences(library).map(item => canonical([
          item.input_id, item.finding_id, library.classes[item.class_id].component_id])));
        const pending = [...(library.pending_observations ?? []).filter(ref => !processed.has(problemSampleKey(ref))),
          ...material.pending.filter(ref => !ref.components.length || ref.components.some(label => {
            const component = Object.values(library.components).find(item => [item.label, ...item.aliases]
              .some(alias => normalizeLabel(alias) === normalizeLabel(label)));
            return !component || !active.has(canonical([ref.input_id, ref.finding_id, component.id]));
          }))];
        if (canonical(pending) !== canonical(library.pending_observations ?? []))
          library = replacePendingObservations(library, pending, { at: new Date().toISOString(), run });
      }
      writes.push(async () => {
        if (library !== saved && state.manifest.tasks.some(task => task.stage === "clustering" &&
          (task.data as ClusteringJobTask).model === model && state.receipts[task.id])) await writeProblemLibrary(file, library);
        jobMaterial(inputs, model).library = await recallProblemLibrary(library, config.output.path);
      });
      stats[model] = { classes, components: projection.components.length,
        occurrences: countProblemSamples(effectiveProblemOccurrences(library)), assigned: assigned.size };
      await apply(index + 1);
    });
  };
  await apply(0);
  return stats;
}
export const clusteringJobRepository: RunRepository = {
  ...clusteringJobStorage,
  createResultWriter(run, inputs) {
    const write = clusteringJobStorage.createResultWriter(run, inputs);
    let accepted = "";
    return async state => {
      await write(state);
      const current = canonical(state.manifest.tasks.filter(task => task.stage === "clustering" && state.receipts[task.id])
        .map(task => state.receipts[task.id].submissionId));
      if (accepted !== current) { await syncJobLibrary(run, state, inputs); accepted = current; }
    };
  },
};
/** Empty prose needs no Worker call; retain any previous attempts without inventing receipts. */
function excludeEmptyClusteringRewrites(state: RunState) {
  const empty = new Set(state.manifest.tasks.filter(task => {
    if (task.stage !== "rewrite" || state.receipts[task.id]) return false;
    const sourceId = (task.data as ClusteringJobTask).rewriteOf;
    const source = sourceId && state.receipts[sourceId];
    return !!source && clusteringSlots(source.evaluation as ClusteringResult).length === 0;
  }).map(task => task.id));
  if (empty.size) state.manifest.executionScope =
    (state.manifest.executionScope ?? state.manifest.tasks.map(task => task.id)).filter(id => !empty.has(id));
}
export const clusteringJobWorkflow: WorkflowDefinition = {
  id: "clustering-job",
  plan: async () => { throw new Error("使用 prepareClusteringJob 选择来源 run"); },
  async reconcile(run, state, supplied) {
    const saved = state.manifest.config as ClusteringJobConfig, current = supplied as ClusteringJobConfig;
    if (!saved.clusteringJob) throw new Error("该目录不是独立聚类作业");
    // The original source selection and accepted receipts remain authoritative on every resume.
    state.manifest.config = { ...current, clusteringJob: saved.clusteringJob };
    const inputs = await loadClusteringJobInputs(state.manifest.config as ClusteringJobConfig);
    await syncJobLibrary(run, state, inputs);
    excludeEmptyClusteringRewrites(state);
    return { tasks: state.manifest.tasks, inputs, summary: state.manifest.preflight };
  },
  advance(task, _receipt, state, inputs) {
    excludeEmptyClusteringRewrites(state);
    return { tasks: planDeferredRecall(task, state, inputs) };
  },
  bind(task, inputs, dependencies, context) {
    const data = task.data as ClusteringJobTask, material = jobMaterial(inputs, data.model);
    if (task.stage === "rewrite") {
      const source = dependencies.source;
      if (!source) throw new Error("聚类改写缺少已接受结果");
      const input = { kind: "clustering", scope: { batch_ids: jobBatchIds(inputs, data), model: data.model },
        items: clusteringSlots(source.evaluation as ClusteringResult) };
      return bindRewriteItems(input);
    }
    const classes = material.library.components.reduce((sum, component) => sum + component.classes.length, 0);
    const assignmentOnly = !!data.revisit || !!material.config.clusteringJob.assignmentOnly;
    const limits = material.config.clustering;
    const items = jobObservations(inputs, data);
    const known = new Set(material.library.components.flatMap(component => [component.label, ...component.aliases].map(normalizeLabel)));
    const involved = new Set(items.map(item => normalizeLabel(item.component)));
    const library = data.consolidate ? material.library : { components: material.library.components.filter(component =>
      [component.label, ...component.aliases].some(label => involved.has(normalizeLabel(label)))) };
    return { agent: "clustering", profile: "default", request: { sources: {}, input: {
      model: data.model, batch_ids: jobBatchIds(inputs, data),
      library, items: requestItems(items), budget: {
        active_classes: classes, max_classes: limits.maxClassesPerModel,
        max_new_classes: data.consolidate || assignmentOnly ? 0 : Math.min(limits.maxNewClassesPerTask, Math.max(0, limits.maxClassesPerModel - classes)),
        active_components: material.library.components.length, max_components: limits.maxComponentsPerModel,
        max_new_components: Math.min(Math.max(0, limits.maxComponentsPerModel - material.library.components.length),
          new Set(items.map(item => normalizeLabel(item.component)).filter(component => !known.has(component))).size),
        consolidate: !assignmentOnly && (!!data.consolidate || classes >= limits.consolidateAt ||
          !context.tasks.some(next => next.stage === "clustering" && next.dependencies.previous === task.id)),
        ...(assignmentOnly ? { assignment_only: true } : {}),
        min_support: limits.minSupport,
      },
    } } };
  },
};
export async function reportClusteringJob(run: string) {
  const state = await clusteringJobRepository.readRun(run), config = state.manifest.config as ClusteringJobConfig;
  const inputs = await loadClusteringJobInputs(config), library = await syncJobLibrary(run, state, inputs);
  const stages: Record<string, Record<string, number>> = {};
  for (const task of state.manifest.tasks) {
    const counts = stages[task.stage] ??= {}, status = state.manifest.states[task.id].status;
    counts[status] = (counts[status] ?? 0) + 1;
  }
  const result = { run_id: state.manifest.runId, workflow: "clustering-job", status: state.manifest.status,
    source_runs: config.clusteringJob.runs, stages, problem_library: library, usage: state.usage };
  const layout = locateRun(run);
  await writeJson(layout.stats, result);
  await atomicWrite(layout.report, `# 聚类作业 ${state.manifest.runId}\n\n` +
    `来源：${config.clusteringJob.runs.join("、")}\n\n` +
    Object.entries(stages).map(([stage, counts]) => `${stage}：${Object.entries(counts).map(([status, n]) => `${status} ${n}`).join("，")}`).join("\n\n") + "\n");
  return result;
}
