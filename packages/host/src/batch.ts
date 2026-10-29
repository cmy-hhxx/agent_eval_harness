import { createChannelRequests } from "./channel-requests.js";
import type { ModelRequestControl } from "./model-requests.js";

export interface TaskDemand { running: number; ready: number }
export type TaskLimit = (demand: TaskDemand) => number;

export interface BatchJob {
  id: string;
  priority: number;
  run(control: ModelRequestControl, taskLimit: TaskLimit, signal: AbortSignal): Promise<Record<string, unknown>>;
}

/** One process owns the request gate and directly hands free capacity to surviving runs. */
export async function runBatch(jobs: BatchJob[], limits: Record<string, number>, taskConcurrency: number,
  signal: AbortSignal, event: (value: Record<string, unknown>) => void) {
  if (!jobs.length || new Set(jobs.map(job => job.id)).size !== jobs.length ||
    jobs.some(job => !job.id || !Number.isSafeInteger(job.priority)) ||
    !Number.isSafeInteger(taskConcurrency) || taskConcurrency < jobs.length)
    throw new Error("Batch needs unique runs, integer priorities and at least one task slot per run");
  const weights = Object.fromEntries(jobs.map(job => [job.id, 1]));
  const gate = createChannelRequests(limits, weights, () => 0, Object.fromEntries(jobs.map(job => [job.id, job.priority])));
  const live = new Set(jobs);
  const demand = new Map(jobs.map(job => [job, { running: 0, ready: 0 }]));
  const share = (job: BatchJob, limit: number, tasks: boolean) => {
    const allocations = new Map([...live].map(other => [other, tasks ? demand.get(other)!.running : 0]));
    let remaining = limit - [...allocations.values()].reduce((sum, count) => sum + count, 0);
    while (remaining-- > 0) {
      const candidates = [...live].filter(other => allocations.get(other)! < demand.get(other)!.running + demand.get(other)!.ready);
      candidates.sort((a, b) => a.priority - b.priority || allocations.get(a)! - allocations.get(b)!);
      if (!candidates.length) break;
      const next = candidates[0];
      allocations.set(next, allocations.get(next)! + 1);
    }
    return allocations.get(job) ?? 0;
  };
  const results: Record<string, Record<string, unknown>> = {};
  await Promise.all(jobs.map(async job => {
    const control: ModelRequestControl = { concurrency: () => share(job, gate.concurrency(), false),
      acquire: (context, cancelled) => gate.acquire({ ...context, trafficGroup: job.id }, cancelled), snapshot: gate.snapshot,
      disable: gate.disable, available: gate.available, setRunLimit: gate.setRunLimit };
    try {
      event({ event: "batch_run_started", run_id: job.id });
      while (!signal.aborted) {
        const result = await job.run(control, value => {
          demand.set(job, value);
          return share(job, taskConcurrency, true);
        }, signal);
        demand.set(job, { running: 0, ready: 0 });
        results[job.id] = result;
        if (!result.resource_pause || result.resource_pause === "model_channels_unavailable") break;
        event({ event: "batch_run_paused", run_id: job.id, reason: result.resource_pause });
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
          const timer = setTimeout(done, 30_000); signal.addEventListener("abort", done, { once: true });
          if (signal.aborted) done();
        });
      }
    } catch (error) {
      // A failed run is reported explicitly; independent runs keep their own lifecycle.
      results[job.id] = { status: "interrupted", error: error instanceof Error ? error.message : String(error) };
      event({ event: "batch_run_failed", run_id: job.id, ...results[job.id] });
    } finally {
      live.delete(job);
      event({ event: "batch_capacity_handoff", completed_run_id: job.id, remaining_runs: [...live].map(value => value.id),
        model_requests: gate.snapshot() });
    }
  }));
  return results;
}
