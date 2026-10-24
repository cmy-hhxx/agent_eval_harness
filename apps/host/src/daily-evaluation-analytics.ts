import { publishableComparisons, type Checkpoint, type EvalConfig } from "@eval/workflows/comparison";
import { isAutomationTask } from "./automation-evaluation.js";

export interface EvaluationCounts { total: number; completed: number; partial: number; pending: number; failed: number; running: number }
export interface EvaluationAnalytics {
  unit: "answers" | "comparisons";
  totals: EvaluationCounts;
  models: (EvaluationCounts & { model: string })[];
  dates: (EvaluationCounts & { date: string | null })[];
  stages: { stage: string; total: number; completed: number; pending: number; failed: number; running: number }[];
  groups: (EvaluationCounts & { date: string | null; model: string; stages: EvaluationAnalytics["stages"] })[];
}
const empty = (): EvaluationCounts => ({ total: 0, completed: 0, partial: 0, pending: 0, failed: 0, running: 0 });
const failures = new Set(["failed", "timed_out", "blocked", "cancelled"]);
const taskStatus = (task: Checkpoint["tasks"][string]) => task.status === "succeeded"
  ? task.receipt?.exported ? "completed" : "failed"
  : failures.has(task.status) ? "failed" : task.status === "running" ? "running" : "pending";

/** A comparison is complete only after its formal result and required rewrites are publishable. */
export function comparisonEvaluationAnalytics(date: string, runs: readonly Checkpoint[]): EvaluationAnalytics {
  const totals = empty(), models = new Map<string, EvaluationCounts>();
  const stages = new Map<string, EvaluationAnalytics["stages"][number]>();
  const comparisons = new Map<string, { model: string; status: Exclude<keyof EvaluationCounts, "total"> }>();
  const rank = { completed: 4, failed: 3, partial: 2, running: 1, pending: 0 };
  for (const run of runs) {
    const published = publishableComparisons(run), rewrites = new Map<string, string[]>();
    for (const [id, task] of Object.entries(run.tasks)) {
      if (!isAutomationTask(task)) continue;
      const status = taskStatus(task), counts = stages.get(task.stage) ?? { stage: task.stage, total: 0, completed: 0, pending: 0, failed: 0, running: 0 };
      counts.total++; counts[status]++; stages.set(task.stage, counts);
      if (task.data.rewriteOf) {
        const source = task.data.rewriteOf.taskId;
        rewrites.set(source, [...(rewrites.get(source) ?? []), id]);
      }
    }
    if (!Object.values(run.tasks).some(task => task.stage === "comparison" && !task.data.verificationAudit)) continue;
    const versions = new Map((run.config as EvalConfig).inputs.versions.map(version => [version.id, version]));
    for (const [id, task] of Object.entries(run.tasks)) {
      if (task.stage !== "comparison" || task.data.verificationAudit) continue;
      const group = task.data.group ?? Object.values(task.inputIds).map(inputId => run.inputs[inputId]?.version);
      const tiers = new Set(group.map(model => versions.get(model)?.comparison_tier));
      const model = tiers.size === 1 && !tiers.has(undefined) ? [...tiers][0]! : group.join(" / ");
      const required = new Set<string>();
      const collect = (taskId: string) => {
        if (required.has(taskId)) return;
        required.add(taskId);
        for (const dependency of Object.values(run.tasks[taskId]?.dependencies ?? {})) collect(dependency);
        for (const rewrite of rewrites.get(taskId) ?? []) collect(rewrite);
      };
      collect(id);
      const statuses = [...required].map(taskId => run.tasks[taskId] ? taskStatus(run.tasks[taskId]) : "failed");
      const status = task.data.comparisonId && published.has(task.data.comparisonId) ? "completed" : statuses.includes("failed") ? "failed"
        : statuses.includes("completed") ? "partial" : statuses.includes("running") ? "running" : "pending";
      const identities = Object.values(task.inputIds).map(inputId => {
        const input = run.inputs[inputId];
        if (!input) throw new Error("比较任务缺少登记的回答：" + id);
        return [input.version, input.batch_id, input.case_id, input.trace_id ?? null];
      }).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
      const key = JSON.stringify(identities), previous = comparisons.get(key);
      if (!previous || rank[status] > rank[previous.status]) comparisons.set(key, { model, status });
    }
  }
  for (const { model, status } of comparisons.values()) {
    const counts = models.get(model) ?? empty(); models.set(model, counts);
    for (const target of [totals, counts]) { target.total++; target[status]++; }
  }
  return { unit: "comparisons", totals, models: [...models].map(([model, counts]) => ({ model, ...counts })),
    dates: [{ date, ...totals }], stages: [...stages.values()],
    groups: [...models].map(([model, counts]) => ({ date, model, ...counts, stages: [] })) };
}

export function combineEvaluationAnalytics(unit: EvaluationAnalytics["unit"], rows: Omit<EvaluationAnalytics, "unit">[]): EvaluationAnalytics {
  const totals = empty(), models = new Map<string, EvaluationCounts>(), dates = new Map<string | null, EvaluationCounts>();
  const stages = new Map<string, EvaluationAnalytics["stages"][number]>();
  const add = (target: EvaluationCounts, source: EvaluationCounts) => {
    for (const key of ["total", "completed", "partial", "pending", "failed", "running"] as const) target[key] += source[key];
  };
  for (const row of rows) {
    add(totals, row.totals);
    for (const item of row.models) { const counts = models.get(item.model) ?? empty(); add(counts, item); models.set(item.model, counts); }
    for (const item of row.dates) { const counts = dates.get(item.date) ?? empty(); add(counts, item); dates.set(item.date, counts); }
    for (const item of row.stages) {
      const counts = stages.get(item.stage) ?? { stage: item.stage, total: 0, completed: 0, pending: 0, failed: 0, running: 0 };
      for (const key of ["total", "completed", "pending", "failed", "running"] as const) counts[key] += item[key];
      stages.set(item.stage, counts);
    }
  }
  return { unit, totals, models: [...models].map(([model, counts]) => ({ model, ...counts })),
    dates: [...dates].sort(([a], [b]) => (a ?? "").localeCompare(b ?? "")).map(([date, counts]) => ({ date, ...counts })),
    stages: [...stages.values()], groups: rows.flatMap(row => row.groups) };
}
