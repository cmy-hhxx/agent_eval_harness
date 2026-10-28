import type { RunState, WorkflowScheduling } from "@eval/contracts";
import { dependencyReady, sessionAdmissionSnapshot } from "./scheduling.js";

export function progressSnapshot(state: RunState, now = Date.now(), preparing: ReadonlySet<string> = new Set(),
  sessionAdmission?: WorkflowScheduling["sessionAdmission"]) {
  const repairing = (id: string) => state.manifest.states[id].status === "running" &&
    !preparing.has(id) && state.manifest.states[id].failure?.draft !== undefined;
  const stages: Record<string, { queued: number; ready: number; preparing: number; running: number; repairing: number; accepted: number; complete: number; partial: number; failed: number; recent_completed_per_minute: number }> = {};
  const scope = state.manifest.executionScope && new Set(state.manifest.executionScope);
  for (const task of state.manifest.tasks) {
    const stage = stages[task.stage] ??= { queued: 0, ready: 0, preparing: 0, running: 0, repairing: 0, accepted: 0, complete: 0, partial: 0, failed: 0, recent_completed_per_minute: 0 };
    const status = state.manifest.states[task.id].status;
    if (preparing.has(task.id)) stage.preparing++;
    if (status === "pending" && !preparing.has(task.id) && (!scope || scope.has(task.id))) {
      stage.queued++;
      if (!state.manifest.pausedStages?.some((pause) => pause.stage === task.stage) &&
        Object.keys(task.dependencies).every(label => dependencyReady(task, label, state.manifest.states, preparing))) stage.ready++;
    }
    if (status === "running" && !preparing.has(task.id)) {
      if (repairing(task.id)) stage.repairing++; else stage.running++;
    }
    if (["failed", "timed_out"].includes(status)) stage.failed++;
    const receipt = state.receipts[task.id];
    if (receipt) {
      stage.accepted++;
      if (receipt.incompleteDependencies?.length) stage.partial++; else stage.complete++;
      if (receipt.acceptedAt >= now - 60000 && receipt.acceptedAt <= now) stage.recent_completed_per_minute++;
    }
  }
  const tasks = state.manifest.tasks.map((task) => ({
    id: task.id,
    ...state.manifest.states[task.id],
  }));
  const running = tasks.filter((task) => task.status === "running" && !preparing.has(task.id));
  const queued = tasks.filter((task) => task.status === "pending" && !preparing.has(task.id) && (!scope || scope.has(task.id))).length;
  const failures: Record<string, number> = {};
  for (const task of tasks)
    if (["failed", "timed_out"].includes(task.status)) {
      const category = task.failure?.errors[0]?.category || "interruption";
      failures[category] = (failures[category] || 0) + 1;
    }
  const completed = tasks
    .filter((task) => task.status === "succeeded" && task.durationMs)
    .sort((a, b) => (state.receipts[b.id]?.acceptedAt || 0) - (state.receipts[a.id]?.acceptedAt || 0))
    .slice(0, 50);
  const durations = completed.map((task) => task.durationMs!).sort((a, b) => a - b);
  const concurrency = state.manifest.concurrency || 1;
  const remaining = queued + running.length;
  const waves = Math.ceil(remaining / concurrency);
  const eta =
    durations.length < 5 || state.manifest.pausedStages?.length
      ? null
      : {
          p50_seconds: Math.round((waves * durations[Math.floor((durations.length - 1) * 0.5)]) / 1000),
          p95_seconds: Math.round((waves * durations[Math.floor((durations.length - 1) * 0.95)]) / 1000),
          note: "近期任务耗时估计，尾部修复可能超出区间",
        };
  const longest = running.sort(
    (a, b) => (a.lastProgressAt || a.startedAt || now) - (b.lastProgressAt || b.startedAt || now),
  )[0];
  const sessions = sessionAdmission ? sessionAdmissionSnapshot(state.manifest.tasks, state.manifest.states, sessionAdmission, state.manifest) : undefined;
  return {
    updated_at: new Date(now).toISOString(),
    usage: { archived_tokens: state.usage.totalTokens, archived_attempts: state.recordedAttempts,
      unarchived_attempts: Math.max(0,tasks.reduce((sum,task)=>sum+task.attempts,0)-state.recordedAttempts),
      scope: '仅已归档尝试；待归档及当前响应不计入，零不代表未消耗' },
    stages,
    paused_stages: state.manifest.pausedStages ?? [],
    execution_scope_count: state.manifest.executionScope?.length ?? null,
    queued,
    preparing: preparing.size,
    running: running.filter(task => !repairing(task.id)).length,
    accepted: Object.keys(state.receipts).length,
    complete: Object.values(stages).reduce((count, stage) => count + stage.complete, 0),
    partial: Object.values(stages).reduce((count, stage) => count + stage.partial, 0),
    repairing: running.filter(task => repairing(task.id)).length,
    failed: Object.values(failures).reduce((total, count) => total + count, 0),
    failures,
    blocked: tasks.filter((task) => task.status === "blocked").length,
    cancelled: tasks.filter((task) => task.status === "cancelled").length,
    concurrency,
    recent_completed_per_minute: Object.values(state.receipts).filter((r) => r.acceptedAt >= now - 60000)
      .length,
    longest_without_progress: longest
      ? {
          task_id: longest.id,
          seconds: Math.round((now - (longest.lastProgressAt || longest.startedAt || now)) / 1000),
        }
      : null,
    eta,
    eta_status: state.manifest.pausedStages?.length ? "paused" : eta ? "estimated" : "insufficient_samples",
    ...(sessions ? {
      total_sessions: sessions.total_sessions,
      active_sessions: sessions.active_sessions,
      completed_sessions: sessions.completed_sessions,
      waiting_sessions: sessions.waiting_sessions,
      failed_sessions: sessions.failed_sessions,
      blocked_sessions: sessions.blocked_sessions,
    } : {}),
  };
}
