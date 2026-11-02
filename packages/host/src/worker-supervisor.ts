import path from "node:path";
import { randomUUID } from "node:crypto";
import { canonical, errorText, type EngineIdentity, type WorkerStatus } from "@eval/contracts";
import { spawnWorker, WorkerStartupError, type WorkerProcess } from "@eval/runtime/client";
import { request } from "@eval/runtime/http";

export interface WorkerSlot { url: string; health: WorkerStatus; owner?: WorkerProcess; reserved?: boolean }
interface Capacity { size: number; failures: number; restarts: number; retryAt: number; exhausted: boolean; owner?: WorkerProcess }

/** Owns process capacity. Scheduling only consumes ready slots and never waits for startup. */
export class WorkerSupervisor {
  readonly slots: WorkerSlot[] = [];
  private readonly capacity: Capacity[] = [];
  private readonly dead = new WeakSet<WorkerProcess>();
  private readonly closing = new Set<Promise<void>>();
  private starting = 0;
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly controller = new AbortController();
  private readonly launches = new Set<Promise<void>>();
  private readonly demand = new Map<string, number>();
  private probeAt = 0;
  private target = 0;
  constructor(private readonly options: {
    identity: EngineIdentity; runtime: { root: string; workerEntry: string; workerSlots?: number };
    directory: string; retries: number; retryDelaySeconds: number;
    maxSlots?: number;
    wake(): void; event(name: string, detail: Record<string, unknown>): void;
    spawn?: typeof spawnWorker;
  }) {}
  snapshot() {
    return { ready_slots: this.slots.filter(slot => !slot.reserved).length, total_slots: this.slots.length, starting_processes: this.starting,
      quarantined_slots: this.capacity.filter(unit => unit.exhausted).reduce((n, unit) => n + unit.size, 0),
      restart_failures: this.capacity.reduce((n, unit) => n + unit.failures, 0) };
  }
  exited(owner: WorkerProcess | undefined) { return !!owner && this.dead.has(owner); }
  exhausted() { return this.capacity.length > 0 && this.capacity.every(unit => unit.exhausted) && !this.starting; }
  setDemand(run: string, slots: number) {
    if (slots) this.demand.set(run, slots); else this.demand.delete(run);
    const total = [...this.demand.values()].reduce((sum, count) => sum + count, 0);
    const slotsPerProcess = this.options.runtime.workerSlots ?? 1;
    if (total) this.retryQuarantined();
    this.setTarget(this.options.maxSlots === undefined ? total : Math.min(this.options.maxSlots, Math.ceil(total / slotsPerProcess) * slotsPerProcess));
  }
  retryQuarantined() {
    if (Date.now() < this.probeAt) return;
    this.probeAt = Date.now() + 30_000;
    for (const unit of this.capacity) if (unit.exhausted && !unit.owner) {
      unit.failures = 0; unit.restarts = 0; unit.exhausted = false; unit.retryAt = Date.now();
    }
    this.pump();
  }
  setTarget(target: number) {
    if (this.closed) return;
    this.target = target;
    // Prove a small amount of capacity before preparing the next batch. An
    // unavailable SDK must not turn a target of 350 into 350 startup timeouts.
    const planned = Math.min(target, this.slots.length + 2 * (this.options.runtime.workerSlots ?? 1));
    let size = this.capacity.reduce((n, unit) => n + unit.size, 0);
    while (size < planned) {
      const count = Math.min(this.options.runtime.workerSlots ?? 1, planned - size);
      this.capacity.push({ size: count, failures: 0, restarts: 0, retryAt: 0, exhausted: false }); size += count;
    }
    this.pump();
  }
  private pump() {
    clearTimeout(this.timer);
    if (this.closed || this.target === 0) return;
    for (const unit of this.capacity) {
      if (this.starting >= 2) break;
      if (unit.owner || unit.exhausted || unit.retryAt > Date.now()) continue;
      // A reserved owner prevents another wakeup from starting this capacity twice.
      unit.retryAt = Infinity; this.starting++;
      const launch = this.launch(unit).finally(() => {
        this.launches.delete(launch); this.starting--; this.options.wake(); this.setTarget(this.target);
      });
      this.launches.add(launch);
      void launch.catch(error => this.options.event("worker_cleanup_failed", { error: errorText(error) }));
    }
    const next = Math.min(...this.capacity.filter(unit => !unit.owner && !unit.exhausted).map(unit => unit.retryAt));
    if (Number.isFinite(next)) this.timer = setTimeout(() => this.pump(), Math.max(1, next - Date.now()));
  }
  private async launch(unit: Capacity) {
    let owner: WorkerProcess | undefined;
    try {
      owner = await (this.options.spawn ?? spawnWorker)(this.options.identity.engine,
        path.join(this.options.directory, randomUUID()), { ...this.options.runtime, workerSlots: unit.size, signal: this.controller.signal });
      const health = await Promise.all(owner.urls.map(url => request<WorkerStatus>(url + "/api/health", "GET", undefined, AbortSignal.timeout(10_000))));
      if (owner.urls.length !== unit.size || health.some(value => canonical(value.identity) !== canonical(this.options.identity)))
        throw new Error("Worker identity or slot count mismatch");
      if (this.closed) { await owner.close(); return; }
      unit.owner = owner;
      owner.urls.forEach((url, index) => this.slots.push({ url, health: health[index], owner }));
      this.options.event("worker_ready", { pid: owner.pid, slots: unit.size });
      const process = owner;
      void owner.exited.then(exit => {
        this.remove(process);
        if (!this.closed) {
          unit.owner = undefined; unit.retryAt = Date.now();
          unit.restarts = exit.expectedClose ? 0 : unit.restarts + 1;
          unit.exhausted = unit.restarts > Math.max(1, this.options.retries);
          if (unit.exhausted) this.options.event("worker_capacity_quarantined",
            { slots: unit.size, restarts: unit.restarts, error: "Unexpected Worker exit retry budget exhausted" });
          this.options.event("worker_exited", { ...exit }); this.options.wake(); this.pump();
        }
      });
    } catch (error) {
      if (error instanceof WorkerStartupError) owner = error.worker;
      if (owner) {
        try { await owner.close(); }
        catch (cleanupError) {
          // Unconfirmed termination cannot be treated as free capacity on the next probe.
          unit.owner = owner;
          const process = owner;
          void owner.exited.then(exit => {
            this.remove(process);
            unit.owner = undefined;
            this.options.event("worker_exited", { ...exit }); this.options.wake();
          });
          this.options.event("worker_cleanup_failed", { pid: owner.pid, error: errorText(cleanupError) });
        }
      }
      unit.failures++; unit.exhausted = !!unit.owner || unit.failures > this.options.retries;
      unit.retryAt = Date.now() + this.options.retryDelaySeconds * 1000 * 2 ** (unit.failures - 1);
      this.options.event(unit.exhausted ? "worker_capacity_quarantined" : "worker_startup_failed",
        { failures: unit.failures, slots: unit.size, error: errorText(error) });
    }
  }
  private remove(owner: WorkerProcess) {
    this.dead.add(owner);
    for (let i = this.slots.length - 1; i >= 0; i--) if (this.slots[i].owner === owner) this.slots.splice(i, 1);
  }
  retire(slot: WorkerSlot, reason: string) {
    if (!slot.owner || this.dead.has(slot.owner)) return;
    const owner = slot.owner;
    this.remove(owner);
    this.options.event("worker_recycling", { pid: owner.pid, reason });
    const pending = owner.close().finally(() => this.closing.delete(pending));
    this.closing.add(pending);
    void pending.catch(error => {
      const unit = this.capacity.find(unit => unit.owner === owner);
      if (unit) {
        unit.exhausted = true;
        this.options.event("worker_capacity_quarantined", { pid: owner.pid, slots: unit.size, error: errorText(error) });
      }
      this.options.event("worker_cleanup_failed", { error: errorText(error) });
      this.options.wake();
    });
  }
  async close() {
    this.closed = true; clearTimeout(this.timer); this.controller.abort(new Error("Supervisor closing"));
    const results = await Promise.allSettled([...this.capacity.flatMap(unit => unit.owner ? [unit.owner.close()] : []), ...this.closing, ...this.launches]);
    const failures = results.filter(result => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Worker shutdown failed");
  }
}
