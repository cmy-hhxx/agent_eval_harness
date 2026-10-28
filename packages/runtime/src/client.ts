import { fork, type ChildProcess } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Engine, WorkerEvent } from "@eval/contracts";

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

export async function spawnWorker(
  engine: Engine,
  directory: string,
  paths: { root: string; workerEntry: string; workerSlots?: number },
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
  const close = async () => {
    if (proc.exitCode === null && proc.signalCode === null && shutdownReason === undefined && disconnectedAt === null && !exitedAt)
      expectedClose = true;
    await closeProcess(proc);
    await exited;
  };
  try {
    url = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        proc.kill("SIGTERM");
        const error = new Error("Worker startup timeout: " + stderr);
        error.name = "TimeoutError";
        reject(error);
      }, 60000);
      const fail = (code: number | null) => {
        clearTimeout(timeout);
        reject(new Error(`Worker exited ${code}: ${stderr}`));
      };
      proc.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      proc.once("exit", fail);
      proc.on("message", (message) => {
        const value = message as { type?: string; url?: string; urls?: string[] };
        if (value.type === "ready" && value.url) {
          clearTimeout(timeout);
          proc.off("exit", fail);
          urls = value.urls ?? [value.url];
          resolve(value.url);
        }
      });
    });
    return Object.freeze({ pid: proc.pid!, url, urls: Object.freeze(urls), exited, close });
  } catch (error) {
    await close();
    throw error;
  }
}
async function closeProcess(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => proc.kill("SIGKILL"), 10000);
    proc.once("exit", () => {
      clearTimeout(timeout);
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
