import type { ModelRequestControl } from "./model-requests.js";

/** One permit per live provider request, shared by every run in this process. */
export function createChannelRequests(limits: Record<string, number>, weights: Record<string, number> = { default: 1 }) {
  if (!Object.keys(limits).length || Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 1))
    throw new Error("Channel request limits must be positive integers");
  if (!Object.keys(weights).length || Object.values(weights).some(value => !Number.isSafeInteger(value) || value < 1))
    throw new Error("Traffic weights must be positive integers");
  const active = new Map<string, number>();
  const calls = new Set<string>();
  const credits = new Map<string, Map<string, number>>();
  const usage = new Map<string, { active: number; granted: number }>();
  const waiting: { channel: string; group: string; grant(): void }[] = [];
  function pump() {
    for (const channel of Object.keys(limits)) {
      const credit = credits.get(channel) ?? new Map<string, number>();
      credits.set(channel, credit);
      while ((active.get(channel) ?? 0) < limits[channel]) {
        let selected: string | undefined, total = 0;
        for (const [group, weight] of Object.entries(weights)) {
          if (!waiting.some(item => item.channel === channel && item.group === group)) { credit.set(group, 0); continue; }
          total += weight;
          credit.set(group, (credit.get(group) ?? 0) + weight);
          if (!selected || credit.get(group)! > credit.get(selected)!) selected = group;
        }
        if (!selected) break;
        credit.set(selected, credit.get(selected)! - total);
        const index = waiting.findIndex(item => item.channel === channel && item.group === selected);
        waiting.splice(index, 1)[0].grant();
      }
    }
  }
  return {
    concurrency: () => Object.values(limits).reduce((sum, value) => sum + value, 0),
    snapshot: () => ({ updatedAt: new Date().toISOString(), weights, channels: Object.fromEntries(Object.entries(limits).map(([channel, limit]) =>
      [channel, { limit, active: active.get(channel) ?? 0, groups: Object.fromEntries(Object.keys(weights).map(group =>
        [group, { ...(usage.get(JSON.stringify([channel, group])) ?? { active: 0, granted: 0 }),
          waiting: waiting.filter(item => item.channel === channel && item.group === group).length }])) }])) }),
    acquire(context: Parameters<ModelRequestControl["acquire"]>[0], signal: AbortSignal): ReturnType<ModelRequestControl["acquire"]> {
      const channel = context.model.provider, group = context.trafficGroup ?? "default", key = JSON.stringify([context.runId, context.callId]);
      if (!Object.hasOwn(limits, channel)) return Promise.reject(new Error("Unallocated channel: " + channel));
      if (!Object.hasOwn(weights, group)) return Promise.reject(new Error("Unallocated traffic group: " + group));
      if (calls.has(key)) return Promise.reject(new Error("Duplicate model call: " + key));
      return new Promise((resolve, reject) => {
        signal.throwIfAborted();
        calls.add(key);
        const abort = () => {
          const index = waiting.indexOf(item);
          if (index >= 0) waiting.splice(index, 1);
          calls.delete(key);
          reject(signal.reason);
          pump();
        };
        const item = { channel, group, grant() {
          signal.removeEventListener("abort", abort);
          active.set(channel, (active.get(channel) ?? 0) + 1);
          const groupKey = JSON.stringify([channel, group]), counter = usage.get(groupKey) ?? { active: 0, granted: 0 };
          usage.set(groupKey, counter);
          counter.active++; counter.granted++;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            active.set(channel, active.get(channel)! - 1);
            counter.active--;
            calls.delete(key);
            pump();
          });
        } };
        signal.addEventListener("abort", abort, { once: true });
        waiting.push(item);
        queueMicrotask(pump);
      });
    },
  };
}
