import path from "node:path";
import { RuntimeLogReader, exists, locateRun, type LogPosition } from "@eval/data";
import { runErrorTasks } from "@eval/workflows/comparison";

export class DashboardErrors {
  private reader: RuntimeLogReader;
  private entries: { runId: string; taskId?: string; position: LogPosition }[] = [];
  private polling = Promise.resolve();
  constructor(directory: string) { this.reader = new RuntimeLogReader(path.join(directory, "runtime.log")); }
  async read(run: string, query: URLSearchParams) {
    const page = Number(query.get("page") || 1), size = 40;
    if (!Number.isSafeInteger(page) || page < 1) throw new Error("Invalid page");
    this.polling = this.polling.catch(() => {}).then(() => this.reader.poll((record, position) => {
      if (typeof record.run_id === "string") this.entries.push({ runId: record.run_id,
        taskId: typeof record.task_id === "string" ? record.task_id : undefined, position });
    }, () => { this.entries = []; }));
    await this.polling;
    const runId = path.basename(run), tasks = await exists(locateRun(run).stateFile) ? await runErrorTasks(run) : [], byId = new Map(tasks.map(task => [task.task_id, task]));
    const taskId = query.get("task"), stage = query.get("stage"), sample = query.get("case"), history = query.get("history") === "true";
    const match = (task: typeof tasks[number]) => (!taskId || taskId === task.task_id) && (!stage || stage === task.stage) &&
      (!sample || task.locations.some(location => location.case_id.includes(sample)));
    const unresolved = tasks.filter(task => !task.recovered && (task.reason || task.errors.length || ["failed","timed_out","blocked","cancelled"].includes(task.status)) && match(task));
    const entries = this.entries.filter(entry => entry.runId === runId && (!taskId || entry.taskId === taskId) &&
      (entry.taskId ? byId.has(entry.taskId) && match(byId.get(entry.taskId)!) && (history || !byId.get(entry.taskId)!.recovered) : !stage && !sample));
    const records = await Promise.all(entries.slice().reverse().slice((page - 1) * size, page * size).map(async entry => ({
      record: await this.reader.read(entry.position), task: entry.taskId ? byId.get(entry.taskId) : undefined,
      recovery: entry.taskId ? byId.get(entry.taskId)?.recovered ? "recovered" : "unresolved" : "unknown",
    })));
    return { page, page_size: size, total: entries.length, unresolved_count: unresolved.length,
      tasks: unresolved.slice((page - 1) * size, page * size), records };
  }
}
