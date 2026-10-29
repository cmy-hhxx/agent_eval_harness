import { fork, type ChildProcess } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Engine, WorkerEvent } from "@eval/contracts";
import { errorText } from "@eval/contracts";

export interface WorkerExit {
  readonly pid: number;
  readonly url?: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly expectedClose: boolean;
  readonly disconnectedAt: number | null;
  readonly exitedAt: number;
  readonly shutdownReason?: "SIGTERM" | "SIGINT" | "disconnect";
  readonly stderr: string;
}

export interface WorkerProcess {
  readonly pid: number;
  readonly url: string;
  readonly urls: readonly string[];
  readonly exited: Promise<WorkerExit>;
  close(): Promise<void>;
}

/** Startup failed and termination could not be confirmed; the owner must quarantine this process. */
export class WorkerStartupError extends AggregateError {
  constructor(error: unknown, cleanupError: unknown, readonly worker: WorkerProcess) {
    super([error, cleanupError], `Worker startup failed: ${errorText(error)}; cleanup failed: ${errorText(cleanupError)}`);
  }
}

export async function spawnWorker(
  engine: Engine,
  directory: string,
  paths: { root: string; workerEntry: string; workerSlots?: number; signal?: AbortSignal },
): Promise<WorkerProcess> {
  await mkdir(directory, { recursive: true });
  const proc = fork(paths.workerEntry, ["--engine", engine, "--directory", directory, "--root", paths.root,
    "--slots", String(paths.workerSlots ?? 1)], {
    // Isolate shell/group signals; IPC loss and explicit close still supervise it.
    detached: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {
      ...process.env,
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      DO_NOT_TRACK: "1",
    },
  });
  let stderr = "";
  let url: string | undefined;
  let urls: string[] = [];
  let expectedClose = false;
  let disconnectedAt: number | null = null;
  let exitedAt = 0;
  let shutdownReason: WorkerExit["shutdownReason"];
  proc.stdout?.on("data", () => {});
  proc.stderr?.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-12000);
  });
  proc.once("disconnect", () => { disconnectedAt = Date.now(); });
  proc.once("exit", () => {
    exitedAt = Date.now();
    // Drain this exit's pending pipe data, then release our read ends. An orphan
    // inheriting a write end must not keep exit observation or close pending.
    setImmediate(() => { proc.stdout?.destroy(); proc.stderr?.destroy(); });
  });
  proc.on("message", message => {
    const value = message as { type?: string; reason?: string };
    if (value.type === "shutdown" && ["SIGTERM", "SIGINT", "disconnect"].includes(value.reason ?? ""))
      shutdownReason ??= value.reason as WorkerExit["shutdownReason"];
  });
  // close follows exit after the stdout/stderr pipes have drained.
  const exited = new Promise<WorkerExit>(resolve => proc.once("close", (exitCode, signal) => resolve(Object.freeze({
    pid: proc.pid!, ...(url ? { url } : {}), exitCode, signal, expectedClose,
    disconnectedAt, exitedAt: exitedAt || Date.now(), ...(shutdownReason ? { shutdownReason } : {}), stderr,
  }))));
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    if (proc.exitCode === null && proc.signalCode === null && shutdownReason === undefined && disconnectedAt === null && !exitedAt)
      expectedClose = true;
    await closeProcess(proc);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([exited, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Worker exit observation timeout")), 2000);
    })]); } finally { clearTimeout(timer); }
  })();
  try {
    url = await new Promise<string>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timeout); paths.signal?.removeEventListener("abort", abort); };
      const abort = () => { cleanup(); reject(paths.signal?.reason ?? new Error("Worker startup cancelled")); };
      const timeout = setTimeout(() => {
        cleanup();
        proc.kill("SIGTERM");
        const error = new Error("Worker startup timeout: " + stderr);
        error.name = "TimeoutError";
        reject(error);
      }, 60000);
      if (paths.signal?.aborted) { abort(); return; }
      paths.signal?.addEventListener("abort", abort, { once: true });
      const fail = (code: number | null) => {
        cleanup();
        reject(new Error(`Worker exited ${code}: ${stderr}`));
      };
      proc.once("error", (error) => {
        cleanup();
        reject(error);
      });
      proc.once("exit", fail);
      proc.on("message", (message) => {
        const value = message as { type?: string; url?: string; urls?: string[] };
        if (value.type === "ready" && value.url) {
          cleanup();
          proc.off("exit", fail);
          urls = value.urls ?? [value.url];
          resolve(value.url);
        }
      });
    });
    return Object.freeze({ pid: proc.pid!, url, urls: Object.freeze(urls), exited, close });
  } catch (error) {
    try { await close(); }
    catch (cleanupError) {
      throw new WorkerStartupError(error, cleanupError,
        Object.freeze({ pid: proc.pid!, url: url ?? "", urls: Object.freeze(urls), exited, close }));
    }
    throw error;
  }
}
async function closeProcess(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    let forced: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      forced = setTimeout(() => reject(new Error("Worker did not exit after SIGKILL")), 2000);
    }, 10000);
    proc.once("exit", () => {
      clearTimeout(timeout);
      clearTimeout(forced);
      resolve();
    });
    proc.kill("SIGTERM");
  });
}
export async function consumeEvents(
  url: string,
  attemptId: string,
  file: string | undefined,
  signal: AbortSignal,
  onEvent?: (event: WorkerEvent) => void,
): Promise<boolean> {
  let cursor = 0;
  if (file) await mkdir(path.dirname(file), { recursive: true });
  while (!signal.aborted) {
    try {
      const response = await fetch(`${url}/api/attempts/${attemptId}/events?after=${cursor}`, { signal });
      if (!response.ok || !response.body) throw new Error("Event stream unavailable");
      let buffer = "";
      const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const line = block.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const event = JSON.parse(line.slice(6)) as WorkerEvent;
          if (event.attemptId !== attemptId || event.seq <= cursor) continue;
          if (event.seq !== cursor + 1) throw new Error("Event sequence gap");
          if (file) await appendFile(file, JSON.stringify(event) + "\n");
          onEvent?.(event);
          cursor = event.seq;
          if (event.type === "finished") return true;
        }
      }
    } catch (error) {
      if (signal.aborted) return false;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  return false;
}
