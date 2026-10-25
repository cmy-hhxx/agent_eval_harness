import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { hasLiveRunOwner, localFiles } from "@eval/data";
import type { WorkbenchConfig } from "./workbench-config.js";

export interface WorkbenchStatus {
  instanceId: string;
  pid: number;
  configFile: string;
  publicOrigin: string;
  phase: "starting" | "ready" | "stopping";
  services: Record<string, boolean>;
}
const socketFile = (config: WorkbenchConfig) => path.join(config.runtime.instanceLockDirectory, "control.sock");
const missingSocket = (error: unknown) => ["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "");

/** Called only while holding the instance lock. The socket is private to the server account. */
export async function openWorkbenchControl(config: WorkbenchConfig, inspect: () => Pick<WorkbenchStatus, "phase" | "services">,
  stop: () => void): Promise<() => Promise<void>> {
  const socket = socketFile(config), instanceId = randomUUID();
  await localFiles.chmod(config.runtime.instanceLockDirectory, 0o700);
  await localFiles.remove(socket, { force: true });
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/status") {
      res.end(JSON.stringify({ instanceId, pid: process.pid, configFile: config.file, publicOrigin: config.publicOrigin, ...inspect() }));
    } else if (req.method === "POST" && req.url === "/stop" && req.headers["x-workbench-instance"] === instanceId) {
      res.writeHead(202); res.end("{}", stop);
    } else { res.writeHead(409); res.end(JSON.stringify({ error: "Workbench instance or command does not match" })); }
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
    await localFiles.chmod(socket, 0o600);
  } catch (error) { server.close(); throw error; }
  return async () => {
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await localFiles.remove(socket, { force: true });
  };
}

function request(config: WorkbenchConfig, action: "status"): Promise<WorkbenchStatus>;
function request(config: WorkbenchConfig, action: "stop", instanceId: string): Promise<unknown>;
function request(config: WorkbenchConfig, action: "status" | "stop", instanceId?: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: socketFile(config), path: "/" + action, agent: false,
      method: action === "status" ? "GET" : "POST", headers: { "x-workbench-instance": instanceId ?? "" } }, res => {
      let text = "";
      res.setEncoding("utf8"); res.on("data", chunk => { text += chunk; });
      res.once("error", reject);
      res.once("aborted", () => reject(new Error("Workbench control response interrupted")));
      res.once("end", () => {
        try {
          if (res.statusCode !== (action === "status" ? 200 : 202)) throw new Error(`Workbench control HTTP ${res.statusCode}: ${text}`);
          resolve(JSON.parse(text));
        } catch (error) { reject(error); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error("Workbench control timed out")), 2000);
    req.once("close", () => clearTimeout(timer)); req.once("error", reject); req.end();
  });
}

export async function workbenchStatus(config: WorkbenchConfig): Promise<WorkbenchStatus | undefined> {
  try {
    const status = await request(config, "status");
    if (status.configFile !== config.file) throw new Error("Instance directory belongs to another Workbench configuration");
    return status;
  } catch (error) {
    if (!missingSocket(error)) throw error;
    if (await hasLiveRunOwner(config.runtime.instanceLockDirectory))
      throw new Error("Workbench owner is alive but its control socket is unavailable; retry or inspect the server terminal");
    return undefined;
  }
}

export async function stopWorkbench(config: WorkbenchConfig): Promise<void> {
  const owner = await workbenchStatus(config);
  if (!owner) return;
  await request(config, "stop", owner.instanceId);
  const deadline = Date.now() + config.shutdownTimeoutMs + 5000;
  while (Date.now() < deadline) {
    try {
      const status = await request(config, "status");
      if (status.instanceId !== owner.instanceId) return;
    } catch (error) {
      if (!missingSocket(error)) throw error;
      if (!await hasLiveRunOwner(config.runtime.instanceLockDirectory)) return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Workbench did not finish stopping within its shutdown deadline; inspect the server terminal");
}

export async function workbenchLogs(config: WorkbenchConfig, options: { log?: string; lines?: string; follow?: boolean }): Promise<void> {
  const log = options.log ?? "runtime", lines = options.lines ?? "100";
  if (!["runtime", "evaluation"].includes(log)) throw new Error("--log must be runtime or evaluation");
  if (!/^\d+$/.test(lines) || !Number.isSafeInteger(Number(lines)) || Number(lines) < 1)
    throw new Error("--lines must be a positive integer");
  const file = path.join(config.runtime.logDirectory, log + ".log");
  await localFiles.stat(file);
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tail", ["-n", lines, ...(options.follow ? ["-f"] : []), file], { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 || signal === "SIGINT" ? resolve() : reject(new Error(`tail exited ${code ?? signal}`)));
  });
}
