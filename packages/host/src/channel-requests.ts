import type { ModelRequestControl } from "./model-requests.js";

/** One permit per live provider request, shared by every run in this process. */
export function createChannelRequests(limits: Record<string, number>): ModelRequestControl {
  if (!Object.keys(limits).length || Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 1))
    throw new Error("Channel request limits must be positive integers");
  const active = new Map<string, number>();
  const calls = new Set<string>();
  const waiting: { channel: string; grant(): void }[] = [];
  function pump() {
    for (let index = 0; index < waiting.length;) {
      const item = waiting[index];
      if ((active.get(item.channel) ?? 0) >= limits[item.channel]) { index++; continue; }
      waiting.splice(index, 1);
      item.grant();
    }
  }
  return {
    concurrency: () => Object.values(limits).reduce((sum, value) => sum + value, 0),
    acquire(context, signal) {
      const channel = context.model.provider, key = JSON.stringify([context.runId, context.callId]);
      if (!Object.hasOwn(limits, channel)) return Promise.reject(new Error("Unallocated channel: " + channel));
      if (calls.has(key)) return Promise.reject(new Error("Duplicate model call: " + key));
      return new Promise((resolve, reject) => {
        signal.throwIfAborted();
        calls.add(key);
        const abort = () => {
          const index = waiting.indexOf(item);
          if (index >= 0) waiting.splice(index, 1);
          calls.delete(key);
          reject(signal.reason);
        };
        const item = { channel, grant() {
          signal.removeEventListener("abort", abort);
          active.set(channel, (active.get(channel) ?? 0) + 1);
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            active.set(channel, active.get(channel)! - 1);
            calls.delete(key);
            pump();
          });
        } };
        signal.addEventListener("abort", abort, { once: true });
        waiting.push(item);
        pump();
      });
    },
  };
}
