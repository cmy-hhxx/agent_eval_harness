import path from "node:path";
import { readJson } from "@eval/data";

export interface WorkbenchConfig {
  file: string;
  root: string;
  publicOrigin: string;
  listen: { host: string; port: number };
  secretsFile: string;
  data: { host: string; port: number; root: string; stateRoot: string; pythonPackages: string };
  runtime: {
    automationPort: number;
    runsPort: number;
    configDirectory: string;
    evalConfigFile: string;
    manifest: string;
    schedulingFile: string;
    statisticsDeliveryFile: string;
    hostConfigs: string[];
    logDirectory: string;
    logLockDirectory: string;
    instanceLockDirectory: string;
  };
  restart: { limit: number; windowMs: number; baseDelayMs: number; maxDelayMs: number };
  shutdownTimeoutMs: number;
}

const record = (value: unknown, name: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
};
const exactKeys = (value: Record<string, unknown>, keys: readonly string[], name: string) => {
  const unknown = Object.keys(value).filter(key => !keys.includes(key));
  const missing = keys.filter(key => !(key in value));
  if (unknown.length || missing.length) throw new Error(`Invalid ${name}: unknown=[${unknown.join(",")}] missing=[${missing.join(",")}]`);
};
const text = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
};
const port = (value: unknown, name: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 65535) throw new Error(`${name} must be a port`);
  return Number(value);
};
const positive = (value: unknown, name: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`${name} must be a positive integer`);
  return Number(value);
};
const loopback = (value: unknown, name: string): string => {
  const host = text(value, name);
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) throw new Error(`${name} must bind a loopback host`);
  return host;
};

export async function loadWorkbenchConfig(file: string): Promise<WorkbenchConfig> {
  const absolute = path.resolve(file), root = path.dirname(absolute);
  const raw = record(await readJson(absolute), "workbench");
  exactKeys(raw, ["publicOrigin", "listen", "secretsFile", "data", "runtime", "restart", "shutdownTimeoutMs"], "workbench");
  const listen = record(raw.listen, "workbench.listen");
  exactKeys(listen, ["host", "port"], "workbench.listen");
  const data = record(raw.data, "workbench.data");
  exactKeys(data, ["host", "port", "root", "stateRoot", "pythonPackages"], "workbench.data");
  const runtime = record(raw.runtime, "workbench.runtime");
  exactKeys(runtime, ["automationPort", "runsPort", "configDirectory", "evalConfigFile", "manifest", "schedulingFile", "statisticsDeliveryFile",
    "hostConfigs", "logDirectory", "logLockDirectory", "instanceLockDirectory"], "workbench.runtime");
  const restart = record(raw.restart, "workbench.restart");
  exactKeys(restart, ["limit", "windowMs", "baseDelayMs", "maxDelayMs"], "workbench.restart");
  if (!Number.isSafeInteger(restart.limit) || Number(restart.limit) < 0) throw new Error("workbench.restart.limit must be a non-negative integer");
  if (!Array.isArray(runtime.hostConfigs) || !runtime.hostConfigs.length || runtime.hostConfigs.some(item => typeof item !== "string" || !item.trim()))
    throw new Error("workbench.runtime.hostConfigs must contain file paths");
  const publicOrigin = text(raw.publicOrigin, "workbench.publicOrigin").replace(/\/$/, "");
  const origin = new URL(publicOrigin);
  if (!["http:", "https:"].includes(origin.protocol) || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password)
    throw new Error("workbench.publicOrigin must be an HTTP origin without path, query, credentials, or fragment");
  const resolve = (value: unknown, name: string) => path.resolve(root, text(value, name));
  const resolved = {
    file: absolute, root, publicOrigin,
    listen: { host: text(listen.host, "workbench.listen.host"), port: port(listen.port, "workbench.listen.port") },
    secretsFile: resolve(raw.secretsFile, "workbench.secretsFile"),
    data: { host: loopback(data.host, "workbench.data.host"), port: port(data.port, "workbench.data.port"),
      root: resolve(data.root, "workbench.data.root"), stateRoot: resolve(data.stateRoot, "workbench.data.stateRoot"),
      pythonPackages: resolve(data.pythonPackages, "workbench.data.pythonPackages") },
    runtime: { automationPort: port(runtime.automationPort, "workbench.runtime.automationPort"),
      runsPort: port(runtime.runsPort, "workbench.runtime.runsPort"),
      configDirectory: resolve(runtime.configDirectory, "workbench.runtime.configDirectory"),
      evalConfigFile: resolve(runtime.evalConfigFile, "workbench.runtime.evalConfigFile"),
      manifest: resolve(runtime.manifest, "workbench.runtime.manifest"),
      schedulingFile: resolve(runtime.schedulingFile, "workbench.runtime.schedulingFile"),
      statisticsDeliveryFile: resolve(runtime.statisticsDeliveryFile, "workbench.runtime.statisticsDeliveryFile"),
      hostConfigs: runtime.hostConfigs.map((item, index) => resolve(item, `workbench.runtime.hostConfigs[${index}]`)),
      logDirectory: resolve(runtime.logDirectory, "workbench.runtime.logDirectory"),
      logLockDirectory: resolve(runtime.logLockDirectory, "workbench.runtime.logLockDirectory"),
      instanceLockDirectory: resolve(runtime.instanceLockDirectory, "workbench.runtime.instanceLockDirectory") },
    restart: { limit: Number(restart.limit), windowMs: positive(restart.windowMs, "workbench.restart.windowMs"),
      baseDelayMs: positive(restart.baseDelayMs, "workbench.restart.baseDelayMs"), maxDelayMs: positive(restart.maxDelayMs, "workbench.restart.maxDelayMs") },
    shutdownTimeoutMs: positive(raw.shutdownTimeoutMs, "workbench.shutdownTimeoutMs"),
  };
  const ports = [resolved.listen.port, resolved.data.port, resolved.runtime.automationPort, resolved.runtime.runsPort];
  if (new Set(ports).size !== ports.length) throw new Error("Workbench ports must be distinct");
  return resolved;
}
