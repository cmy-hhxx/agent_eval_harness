import type { RunState } from "@eval/contracts";

export function progressSnapshot(state: RunState, now = Date.now()) {
  const stages: Record<string, { queued: number; ready: number; running: number; accepted: number; recent_completed_per_minute: number }> = {};
  const scope = state.manifest.executionScope && new Set(state.manifest.executionScope);
  for (const task of state.manifest.tasks) {
    const stage = stages[task.stage] ??= { queued: 0, ready: 0, running: 0, accepted: 0, recent_completed_per_minute: 0 };
    const status = state.manifest.states[task.id].status;
    if (status === "pending" && (!scope || scope.has(task.id))) {
      stage.queued++;
      if (!state.manifest.pausedStages?.some((pause) => pause.stage === task.stage) &&
        Object.values(task.dependencies).every((id) => state.receipts[id])) stage.ready++;
    }
    if (status === "running") stage.running++;
    const receipt = state.receipts[task.id];
    if (receipt) {
      stage.accepted++;
      if (receipt.acceptedAt >= now - 60000 && receipt.acceptedAt <= now) stage.recent_completed_per_minute++;
    }
  }
  const tasks = state.manifest.tasks.map((task) => ({
    id: task.id,
    ...state.manifest.states[task.id],
  }));
  const running = tasks.filter((task) => task.status === "running");
  const queued = tasks.filter((task) => task.status === "pending" && (!scope || scope.has(task.id))).length;
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
  return {
    stages,
    paused_stages: state.manifest.pausedStages ?? [],
    execution_scope_count: state.manifest.executionScope?.length ?? null,
    queued,
    running: running.length,
    accepted: Object.keys(state.receipts).length,
    repairing: running.filter((task) => task.failure?.draft !== undefined).length,
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
  };
}
