import type { PlannedTask, RunManifest } from "@eval/contracts";

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

// Share free slots between ready stages; a large upstream backlog must not
// prevent work with already accepted dependencies from reaching its next stage.
export function scheduleTasks(tasks: PlannedTask[], states: RunManifest["states"]): PlannedTask[] {
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
  // Plans list upstream stages first. Prefer downstream work when counts tie.
  const queues = [...stages.values()].reverse();
  const scheduled: PlannedTask[] = [];
  for (;;) {
    let next: typeof queues[number] | undefined;
    for (const stage of queues)
      if (stage.next < stage.tasks.length && (!next || stage.running < next.running)) next = stage;
    if (!next) break;
    scheduled.push(next.tasks[next.next++]!);
    next.running++;
  }
  // Preserve all tasks for dependency failure handling and ordinary readers.
  return scheduled.concat(waiting);
}
