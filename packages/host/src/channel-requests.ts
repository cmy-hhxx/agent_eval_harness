import type { ModelRequestContext, ModelRequestControl } from "./model-requests.js";

/** One permit per live provider request, shared by every run in this process. */
export function createChannelRequests(limits: Record<string, number>, weights: Record<string, number> = { default: 1 },
  priority: (context: ModelRequestContext) => number = () => 0, groupPriority: Record<string, number> = {}, totalLimit = Infinity) {
  if (!Object.keys(limits).length || Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 1))
    throw new Error("Channel request limits must be positive integers");
  if (!Object.keys(weights).length || Object.values(weights).some(value => !Number.isSafeInteger(value) || value < 1))
    throw new Error("Traffic weights must be positive integers");
  if (totalLimit !== Infinity && (!Number.isSafeInteger(totalLimit) || totalLimit < 1)) throw new Error("Total model request limit must be a positive integer");
  const active = new Map<string, number>();
  const calls = new Set<string>();
  const credits = new Map<string, Map<string, number>>();
  const usage = new Map<string, { active: number; granted: number }>();
  const disabled = new Map<string, string>();
  const runLimits = new Map<string, number>(), runActive = new Map<string, number>();
  const waiting: { runId: string; channels: string[]; group: string; priority: number; grant(channel: string): void; deny(): void }[] = [];
  const admissible = (item: typeof waiting[number]) => (runActive.get(item.runId) ?? 0) < (runLimits.get(item.runId) ?? Infinity);
  const channels = Object.keys(limits);
  let nextChannel = 0;
  function pump() {
    while ([...active.values()].reduce((sum, value) => sum + value, 0) < totalLimit) {
      let granted = false;
      for (let offset = 0; offset < channels.length; offset++) {
        const channelIndex = (nextChannel + offset) % channels.length, channel = channels[channelIndex];
        if (disabled.has(channel) || (active.get(channel) ?? 0) >= limits[channel]) continue;
        const credit = credits.get(channel) ?? new Map<string, number>();
        credits.set(channel, credit);
        let selected: string | undefined, total = 0;
        const groups = Object.keys(weights).filter(group => waiting.some(item => item.channels.includes(channel) && item.group === group && admissible(item)));
        const bestPriority = Math.min(...groups.map(group => groupPriority[group] ?? 0));
        for (const group of groups) {
          const weight = weights[group];
          if ((groupPriority[group] ?? 0) !== bestPriority) continue;
          total += weight;
          credit.set(group, (credit.get(group) ?? 0) + weight);
          if (!selected || credit.get(group)! > credit.get(selected)!) selected = group;
        }
        if (!selected) continue;
        credit.set(selected, credit.get(selected)! - total);
        let index = -1;
        for (let candidate = 0; candidate < waiting.length; candidate++) {
          const item = waiting[candidate];
          if (item.channels.includes(channel) && item.group === selected && admissible(item) &&
              (index < 0 || item.priority < waiting[index].priority)) index = candidate;
        }
        waiting.splice(index, 1)[0].grant(channel);
        nextChannel = (channelIndex + 1) % channels.length;
        granted = true;
        break;
      }
      if (!granted) break;
    }
  }
  return {
    setCapacity(next: Record<string, number>, total: number) {
      if (Object.keys(next).length !== Object.keys(limits).length ||
          Object.keys(limits).some(channel => !Object.hasOwn(next, channel)) ||
          Object.values(next).some(value => !Number.isSafeInteger(value) || value < 1) ||
          !Number.isSafeInteger(total) || total < 1)
        throw new Error("Capacity requires the existing channels and positive integer limits");
      limits = { ...next };
      totalLimit = total;
      pump();
    },
    setRunLimit(runId: string, limit: number | undefined) {
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error("Run request limit must be a positive integer");
      if (limit === undefined) runLimits.delete(runId); else runLimits.set(runId, limit);
      pump();
    },
    available: (channels: readonly string[] = Object.keys(limits)) => channels.some(channel => Object.hasOwn(limits, channel) && !disabled.has(channel)),
    disable(channel: string, reason: string) {
      if (!Object.hasOwn(limits, channel)) throw new Error("Unallocated channel: " + channel);
      disabled.set(channel, reason);
      for (const item of [...waiting]) if (item.channels.every(value => disabled.has(value))) item.deny();
      pump();
    },
    concurrency: () => Math.min(totalLimit, Object.values(limits).reduce((sum, value) => sum + value, 0)),
    snapshot: () => ({ updatedAt: new Date().toISOString(), weights,
      limit: Math.min(totalLimit, Object.values(limits).reduce((sum, value) => sum + value, 0)),
      available_limit: Math.min(totalLimit, Object.entries(limits).reduce((sum, [channel, limit]) => sum + (disabled.has(channel) ? 0 : limit), 0)),
      active: [...active.values()].reduce((sum, value) => sum + value, 0), queued: waiting.length,
      runs: Object.fromEntries([...new Set([...runActive.keys(), ...runLimits.keys()])].map(runId => [runId,
        { active: runActive.get(runId) ?? 0, limit: runLimits.get(runId) ?? null }])),
      channels: Object.fromEntries(Object.entries(limits).map(([channel, limit]) =>
      [channel, { limit, active: active.get(channel) ?? 0, disabled_reason: disabled.get(channel), groups: Object.fromEntries(Object.keys(weights).map(group =>
        [group, { ...(usage.get(JSON.stringify([channel, group])) ?? { active: 0, granted: 0 }),
          waiting: waiting.filter(item => item.channels.includes(channel) && item.group === group).length }])) }])) }),
    acquire(context: Parameters<ModelRequestControl["acquire"]>[0], signal: AbortSignal): ReturnType<ModelRequestControl["acquire"]> {
      const routes = context.routes ?? [context.model], channels = routes.map(model => model.provider);
      const group = context.trafficGroup ?? "default", key = JSON.stringify([context.runId, context.callId]);
      if (!channels.length || channels.some(channel => !Object.hasOwn(limits, channel))) return Promise.reject(new Error("Unallocated channel: " + channels.join(",")));
      if (!Object.hasOwn(weights, group)) return Promise.reject(new Error("Unallocated traffic group: " + group));
      if (channels.every(channel => disabled.has(channel))) return Promise.reject(new Error("Model capacity unavailable: configured gateways are disabled"));
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
        const item = { runId: context.runId, channels, group, priority: priority(context), deny() {
          signal.removeEventListener("abort", abort);
          const index = waiting.indexOf(item); if (index >= 0) waiting.splice(index, 1);
          calls.delete(key); reject(new Error("Model capacity unavailable: configured gateways are disabled"));
        }, grant(channel: string) {
          signal.removeEventListener("abort", abort);
          active.set(channel, (active.get(channel) ?? 0) + 1);
          runActive.set(context.runId, (runActive.get(context.runId) ?? 0) + 1);
          const groupKey = JSON.stringify([channel, group]), counter = usage.get(groupKey) ?? { active: 0, granted: 0 };
          usage.set(groupKey, counter);
          counter.active++; counter.granted++;
          let released = false;
          resolve({ model: routes.find(model => model.provider === channel)!, release: () => {
            if (released) return;
            released = true;
            active.set(channel, active.get(channel)! - 1);
            runActive.set(context.runId, runActive.get(context.runId)! - 1);
            counter.active--;
            calls.delete(key);
            pump();
          } });
        } };
        signal.addEventListener("abort", abort, { once: true });
        waiting.push(item);
        queueMicrotask(pump);
      });
    },
  };
}
