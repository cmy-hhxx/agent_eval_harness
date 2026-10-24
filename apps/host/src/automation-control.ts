import { errorText, HttpError } from "@eval/contracts";

export interface AutomationControlState {
  status: "idle" | "running" | "pausing" | "paused" | "stopping" | "failed";
  error?: string;
}

/** Activation belongs to this process. A restart always waits for another explicit run. */
export function createAutomationControl(
  sources: readonly string[],
  execute: (id: string, signal: AbortSignal, pauseSignal: AbortSignal) => Promise<void>,
) {
  const entries = new Map(sources.map(id => [id, {
    state: { status: "idle" } as AutomationControlState,
    controller: undefined as AbortController | undefined,
    pauseController: undefined as AbortController | undefined,
    task: undefined as Promise<void> | undefined,
  }]));
  let closed = false;
  const entry = (id: string) => {
    const value = entries.get(id);
    if (!value) throw new HttpError(404, "Unknown automation source");
    return value;
  };
  return {
    snapshot(id: string): AutomationControlState { return { ...entry(id).state }; },
    run(id: string) {
      const value = entry(id);
      if (closed) throw new HttpError(409, "工作台正在停止");
      if (value.task) throw new HttpError(409, "该来源正在运行或停止中");
      const controller = new AbortController();
      const pauseController = new AbortController();
      value.controller = controller;
      value.pauseController = pauseController;
      value.state = { status: "running" };
      value.task = Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return execute(id, controller.signal, pauseController.signal);
      }).then(() => { value.state = { status: pauseController.signal.aborted && !controller.signal.aborted ? "paused" : "idle" }; }, error => {
        value.state = controller.signal.aborted ? { status: "idle" } : { status: "failed", error: errorText(error) };
      }).finally(() => { value.task = undefined; value.controller = undefined; value.pauseController = undefined; });
      return { ...value.state };
    },
    pause(id: string) {
      const value = entry(id);
      if (value.state.status === "running") {
        value.state = { status: "pausing" };
        value.pauseController!.abort(new Error("Automation paused by operator"));
      }
      return { ...value.state };
    },
    resume(id: string) { return this.run(id); },
    stop(id: string) {
      const value = entry(id);
      if (value.task) {
        value.state = { status: "stopping" };
        value.controller!.abort(new Error("Automation stopped by operator"));
      } else value.state = { status: "idle" };
      return { ...value.state };
    },
    async close() {
      closed = true;
      for (const value of entries.values()) value.controller?.abort(new Error("Workbench stopped"));
      await Promise.all([...entries.values()].map(value => value.task));
    },
  };
}
