import type { PlannedTask, RunManifest, WorkflowScheduling } from "@eval/contracts";

/** Scopes are replaced or extended by accepted follow-up tasks. Index each revision once. */
export function createScopeMembership(manifest: Pick<RunManifest, "executionScope">): (id: string) => boolean {
  let scope: string[] | undefined, length = -1, selected = new Set<string>();
  return id => {
    const current = manifest.executionScope;
    if (!current) return true;
    if (current !== scope || current.length !== length) {
      scope = current;
      length = current.length;
      selected = new Set(current);
    }
    return selected.has(id);
  };
}

export interface SessionAdmissionSnapshot {
  total_sessions: number;
  active_sessions: number;
  completed_sessions: number;
  waiting_sessions: number;
  failed_sessions: number;
  blocked_sessions: number;
  admitted: ReadonlySet<string>;
}

/** Derive the foreground window only from durable task states so resume needs no cursor. */
export function sessionAdmissionSnapshot(
  tasks: readonly PlannedTask[],
  states: RunManifest["states"],
  policy: NonNullable<WorkflowScheduling["sessionAdmission"]>,
): SessionAdmissionSnapshot {
  if (!Number.isSafeInteger(policy.window) || policy.window < 1)
    throw new Error("Session admission window must be a positive integer");
  const sessions = new Map<string, { started: boolean; completed: boolean; failed: boolean; blocked: boolean }>();
  for (const task of tasks) {
    const id = policy.id(task);
    if (!id) continue;
    const state = states[task.id], status = state?.status ?? "pending",
      session = sessions.get(id) ?? { started: false, completed: false, failed: false, blocked: false };
    session.started ||= status !== "pending" || (state?.attempts ?? 0) > 0;
    session.completed ||= status === "succeeded" && policy.completed(task);
    session.failed ||= status === "failed" || status === "timed_out" || status === "cancelled";
    session.blocked ||= status === "blocked";
    sessions.set(id, session);
  }
  const admitted = new Set<string>();
  for (const [id, session] of sessions)
    if (session.started && (session.completed || session.failed || session.blocked)) admitted.add(id);
  const open = [...sessions].filter(([, session]) => !session.completed && !session.failed && !session.blocked);
  const selected = [...open.filter(([, session]) => session.started), ...open.filter(([, session]) => !session.started)]
    .slice(0, policy.window);
  for (const [id] of selected) admitted.add(id);
  const completed = [...sessions.values()].filter((session) => session.completed).length;
  const failed = [...sessions.values()].filter((session) => !session.completed && session.failed).length;
  const blocked = [...sessions.values()].filter((session) => !session.completed && !session.failed && session.blocked).length;
  const active = selected.length;
  return {
    total_sessions: sessions.size,
    active_sessions: active,
    completed_sessions: completed,
    waiting_sessions: sessions.size - completed - failed - blocked - active,
    failed_sessions: failed,
    blocked_sessions: blocked,
    admitted,
  };
}

// Share primary slots between stages; independent checks and polish follow decisions.
export function scheduleTasks(tasks: PlannedTask[], states: RunManifest["states"], stagePriority?: (stage: string) => number): PlannedTask[] {
  const priority = stagePriority ?? ((stage: string) => stage === "rewrite" ? 2 : stage === "instruction-review" ? 1 : 0);
  const stageByTask = new Map(tasks.map(task => [task.id, task.stage]));
  const continuation = (task: PlannedTask) => Object.values(task.dependencies).some(id => stageByTask.get(id) === task.stage);
  const stages = new Map<string, { tasks: PlannedTask[]; next: number; running: number }>();
  const waiting: PlannedTask[] = [];
  for (const task of tasks) {
    let stage = stages.get(task.stage);
    if (!stage) stages.set(task.stage, stage = { tasks: [], next: 0, running: 0 });
    const status = states[task.id]?.status;
    if (status === "running") stage.running++;
    if (status === "pending" && Object.values(task.dependencies).every((id) => states[id]?.status === "succeeded"))
      stage.tasks.push(task);
    else waiting.push(task);
  }
  for (const stage of stages.values()) stage.tasks.sort((a, b) => Number(continuation(b)) - Number(continuation(a)));
  // Plans list upstream stages first. Prefer downstream work when counts tie.
  const queues = [...stages.entries()].reverse().map(([name, stage]) => ({ ...stage, priority: priority(name) }));
  const scheduled: PlannedTask[] = [];
  for (;;) {
    let next: typeof queues[number] | undefined;
    for (const stage of queues)
      if (stage.next < stage.tasks.length && (!next || stage.priority < next.priority ||
        stage.priority === next.priority && stage.running < next.running)) next = stage;
    if (!next) break;
    scheduled.push(next.tasks[next.next++]!);
    next.running++;
  }
  // Preserve all tasks for dependency failure handling and ordinary readers.
  return scheduled.concat(waiting);
}
