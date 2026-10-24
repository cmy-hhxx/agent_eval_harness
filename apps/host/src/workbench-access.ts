import type { IncomingMessage, ServerResponse } from "node:http";
import { bearerMatches, clearSessionCookie, cookieValue, SessionStore, sessionCookie, verifyPassword, type WorkbenchSecrets } from "./workbench-auth.js";

export function createWorkbenchAccess(options: {
  secrets: WorkbenchSecrets;
  publicOrigin: string;
  loginEvent: (event: "login_failed" | "login_succeeded", remote: string) => Promise<void>;
}) {
  const sessions = new SessionStore(), attempts = new Map<string, { count: number; resetAt: number }>();
  function reply(res: ServerResponse, status: number, value: unknown, cookie?: string) {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...(cookie ? { "set-cookie": cookie } : {}) });
    res.end(JSON.stringify(value)); return true;
  }
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    const sessionId = cookieValue(req.headers.cookie, "workbench_session"), session = sessions.read(sessionId);
    if (url.pathname.startsWith("/runtime/api/relay/"))
      return bearerMatches(req.headers.authorization, options.secrets.relayToken) ? false : reply(res, 401, { error: "Unauthorized" });
    if (url.pathname === "/session" && req.method === "GET") return reply(res, 200, { authenticated: Boolean(session) });
    if (req.method === "GET" || req.method === "HEAD") return false;
    if (req.headers.origin !== options.publicOrigin) return reply(res, 403, { error: "来源校验失败" });
    if (url.pathname === "/login" && req.method === "POST") {
      const remote = req.socket.remoteAddress || "unknown", now = Date.now(), previous = attempts.get(remote);
      if (previous && previous.resetAt > now && previous.count >= 5) return reply(res, 429, { error: "尝试次数过多，请稍后再试" });
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length; if (size > 8192) return reply(res, 413, { error: "登录请求过大" });
        chunks.push(Buffer.from(chunk));
      }
      const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const valid = body.get("username") === options.secrets.adminUser && await verifyPassword(body.get("password") || "", options.secrets.passwordHash);
      if (!valid) {
        const attempt = previous && previous.resetAt > now ? previous : { count: 0, resetAt: now + 5 * 60_000 };
        attempt.count++; attempts.set(remote, attempt); await options.loginEvent("login_failed", remote);
        return reply(res, 401, { error: "用户名或密码错误" });
      }
      attempts.delete(remote); const id = sessions.create(options.secrets.adminUser); await options.loginEvent("login_succeeded", remote);
      return reply(res, 200, { authenticated: true }, sessionCookie(id));
    }
    if (url.pathname === "/logout" && req.method === "POST") {
      sessions.delete(sessionId); return reply(res, 200, { authenticated: false }, clearSessionCookie());
    }
    return session ? false : reply(res, 401, { code: "login_required", error: "请先登录后执行操作" });
  };
}
