import type { AutomationState } from "@eval/automations";
import { object, type JsonObject } from "@eval/contracts";
import { readJson, readStatisticsLog } from "@eval/data";
import { assertStatisticsLog } from "@eval/workflows/comparison";
import type { StatisticsDeliveryRecord } from "./statistics-delivery.js";

function percentage(completed: number, total: number) {
  return total === 0 ? null : Number((completed / total * 100).toFixed(2));
}

/** A durable log line is usable as published history only with a completed upload receipt. */
export async function readPublishedStatistics(files: { stateFile: string; logFile: string; deliveryFile: string }) {
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
  const progress = data.progress as { expectedBattleCount: number; completedBattleCount: number; completedCaseCount: number };
  const stats = data.stats as (JsonObject & { evaluated: number; wins: number; both_good: number; both_bad: number })[];
  return { status: "published" as const, traceId: record.traceId, snapshotAt: record.logtime, publishedAt: delivery.uploadedAt,
    requestDates: (data.requestDates as { date: string }[]).map(item => item.date),
    caseCount: data.caseCount, totalCaseCount: data.totalCaseCount, models: data.models,
    stats: stats.map((row): JsonObject & { losses: number } => ({ ...row, losses: row.evaluated - row.wins - row.both_good - row.both_bad })),
    progress: { ...progress,
      battleCompletionRate: percentage(progress.completedBattleCount, progress.expectedBattleCount),
      caseCompletionRate: percentage(progress.completedCaseCount, data.totalCaseCount as number),
    } };
}
