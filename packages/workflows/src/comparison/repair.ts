import { randomUUID } from "node:crypto";
import type { PlannedTask, RunState } from "@eval/contracts";
import { runLock } from "@eval/data";
import { comparisonSlots } from "./commentary.js";
import { taskCase } from "./input.js";
import { readRunState, writeRunState } from "./run-data.js";
import { stageResult } from "./results.js";
import type { ComparisonResult, EvalConfig, TaskData } from "./types.js";

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

function selectedTasks(state: RunState, selection: RepairSelection): Set<string> | undefined {
  const selected = new Set<string>();
  for (const id of selection.taskIds ?? []) {
    if (!state.manifest.tasks.some((task) => task.id === id)) throw new Error("未知任务：" + id);
    selected.add(id);
  }
  for (const id of selection.resultIds ?? []) {
    const task = state.manifest.tasks.find((task) => task.stage === "comparison" && (task.data as TaskData).comparisonId === id);
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
          if (Object.values(task.dependencies).includes(id) && !state.receipts[task.id]) visitDependencies(task.id);
      }
    } else for (const task of tasks)
      if (failed.has(state.manifest.states[task.id].status)) visitDependencies(task.id);
    // Only descendants of selected unfinished work join the frozen recovery scope.
    let expanded = true;
    while (expanded) {
      const size = ids.size;
      for (const task of tasks)
        if (!state.receipts[task.id] && Object.values(task.dependencies).some((id) => ids.has(id)) &&
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
      await freeze(run, state, [...ids]);
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
      if (task.stage === "comparison") sources.add(id);
      else if (data.rewriteOf?.stage === "comparison") sources.add(data.rewriteOf.taskId);
      else throw new Error("只能选择对比或对比改写任务：" + id);
    }
    const plans: { source: PlannedTask; rewrite?: PlannedTask; slots: string[] }[] = [];
    const requested = new Set(selection.slotIds);
    if (selection.slotIds && (!requested.size || requested.size !== selection.slotIds.length))
      throw new Error("槽位选择不能为空或重复");
    for (const source of tasks) {
      if (source.stage !== "comparison" || (chosen && !sources.has(source.id))) continue;
      const receipt = state.receipts[source.id];
      if (!receipt) {
        if (chosen) throw new Error("对比尚未接受，先补跑失败任务：" + source.id);
        continue;
      }
      if ((source.data as TaskData).supersededBy || (receipt.evaluation as ComparisonResult).status === "needs_review") {
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
      const rewrites = tasks.filter((task) => task.stage === "rewrite" && (task.data as TaskData).rewriteOf?.taskId === source.id);
      if (rewrites.length > 1) throw new Error("重复的对比改写任务：" + source.id);
      plans.push({ source, rewrite: rewrites[0], slots });
    }
    const selected = plans.map(({ source, rewrite, slots }) => ({
      source_task_id: source.id, result_id: (source.data as TaskData).comparisonId!,
      rewrite_task_id: rewrite?.id ?? null, slots,
    }));
    const replaced = new Set(plans.map((item) => item.rewrite?.id));
    const protectedAccepted = Object.keys(state.receipts).filter((id) => !replaced.has(id)).length;
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
        delete state.receipts[rewrite.id];
        state.manifest.states[rewrite.id] = { status: "pending", attempts: state.manifest.states[rewrite.id]?.attempts ?? 0 };
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

async function freeze(run: string, state: RunState, ids: string[]) {
  state.manifest.executionScope = ids;
  state.manifest.status = "interrupted";
  delete state.manifest.finishedAt;
  await writeRunState(run, state);
}
