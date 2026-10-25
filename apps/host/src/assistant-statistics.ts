import type { AutomationState } from "@eval/automations";
import { object, type AnalysisQuery, type JsonObject } from "@eval/contracts";
import { readJson, readStatisticsLog } from "@eval/data";
import { assertStatisticsLog } from "@eval/workflows/comparison";
import type { StatisticsDeliveryRecord } from "./statistics-delivery.js";

function percentage(completed: number, total: number) {
  return total === 0 ? null : Number((completed / total * 100).toFixed(2));
}

type Counts = JsonObject & { evaluated: number; wins: number; both_good: number; both_bad: number; winRate: number };
type Progress = { expectedBattleCount: number; completedBattleCount: number; completedCaseCount: number };
const statistics = (rows: Counts[]) => rows.map(row => {
  const losses = row.evaluated - row.wins - row.both_good - row.both_bad;
  return { ...row, winRate: row.evaluated === 0 ? null : row.winRate, losses, lossRate: percentage(losses, row.evaluated),
    bothGoodRate: percentage(row.both_good, row.evaluated), bothBadRate: percentage(row.both_bad, row.evaluated) };
});
const progressRates = (progress: Progress, count: number) => ({ ...progress,
  battleCompletionRate: percentage(progress.completedBattleCount, progress.expectedBattleCount),
  caseCompletionRate: percentage(progress.completedCaseCount, count),
});

/** A durable log line is usable as published history only with a completed upload receipt. */
export async function readPublishedStatistics(files: { stateFile: string; logFile: string; deliveryFile: string }, query: Pick<AnalysisQuery, "breakdown" | "offset" | "limit"> = {}) {
  const state = await readJson<AutomationState>(files.stateFile);
  const traceId = state.statistics?.lastTraceId;
  if (!traceId) throw new Error("没有完整发布成功的累计统计。");
  const ledger = await readJson<{ records?: Record<string, StatisticsDeliveryRecord> }>(files.deliveryFile);
  const delivery = ledger.records?.[traceId];
  if (!delivery || delivery.status !== "uploaded" || !delivery.uploadedAt) throw new Error("没有完整发布成功的累计统计。");
  const record = await readStatisticsLog(files.logFile, traceId);
  if (!record) throw new Error("已发布统计的日志记录缺失：" + traceId);
  assertStatisticsLog(record);
  const data = object(record.data);
  let breakdown;
  if (query.breakdown) {
    const groups = data[query.breakdown === "date" ? "requestDates" : query.breakdown === "task" ? "tasks" : "difficultyLevels"] as JsonObject[];
    const offset = query.offset ?? 0, limit = Math.min(query.limit ?? 20, 100), end = Math.min(groups.length, offset + limit);
    breakdown = { dimension: query.breakdown, total: groups.length, offset, limit, hasMore: end < groups.length, nextOffset: end < groups.length ? end : null,
      items: groups.slice(offset, end).map(group => ({
        ...(query.breakdown === "date" ? { date: group.date, caseCount: group.caseCount, totalCaseCount: group.totalCaseCount }
          : { id: group.id, name: group.name, count: group.count, evaluatedCount: group.evaluatedCount,
            ...(query.breakdown === "difficulty" ? { description: group.description } : {}) }),
        stats: statistics(group.stats as Counts[]),
        progress: progressRates(group.progress as Progress, (query.breakdown === "date" ? group.totalCaseCount : group.count) as number),
      })) };
  }
  return { status: "published" as const, traceId: record.traceId, snapshotAt: record.logtime, publishedAt: delivery.uploadedAt,
    requestDates: (data.requestDates as { date: string }[]).map(item => item.date),
    caseCount: data.caseCount, totalCaseCount: data.totalCaseCount, models: data.models,
    stats: statistics(data.stats as Counts[]), progress: progressRates(data.progress as Progress, data.totalCaseCount as number),
    ...(breakdown ? { breakdown } : {}) };
}
