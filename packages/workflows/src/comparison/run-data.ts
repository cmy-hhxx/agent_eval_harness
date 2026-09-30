import {
  errorText,
  ValidationError,
  type RunManifest,
  type RunState,
  type TaskPlan,
  type ValidationIssue,
} from "@eval/contracts";
import { createRunRepository, fileSourceReader } from "@eval/data";
import { adapt, buildPlan, candidateKey, inputSources, locateRecordStream, taskCase, taskIdentity } from "./input.js";
import type { BatchPreflight, Candidate, ComparisonResult, EvalConfig, TaskData } from "./types.js";
import { comparisonCodec } from "./codec.js";
import { encodeResult, stageResult } from "./results.js";
import { comparisonSlots } from "./commentary.js";
export const comparisonRepository = createRunRepository(comparisonCodec, encodeResult);
export const { readRun: readRunState, writeRun: writeRunState, createResultWriter, readTasks: readRunTasks } =
  comparisonRepository;
export async function loadRunInputs(
  manifest: RunManifest,
  issues?: ValidationIssue[],
  taskIds?: ReadonlySet<string>,
): Promise<Record<string, unknown>> {
  const inputs: Record<string, unknown> = {},
    errors: ValidationIssue[] = [];
  const config = manifest.config as EvalConfig;
  const inputIds = taskIds && new Set(manifest.tasks.filter((task) => taskIds.has(task.id)).flatMap((task) => Object.values(task.inputIds)));
  const sources = inputSources((manifest.inputCatalog as Candidate[]).filter((candidate) => !inputIds || inputIds.has(candidate.input_id)));
  for (const [source, candidates] of sources) {
    const found: Record<string, unknown> = {};
    let revision: string;
    const register = (candidate: Candidate, byteOffset: number, byteLength: number) => {
      Object.defineProperty(found, candidate.input_id, {
        enumerable: true,
        configurable: true,
        get: () => JSON.parse(fileSourceReader.record(source, byteOffset, byteLength, revision)),
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
            if (candidateKey(adapt(raw, version, source, index, config.inputs.default_batch_id)) === candidateKey(candidate))
              register(candidate, byteOffset, byteLength);
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
          const { byteOffset, byteLength } = await locateRecordStream(source, candidate, version, config.inputs.default_batch_id);
          register(candidate, byteOffset, byteLength);
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
export async function reconcileRun(_run: string, state: RunState, current: unknown, options?: { extendVersions: boolean }): Promise<TaskPlan> {
  if (state.manifest.executionScope) {
    const pending = new Set(state.manifest.executionScope.filter((id) => !state.receipts[id]));
    return { tasks: state.manifest.tasks, inputs: await loadRunInputs(state.manifest, undefined, pending),
      catalog: state.manifest.inputCatalog, summary: state.manifest.preflight };
  }
  const config = state.manifest.config as EvalConfig,
    supplied = current as EvalConfig;
  const versions = [...config.inputs.versions, ...(options?.extendVersions ? supplied.inputs.versions.filter((version) =>
    !config.inputs.versions.some((existing) => existing.id === version.id)) : [])];
  const selected: EvalConfig = {
    ...config,
    execution: supplied.execution,
    // Automation explicitly extends a daily run's model selection; normal resume retains its selection.
    comparisons: supplied.comparisons
      .map((group) => group.filter((id) => versions.some((version) => version.id === id)))
      .filter((group) => group.length >= 2),
    // Presentation and library stages may be enabled or disabled on resume without touching evaluations.
    rewrite: supplied.rewrite,
    clustering: supplied.clustering,
    inputs: {
      ...config.inputs,
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
    if (state.receipts[task.id] || !tasks.has(task.id)) tasks.set(task.id, task);
  }
  const dependencies = new Set([...tasks.values()].flatMap((task) => Object.values(task.dependencies)));
  for (const [id, task] of tasks)
    if (task.stage === "attribution" && !dependencies.has(id) && !state.receipts[id]) tasks.delete(id);
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
  plan.tasks = [...tasks.values()];
  plan.summary.issues = issues;
  plan.summary.attribution_tasks = plan.tasks.filter((task) => task.stage === "attribution").length;
  plan.summary.comparison_tasks = plan.tasks.filter((task) => task.stage === "comparison").length;
  plan.summary.rewrite_tasks = plan.tasks.filter((task) => task.stage === "rewrite").length;
  plan.summary.clustering_tasks = plan.tasks.filter((task) => task.stage === "clustering").length;
  for (const [batch, counts] of Object.entries(plan.summary.by_batch as Record<string, BatchPreflight>)) {
    const selected = plan.tasks.filter((task) => taskIdentity(task.data as TaskData).batch_id === batch);
    counts.attribution_tasks = selected.filter((task) => task.stage === "attribution").length;
    counts.comparison_tasks = selected.filter((task) => task.stage === "comparison").length;
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
        status: "pending",
        attempts: old?.attempts || 0,
        revision,
      };
  }
  state.manifest.config = selected;
  state.manifest.tasks = plan.tasks;
  if (selected.rewrite.comparison && selected.rewrite.comparisonItems) {
    for (const task of plan.tasks) {
      const data = task.data as TaskData;
      if (data.rewriteOf?.stage !== "comparison") continue;
      const source = state.receipts[data.rewriteOf.taskId];
      if (!source) continue;
      const stored = source.exported && stageResult("comparison", source.exported.row).rewritten as
        { rewrites: { id: string; text: string }[] } | undefined;
      const filled = new Set(stored?.rewrites.filter((item) => item.text.trim()).map((item) => item.id));
      const missing = comparisonSlots(source.evaluation as ComparisonResult, "all").filter((item) => !filled.has(item.id));
      const accepted = state.receipts[task.id];
      data.comparisonRewriteScope = "all";
      if (!missing.length) {
        // A targeted refresh may own only part of the complete, merged source row.
        if (accepted) data.rewriteSlotIds = (accepted.evaluation as { rewrites: { id: string }[] }).rewrites.map((item) => item.id);
        continue;
      }
      data.rewriteSlotIds = missing.map((item) => item.id);
      if (accepted) {
        // Preserve accepted evaluations and stored prose; request only missing presentation slots.
        delete state.receipts[task.id];
        state.manifest.states[task.id] = { status: "pending", attempts: state.manifest.states[task.id].attempts };
      }
    }
  }
  state.manifest.inputCatalog = plan.catalog;
  state.manifest.inputs = Object.fromEntries(
    (plan.catalog as Candidate[]).map((c) => [c.input_id, { id: c.input_id, name: c.input_id }]),
  );
  state.manifest.preflight = plan.summary;
  return plan;
}
