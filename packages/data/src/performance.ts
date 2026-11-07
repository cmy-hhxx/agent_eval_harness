import path from "node:path";
import type { TaskPerformance } from "@eval/contracts";
import { appendLines } from "./files.js";

/** Run-owned attempt costs; a write failure must never fail evaluation. */
export interface PerformanceLog {
  record(row: TaskPerformance): Promise<void>;
  /** Durably write every recorded row; call before the run's process exits. */
  close(): Promise<void>;
}

function project(row: TaskPerformance) {
  return {
    run_id: row.runId,
    task_id: row.taskId,
    stage: row.stage,
    attempt_id: row.attemptId,
    attempt: row.attempt,
    status: row.status,
    confirmed: row.confirmed,
    channel: row.channel ?? null,
    model: row.model,
    model_usage: row.modelUsage,
    input_ids: row.inputIds,
    identity: row.identity ?? null,
    usage: row.usage,
    reasoning_tokens: row.reasoningTokens,
    cache_hit_ratio: row.usage.input + row.usage.cacheRead + row.usage.cacheWrite > 0
      ? row.usage.cacheRead / (row.usage.input + row.usage.cacheRead + row.usage.cacheWrite) : null,
    calls: row.calls,
    required_read_calls: row.requiredReadCalls,
    content_submissions: row.contentSubmissions,
    timings: row.timings,
    started_at: row.startedAt,
    finished_at: row.finishedAt,
    wall_ms: row.wallMs,
  };
}

/** One JSONL row per attempt, beside the run for throughput and cost analysis. */
export function createPerformanceLog(run: string): PerformanceLog {
  const file = path.join(run, "performance.jsonl");
  let pending: string[] = [], flushing: Promise<void> | undefined,
    timer: ReturnType<typeof setTimeout> | undefined;
  // Shared mounts charge a full fsync per append, so concurrent attempts would queue
  // behind each other's finalization; write each visible batch in one durable append.
  const flush = (): Promise<void> => {
    if (flushing) return flushing;
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    if (!pending.length) return Promise.resolve();
    const batch = pending;
    pending = [];
    // One failing batch must not stop later rows from being written.
    flushing = appendLines(file, batch).catch(() => {}).finally(() => {
      flushing = undefined;
      if (pending.length) void flush();
    });
    return flushing;
  };
  return {
    record(row) {
      // Serialize before a row leaves the caller so an unrepresentable value is still reported.
      try { pending.push(JSON.stringify(project(row)) + "\n"); } catch (error) { return Promise.reject(error); }
      // An attempt never waits for log durability.
      if (timer === undefined) timer = setTimeout(() => void flush(), 1000);
      return Promise.resolve();
    },
    async close() {
      await flush();
      if (pending.length || flushing) await flush();
    },
  };
}
