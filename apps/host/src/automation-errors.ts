import { HttpError } from "@eval/contracts";
import { RuntimeLogReader, type LogPosition } from "@eval/data";
import type { AutomationState } from "@eval/automations";

interface Entry { position: LogPosition; time: number; runId: string; date: string; automationId: string; component: string }

/** Only metadata is indexed. The full, redacted source records are read for the requested page. */
export function automationErrors(file: string, state: () => AutomationState) {
  const reader = new RuntimeLogReader(file);
  let entries: Entry[] = [], refreshing: Promise<void> | undefined;
  return async (params: URLSearchParams, now = Date.now()) => {
    const page = Number(params.get("page") ?? 1), range = params.get("hours") ?? "24";
    if (!Number.isSafeInteger(page) || page < 1 || !["24", "168", "all"].includes(range)) throw new HttpError(400, "Invalid error-log filter");
    const snapshot = state(), date = params.get("date") ?? "";
    if (date && !snapshot.jobs[date]) throw new HttpError(400, "Unknown error-log date");
    refreshing ??= reader.poll((record, position) => {
      entries.push({ position, time: Date.parse(String(record.time)) || 0,
        runId: String(record.run_id ?? ""), date: String(record.date ?? ""), automationId: String(record.automation_id ?? ""), component: String(record.component ?? "") });
    }, () => { entries = []; }).finally(() => { refreshing = undefined; });
    await refreshing;
    const runDates = new Map(Object.values(snapshot.jobs).flatMap(job => job.runIds.map(id => [id, job.date] as const)));
    const cutoff = range === "all" ? 0 : now - Number(range) * 3600000;
    const rows = entries.filter(entry => (entry.component === "logging" ||
      entry.component === "automations" && (!entry.automationId || entry.automationId === snapshot.id) || runDates.has(entry.runId)) &&
      (!date || (entry.date || runDates.get(entry.runId)) === date) && (!entry.time || entry.time >= cutoff));
    const total = rows.length, pageSize = 10;
    const currentPage = Math.min(page, Math.max(1, Math.ceil(total / pageSize))), start = (currentPage - 1) * pageSize;
    const records = await Promise.all(rows.reverse().slice(start, start + pageSize).map(async entry => ({
      id: entry.position.offset, date: entry.date || runDates.get(entry.runId), record: await reader.read(entry.position),
    })));
    return { sampledAt: now, total, page: currentPage, pageSize,
      dates: Object.keys(snapshot.jobs).sort().reverse(), records };
  };
}
