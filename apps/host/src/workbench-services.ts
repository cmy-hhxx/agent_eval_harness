import type { ChildProcess } from "node:child_process";
import type { WorkbenchConfig } from "./workbench-config.js";

export type ServiceName = "data" | "automation" | "runs";
const names: ServiceName[] = ["data", "automation", "runs"];

export function signalWorkbenchChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal); }
}

interface Service {
  child?: ChildProcess;
  probe?: AbortController;
  timer?: NodeJS.Timeout;
  restarts: number[];
  ready: Promise<void>;
  resolveReady: () => void;
}
function newService(): Service {
  let resolveReady!: () => void;
  const ready = new Promise<void>(resolve => { resolveReady = resolve; });
  return { restarts: [], ready, resolveReady };
}

/** Owns exactly the three children started by this foreground Workbench instance. */
export class WorkbenchServices {
  readonly health = { data: false, automation: false, runs: false };
  readonly failed: Promise<never>;
  private fail!: (error: Error) => void;
  private stopping = false;
  private readonly services: Record<ServiceName, Service> = { data: newService(), automation: newService(), runs: newService() };

  constructor(private readonly options: {
    restart: WorkbenchConfig["restart"];
    launch: (name: ServiceName) => ChildProcess;
    probe: (name: ServiceName, signal: AbortSignal) => Promise<void>;
    report: (message: string) => void;
    signalChild?: typeof signalWorkbenchChild;
  }) {
    this.failed = new Promise<never>((_resolve, reject) => { this.fail = reject; });
    void this.failed.catch(() => {});
  }

  async start(): Promise<void> {
    for (const name of names) this.launch(name);
    await Promise.race([this.failed, Promise.all(names.map(name => this.services[name].ready))]);
  }

  private launch(name: ServiceName): void {
    if (this.stopping) return;
    const service = this.services[name], probe = new AbortController();
    let child: ChildProcess;
    try { child = this.options.launch(name); }
    catch (error) { this.fail(error as Error); return; }
    service.child = child; service.probe = probe;
    child.once("error", error => { if (!this.stopping) this.fail(error); });
    child.once("exit", (code, signal) => {
      probe.abort(); this.health[name] = false;
      if (service.child === child) service.child = undefined;
      this.signal(child, "SIGKILL");
      if (this.stopping) return;
      this.options.report(`${name} exited code=${code ?? "null"} signal=${signal ?? "null"}`);
      const now = Date.now(), restart = this.options.restart;
      service.restarts = service.restarts.filter(time => now - time < restart.windowMs);
      service.restarts.push(now);
      if (code === 2 || service.restarts.length > restart.limit) {
        this.fail(new Error(code === 2 ? `${name} reported a configuration or startup error` : `${name} exceeded ${restart.limit} restarts`));
        return;
      }
      const delay = Math.min(restart.baseDelayMs * 2 ** (service.restarts.length - 1), restart.maxDelayMs);
      this.options.report(`restarting ${name} in ${delay}ms`);
      service.timer = setTimeout(() => this.launch(name), delay);
    });
    void this.options.probe(name, probe.signal).then(() => {
      if (!probe.signal.aborted && !this.stopping && service.child === child) {
        this.health[name] = true; service.resolveReady();
      }
    }, error => { if (!probe.signal.aborted && !this.stopping) this.fail(error as Error); });
  }

  private signal(child: ChildProcess, signal: NodeJS.Signals): void {
    (this.options.signalChild ?? signalWorkbenchChild)(child, signal);
  }

  async stop(deadline: number): Promise<void> {
    this.stopping = true;
    for (const name of names) {
      const service = this.services[name];
      clearTimeout(service.timer); service.probe?.abort(); this.health[name] = false;
    }
    // Keep data available while evaluation hosts save their progress.
    for (const name of ["automation", "runs", "data"] as const) {
      const child = this.services[name].child;
      if (!child?.pid) continue;
      const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
      this.signal(child, "SIGTERM");
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([closed, new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(0, deadline - Date.now())); })]);
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) this.options.report(`forcing ${name} to stop at the shutdown deadline`);
      this.signal(child, "SIGKILL");
    }
  }
}
