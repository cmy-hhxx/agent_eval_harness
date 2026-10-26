import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { access, constants, mkdir, stat, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { errorText, redact } from "@eval/contracts";
import { createFileLogger, runLock } from "@eval/data";
import { applySettings, configurationSecrets, readSettings } from "./settings.js";
import { ROOT } from "./paths.js";
import { loadWorkbenchConfig } from "./workbench-config.js";
import { loadWorkbenchSecrets } from "./workbench-auth.js";
import { createWorkbenchAccess } from "./workbench-access.js";
import { loadConfig } from "./config.js";
import { workbenchProxyTarget } from "./workbench-routes.js";
import { openWorkbenchControl, stopWorkbench, workbenchLogs, workbenchStatus, type WorkbenchStatus } from "./workbench-control.js";
import { signalWorkbenchChild, WorkbenchServices, type ServiceName } from "./workbench-services.js";

const args = parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: {
  config: { type: "string" }, help: { type: "boolean" }, log: { type: "string" }, lines: { type: "string" }, follow: { type: "boolean" },
} });
const command = args.positionals[0] ?? "start";
if (args.positionals.length > 1 || !["start", "stop", "status", "check", "logs"].includes(command)) throw new Error("Unknown Workbench command");
if (command !== "logs" && [args.values.log, args.values.lines, args.values.follow].some(value => value !== undefined))
  throw new Error("--log, --lines and --follow require logs");
if (args.values.help || !args.values.config) {
  console.log("Usage: bash workbench.sh [start|stop|status|check|logs] [--config FILE]");
  process.exit(args.values.help ? 0 : 2);
}
const config = await loadWorkbenchConfig(args.values.config);
if (command === "status") { console.log(JSON.stringify(await workbenchStatus(config) ?? { phase: "stopped" }, null, 2)); process.exit(0); }
if (command === "stop") { await stopWorkbench(config); console.log("Workbench stopped"); process.exit(0); }
if (command === "logs") { await workbenchLogs(config, args.values); process.exit(0); }
const secrets = await loadWorkbenchSecrets(config.secretsFile);
const settings = await readSettings(config.runtime.evalConfigFile);
const localNoProxy = [...new Set([process.env.NO_PROXY, process.env.no_proxy, "localhost", "127.0.0.1", "::1"]
  .flatMap(value => value?.split(",") ?? []).map(value => value.trim()).filter(Boolean))].join(",");
process.env.NO_PROXY = localNoProxy;
process.env.no_proxy = localNoProxy;
applySettings(settings);
const logger = createFileLogger({ directory: config.runtime.logDirectory, lockDirectory: config.runtime.logLockDirectory,
  secrets: [...configurationSecrets(), secrets.relayToken] });

const services = new WorkbenchServices({ restart: config.restart, launch: launchService,
  probe: (name, signal) => waitHealthy(name, signal), report: message => {
    console.error(message);
    void logger.error(new Error(message), { component: "workbench", event: "service_exited" });
  } });
const health = services.health;
const accessRequest = createWorkbenchAccess({ secrets, publicOrigin: config.publicOrigin,
  loginEvent: async (event, remote) => { await logger.event(event, { component: "workbench", event, remote }); } });
let server: http.Server | undefined, phase: WorkbenchStatus["phase"] = "starting";
let preparation: ChildProcess | undefined;
const lifetime = new AbortController();
const interrupt = () => lifetime.abort();
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, interrupt);
if (command === "start") {
  process.stdin.once("end", interrupt); process.stdin.once("close", interrupt); process.stdin.once("error", interrupt); process.stdin.resume();
  const terminalError = (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") process.exitCode = 2; interrupt(); };
  process.stdout.on("error", terminalError); process.stderr.on("error", terminalError);
}
const interrupted = new Promise<void>(resolve => lifetime.signal.addEventListener("abort", () => resolve(), { once: true }));

function childEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, NO_PROXY: localNoProxy, no_proxy: localNoProxy, EVAL_CONFIG_FILE: config.runtime.evalConfigFile,
    EVAL_LOG_DIR: config.runtime.logDirectory, EVAL_LOG_LOCK_DIR: config.runtime.logLockDirectory,
    EVAL_AUTOMATION_SCHEDULING_FILE: config.runtime.schedulingFile,
    EVAL_STATISTICS_DELIVERY_FILE: config.runtime.statisticsDeliveryFile,
    EVAL_WORKBENCH_PUBLIC_ORIGIN: config.publicOrigin,
    EVAL_WORKBENCH_DATA_URL: `http://${config.data.host}:${config.data.port}`,
    EVAL_WORKBENCH_RUNS_DIR: path.join(config.runtime.configDirectory, "workbench-runs"), ...extra };
}

function lineWriter(service: ServiceName, stream: "stdout" | "stderr", write: (...values: unknown[]) => void) {
  let pending = "";
  return (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    let end: number;
    while ((end = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, end).trimEnd(); pending = pending.slice(end + 1);
      if (!line) continue;
      write(`[${service}] ${line}`);
      if (service === "data") void (stream === "stderr"
        ? logger.error(new Error(line), { component: "workbench", event: "data_stderr" })
        : logger.event("data_output", { component: "data", message: line }));
    }
  };
}

function launchService(name: ServiceName): ChildProcess {
  const command = name === "data" ? "python3" : process.execPath;
  const child = name === "data"
    ? spawn(command, [path.join(ROOT, "data_service/app.py")], { cwd: ROOT, env: childEnvironment({
      DATA_ROOT: config.data.root, STATE_ROOT: config.data.stateRoot, TEMP_ROOT: path.join(config.data.stateRoot, "tmp"),
      PYTHONPATH: config.data.pythonPackages, HOST: config.data.host, PORT: String(config.data.port),
    }), detached: true, stdio: ["ignore", "pipe", "pipe"] })
    : name === "automation"
      ? spawn(command, [path.join(ROOT, "dist/apps/host/src/automations.js"), "serve",
        "--port", String(config.runtime.automationPort), "--manifest", config.runtime.manifest, "--config-dir", config.runtime.configDirectory],
        { cwd: ROOT, env: childEnvironment(), detached: true, stdio: ["ignore", "pipe", "pipe"] })
      : spawn(command, [path.join(ROOT, "dist/apps/host/src/cli.js"), "dashboard", "--port", String(config.runtime.runsPort),
        ...config.runtime.hostConfigs.flatMap(file => ["--config", file])], { cwd: ROOT, env: childEnvironment(), detached: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.on("data", lineWriter(name, "stdout", console.log));
  child.stderr!.on("data", lineWriter(name, "stderr", console.error));
  return child;
}

async function preflight(): Promise<void> {
  const required = [config.data.root, config.runtime.configDirectory, config.runtime.manifest, config.runtime.evalConfigFile,
    ...config.runtime.hostConfigs];
  for (const file of required) {
    try { await stat(file); }
    catch { throw new Error("Missing workbench input: " + file); }
  }
  await access(config.data.root, constants.R_OK | constants.W_OK).catch(() => {
    throw new Error("Data root must be readable and writable: " + config.data.root);
  });
  const targets: [string, number][] = [[config.listen.host, config.listen.port], [config.data.host, config.data.port],
    ["127.0.0.1", config.runtime.automationPort], ["127.0.0.1", config.runtime.runsPort]];
  for (const [host, port] of targets) await new Promise<void>((resolve, reject) => {
    const probe = net.createServer().once("error", error => reject(new Error(`Port ${host}:${port} is unavailable: ${errorText(error)}`)))
      .once("listening", () => probe.close(error => error ? reject(error) : resolve()));
    probe.listen(port, host);
  });
}

async function python(args: string[], stdio: "ignore" | "inherit"): Promise<number | null> {
  lifetime.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn("python3", args, { cwd: ROOT, env: { ...process.env, PYTHONPATH: config.data.pythonPackages },
      stdio, detached: true, signal: lifetime.signal });
    preparation = child;
    child.once("error", reject);
    child.once("exit", code => {
      signalWorkbenchChild(child, "SIGKILL");
      if (preparation === child) preparation = undefined;
      resolve(code);
    });
  });
}
async function preparePython(): Promise<void> {
  await mkdir(config.data.pythonPackages, { recursive: true });
  if (await python(["-c", "import py7zr"], "ignore") === 0) return;
  console.log("Installing Python data-service dependencies into the persistent runtime");
  const status = await python(["-m", "pip", "install", "--disable-pip-version-check", "--no-input",
    "--target", config.data.pythonPackages, "-r", path.join(ROOT, "data_service/requirements.txt")],
    "inherit");
  if (status !== 0) throw new Error("Python dependency installation failed");
}

async function waitHealthy(name: ServiceName, signal: AbortSignal, timeoutMs = 90_000): Promise<void> {
  const url = name === "data" ? `http://${config.data.host}:${config.data.port}/data/wencai/health`
    : `http://127.0.0.1:${name === "automation" ? config.runtime.automationPort : config.runtime.runsPort}/api/health`;
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    try {
      const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]) });
      await response.arrayBuffer();
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) { last = errorText(error); }
    await delay(500, undefined, { signal });
  }
  throw new Error(`${name} health check timed out: ${last}`);
}

const ASSETS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dashboard");
const workbenchAssets = new Set(["tabler.css", "workbench.css", "workbench-region.css", "workbench.bundle.js", "daily-charts.bundle.js", "dashboard.css", "automations.css", "problems.css", "automations.html", "automation-errors.html", "index.html", "problems.html", "intake.html", "batch-runs.html", "analysis.html", "daily.html", "aime-results.html", "daily-data.html"]);
const dataAssets: Record<string, string> = { "data.html": "dashboard.html", "data.css": "dashboard.css", "records.html": "records.html" };


function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}
function sendHtml(res: ServerResponse, status: number, html: string, extra: http.OutgoingHttpHeaders = {}): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...extra }); res.end(html);
}
async function proxy(req: IncomingMessage, res: ServerResponse, target: { port: number; path: string }): Promise<void> {
  const headers: http.OutgoingHttpHeaders = { ...req.headers, host: req.headers.host, "x-forwarded-for": req.socket.remoteAddress,
    "x-forwarded-proto": new URL(config.publicOrigin).protocol.slice(0, -1) };
  for (const name of ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"])
    delete headers[name];
  await new Promise<void>((resolve, reject) => {
    const upstream = http.request({ host: "127.0.0.1", port: target.port, method: req.method, path: target.path + (req.url?.includes("?") ? "?" + req.url.split("?").slice(1).join("?") : ""), headers }, incoming => {
      res.writeHead(incoming.statusCode ?? 502, incoming.headers); incoming.pipe(res);
      incoming.once("end", resolve); incoming.once("error", reject);
    });
    upstream.once("error", reject); req.pipe(upstream);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || "/", config.publicOrigin);
  if (url.pathname === "/health") return sendJson(res, 200, { ok: phase === "ready" && health.data && health.automation && health.runs, services: health });
  if (await accessRequest(req, res, url)) return;
  if (url.pathname === "/") return sendHtml(res, 200, await readFile(path.join(ASSETS, "workbench.html"), "utf8"));
  if (url.pathname.startsWith("/workbench-assets/")) {
    const name = url.pathname.slice("/workbench-assets/".length);
    const file = workbenchAssets.has(name) ? path.join(ASSETS, name) : Object.hasOwn(dataAssets, name)
      ? path.join(ROOT, "data_service", dataAssets[name]) : undefined;
    if (!file) return sendJson(res, 404, { error: "Not found" });
    res.writeHead(200, { "content-type": name.endsWith(".css") ? "text/css; charset=utf-8" : name.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(await readFile(file)); return;
  }
  const target = workbenchProxyTarget(url.pathname, {
    data: config.data.port, automation: config.runtime.automationPort, runs: config.runtime.runsPort,
  });
  if (!target) return sendJson(res, 404, { error: "Not found" });
  try { await proxy(req, res, target); }
  catch (error) {
    health[target.port === config.data.port ? "data" : target.port === config.runtime.automationPort ? "automation" : "runs"] = false;
    await logger.error(error, { component: "workbench", event: "proxy_failed", detail: url.pathname });
    if (!res.headersSent) sendJson(res, 502, { error: redact(errorText(error), [...configurationSecrets(), secrets.relayToken]) });
    else res.destroy();
  }
}

if (!settings.channels || !Object.keys(settings.channels).length) throw new Error("config.ini has no model channels");
const host = await loadConfig(config.runtime.hostConfigs, settings);
for (const binding of Object.values(host.models.bindings)) {
  const profile = host.models.models[binding.profile];
  if (profile && !process.env[profile.apiKeyEnv]) throw new Error(`Missing model credential ${profile.apiKeyEnv}`);
}
if (!process.env.AUTOMATIONS_MONGODB_URI) throw new Error("Missing AUTOMATIONS_MONGODB_URI");
await preflight();
if (command === "check") {
  if (await python(["-c", "import py7zr"], "ignore") !== 0) throw new Error("Python data-service dependencies are missing");
  console.log("Workbench preflight passed; no services started"); process.exit(0);
}
lifetime.signal.throwIfAborted();
const release = await runLock(config.runtime.instanceLockDirectory);
let closeControl: (() => Promise<void>) | undefined;
let shutdownTimer: NodeJS.Timeout | undefined;
const beginShutdown = () => {
  phase = "stopping";
  shutdownTimer = setTimeout(() => { console.error("Workbench shutdown deadline exceeded"); process.exit(2); }, config.shutdownTimeoutMs + 1000);
};
lifetime.signal.addEventListener("abort", beginShutdown, { once: true });
if (lifetime.signal.aborted) beginShutdown();
try {
  closeControl = await openWorkbenchControl(config, () => ({ phase, services: health }), interrupt);
  await mkdir(config.runtime.logDirectory, { recursive: true });
  await mkdir(config.runtime.logLockDirectory, { recursive: true });
  await logger.initialize();
  const startup = async () => {
    await preparePython();
    lifetime.signal.throwIfAborted();
    const ready = services.start();
    void ready.catch(() => {});
    server = http.createServer((req, res) => {
      void handle(req, res).catch(async error => {
        await logger.error(error, { component: "workbench", event: "request_failed", detail: req.url });
        if (!res.headersSent) sendJson(res, 500, { error: redact(errorText(error), [...configurationSecrets(), secrets.relayToken]) }); else res.destroy();
      });
    });
    await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(config.listen.port, config.listen.host, resolve); });
    console.log(`Workbench listening on ${config.listen.host}:${config.listen.port}; public origin ${config.publicOrigin}`);
    await ready;
    lifetime.signal.throwIfAborted();
    phase = "ready";
    await logger.event("workbench_ready", { component: "workbench", event: "workbench_ready" });
    console.log(`Ready: ${config.publicOrigin}/`);
  };
  await Promise.race([startup().then(() => new Promise<void>(resolve => server!.once("close", resolve))), services.failed, interrupted]);
} catch (error) {
  if (!lifetime.signal.aborted) { console.error(errorText(error)); process.exitCode = 2; }
} finally {
  interrupt();
  console.log("Stopping workbench");
  try {
    server?.close(); server?.closeAllConnections();
    await services.stop(Date.now() + config.shutdownTimeoutMs);
    await logger.event("workbench_stopped", { component: "workbench", event: "workbench_stopped" });
  } finally {
    try {
      if (preparation) signalWorkbenchChild(preparation, "SIGKILL");
      try { await closeControl?.(); } finally { await release(); }
    } finally {
      clearTimeout(shutdownTimer);
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(signal, interrupt);
      process.stdin.off("end", interrupt); process.stdin.off("close", interrupt); process.stdin.off("error", interrupt); process.stdin.pause();
    }
  }
}
