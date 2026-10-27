import { HttpError, type AttemptSpec, type ModelConfig, type PlannedTask } from "@eval/contracts";

export interface ModelRequestContext {
  callId: string;
  runId: string;
  taskId: string;
  stage: string;
  model: ModelConfig;
  trafficGroup?: string;
}
export interface ModelRequestControl {
  concurrency(): number;
  acquire(context: ModelRequestContext, signal: AbortSignal): Promise<() => void>;
}

/** Bind permits to live attempts and exclude manual scheduling waits from task deadlines. */
export function createModelRequests(control: ModelRequestControl | undefined) {
  const attempts = new Map<string, {
    spec: AttemptSpec; task: PlannedTask; controller: AbortController; waited: number;
    waiting: Map<string, number>; active: Map<string, () => void>;
  }>();
  return {
    register(spec: AttemptSpec, task: PlannedTask) {
      if (control) attempts.set(spec.attemptId, { spec, task, controller: new AbortController(), waited: 0, waiting: new Map(), active: new Map() });
    },
    async acquire(attemptId: string, callId: string, signal: AbortSignal) {
      const attempt = attempts.get(attemptId);
      if (!attempt || !control) throw new HttpError(404, "Unknown controlled attempt");
      if (attempt.waiting.has(callId) || attempt.active.has(callId)) throw new HttpError(409, "Duplicate model request");
      const combined = AbortSignal.any([signal, attempt.controller.signal]);
      const started = Date.now();
      attempt.waiting.set(callId, started);
      try {
        const release = await control.acquire({ callId, runId: attempt.spec.runId, taskId: attempt.task.id,
          stage: attempt.task.stage, model: attempt.spec.model }, combined);
        if (combined.aborted) { release(); combined.throwIfAborted(); }
        attempt.active.set(callId, release);
      } finally {
        attempt.waited += Date.now() - started;
        attempt.waiting.delete(callId);
      }
    },
    release(attemptId: string, callId: string) {
      const attempt = attempts.get(attemptId);
      attempt?.active.get(callId)?.();
      attempt?.active.delete(callId);
    },
    deadline(spec: AttemptSpec) {
      const attempt = attempts.get(spec.attemptId);
      return spec.deadline + (attempt?.waited ?? 0) +
        [...(attempt?.waiting.values() ?? [])].reduce((sum, at) => sum + Date.now() - at, 0);
    },
    remove(attemptId: string) {
      const attempt = attempts.get(attemptId);
      attempt?.controller.abort(new Error("Attempt ended"));
      for (const release of attempt?.active.values() ?? []) release();
      attempts.delete(attemptId);
    },
  };
}
