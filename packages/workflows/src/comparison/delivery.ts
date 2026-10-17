import { canonical, type RunState, type TaskPlan } from "@eval/contracts";
import { attributionSlots, comparisonSlots } from "./commentary.js";
import { taskCase } from "./input.js";
import { display, stageResult, sourceRewriteTasks } from "./results.js";
import type { AttributionResult, ComparisonResult, EvalConfig, TaskData } from "./types.js";

function attributionDeliveryCoverage(state: RunState, requirements: DeliveryRequirements) {
  if (requirements.rewriteScopes?.length) throw new Error("归因作业不使用对比改写范围");
  const selected = requirements.selectedOnly ? new Set(state.manifest.executionScope) : undefined;
  if (requirements.selectedOnly && !state.manifest.executionScope) throw new Error("Run has no frozen execution scope");
  const config = state.manifest.config as EvalConfig;
  const latest = new Map<string, typeof state.manifest.tasks[number]>();
  for (const task of state.manifest.tasks) {
    if (task.stage !== "attribution" || (selected && !selected.has(task.id))) continue;
    const candidate = (task.data as TaskData).candidates.A;
    latest.set(canonical([candidate.batch_id, candidate.case_id, candidate.version]), task);
  }
  const errors: string[] = [], missingSlots: { task_id: string; result_id: string; slot_ids: string[] }[] = [];
  const byBatch: Record<string, { planned: number; accepted: number; delivered: number }> = {};
  let requiredSlots = 0, filledSlots = 0;
  for (const task of latest.values()) {
    const candidate = (task.data as TaskData).candidates.A;
    const counts = byBatch[candidate.batch_id] ??= { planned: 0, accepted: 0, delivered: 0 };
    counts.planned++;
    const receipt = state.receipts[task.id];
    if (!receipt || state.manifest.states[task.id]?.status !== "succeeded") {
      errors.push(`${task.id}: attribution not completed`); continue;
    }
    counts.accepted++;
    const expected = config.rewrite.attribution ? attributionSlots(receipt.evaluation as AttributionResult) : [];
    const row = receipt.exported && stageResult("attribution", receipt.exported.row);
    const rewritten = row?.rewritten as { rewrites: { id: string; text: string }[] } | undefined;
    const filled = new Set(rewritten?.rewrites.filter(item => item.text.trim()).map(item => item.id));
    const missing = expected.filter(item => !filled.has(item.id));
    requiredSlots += expected.length; filledSlots += expected.length - missing.length;
    if (missing.length) missingSlots.push({ task_id: task.id, result_id: task.id, slot_ids: missing.map(item => item.id) });
    counts.delivered++;
  }
  if (!latest.size) errors.push("No planned attributions");
  for (const batch of requirements.batchIds ?? []) if (!byBatch[batch]) errors.push(`missing batch: ${batch}`);
  if (requirements.batchIds) for (const batch of Object.keys(byBatch))
    if (!requirements.batchIds.includes(batch)) errors.push(`unexpected batch: ${batch}`);
  return { valid: !errors.length, by_batch: byBatch, errors,
    required_slots: requiredSlots, filled_slots: filledSlots, missing_slots: missingSlots };
}

export interface DeliveryRequirements {
  rewriteScopes?: string[];
  batchIds?: string[];
  selectedOnly?: boolean;
}
export function deliveryCoverage(state: RunState, requirements: DeliveryRequirements = {}) {
  if ((state.manifest.config as EvalConfig & { attributionJob?: unknown }).attributionJob)
    return attributionDeliveryCoverage(state, requirements);
  const scopes = new Set(requirements.rewriteScopes ?? []);
  if ([...scopes].some((scope) => scope !== "items" && scope !== "verdicts"))
    throw new Error("require-rewrite must be items or verdicts");
  const errors: string[] = [], keys = new Set<string>();
  const selected = requirements.selectedOnly ? new Set(state.manifest.executionScope) : undefined;
  if (requirements.selectedOnly && !state.manifest.executionScope) throw new Error("Run has no frozen execution scope");
  const missingSlots: { task_id: string; result_id: string; slot_ids: string[] }[] = [];
  const byBatch: Record<string, { planned: number; accepted: number; delivered: number }> = {};
  let requiredSlots = 0, filledSlots = 0;
  for (const task of state.manifest.tasks) {
    if (task.stage !== "comparison" || (task.data as TaskData).verificationAudit) continue;
    const rewrites = sourceRewriteTasks(state.manifest.tasks, task.id);
    if (selected && !selected.has(task.id) && !rewrites.some(rewrite => selected.has(rewrite.id))) continue;
    const data = task.data as TaskData, batch = taskCase(data).batch_id;
    const counts = byBatch[batch] ??= { planned: 0, accepted: 0, delivered: 0 };
    counts.planned++;
    const key = canonical([batch, taskCase(data).case_id, [...data.group!].sort()]);
    if (keys.has(key)) errors.push(`${task.id}: duplicate comparison business identity`);
    keys.add(key);
    const receipt = state.receipts[task.id];
    if (!receipt || state.manifest.states[task.id]?.status !== "succeeded") {
      errors.push(`${task.id}: comparison not completed`);
      continue;
    }
    counts.accepted++;
    if ((receipt.evaluation as ComparisonResult).status === "needs_review") {
      errors.push(`${task.id}: comparison remains unresolved`);
      continue;
    }
    const expected = [...scopes].flatMap((scope) => comparisonSlots(receipt.evaluation as ComparisonResult, scope as "items" | "verdicts"));
    const saved = receipt.exported && stageResult("comparison", receipt.exported.row).rewritten as
      { rewrites: { id: string; text: string }[] } | undefined;
    const filled = new Set(saved?.rewrites.filter((item) => item.text.trim()).map((item) => item.id));
    const missing = expected.filter((item) => !filled.has(item.id));
    requiredSlots += expected.length;
    filledSlots += expected.length - missing.length;
    // A prepared refresh remains outstanding even if old text still fills the JSONL.
    const requiredIds = new Set(expected.map(item => item.id));
    const outstanding = rewrites.some(rewrite => {
      if (state.receipts[rewrite.id]) return false;
      const data = rewrite.data as TaskData, scope = data.comparisonRewriteScope ?? "verdicts";
      return data.rewriteSlotIds ? data.rewriteSlotIds.some(id => requiredIds.has(id))
        : scope === "all" ? scopes.size > 0 : scopes.has(scope);
    });
    if (missing.length) missingSlots.push({ task_id: task.id, result_id: data.comparisonId!, slot_ids: missing.map((item) => item.id) });
    if (outstanding) errors.push(`${task.id}: requested rewrite not completed`);
    if (!missing.length && !outstanding) counts.delivered++;
  }
  const expectedBatches = requirements.batchIds;
  if (expectedBatches) {
    for (const batch of expectedBatches) if (!byBatch[batch]) errors.push(`missing batch: ${batch}`);
    for (const batch of Object.keys(byBatch)) if (!expectedBatches.includes(batch)) errors.push(`unexpected batch: ${batch}`);
  }
  if (!keys.size) errors.push("No planned comparisons");
  return { valid: !errors.length && !missingSlots.length, by_batch: byBatch, errors,
    required_slots: requiredSlots, filled_slots: filledSlots, missing_slots: missingSlots };
}

/** Distribute a pilot across date/group strata; retain the full plan for incremental release. */
export function pilotTaskIds(plan: TaskPlan, count: number): string[] {
  if (!Number.isInteger(count) || count < 1) throw new Error("pilot-cases must be positive");
  const groups = new Map<string, string[]>();
  for (const task of plan.tasks) if (task.stage === "comparison" && !(task.data as TaskData).verificationAudit) {
    const data = task.data as TaskData, key = canonical([taskCase(data).batch_id, data.group]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(task.id);
  }
  if (!groups.size) throw new Error("No comparisons for pilot");
  const selected = new Set<string>();
  while (selected.size < count) {
    const before = selected.size;
    for (const ids of groups.values()) {
      const id = ids.shift();
      if (id) selected.add(id);
      if (selected.size === count) break;
    }
    if (selected.size === before) break;
  }
  const dependencies = (id: string) => {
    const task = plan.tasks.find((task) => task.id === id)!;
    for (const dependency of Object.values(task.dependencies)) if (!selected.has(dependency)) {
      selected.add(dependency);
      dependencies(dependency);
    }
  };
  [...selected].forEach(dependencies);
  for (const task of plan.tasks) if (task.stage === "rewrite" && selected.has(task.dependencies.source!)) selected.add(task.id);
  return [...selected];
}

/** Source and polished text side by side; this does not claim semantic approval. */
export function comparisonRewriteReview(state: RunState, resultIds: string[] | undefined, limit: number) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("review limit must be positive");
  const tasks = state.manifest.tasks.filter((task) => task.stage === "comparison" && !(task.data as TaskData).verificationAudit);
  for (const id of resultIds ?? [])
    if (!tasks.some((task) => (task.data as TaskData).comparisonId === id)) throw new Error("未知对比结果：" + id);
  const versions = (state.manifest.config as EvalConfig).inputs.versions;
  const cases = tasks.filter((task) => state.receipts[task.id] &&
    (!resultIds?.length || resultIds.includes((task.data as TaskData).comparisonId!))).slice(0, limit).map((task) => {
    const data = task.data as TaskData, receipt = state.receipts[task.id];
    const names = Object.fromEntries(Object.entries(data.candidates).map(([label, candidate]) => {
      const version = versions.find((version) => version.id === candidate.version);
      return [label, version?.display_name || candidate.name];
    }));
    const saved = receipt.exported && stageResult("comparison", receipt.exported.row).rewritten as
      { rewrites: { id: string; text: string }[] } | undefined;
    return { task_id: task.id, result_id: data.comparisonId, ...taskCase(data),
      slots: (["verdicts", "items"] as const).flatMap((scope) => comparisonSlots(receipt.evaluation as ComparisonResult, scope))
        .map((item) => ({ ...display(item, names), rewritten: saved?.rewrites.find((entry) => entry.id === item.id)?.text ?? null })) };
  });
  return { semantic_review: "required", cases };
}
