import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { errorText, HttpError, redact } from "@eval/contracts";
import { consoleLog, localFiles, readJson } from "@eval/data";
import { body, json, listen } from "@eval/runtime/http";
import { ConsoleTasks, type ConsoleConfig } from "./console-tasks.js";
import { configurationSecrets } from "./settings.js";
import { logger } from "./composition.js";
import { ROOT } from "./paths.js";

export async function readConsoleConfig(file: string): Promise<ConsoleConfig> {
  const value = await readJson<ConsoleConfig>(file), root = path.dirname(path.resolve(file));
  if (!value || !Number.isInteger(value.port) || value.port < 0 || value.port > 65535 || typeof value.hostname !== "string" ||
      !Array.isArray(value.channels) || !value.channels.length || value.channels.some(id => typeof id !== "string" || !id) ||
      new Set(value.channels).size !== value.channels.length || !Array.isArray(value.presets) || !value.presets.length)
    throw new Error("Invalid console configuration");
  const locate = (source: string) => {
    if (typeof source !== "string" || !source.trim()) throw new Error("Console paths must be nonempty");
    return path.resolve(root, source);
  };
  for (const key of ["stateDirectory", "logDirectory", "passwordFile"] as const) value[key] = locate(value[key]);
  const ids = new Set<string>();
  for (const preset of value.presets) {
    if (!preset || typeof preset.id !== "string" || !/^[a-z0-9-]+$/.test(preset.id) || ids.has(preset.id) ||
        !["wencai", "aime"].includes(preset.source) || typeof preset.name !== "string" || !preset.name.trim() ||
        !Number.isSafeInteger(preset.concurrency) || preset.concurrency < 1) throw new Error("Invalid console preset");
    ids.add(preset.id);
    for (const key of ["configs", "inputRoots"] as const) {
      if (!Array.isArray(preset[key]) || !preset[key].length) throw new Error("Missing preset " + key);
      preset[key] = preset[key].map(locate);
    }
  }
  return value;
}

export async function serveConsole(tasks: ConsoleTasks, password: string) {
  if (password.length < 16) throw new Error("管理员密码至少 16 位");
  const sessions = new Map<string, number>(), attempts = new Map<string, { count: number; reset: number }>();
  const matches = (value: string) => {
    const a = Buffer.from(value), b = Buffer.from(password);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const clean = (value: unknown) => JSON.parse(redact(JSON.stringify(value), [...configurationSecrets(), password]));
  const staticFiles: Record<string, [string, string]> = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/console.js": ["console.js", "text/javascript; charset=utf-8"],
    "/console.css": ["console.css", "text/css; charset=utf-8"],
    "/geist.woff2": ["geist.woff2", "font/woff2"],
  };
  return listen(async (req, res, url) => {
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const send = (value: unknown, status = 200) => json(res, clean(value), status);
    try {
      if (req.method === "GET" && staticFiles[url.pathname]) {
        const [file, contentType] = staticFiles[url.pathname];
        const bytes = await localFiles.read(path.join(ROOT, "apps/host/console", file));
        res.writeHead(200, { "content-type": contentType }); res.end(bytes); return;
      }
      const cookie = /(?:^|;\s*)eval_console=([a-f0-9]+)/.exec(req.headers.cookie ?? "")?.[1];
      const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : undefined;
      const authenticated = bearer !== undefined ? matches(bearer) : !!cookie && (sessions.get(cookie) ?? 0) > Date.now();
      if (req.method !== "GET" && !bearer && req.headers["x-console-request"] !== "1") throw new HttpError(403, "Invalid control request");
      if (url.pathname === "/api/login" && req.method === "POST") {
        const now = Date.now(), address = req.socket.remoteAddress ?? "local";
        for (const [key, entry] of attempts) if (entry.reset <= now) attempts.delete(key);
        for (const [key, expiry] of sessions) if (expiry <= now) sessions.delete(key);
        const attempt = attempts.get(address) ?? { count: 0, reset: now + 60_000 };
        attempts.set(address, attempt);
        if (++attempt.count > 10) throw new HttpError(429, "尝试过于频繁，请一分钟后重试");
        const value = await body(req, 4096) as { password?: unknown };
        if (typeof value?.password !== "string" || !matches(value.password)) throw new HttpError(401, "密码不正确");
        attempts.delete(address);
        const token = randomBytes(32).toString("hex");
        sessions.set(token, now + 12 * 60 * 60 * 1000);
        res.setHeader("set-cookie", `eval_console=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
        return send({ authenticated: true });
      }
      if (!authenticated) throw new HttpError(401, "请先登录");
      if (url.pathname === "/api/logout" && req.method === "POST") {
        if (cookie) sessions.delete(cookie);
        res.setHeader("set-cookie", "eval_console=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
        return send({ authenticated: false });
      }
      if (url.pathname === "/api/presets" && req.method === "GET") return send(await tasks.presets());
      if (url.pathname === "/api/previews" && req.method === "POST") return send(await tasks.preview(await body(req, 64 * 1024)), 201);
      if (url.pathname === "/api/tasks" && req.method === "GET")
        return send([...tasks.tasks.values()].filter(task => task.status !== "draft").reverse().map(task => tasks.get(task.id)));
      if (url.pathname === "/api/tasks" && req.method === "POST") {
        const value = await body(req, 4096) as { previewId?: unknown };
        if (typeof value?.previewId !== "string") throw new HttpError(400, "请先预览配置");
        return send(await tasks.start(value.previewId), 202);
      }
      const match = /^\/api\/tasks\/(console-[0-9a-f-]{36})(?:\/(pause|resume|concurrency|configuration|logs))?$/.exec(url.pathname);
      if (!match) throw new HttpError(404, "Not found");
      const [, id, action] = match;
      tasks.get(id);
      if (!action && req.method === "GET") return send(tasks.get(id));
      if (action === "pause" && req.method === "POST") return send(await tasks.pause(id), 202);
      if (action === "resume" && req.method === "POST") return send(await tasks.start(id), 202);
      if (action === "concurrency" && req.method === "POST") {
        const value = await body(req, 4096) as { concurrency?: unknown };
        return send(await tasks.concurrency(id, value?.concurrency));
      }
      if (action === "configuration" && req.method === "GET") {
        res.setHeader("content-disposition", `attachment; filename="${id}.json"`);
        return send(await tasks.configuration(id));
      }
      if (action === "logs" && req.method === "GET") {
        const kind = url.searchParams.get("kind") ?? "runtime";
        if (!["runtime", "evaluation"].includes(kind)) throw new HttpError(400, "Unknown log kind");
        const cursor = url.searchParams.has("cursor") ? Number(url.searchParams.get("cursor")) : undefined;
        return send(await consoleLog(path.join(tasks.config.logDirectory, kind + ".log"), id, url.searchParams.get("errors") === "1", cursor));
      }
      throw new HttpError(405, "Method not allowed");
    } catch (error) {
      if (!(error instanceof HttpError) || error.status >= 500)
        await logger.error(error, { component: "console", event: "console_request_failed", detail: url.pathname,
          run_id: /^\/api\/tasks\/(console-[0-9a-f-]{36})/.exec(url.pathname)?.[1] });
      send({ error: errorText(error) }, error instanceof HttpError ? error.status : 500);
    }
  }, tasks.config.port, tasks.config.hostname);
}
