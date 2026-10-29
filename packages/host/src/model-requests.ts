import { HttpError, type AttemptSpec, type ModelConfig, type PlannedTask } from "@eval/contracts";

export interface ModelRequestContext {
  callId: string;
  runId: string;
  taskId: string;
  stage: string;
  model: ModelConfig;
  trafficGroup?: string;
  routes?: ModelConfig[];
}
export interface ModelPermit { model: ModelConfig; release(): void }
export interface ModelRequestControl {
  concurrency(): number;
  snapshot?(): unknown;
  disable?(channel: string, reason: string): void;
  available?(channels?: readonly string[]): boolean;
  setRunLimit?(runId: string, limit: number | undefined): void;
  acquire(context: ModelRequestContext, signal: AbortSignal): Promise<ModelPermit>;
}

/** Bind permits to live attempts and exclude manual scheduling waits from task deadlines. */
export function createModelRequests(control: ModelRequestControl | undefined) {
  const admission = new AbortController();
  const attempts = new Map<string, {
    spec: AttemptSpec; task: PlannedTask; routes?: ModelConfig[]; trafficGroup?: string; controller: AbortController; waited: number;
    waiting: Map<string, number>; active: Map<string, () => void>;
  }>();
  return {
    register(spec: AttemptSpec, task: PlannedTask, routes?: ModelConfig[], trafficGroup?: string) {
      if (control) attempts.set(spec.attemptId, { spec, task, routes, trafficGroup, controller: new AbortController(), waited: 0, waiting: new Map(), active: new Map() });
    },
    async acquire(attemptId: string, callId: string, signal: AbortSignal) {
      const attempt = attempts.get(attemptId);
      if (!attempt || !control) throw new HttpError(404, "Unknown controlled attempt");
      if (attempt.waiting.has(callId) || attempt.active.has(callId)) throw new HttpError(409, "Duplicate model request");
      const combined = AbortSignal.any([signal, attempt.controller.signal, admission.signal]);
      combined.throwIfAborted();
      const started = Date.now();
      attempt.waiting.set(callId, started);
      try {
        const permit = await control.acquire({ callId, runId: attempt.spec.runId, taskId: attempt.task.id,
          stage: attempt.task.stage, model: attempt.spec.model, routes: attempt.routes, trafficGroup: attempt.trafficGroup }, combined);
        if (combined.aborted) { permit.release(); combined.throwIfAborted(); }
        attempt.active.set(callId, permit.release);
        return permit.model;
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
    stopAdmission(reason: unknown) { admission.abort(reason); },
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
