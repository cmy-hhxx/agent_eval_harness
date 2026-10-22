import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { access, constants, mkdir, stat } from "node:fs/promises";
import { parseArgs } from "node:util";
import { errorText, redact } from "@eval/contracts";
import { createFileLogger, runLock } from "@eval/data";
import { applySettings, configurationSecrets, readSettings } from "./settings.js";
import { ROOT } from "./paths.js";
import { loadWorkbenchConfig } from "./workbench-config.js";
import { bearerMatches, clearSessionCookie, cookieValue, loadWorkbenchSecrets, SessionStore, sessionCookie, verifyPassword } from "./workbench-auth.js";
import { loadConfig } from "./config.js";
import { workbenchProxyTarget } from "./workbench-routes.js";

const args = parseArgs({ args: process.argv.slice(2), options: { config: { type: "string" }, help: { type: "boolean" } } });
if (args.values.help || !args.values.config) {
  console.log("Usage: node dist/apps/host/src/workbench.js --config /path/to/runtime/config/workbench.json");
  process.exit(args.values.help ? 0 : 2);
}
const config = await loadWorkbenchConfig(args.values.config);
const secrets = await loadWorkbenchSecrets(config.secretsFile);
const settings = await readSettings(config.runtime.evalConfigFile);
const localNoProxy = [...new Set([process.env.NO_PROXY, process.env.no_proxy, "localhost", "127.0.0.1", "::1"]
  .flatMap(value => value?.split(",") ?? []).map(value => value.trim()).filter(Boolean))].join(",");
process.env.NO_PROXY = localNoProxy;
process.env.no_proxy = localNoProxy;
applySettings(settings);
await mkdir(config.runtime.logDirectory, { recursive: true });
await mkdir(config.runtime.logLockDirectory, { recursive: true });
const logger = createFileLogger({ directory: config.runtime.logDirectory, lockDirectory: config.runtime.logLockDirectory,
  secrets: [...configurationSecrets(), secrets.relayToken] });
await logger.initialize();

type ServiceName = "data" | "automation" | "runs";
interface Service { name: ServiceName; child?: ChildProcess; stopping: boolean; restarts: number[] }
const services: Record<ServiceName, Service> = {
  data: { name: "data", stopping: false, restarts: [] },
  automation: { name: "automation", stopping: false, restarts: [] },
  runs: { name: "runs", stopping: false, restarts: [] },
};
const health = { data: false, automation: false, runs: false };
const sessions = new SessionStore();
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
let stopping = false, server: http.Server | undefined, rejectFatal: ((error: Error) => void) | undefined;
const fatal = new Promise<never>((_resolve, reject) => { rejectFatal = reject; });
// A service can fail before initial health checks finish and the race below is attached.
void fatal.catch(() => {});

function childEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, NO_PROXY: localNoProxy, no_proxy: localNoProxy, EVAL_CONFIG_FILE: config.runtime.evalConfigFile,
    EVAL_LOG_DIR: config.runtime.logDirectory, EVAL_LOG_LOCK_DIR: config.runtime.logLockDirectory,
    EVAL_AUTOMATION_SCHEDULING_FILE: config.runtime.schedulingFile,
    EVAL_STATISTICS_DELIVERY_FILE: config.runtime.statisticsDeliveryFile,
    EVAL_WORKBENCH_PUBLIC_ORIGIN: config.publicOrigin, ...extra };
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

function launch(service: Service): void {
  const command = service.name === "data" ? "python3" : process.execPath;
  const child = service.name === "data"
    ? spawn(command, [path.join(ROOT, "server_dashboard_ths/app.py")], { cwd: ROOT, env: childEnvironment({
      DATA_ROOT: config.data.root, STATE_ROOT: config.data.stateRoot, TEMP_ROOT: path.join(config.data.stateRoot, "tmp"),
      PYTHONPATH: config.data.pythonPackages, HOST: config.data.host, PORT: String(config.data.port),
    }), detached: true, stdio: ["ignore", "pipe", "pipe"] })
    : service.name === "automation"
      ? spawn(command, [path.join(ROOT, "dist/apps/host/src/automations.js"), "run", "--dashboard",
        "--port", String(config.runtime.automationPort), "--manifest", config.runtime.manifest, "--config-dir", config.runtime.configDirectory],
        { cwd: ROOT, env: childEnvironment(), detached: true, stdio: ["ignore", "pipe", "pipe"] })
      : spawn(command, [path.join(ROOT, "dist/apps/host/src/cli.js"), "dashboard", "--port", String(config.runtime.runsPort),
        ...config.runtime.hostConfigs.flatMap(file => ["--config", file])], { cwd: ROOT, env: childEnvironment(), detached: true, stdio: ["ignore", "pipe", "pipe"] });
  service.child = child;
  child.stdout!.on("data", lineWriter(service.name, "stdout", console.log));
  child.stderr!.on("data", lineWriter(service.name, "stderr", console.error));
  child.once("error", error => {
    health[service.name] = false;
    if (!stopping) void logger.error(error, { component: "workbench", event: "spawn_failed", detail: service.name });
  });
  child.once("exit", (code, signal) => {
    service.child = undefined; health[service.name] = false;
    if (stopping || service.stopping) return;
    const now = Date.now();
    service.restarts = service.restarts.filter(time => now - time < config.restart.windowMs);
    service.restarts.push(now);
    const exit = `service ${service.name} exited code=${code ?? "null"} signal=${signal ?? "null"}`;
    console.error(exit);
    void logger.error(new Error(exit), { component: "workbench", event: "service_exited", detail: service.name });
    if (code === 2 || service.restarts.length > config.restart.limit) {
      rejectFatal?.(new Error(code === 2 ? `${service.name} reported a configuration or startup error` :
        `${service.name} exceeded ${config.restart.limit} restarts in ${config.restart.windowMs}ms`));
      return;
    }
    const delay = Math.min(config.restart.baseDelayMs * 2 ** (service.restarts.length - 1), config.restart.maxDelayMs);
    console.error(`restarting ${service.name} in ${delay}ms`);
    setTimeout(() => { if (!stopping) launch(service); }, delay).unref();
  });
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
  for (const directory of [config.data.stateRoot, config.runtime.logDirectory, config.runtime.logLockDirectory,
    config.runtime.instanceLockDirectory, path.dirname(config.runtime.schedulingFile), path.dirname(config.runtime.statisticsDeliveryFile)]) await mkdir(directory, { recursive: true });
  const targets: [string, number][] = [[config.listen.host, config.listen.port], [config.data.host, config.data.port],
    ["127.0.0.1", config.runtime.automationPort], ["127.0.0.1", config.runtime.runsPort]];
  for (const [host, port] of targets) await new Promise<void>((resolve, reject) => {
    const probe = net.createServer().once("error", error => reject(new Error(`Port ${host}:${port} is unavailable: ${errorText(error)}`)))
      .once("listening", () => probe.close(error => error ? reject(error) : resolve()));
    probe.listen(port, host);
  });
}

async function preparePython(): Promise<void> {
  await mkdir(config.data.pythonPackages, { recursive: true });
  const env = { ...process.env, PYTHONPATH: config.data.pythonPackages };
  const probe = spawnSync("python3", ["-c", "import py7zr"], { env, stdio: "ignore" });
  if (probe.status === 0) return;
  console.log("Installing Python data-service dependencies into the persistent runtime");
  const install = spawnSync("python3", ["-m", "pip", "install", "--disable-pip-version-check", "--no-input",
    "--target", config.data.pythonPackages, "-r", path.join(ROOT, "server_dashboard_ths/requirements.txt")],
    { cwd: ROOT, env, stdio: "inherit" });
  if (install.status !== 0) throw new Error("Python dependency installation failed");
}

async function waitHealthy(url: string, name: ServiceName, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) { health[name] = true; return; }
      last = `HTTP ${response.status}`;
    } catch (error) { last = errorText(error); }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`${name} health check timed out: ${last}`);
}

const HOME = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>评测工作台</title>
<style>:root{font-family:Inter,"PingFang SC","Microsoft YaHei",sans-serif;color:#17201d;background:#f3f6f4}*{box-sizing:border-box}body{margin:0}header{height:64px;display:flex;align-items:center;gap:20px;padding:0 28px;border-bottom:1px solid #dbe3df;background:#fff}header strong{margin-right:auto}h1{font-size:22px;margin:0}.nav{display:flex;gap:10px}.nav a,.region{border:1px solid #d5dfda;border-radius:8px;padding:9px 13px;color:inherit;text-decoration:none;background:#fff}.nav a:hover,.region:hover{border-color:#087f83;color:#087f83}main{max-width:1040px;margin:0 auto;padding:48px 28px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}.region{min-height:220px;padding:28px;display:flex;flex-direction:column;justify-content:space-between}.region h2{font-size:30px;margin:0}.region span{font-size:14px;color:#52605a}@media(max-width:720px){.grid{grid-template-columns:1fr}header{padding:0 16px}.nav a:not(:last-child){display:none}}</style></head>
<body><header><strong>评测工作台</strong><nav class="nav"><a href="/data/">数据</a><a href="/runtime/">运行时</a><a href="/logout">退出</a></nav></header>
<main><div class="grid"><a class="region" href="/data/"><h2>数据</h2><span id="data-status">检查中</span></a><a class="region" href="/runtime/"><h2>运行时</h2><span id="runtime-status">检查中</span></a></div></main>
<script>fetch('/health',{cache:'no-store'}).then(r=>r.json()).then(v=>{document.querySelector('#data-status').textContent=v.services.data?'在线':'异常';document.querySelector('#runtime-status').textContent=v.services.automation&&v.services.runs?'在线':'异常'}).catch(()=>{document.querySelector('#data-status').textContent='异常';document.querySelector('#runtime-status').textContent='异常'})</script></body></html>`;

const LOGIN = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录 · 评测工作台</title>
<style>:root{font-family:Inter,"PingFang SC","Microsoft YaHei",sans-serif;color:#17201d;background:#f3f6f4}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center}form{width:min(360px,calc(100vw - 32px));background:#fff;border:1px solid #dbe3df;border-radius:12px;padding:28px}h1{font-size:22px;margin:0 0 22px}label{display:grid;gap:7px;margin:14px 0;font-size:14px}input{height:42px;border:1px solid #cdd8d2;border-radius:7px;padding:0 12px;font:inherit}button{width:100%;height:42px;margin-top:12px;border:0;border-radius:7px;background:#087f83;color:#fff;font:inherit;font-weight:600;cursor:pointer}.error{color:#a13030;font-size:14px;min-height:20px}</style></head>
<body><form method="post" action="/login"><h1>登录</h1><label>用户<input name="username" autocomplete="username" required autofocus></label><label>密码<input name="password" type="password" autocomplete="current-password" required></label><div class="error">__ERROR__</div><button type="submit">登录</button></form></body></html>`;

const DATA_HOME = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>数据 · 评测工作台</title>
<style>:root{font-family:Inter,"PingFang SC","Microsoft YaHei",sans-serif;color:#17201d;background:#f3f6f4}*{box-sizing:border-box}body{margin:0}header{height:64px;display:flex;align-items:center;gap:18px;padding:0 28px;border-bottom:1px solid #dbe3df;background:#fff}h1{font-size:21px;margin:0 auto 0 0}.nav a,.dataset{border:1px solid #d5dfda;border-radius:8px;padding:9px 13px;color:inherit;text-decoration:none;background:#fff}.nav{display:flex;gap:10px}.nav a:hover,.dataset:hover{border-color:#087f83;color:#087f83}main{max-width:960px;margin:0 auto;padding:40px 28px;display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.dataset{padding:24px;min-height:150px;display:flex;align-items:flex-end;font-size:24px;font-weight:650}@media(max-width:720px){main{grid-template-columns:1fr}header{padding:0 16px}}</style></head>
<body><header><h1>数据</h1><nav class="nav"><a href="/">工作台</a><a href="/runtime/">运行时</a><a href="/logout">退出</a></nav></header><main><a class="dataset" href="/data/wencai/">wencai</a><a class="dataset" href="/data/aime/">aime</a><a class="dataset" href="/data/ifind/">ifind</a></main></body></html>`;

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}
function sendHtml(res: ServerResponse, status: number, html: string, extra: http.OutgoingHttpHeaders = {}): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...extra }); res.end(html);
}
async function requestBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error("Request body too large"); chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks).toString("utf8");
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
  if (url.pathname === "/health") return sendJson(res, 200, { ok: health.data && health.automation && health.runs, services: health });
  if (url.pathname === "/login" && req.method === "GET") {
    if (sessions.read(cookieValue(req.headers.cookie, "workbench_session"))) return sendHtml(res, 303, "", { location: "/" });
    return sendHtml(res, 200, LOGIN.replace("__ERROR__", ""));
  }
  if (url.pathname === "/login" && req.method === "POST") {
    const ip = req.socket.remoteAddress || "unknown", now = Date.now();
    const attempt = loginAttempts.get(ip);
    if (attempt && attempt.resetAt > now && attempt.count >= 5) return sendHtml(res, 429, LOGIN.replace("__ERROR__", "尝试次数过多，请稍后再试"));
    if (req.headers.origin && req.headers.origin !== config.publicOrigin) return sendHtml(res, 403, LOGIN.replace("__ERROR__", "来源校验失败"));
    const body = new URLSearchParams(await requestBody(req, 8192));
    const valid = body.get("username") === secrets.adminUser && await verifyPassword(body.get("password") || "", secrets.passwordHash);
    if (!valid) {
      const current = attempt && attempt.resetAt > now ? attempt : { count: 0, resetAt: now + 5 * 60_000 };
      current.count++; loginAttempts.set(ip, current);
      await logger.event("login_failed", { component: "workbench", event: "login_failed", remote: ip });
      return sendHtml(res, 401, LOGIN.replace("__ERROR__", "用户名或密码错误"));
    }
    loginAttempts.delete(ip);
    const id = sessions.create(secrets.adminUser);
    await logger.event("login_succeeded", { component: "workbench", event: "login_succeeded", remote: ip });
    return sendHtml(res, 303, "", { location: "/", "set-cookie": sessionCookie(id) });
  }
  if (url.pathname === "/logout") {
    sessions.delete(cookieValue(req.headers.cookie, "workbench_session"));
    return sendHtml(res, 303, "", { location: "/login", "set-cookie": clearSessionCookie() });
  }
  const relay = url.pathname.startsWith("/runtime/api/relay/");
  if (relay) {
    if (!bearerMatches(req.headers.authorization, secrets.relayToken)) return sendJson(res, 401, { error: "Unauthorized" });
  } else if (!sessions.read(cookieValue(req.headers.cookie, "workbench_session"))) {
    if (url.pathname.startsWith("/runtime/api/") || url.pathname.startsWith("/data/") && !req.headers.accept?.includes("text/html"))
      return sendJson(res, 401, { error: "Unauthorized" });
    return sendHtml(res, 303, "", { location: `/login?next=${encodeURIComponent(url.pathname)}` });
  }
  if (url.pathname === "/") return sendHtml(res, 200, HOME.replaceAll("__USER__", secrets.adminUser));
  if (url.pathname === "/data/") return sendHtml(res, 200, DATA_HOME);
  if (url.pathname === "/runtime" || url.pathname === "/data") return sendHtml(res, 308, "", { location: url.pathname + "/" });
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

async function stopService(service: Service, timeoutMs: number): Promise<void> {
  service.stopping = true;
  const child = service.child;
  if (!child?.pid) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} }
  await Promise.race([new Promise<void>(resolve => child.once("exit", () => resolve())), new Promise(resolve => setTimeout(resolve, timeoutMs))]);
  if (child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
  }
}
async function shutdown(reason: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`Stopping workbench (${reason})`);
  await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
  await stopService(services.automation, config.shutdownTimeoutMs);
  await stopService(services.runs, config.shutdownTimeoutMs);
  await stopService(services.data, config.shutdownTimeoutMs);
  await logger.event("workbench_stopped", { component: "workbench", event: "workbench_stopped", reason });
}

await preflight();
if (!settings.channels || !Object.keys(settings.channels).length) throw new Error("config.ini has no model channels");
const host = await loadConfig(config.runtime.hostConfigs, settings);
for (const binding of Object.values(host.models.bindings)) {
  const profile = host.models.models[binding.profile];
  if (profile && !process.env[profile.apiKeyEnv]) throw new Error(`Missing model credential ${profile.apiKeyEnv}`);
}
if (!process.env.AUTOMATIONS_MONGODB_URI) throw new Error("Missing AUTOMATIONS_MONGODB_URI");
const release = await runLock(config.runtime.instanceLockDirectory);
try {
  await preparePython();
  launch(services.data); launch(services.automation); launch(services.runs);
  server = http.createServer((req, res) => {
    void handle(req, res).catch(async error => {
      await logger.error(error, { component: "workbench", event: "request_failed", detail: req.url });
      if (!res.headersSent) sendJson(res, 500, { error: redact(errorText(error), [...configurationSecrets(), secrets.relayToken]) }); else res.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(config.listen.port, config.listen.host, resolve); });
  console.log(`Workbench listening on ${config.listen.host}:${config.listen.port}; public origin ${config.publicOrigin}`);
  await Promise.all([
    waitHealthy(`http://${config.data.host}:${config.data.port}/data/wencai/health`, "data"),
    waitHealthy(`http://127.0.0.1:${config.runtime.automationPort}/api/health`, "automation"),
    waitHealthy(`http://127.0.0.1:${config.runtime.runsPort}/api/health`, "runs"),
  ]);
  await logger.event("workbench_ready", { component: "workbench", event: "workbench_ready" });
  console.log(`Ready: ${config.publicOrigin}/`);
  const stop = (signal: string) => { void shutdown(signal).finally(() => process.exit(0)); };
  process.once("SIGINT", () => stop("SIGINT")); process.once("SIGTERM", () => stop("SIGTERM"));
  try { await Promise.race([fatal, new Promise(resolve => server!.once("close", resolve))]); }
  catch (error) { console.error(errorText(error)); process.exitCode = 2; }
  await shutdown("fatal");
} catch (error) {
  console.error(errorText(error));
  process.exitCode = 2;
  await shutdown("startup_failure");
} finally {
  await release();
}
