import type { RunState } from "../../../packages/contracts/src/index.js";

export function progressSnapshot(state: RunState, now = Date.now()) {
  const tasks = state.manifest.tasks.map((task) => ({ id: task.id, ...state.manifest.states[task.id] }));
  const running = tasks.filter((task) => task.status === "running");
  const queued = tasks.filter((task) => task.status === "pending").length;
  const failures: Record<string, number> = {};
  for (const task of tasks) if (["failed", "timed_out", "cancelled", "blocked"].includes(task.status)) {
    const category = task.failure?.errors[0]?.category || "interruption";
    failures[category] = (failures[category] || 0) + 1;
  }
  const completed = tasks.filter((task) => task.status === "succeeded" && task.durationMs)
    .sort((a, b) => (state.receipts[b.id]?.acceptedAt || 0) - (state.receipts[a.id]?.acceptedAt || 0)).slice(0, 50);
  const durations = completed.map((task) => task.durationMs!).sort((a, b) => a - b);
  const concurrency = state.manifest.concurrency || 1;
  const remaining = queued + running.length;
  const waves = Math.ceil(remaining / concurrency);
  const eta = durations.length < 5 ? null : {
    p50_seconds: Math.round(waves * durations[Math.floor((durations.length - 1) * 0.5)] / 1000),
    p95_seconds: Math.round(waves * durations[Math.floor((durations.length - 1) * 0.95)] / 1000),
    note: "近期任务耗时估计，尾部修复可能超出区间",
  };
  const longest = running.sort((a, b) => (a.lastProgressAt || a.startedAt || now) - (b.lastProgressAt || b.startedAt || now))[0];
  return { queued, running: running.length, accepted: Object.keys(state.receipts).length,
    repairing: running.filter((task) => task.failure?.draft !== undefined).length,
    failures, concurrency, recent_completed_per_minute: Object.values(state.receipts).filter((r) => r.acceptedAt >= now - 60000).length,
    longest_without_progress: longest ? { task_id: longest.id, seconds: Math.round((now - (longest.lastProgressAt || longest.startedAt || now)) / 1000) } : null,
    eta, eta_status: eta ? "estimated" : "insufficient_samples" };
}
