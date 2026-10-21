import { readJson, writeJson } from "@eval/data";
import type { ModelRequestContext } from "@eval/host";

interface Allocation {
  concurrency: number;
}
type Settings = { sources: Record<string, Allocation> };
export const validLlmConcurrency = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

export async function loadLlmAllocations(file: string, defaults: Record<string, number>): Promise<Settings> {
  let value: Settings;
  try { value = await readJson(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    value = { sources: {} };
  }
  if (!value || Object.keys(value).length !== 1 || !value.sources || typeof value.sources !== "object" || Array.isArray(value.sources))
    throw new Error("Invalid LLM allocation settings");
  for (const [id, entry] of Object.entries(value.sources)) {
    if (!entry || !validLlmConcurrency(entry.concurrency) || Object.keys(entry).some(key => key !== "concurrency"))
      throw new Error("Invalid LLM allocation: " + id);
  }
  for (const [id, concurrency] of Object.entries(defaults)) value.sources[id] ??= { concurrency };
  return value;
}

interface Call {
  sourceId: string; date: string; callId: string; runId: string; taskId: string;
  stage: string; model: string; channel: string; queuedAt: number; startedAt?: number;
}

/** Allocation applies only while a provider stream is running; local work never takes a permit. */
export function createAutomationLlm(
  ids: string[], settings: Settings, save: (value: Settings) => Promise<void>,
) {
  const sources = new Set(ids), active = new Map<string, Call>();
  const waiting: { call: Call; grant(): void }[] = [];
  let writes = Promise.resolve();
  const concurrency = (source: string) => settings.sources[source]?.concurrency ?? 0;
  function pump() {
    for (let index = 0; index < waiting.length;) {
      const next = waiting[index];
      const count = [...active.values()].filter(call => call.sourceId === next.call.sourceId).length;
      if (count >= concurrency(next.call.sourceId)) { index++; continue; }
      waiting.splice(index, 1);
      next.grant();
    }
  }
  const change = (update: (value: Settings) => boolean) => {
    const next = writes.then(async () => {
      const value = structuredClone(settings);
      if (!update(value)) return;
      await save(value);
      settings = value;
      pump();
    });
    writes = next.catch(() => {});
    return next;
  };
  return {
    concurrency,
    acquire(sourceId: string, date: string, context: ModelRequestContext, signal: AbortSignal): Promise<() => void> {
      if (!sources.has(sourceId)) return Promise.reject(new Error("Unknown LLM source"));
      if (active.has(context.callId) || waiting.some(item => item.call.callId === context.callId))
        return Promise.reject(new Error("Duplicate LLM call"));
      const call: Call = { sourceId, date, callId: context.callId, runId: context.runId, taskId: context.taskId,
        stage: context.stage, model: context.model.model, channel: context.model.provider, queuedAt: Date.now() };
      return new Promise((resolve, reject) => {
        const abort = () => {
          const index = waiting.indexOf(item);
          if (index >= 0) waiting.splice(index, 1);
          reject(signal.reason);
        };
        const item = { call, grant: () => {
          signal.removeEventListener("abort", abort);
          call.startedAt = Date.now(); active.set(call.callId, call);
          let released = false;
          resolve(() => {
            if (released) return;
            released = true; active.delete(call.callId); pump();
          });
        } };
        if (signal.aborted) { reject(signal.reason); return; }
        signal.addEventListener("abort", abort, { once: true });
        waiting.push(item); pump();
      });
    },
    setConcurrency(sourceId: string, limit: number) {
      if (!sources.has(sourceId) || !validLlmConcurrency(limit)) return Promise.reject(new Error("Invalid LLM allocation"));
      return change(value => { value.sources[sourceId] = { concurrency: limit }; return true; });
    },
    snapshot: () => ({
      sources: ids.map(sourceId => ({ sourceId, concurrency: concurrency(sourceId),
        active: [...active.values()].filter(call => call.sourceId === sourceId).length,
        waiting: waiting.filter(item => item.call.sourceId === sourceId).length,
      })),
      active: [...active.values()].map(call => ({ ...call })),
      waiting: waiting.map(item => ({ ...item.call })),
    }),
  };
}

export async function automationLlm(file: string, defaults: Record<string, number>) {
  return createAutomationLlm(Object.keys(defaults), await loadLlmAllocations(file, defaults), value => writeJson(file, value));
}
