import type { AutomationState } from "@eval/automations";
import { object } from "@eval/contracts";
import { readJson, readStatisticsLog } from "@eval/data";
import { assertStatisticsLog } from "@eval/workflows/comparison";

/** A durable log line is usable as published history only with a completed upload receipt. */
export async function readPublishedStatistics(files: { stateFile: string; logFile: string }) {
  const state = await readJson<AutomationState>(files.stateFile);
  const delivery = [...(state.publicationHistory ?? []), ...(state.publication ? [state.publication] : [])]
    .filter(item => item.status === "completed" && item.log?.status === "uploaded" && item.traceId && item.completedAt !== undefined)
    .sort((a, b) => b.completedAt! - a.completedAt!)[0];
  if (!delivery) throw new Error("没有完整发布成功的累计统计。");
  const record = await readStatisticsLog(files.logFile, delivery.traceId!);
  if (!record) throw new Error("已发布统计的日志记录缺失：" + delivery.traceId);
  assertStatisticsLog(record);
  const data = object(record.data);
  return { status: "published" as const, traceId: record.traceId, snapshotAt: record.logtime, publishedAt: delivery.completedAt,
    requestDates: (data.requestDates as { date: string }[]).map(item => item.date),
    caseCount: data.caseCount, totalCaseCount: data.totalCaseCount, models: data.models, stats: data.stats, progress: data.progress };
}
