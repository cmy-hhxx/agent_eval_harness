import { randomUUID } from "node:crypto";
import type { PlannedTask, RunState } from "@eval/contracts";
import { problemLibraryFile, readProblemLibrary, runLock } from "@eval/data";
import { emptyLibrary, projectLibrary, type ClusteringResult } from "@eval/agents/clustering";
import { attributionRewriteGroups, attributionSlots, comparisonSlots } from "./commentary.js";
import { taskCase } from "./input.js";
import { readRunState, writeRunState } from "./run-data.js";
import { pendingTaskProgress } from "../review/task-progress.js";
import { stageResult } from "./results.js";
import { acceptedRewriteProjection } from "./rewrite-projection.js";
import { supersededAttributionRewriteIds } from "./attribution-rewrite-planning.js";
import type { ComparisonResult, EvalConfig, SessionAttributionResult, TaskData } from "./types.js";

export interface RepairSelection {
  taskIds?: string[];
  resultIds?: string[];
  apply?: boolean;
}
export interface RewriteSelection extends RepairSelection {
  scope: "items" | "verdicts";
  mode: "missing" | "refresh";
  slotIds?: string[];
  all?: boolean;
}
export interface AttributionRewriteSelection extends RepairSelection {
  mode: "missing" | "refresh";
  slotIds?: string[];
  all?: boolean;
}
export interface DeferredClusteringSelection {
  taskIds?: string[];
  all?: boolean;
  apply?: boolean;
}

/** Reclassify accepted deferred observations using today's directory, preserving every receipt. */
export async function prepareDeferredClustering(run: string, selection: DeferredClusteringSelection) {
  if (!selection.all && !selection.taskIds?.length) throw new Error("重新归类必须选择 --task 或显式 --all");
  if (selection.all && selection.taskIds?.length) throw new Error("--all 不能与任务选择同时使用");
  const release = await runLock(run);
  try {
    const state = await readRunState(run), tasks = state.manifest.tasks;
    const chosen = new Set(selection.taskIds), config = state.manifest.config as EvalConfig;
    for (const id of chosen)
      if (!tasks.some(task => task.id === id && task.stage === "clustering")) throw new Error("未知聚类任务：" + id);
    const eligible = (task: PlannedTask): boolean => {
      if (selection.all) return true;
      const seen = new Set<string>();
      let current: PlannedTask | undefined = task;
      while (current && !seen.has(current.id)) {
        if (chosen.has(current.id)) return true;
        seen.add(current.id);
        const parentId: string | undefined = (current.data as TaskData).reclassifyOf?.task_id;
        current = parentId ? tasks.find(task => task.id === parentId) : undefined;
      }
      return false;
    };
    const clustering = tasks.filter(task => task.stage === "clustering");
    const pending = clustering.filter(task => eligible(task) && (task.data as TaskData).reclassifyOf && !state.receipts[task.id]);
    const plans = clustering.flatMap(source => {
      const receipt = state.receipts[source.id];
      if (!receipt || !eligible(source)) return [];
      // A child owns its selected observations even when it defers again; only leaf work is new.
      const claimed = new Set(clustering.flatMap(task => {
        const data = task.data as TaskData;
        return data.reclassifyOf?.task_id === source.id ? data.reclassifyOf.item_ids : [];
      }));
      const itemIds = (receipt.evaluation as ClusteringResult).assignments
        .filter(item => item.deferred_reason !== undefined && !claimed.has(item.item_id)).map(item => item.item_id);
      return itemIds.length ? [{ source, itemIds }] : [];
    });
    const models = [...new Set(plans.map(plan => (plan.source.data as TaskData).scope!.version))];
    const projections = new Map(await Promise.all(models.map(async model => {
      const library = await readProblemLibrary(problemLibraryFile(config.problemLibrary, model)) ?? emptyLibrary(model);
      if (library.model !== model) throw new Error("问题库模型身份不一致：" + model);
      return [model, projectLibrary(library)] as const;
    })));
    const selected = pending.map(task => ({ source_task_id: (task.data as TaskData).reclassifyOf!.task_id,
      task_id: task.id as string | null, item_ids: (task.data as TaskData).reclassifyOf!.item_ids }));
    const created: PlannedTask[] = [];
    for (const [index, plan] of plans.entries()) {
      const data = plan.source.data as TaskData, scope = data.scope!, projection = projections.get(scope.version)!;
      const siblings = plans.filter(plan => (plan.source.data as TaskData).scope!.version === scope.version);
      const position = siblings.indexOf(plan), activeClasses = projection.components.reduce((sum, entry) => sum + entry.classes.length, 0);
      const reserved = clustering.filter(task => !state.receipts[task.id] && (task.data as TaskData).scope!.version === scope.version);
      const share = (cap: number, active: number, field: "max_new_classes" | "max_new_components") => {
        const headroom = Math.max(0, cap - active - reserved.reduce((sum, task) => sum + (task.data as TaskData).scope!.budget[field], 0));
        return Math.floor(headroom / siblings.length) + Number(position < headroom % siblings.length);
      };
      const task: PlannedTask = { id: randomUUID(), stage: "clustering", inputIds: {}, dependencies: { ...plan.source.dependencies },
        data: { stage: "clustering", candidates: {}, reference: null, projection,
          reclassifyOf: { task_id: plan.source.id, item_ids: plan.itemIds },
          scope: { ...scope, shard: Math.max(...clustering.filter(task => (task.data as TaskData).scope!.version === scope.version &&
            (task.data as TaskData).scope!.batch_id === scope.batch_id).map(task => (task.data as TaskData).scope!.shard), 0) + index + 1,
            budget: { active_classes: activeClasses, max_classes: config.clustering.maxClassesPerModel,
              max_new_classes: Math.min(config.clustering.maxNewClassesPerTask, share(config.clustering.maxClassesPerModel, activeClasses, "max_new_classes")),
              active_components: projection.components.length, max_components: config.clustering.maxComponentsPerModel,
              max_new_components: share(config.clustering.maxComponentsPerModel, projection.components.length, "max_new_components"),
              consolidate: activeClasses >= config.clustering.consolidateAt, min_support: config.clustering.minSupport } },
        } satisfies TaskData };
      selected.push({ source_task_id: plan.source.id, task_id: selection.apply ? task.id : null, item_ids: plan.itemIds });
      created.push(task);
      if (config.rewrite.clustering) created.push({ id: randomUUID(), stage: "rewrite", inputIds: {}, dependencies: { source: task.id },
        data: { stage: "rewrite", candidates: {}, reference: null,
          rewriteOf: { stage: "clustering", taskId: task.id, resultId: task.id },
          rewriteScope: { batch_id: scope.batch_id, model: config.inputs.versions.find(version => version.id === scope.version)!.name },
        } satisfies TaskData });
    }
    if (selection.apply && selected.length) {
      tasks.push(...created);
      const pendingIds = new Set(pending.map(task => task.id));
      const presentation = tasks.filter(task => task.stage === "rewrite" && !state.receipts[task.id] &&
        pendingIds.has((task.data as TaskData).rewriteOf?.taskId ?? ""));
      const ids = [...pendingIds, ...presentation.map(task => task.id), ...created.map(task => task.id)];
      for (const id of ids) state.manifest.states[id] = pendingTaskProgress(state.manifest.states[id]);
      await freeze(run, state, ids);
    }
    return { applied: !!selection.apply, count: selected.length,
      protected_accepted: Object.keys(state.receipts).length, selected };
  } finally { await release(); }
}

function selectedTasks(state: RunState, selection: RepairSelection): Set<string> | undefined {
  const selected = new Set<string>();
  for (const id of selection.taskIds ?? []) {
    if (!state.manifest.tasks.some((task) => task.id === id)) throw new Error("未知任务：" + id);
    selected.add(id);
  }
  for (const id of selection.resultIds ?? []) {
    const task = state.manifest.tasks.find((task) => task.stage === "comparison" && !(task.data as TaskData).verificationAudit && (task.data as TaskData).comparisonId === id);
    if (!task) throw new Error("未知对比结果：" + id);
    selected.add(task.id);
  }
  return selected.size ? selected : undefined;
}

/** Preview and apply use the same locked selection; never edit results to prepare work. */
export async function prepareFailedTasks(run: string, selection: RepairSelection = {}) {
  const release = await runLock(run);
  try {
    const state = await readRunState(run), tasks = state.manifest.tasks;
    const chosen = selectedTasks(state, selection);
    const trialScope = (state.manifest.config as EvalConfig & { attributionJob?: unknown }).attributionJob && state.manifest.executionScope
      ? new Set(state.manifest.executionScope) : undefined;
    const ids = new Set<string>();
    const failed = new Set(["failed", "blocked", "timed_out", "cancelled"]);
    const visitDependencies = (id: string) => {
      if (state.receipts[id] || ids.has(id)) return;
      const task = tasks.find((task) => task.id === id);
      if (!task) throw new Error("缺少依赖任务：" + id);
      ids.add(id);
      Object.values(task.dependencies).forEach(visitDependencies);
    };
    if (chosen) {
      for (const id of chosen) {
        // An accepted comparison may have an unfinished presentation task.
        if (!state.receipts[id]) visitDependencies(id);
        else for (const task of tasks)
          if ((!trialScope || trialScope.has(task.id) || task.stage === "rewrite") &&
            Object.values(task.dependencies).includes(id) && !state.receipts[task.id]) visitDependencies(task.id);
      }
    } else for (const task of tasks)
      if ((!trialScope || trialScope.has(task.id)) && failed.has(state.manifest.states[task.id].status)) visitDependencies(task.id);
    // Only descendants of selected unfinished work join the frozen recovery scope.
    let expanded = true;
    while (expanded) {
      const size = ids.size;
      for (const task of tasks)
        if ((!trialScope || trialScope.has(task.id) || task.stage === "rewrite") &&
          !state.receipts[task.id] && Object.values(task.dependencies).some((id) => ids.has(id)) &&
          // A batch clustering shard must not pull unrelated unfinished cases into a local repair.
          (task.stage !== "clustering" || Object.values(task.dependencies).every((id) => state.receipts[id] || ids.has(id))))
          visitDependencies(task.id);
      expanded = ids.size !== size;
    }
    const selected = tasks.filter((task) => ids.has(task.id)).map((task) => ({
      task_id: task.id, stage: task.stage, status: state.manifest.states[task.id].status,
      attempts: state.manifest.states[task.id].attempts,
    }));
    if (selection.apply && ids.size) {
      for (const id of ids) {
        const progress = state.manifest.states[id];
        progress.status = "pending";
        delete progress.attemptId;
        delete progress.reason;
      }
      // A trial keeps its accepted answers in scope for delivery and post-run clustering.
      await freeze(run, state, [...new Set([...(trialScope ?? []), ...ids])]);
    }
    return { applied: !!selection.apply, selected, count: selected.length,
      protected_accepted: Object.keys(state.receipts).length };
  } finally { await release(); }
}

export async function prepareComparisonRewrites(run: string, selection: RewriteSelection) {
  if (!["items", "verdicts"].includes(selection.scope) || !["missing", "refresh"].includes(selection.mode))
    throw new Error("无效的改写范围或模式");
  if (selection.mode === "refresh" && !selection.all && !selection.taskIds?.length && !selection.resultIds?.length)
    throw new Error("刷新已有文案必须选择 --task、--result 或显式 --all");
  if (selection.all && (selection.taskIds?.length || selection.resultIds?.length))
    throw new Error("--all 不能与任务或结果选择同时使用");
  const release = await runLock(run);
  try {
    const state = await readRunState(run), tasks = state.manifest.tasks;
    const chosen = selectedTasks(state, selection);
    const sources = new Set<string>();
    for (const id of chosen ?? []) {
      const task = tasks.find((task) => task.id === id)!, data = task.data as TaskData;
      if (task.stage === "comparison" && !data.verificationAudit) sources.add(id);
      else if (data.rewriteOf?.stage === "comparison") sources.add(data.rewriteOf.taskId);
      else throw new Error("只能选择对比或对比改写任务：" + id);
    }
    const plans: { source: PlannedTask; rewrite?: PlannedTask; slots: string[] }[] = [];
    const requested = new Set(selection.slotIds);
    if (selection.slotIds && (!requested.size || requested.size !== selection.slotIds.length))
      throw new Error("槽位选择不能为空或重复");
    for (const source of tasks) {
      if (source.stage !== "comparison" || (source.data as TaskData).verificationAudit || (chosen && !sources.has(source.id))) continue;
      const receipt = state.receipts[source.id];
      if (!receipt) {
        if (chosen) throw new Error("对比尚未接受，先补跑失败任务：" + source.id);
        continue;
      }
      if ((receipt.evaluation as ComparisonResult).status === "needs_review") {
        if (chosen) throw new Error("待复核结果没有正式裁决改写槽位：" + source.id);
        continue;
      }
      const available = comparisonSlots(receipt.evaluation as ComparisonResult, selection.scope);
      for (const id of requested)
        if (!available.some((item) => item.id === id)) throw new Error(`结果 ${source.id} 没有槽位 ${id}`);
      const stored = receipt.exported && stageResult("comparison", receipt.exported.row).rewritten as
        { rewrites: { id: string; text: string }[] } | undefined;
      const filled = new Set(stored?.rewrites.filter((item) => item.text.trim()).map((item) => item.id));
      const slots = available.filter((item) => (!requested.size || requested.has(item.id)) &&
        (selection.mode === "refresh" || !filled.has(item.id))).map((item) => item.id);
      if (!slots.length) continue;
      const rewrites = tasks.filter((task) => {
        const data = task.data as TaskData;
        const scope = data.comparisonRewriteScope ?? "verdicts";
        const owned = data.rewriteSlotIds ?? comparisonSlots(receipt.evaluation as ComparisonResult, scope).map(item => item.id);
        return task.stage === "rewrite" && data.rewriteOf?.taskId === source.id && !state.receipts[task.id] &&
          scope === selection.scope && owned.length === slots.length && slots.every(id => owned.includes(id));
      });
      if (rewrites.length > 1) throw new Error("重复的未完成对比改写槽位任务：" + source.id);
      plans.push({ source, rewrite: rewrites[0], slots });
    }
    const selected = plans.map(({ source, rewrite, slots }) => ({
      source_task_id: source.id, result_id: (source.data as TaskData).comparisonId!,
      rewrite_task_id: rewrite?.id ?? null, slots,
    }));
    const protectedAccepted = Object.keys(state.receipts).length;
    if (selection.apply && plans.length) {
      const scope: string[] = [];
      const config = state.manifest.config as EvalConfig;
      for (const [index, plan] of plans.entries()) {
        const data = plan.source.data as TaskData;
        const rewrite = plan.rewrite ?? {
          id: randomUUID(), stage: "rewrite", inputIds: {}, dependencies: { source: plan.source.id },
          data: {
            stage: "rewrite", candidates: {}, reference: null,
            rewriteOf: { stage: "comparison", taskId: plan.source.id, resultId: data.comparisonId! },
            case: { ...taskCase(data), question: Object.values(data.candidates)[0]!.question },
            rewriteNames: Object.fromEntries(Object.entries(data.candidates).map(([label, candidate]) => {
              const version = config.inputs.versions.find((version) => version.id === candidate.version);
              return [label, version?.display_name || version?.name || candidate.name];
            })),
          } satisfies TaskData,
        };
        if (!plan.rewrite) tasks.push(rewrite);
        (rewrite.data as TaskData).comparisonRewriteScope = selection.scope;
        (rewrite.data as TaskData).rewriteSlotIds = plan.slots;
        state.manifest.states[rewrite.id] = pendingTaskProgress(state.manifest.states[rewrite.id]);
        scope.push(rewrite.id);
        selected[index]!.rewrite_task_id = rewrite.id;
      }
      await freeze(run, state, scope);
    }
    return { applied: !!selection.apply, mode: selection.mode, scope: selection.scope,
      count: selected.length, slots: selected.reduce((sum, task) => sum + task.slots.length, 0),
      protected_accepted: protectedAccepted, selected };
  } finally { await release(); }
}

/** New presentation tasks target immutable accepted attributions, grouped by semantic unit. */
export async function prepareAttributionRewrites(run: string, selection: AttributionRewriteSelection) {
  if (!["missing", "refresh"].includes(selection.mode)) throw new Error("无效的改写模式");
  if (selection.mode === "refresh" && !selection.all && !selection.taskIds?.length && !selection.resultIds?.length)
    throw new Error("刷新已有文案必须选择 --task、--result 或显式 --all");
  if (selection.all && (selection.taskIds?.length || selection.resultIds?.length))
    throw new Error("--all 不能与任务或结果选择同时使用");
  const requested = new Set(selection.slotIds);
  if (selection.slotIds && (!requested.size || requested.size !== selection.slotIds.length))
    throw new Error("槽位选择不能为空或重复");
  const release = await runLock(run);
  try {
    const state = await readRunState(run), tasks = state.manifest.tasks, sources = new Set<string>();
    const config = state.manifest.config as EvalConfig & { attributionJob?: unknown };
    const trialScope = config.attributionJob && state.manifest.executionScope ? new Set(state.manifest.executionScope) : undefined;
    const explicit = !!(selection.taskIds?.length || selection.resultIds?.length);
    for (const id of selection.taskIds ?? []) {
      const task = tasks.find(task => task.id === id), data = task?.data as TaskData | undefined;
      if (task?.stage === "attribution-session") sources.add(id);
      else if (task?.stage === "rewrite" && data?.rewriteOf?.stage === "attribution") sources.add(data.rewriteOf.taskId);
      else throw new Error("只能选择归因或归因改写任务：" + id);
    }
    for (const id of selection.resultIds ?? []) {
      if (!tasks.some(task => task.stage === "attribution-session" && task.id === id)) throw new Error("未知归因结果：" + id);
      sources.add(id);
    }
    const latest = new Map<string, PlannedTask>();
    for (const task of tasks) if (task.stage === "attribution-session" && state.receipts[task.id]) {
      if (!explicit && trialScope && !trialScope.has(task.id)) continue;
      const inputId = (task.data as TaskData).candidate!.input_id, previous = latest.get(inputId);
      if (!previous || state.receipts[previous.id]!.acceptedAt <= state.receipts[task.id]!.acceptedAt) latest.set(inputId, task);
    }
    const plans: { source: PlannedTask; rewrite?: PlannedTask; slots: string[] }[] = [];
    for (const source of explicit ? tasks.filter(task => sources.has(task.id)) : latest.values()) {
      const receipt = state.receipts[source.id];
      if (!receipt) throw new Error("归因尚未接受，先补跑失败任务：" + source.id);
      const result = receipt.evaluation as SessionAttributionResult, available = attributionSlots(result);
      for (const id of requested) if (!available.some(item => item.id === id)) throw new Error(`结果 ${source.id} 没有槽位 ${id}`);
      const filled = new Set(acceptedRewriteProjection(state, source.id)?.rewritten.rewrites.filter(item => item.text.trim()).map(item => item.id));
      const slots = available.filter(item => (!requested.size || requested.has(item.id)) &&
        (selection.mode === "refresh" || !filled.has(item.id))).map(item => item.id);
      for (const group of attributionRewriteGroups(result, slots)) {
        const pending = tasks.filter(task => {
          const data = task.data as TaskData, owned = data.rewriteSlotIds;
          return task.stage === "rewrite" && data.rewriteOf?.stage === "attribution" && data.rewriteOf.taskId === source.id &&
            !state.receipts[task.id] && owned?.length === group.length && group.every(id => owned.includes(id));
        });
        if (pending.length > 1) throw new Error("重复的未完成归因改写槽位任务：" + source.id);
        plans.push({ source, rewrite: pending[0], slots: group });
      }
    }
    const selected = plans.map(plan => ({ source_task_id: plan.source.id, result_id: plan.source.id,
      rewrite_task_id: plan.rewrite?.id ?? null, slots: plan.slots }));
    const protectedAccepted = Object.keys(state.receipts).length;
    if (selection.apply && plans.length) {
      const ids: string[] = [];
      for (const [index, plan] of plans.entries()) {
        const candidate = (plan.source.data as TaskData).candidate!, version = config.inputs.versions.find(item => item.id === candidate.version);
        const rewrite = plan.rewrite ?? { id: randomUUID(), stage: "rewrite", inputIds: {}, dependencies: { source: plan.source.id },
          data: { stage: "rewrite", candidates: {}, reference: null, rewriteOf: { stage: "attribution", taskId: plan.source.id, resultId: plan.source.id },
            rewriteSlotIds: plan.slots, rewriteNames: { A: version?.display_name || version?.name || candidate.name },
            case: { batch_id: candidate.batch_id, case_id: candidate.case_id, question: candidate.question } } satisfies TaskData };
        if (!plan.rewrite) tasks.push(rewrite);
        state.manifest.states[rewrite.id] = pendingTaskProgress(state.manifest.states[rewrite.id]);
        ids.push(rewrite.id); selected[index]!.rewrite_task_id = rewrite.id;
      }
      const trial = config.attributionJob ? state.manifest.executionScope ?? [] : [];
      const superseded = supersededAttributionRewriteIds(state);
      await freeze(run, state, [...new Set([...trial, ...ids])].filter(id => !superseded.has(id)));
    }
    return { applied: !!selection.apply, mode: selection.mode, count: selected.length,
      sources: new Set(selected.map(item => item.source_task_id)).size,
      slots: selected.reduce((sum, item) => sum + item.slots.length, 0), protected_accepted: protectedAccepted, selected };
  } finally { await release(); }
}

async function freeze(run: string, state: RunState, ids: string[]) {
  state.manifest.executionScope = ids;
  state.manifest.status = "interrupted";
  delete state.manifest.finishedAt;
  await writeRunState(run, state);
}
