import { randomUUID } from "node:crypto";
import {
  errorText,
  ValidationError,
  type RunManifest,
  type RunState,
  type TaskPlan,
  type ValidationIssue,
} from "@eval/contracts";
import { createRunRepository, fileSourceReader } from "@eval/data";
import { adapt, buildPlan, candidateKey, inputSources, locateRecordStream, selectComparisonGroups, taskCase, taskIdentity } from "./input.js";
import type { BatchPreflight, Candidate, ComparisonResult, EvalConfig, TaskData } from "./types.js";
import { comparisonCodec } from "./codec.js";
import { normalizeInput } from "./input-record.js";
import { encodeResult, stageResult } from "./results.js";
import { comparisonSlots } from "./commentary.js";
import { reconcileAttributionRewriteGroups } from "./attribution-rewrite-planning.js";
import { pendingTaskProgress } from "./task-progress.js";
import { configureStandardReview } from "./review.js";
export const comparisonRepository = createRunRepository(comparisonCodec, encodeResult);
export const { readRun: readRunState, writeRun: writeRunState, createResultWriter, readTasks: readRunTasks } =
  comparisonRepository;

export async function loadRunInputs(
  manifest: RunManifest,
  issues?: ValidationIssue[],
  taskIds?: ReadonlySet<string>,
  records?: Map<string, Candidate>,
): Promise<Record<string, unknown>> {
  const inputs: Record<string, unknown> = {},
    errors: ValidationIssue[] = [];
  const config = manifest.config as EvalConfig;
  const inputIds = taskIds && new Set(manifest.tasks.filter((task) => taskIds.has(task.id)).flatMap((task) => Object.values(task.inputIds)));
  const sources = inputSources((manifest.inputCatalog as Candidate[]).filter((candidate) => !inputIds || inputIds.has(candidate.input_id)));
  for (const [source, candidates] of sources) {
    const found: Record<string, unknown> = {};
    let revision: string;
    const register = (candidate: Candidate, record: Candidate, byteOffset: number, byteLength: number) => {
      records?.set(candidate.input_id, record);
      Object.defineProperty(found, candidate.input_id, {
        enumerable: true,
        configurable: true,
        get: () => normalizeInput(JSON.parse(fileSourceReader.record(source, byteOffset, byteLength, revision))),
      });
    };
    try {
      revision = await fileSourceReader.revision(source);
      const byLine = new Map<number, Candidate[]>();
      for (const candidate of candidates)
        byLine.set(candidate.line, [...(byLine.get(candidate.line) || []), candidate]);
      for await (const { line, index, byteOffset, byteLength } of fileSourceReader.lines(source, revision)) {
        const registered = byLine.get(index);
        if (!registered) continue;
        for (const candidate of registered) {
          try {
            const version = config.inputs.versions.find((item) => item.id === candidate.version);
            if (!version) throw new Error("Input version is not registered");
            const raw = JSON.parse(line);
            const record = adapt(raw, version, source, index, config.inputs.default_batch_id);
            if (candidateKey(record) === candidateKey(candidate)) register(candidate, record, byteOffset, byteLength);
          } catch { /* Reordered or missing records are resolved by business identity below. */ }
        }
        byLine.delete(index);
        if (!byLine.size) break;
      }
      if (await fileSourceReader.revision(source) !== revision)
        throw new Error("读取期间输入文件发生变化，请重试：" + source);
    } catch (error) {
      errors.push({
        category: "file",
        code: "input_source_unavailable",
        path: source,
        expected: "可读取的原始输入文件",
        actual: null,
        message: errorText(error),
      });
      continue;
    }
    for (const candidate of candidates) {
      try {
        const version = config.inputs.versions.find((version) => version.id === candidate.version);
        if (!version) throw new Error("Input version is not registered");
        if (!Object.hasOwn(found, candidate.input_id)) {
          const { record, byteOffset, byteLength } = await locateRecordStream(source, candidate, version, config.inputs.default_batch_id);
          register(candidate, record, byteOffset, byteLength);
        }
      } catch (error) {
        errors.push({
          category: "file",
          code: "input_source_unavailable",
          path: source,
          expected: candidate.input_id,
          actual: null,
          message: errorText(error),
        });
      }
    }
    if (await fileSourceReader.revision(source).catch(() => null) !== revision) {
      errors.push({ category: "file", code: "input_source_changed", path: source,
        message: "读取期间输入文件发生变化，请重试：" + source });
    } else Object.defineProperties(inputs, Object.getOwnPropertyDescriptors(found));
  }
  if (issues) issues.push(...errors);
  else if (errors.length) throw new ValidationError(errors);
  return inputs;
}
export async function reconcileRun(_run: string, state: RunState, current: unknown,
  options?: { extendVersions: boolean; preserveCompletedResults?: boolean }): Promise<TaskPlan> {
  const config = state.manifest.config as EvalConfig,
    supplied = current as EvalConfig;
  configureStandardReview(state, supplied.standardAnswerReview === true);
  if (state.manifest.executionScope) {
    state.manifest.config = { ...config, execution: supplied.execution, standardAnswerReview: supplied.standardAnswerReview === true };
    reconcileAttributionRewriteGroups(state, options?.preserveCompletedResults);
    const pending = new Set(state.manifest.executionScope!.filter((id) => !state.receipts[id]));
    return { tasks: state.manifest.tasks, inputs: await loadRunInputs(state.manifest, undefined, pending),
      catalog: state.manifest.inputCatalog, summary: state.manifest.preflight };
  }
  const versions = [...config.inputs.versions, ...(options?.extendVersions ? supplied.inputs.versions.filter((version) =>
    !config.inputs.versions.some((existing) => existing.id === version.id)) : [])];
  const selected: EvalConfig = {
    ...config,
    execution: supplied.execution,
    reviewQuestions: supplied.reviewQuestions,
    prediction: supplied.prediction,
    standardAnswerReview: supplied.standardAnswerReview === true,
    // Automation explicitly extends a daily run's model selection; normal resume retains its selection.
    comparisons: selectComparisonGroups(supplied.comparisons, versions.map((version) => version.id)),
    // Presentation and library stages may be enabled or disabled on resume without touching evaluations.
    rewrite: supplied.rewrite,
    clustering: supplied.clustering,
    inputs: {
      ...config.inputs,
      ...(supplied.prediction ? { case_ids: supplied.inputs.case_ids } : {}),
      versions: versions.map((v) => ({
        ...v,
        sources: config.inputs.dataset_id && supplied.inputs.dataset_id !== config.inputs.dataset_id
          ? v.sources
          : supplied.inputs.versions.find((item) => item.id === v.id)?.sources || v.sources,
      })),
    },
  };
  const previous = state.manifest.tasks;
  const plan = await buildPlan(selected, {
    tasks: previous,
    inputs: {},
    summary: state.manifest.preflight,
    catalog: state.manifest.inputCatalog,
  }, { acceptedTaskIds: new Set(Object.keys(state.receipts)) });
  const tasks = new Map(plan.tasks.map((task) => [task.id, task]));
  // Accepted work is immutable within a run. Only unfinished/new tasks use the latest source records.
  for (const task of previous) {
    if (task.stage === "rewrite" && !state.receipts[task.id]) {
      const target = (task.data as TaskData).rewriteOf!.stage;
      if (!selected.rewrite[target]) continue;
    }
    if (task.stage === "clustering" && !state.receipts[task.id] && !selected.clustering.enabled) continue;
    if (task.stage === "rewrite" || state.receipts[task.id] || !tasks.has(task.id) || (task.data as TaskData).reviewOf ||
      Object.values(task.dependencies).some((id) =>
        previous.some((item) => item.id === id && !!(item.data as TaskData).reviewOf))) tasks.set(task.id, task);
  }
  // Pending polish alone must not keep an obsolete, unaccepted attribution alive after expansion.
  const dependencies = new Set([...tasks.values()].filter(task => task.stage !== "rewrite")
    .flatMap((task) => Object.values(task.dependencies)));
  // Pending standard reviews still need their original task and paid progress if the opt-in is disabled.
  for (const task of tasks.values()) {
    const data = task.data as TaskData;
    if (data.standardConflictReview && data.reviewOf && !state.receipts[task.id]) dependencies.add(data.reviewOf.taskId);
  }
  for (const task of tasks.values()) if (task.stage === "attribution" && !state.receipts[task.id])
    (task.data as TaskData).standardAnswerReview = selected.standardAnswerReview === true;
  for (const [id, task] of tasks)
    if (task.stage === "attribution" && !dependencies.has(id) && !state.receipts[id] &&
      !(task.data as TaskData).standardConflictReview) tasks.delete(id);
  // Unfinished tasks whose source records are no longer available are dropped with a diagnostic
  // instead of aborting the run; accepted work is never affected.
  const issues = [...((plan.summary.issues as unknown[]) || [])];
  for (const [id, task] of tasks) {
    if (state.receipts[id]) continue;
    if (task.stage === "rewrite" || task.stage === "clustering") continue;
    const missing = Object.values(task.inputIds).find((inputId) => !Object.hasOwn(plan.inputs, inputId));
    if (!missing) continue;
    tasks.delete(id);
    issues.push({
      batch_id: taskCase(task.data as TaskData).batch_id,
      case_id: taskCase(task.data as TaskData).case_id,
      stage: task.stage,
      reason: "input_source_unavailable",
      input_id: missing,
    });
  }
  // A rewrite task whose source task is no longer planned and that never finished has nothing to polish.
  for (const [id, task] of tasks) {
    if (task.stage !== "rewrite" || state.receipts[id]) continue;
    if (!tasks.has((task.data as TaskData).rewriteOf!.taskId)) tasks.delete(id);
  }
  // A clustering task with missing attribution dependencies has nothing to classify.
  for (const [id, task] of tasks) {
    if (task.stage !== "clustering" || state.receipts[id]) continue;
    if (Object.values(task.dependencies).some((taskId) => !tasks.has(taskId))) tasks.delete(id);
  }
  const requiredCriteria = new Set([...tasks.values()].flatMap(task => Object.values(task.dependencies)));
  for (const [id, task] of tasks)
    if (task.stage === "criteria" && !state.receipts[id] && !requiredCriteria.has(id)) tasks.delete(id);
  plan.tasks = [...tasks.values()];
  plan.summary.issues = issues;
  plan.summary.attribution_tasks = plan.tasks.filter((task) => task.stage === "attribution").length;
  plan.summary.criteria_tasks = plan.tasks.filter((task) => task.stage === "criteria").length;
  plan.summary.comparison_tasks = plan.tasks.filter((task) => task.stage === "comparison" && !(task.data as TaskData).verificationAudit).length;
  plan.summary.comparison_verification_tasks = plan.tasks.filter(task => !!(task.data as TaskData).verificationAudit).length;
  plan.summary.rewrite_tasks = plan.tasks.filter((task) => task.stage === "rewrite").length;
  plan.summary.clustering_tasks = plan.tasks.filter((task) => task.stage === "clustering").length;
  for (const [batch, counts] of Object.entries(plan.summary.by_batch as Record<string, BatchPreflight>)) {
    const selected = plan.tasks.filter((task) => taskIdentity(task.data as TaskData).batch_id === batch);
    counts.attribution_tasks = selected.filter((task) => task.stage === "attribution").length;
    counts.comparison_verification_tasks = selected.filter(task => !!(task.data as TaskData).verificationAudit).length;
    counts.comparison_tasks = selected.filter((task) => task.stage === "comparison" && !(task.data as TaskData).verificationAudit).length;
  }
  const catalog = new Map((plan.catalog as Candidate[]).map((c) => [c.input_id, c]));
  for (const task of plan.tasks)
    for (const c of Object.values((task.data as TaskData).candidates)) catalog.set(c.input_id, c);
  // Unused new revisions of completed inputs need no persistent registration.
  const used = new Set(plan.tasks.flatMap((t) => Object.values(t.inputIds)));
  const represented = new Set([...used].map((id) => candidateKey(catalog.get(id)!)));
  plan.catalog = [...catalog.values()].filter(
    (c) => used.has(c.input_id) || !represented.has(candidateKey(c)),
  );
  for (const task of plan.tasks) {
    const revision = (task.data as TaskData).revision || 1,
      old = state.manifest.states[task.id];
    if (!state.receipts[task.id] && (!old || (old.revision || 1) !== revision))
      state.manifest.states[task.id] = {
        ...pendingTaskProgress(old, true),
        revision,
      };
  }
  state.manifest.config = selected;
  state.manifest.tasks = plan.tasks;
  if (selected.rewrite.comparison && selected.rewrite.comparisonItems) {
    const bySource = new Map<string, typeof plan.tasks>();
    for (const task of plan.tasks) {
      const data = task.data as TaskData;
      if (data.rewriteOf?.stage !== "comparison") continue;
      const id = data.rewriteOf.taskId;
      if ((tasks.get(id)?.data as TaskData | undefined)?.verificationAudit) continue;
      bySource.set(id, [...(bySource.get(id) ?? []), task]);
    }
    for (const [sourceId, rewrites] of bySource) {
      const source = state.receipts[sourceId];
      if (!source) continue;
      // Incremental automation keeps the exact presentation already accepted for a finished result.
      if (options?.preserveCompletedResults && rewrites.every(task => state.receipts[task.id])) continue;
      const stored = source.exported && stageResult("comparison", source.exported.row).rewritten as
        { rewrites: { id: string; text: string }[] } | undefined;
      const filled = new Set(stored?.rewrites.filter((item) => item.text.trim()).map((item) => item.id));
      const missing = comparisonSlots(source.evaluation as ComparisonResult, "all").filter((item) => !filled.has(item.id));
      const claimed = new Set(rewrites.filter(task => !state.receipts[task.id]).flatMap(task => {
        const data = task.data as TaskData;
        return data.rewriteSlotIds ?? comparisonSlots(source.evaluation as ComparisonResult,
          data.comparisonRewriteScope ?? "verdicts").map(item => item.id);
      }));
      const slots = missing.filter(item => !claimed.has(item.id)).map(item => item.id);
      if (!slots.length) continue;
      // Accepted text work stays immutable; filling other slots is a distinct task.
      const template = rewrites[0], data = template.data as TaskData;
      const supplemental = { id: randomUUID(), stage: "rewrite", inputIds: {}, dependencies: { source: sourceId },
        data: { stage: "rewrite", candidates: {}, reference: null, rewriteOf: data.rewriteOf,
          case: data.case, rewriteNames: data.rewriteNames, comparisonRewriteScope: "all", rewriteSlotIds: slots,
        } satisfies TaskData };
      plan.tasks.push(supplemental);
      state.manifest.states[supplemental.id] = pendingTaskProgress();
    }
    plan.summary.rewrite_tasks = plan.tasks.filter(task => task.stage === "rewrite").length;
  }
  state.manifest.inputCatalog = plan.catalog;
  state.manifest.inputs = Object.fromEntries(
    (plan.catalog as Candidate[]).map((c) => [c.input_id, { id: c.input_id, name: c.input_id }]),
  );
  state.manifest.preflight = plan.summary;
  reconcileAttributionRewriteGroups(state, options?.preserveCompletedResults);
  plan.tasks = state.manifest.tasks;
  plan.summary = state.manifest.preflight;
  return plan;
}
