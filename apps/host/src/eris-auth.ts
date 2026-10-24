import type { IncomingMessage, ServerResponse } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { AssistantAccounts } from "@eval/data";
import type { AssistantAccess } from "@eval/runtime/assistant";
import { cookieValue } from "./workbench-auth.js";

const cookie = (id: string, days = 7) => `eris_session=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${days * 86400}`;
function send(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 16384) throw new Error("请求过大"); chunks.push(chunk); }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求无效");
  return value;
}
const page = (content: string, script: string) => `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Eris</title><style>body{font:15px system-ui;background:#fafafa;color:#222;margin:5vh auto;padding:24px;max-width:780px}input,button{font:inherit;padding:10px;margin:6px;border:1px solid #ddd;border-radius:8px}button{cursor:pointer;background:white}label{display:block}table{width:100%;text-align:left;border-collapse:collapse}td,th{padding:12px 6px;border-bottom:1px solid #ddd}#error{color:#b42318}a{color:inherit}form{margin:24px 0}</style>${content}<p id="error" role="alert"></p><script>const api=async(path,data)=>{const r=await fetch(path,{method:data?'POST':'GET',headers:{'content-type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});const v=await r.json();if(r.status===401&&path!=='/auth/login')location.href='/auth/login';if(!r.ok)throw Error(v.error||'请求失败');return v};const fail=e=>document.getElementById('error').textContent=e.message;${script}</script></html>`;

export async function erisAccess(accounts: AssistantAccounts, publicOrigin: string, cancelUser: (id: string) => Promise<void>): Promise<AssistantAccess & { internalAuthorization(userId: string): string }> {
  const key = await accounts.internalKey();
  const listeners = new Set<(userId: string, loginId?: string) => void>();
  const revoke = (userId: string, loginId?: string) => { for (const listener of listeners) listener(userId, loginId); };
  const attempts = new Map<string, { count: number; until: number }>();
  const sign = (value: string) => createHmac("sha256", key).update(value).digest("base64url");
  const internalAuthorization = (userId: string) => { const value = `${userId}.${Date.now() + 30000}`; return `Eris ${value}.${sign(value)}`; };
  const authenticate: AssistantAccess["authenticate"] = async req => {
    const authorization = req.headers.authorization;
    if (authorization?.startsWith("Eris ")) {
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "")) return;
      const [userId, expiry, proof] = authorization.slice(5).split(".");
      if (!userId || !proof || !Number.isSafeInteger(Number(expiry)) || Number(expiry) <= Date.now() || Number(expiry) > Date.now() + 30000) return;
      const expected = Buffer.from(sign(`${userId}.${expiry}`)), actual = Buffer.from(proof);
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual) || !await accounts.account(userId)) return;
      return { userId, loginId: "internal", expiresAt: Number(expiry), internal: true };
    }
    const login = await accounts.authenticate(cookieValue(req.headers.cookie, "eris_session"));
    return login && { userId: login.user.id, loginId: login.loginId, expiresAt: login.expiresAt };
  };
  return { publicOrigin, authenticate, internalAuthorization,
    async active(principal) { return principal.internal ? Boolean(await accounts.account(principal.userId)) : Boolean(await accounts.authenticate(principal.loginId)); },
    onRevoke(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async handle(req, res) {
      const url = new URL(req.url ?? "/", publicOrigin), route = url.pathname;
      if (!route.startsWith("/auth/") && route !== "/account" && !route.startsWith("/admin/users")) return false;
      res.setHeader("cache-control", "no-store");
      res.setHeader("content-security-policy", "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'");
      if (req.method !== "GET" && (req.method !== "POST" || req.headers.origin !== publicOrigin)) { send(res, 403, { error: "来源校验失败" }); return true; }
      try {
        if (route === "/auth/login" && req.method === "GET") {
          if (await authenticate(req)) { res.writeHead(303, { location: "/" }); res.end(); return true; }
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.end(page('<h1>Eris</h1><form id="login"><label>用户名<input name="username" autocomplete="username" required></label><label>密码<input name="password" type="password" autocomplete="current-password" required></label><button>登录</button></form>', `document.getElementById('login').onsubmit=async e=>{e.preventDefault();try{await api('/auth/login',Object.fromEntries(new FormData(e.target)));location.href='/'}catch(e){fail(e)}}`)); return true;
        }
        if (route === "/auth/login" && req.method === "POST") {
          const input = await body(req), name = String(input.username ?? ""), ip = req.socket.remoteAddress ?? "unknown", now = Date.now();
          for (const [id, attempt] of attempts) if (attempt.until <= now) attempts.delete(id);
          const ids = [`user:${name}`, `ip:${ip}`];
          if (ids.some(id => (attempts.get(id)?.count ?? 0) >= (id.startsWith("ip:") ? 30 : 5))) { send(res, 429, { error: "尝试次数过多，请稍后重试" }); return true; }
          for (const id of ids) { const attempt = attempts.get(id) ?? { count: 0, until: now + 15 * 60_000 }; attempt.count++; attempts.set(id, attempt); }
          const login = await accounts.login(name, String(input.password ?? ""));
          attempts.delete(ids[0]); res.setHeader("set-cookie", cookie(login.loginId)); send(res, 200, { user: login.user }); return true;
        }
        const login = await accounts.authenticate(cookieValue(req.headers.cookie, "eris_session"));
        if (!login) {
          if (req.method === "GET" && route === "/account") { res.writeHead(303, { location: "/auth/login" }); res.end(); }
          else send(res, 401, { error: "请登录" });
          return true;
        }
        const input = req.method === "POST" ? await body(req) : {};
        if (route === "/auth/me" && req.method === "GET") { send(res, 200, { user: login.user, expiresAt: login.expiresAt }); return true; }
        if (["/auth/logout", "/auth/logout-all"].includes(route) && req.method === "POST") {
          if (route.endsWith("-all")) { await accounts.logoutAll(login.user.id); revoke(login.user.id); }
          else { await accounts.logout(login.loginId); revoke(login.user.id, login.loginId); }
          res.setHeader("set-cookie", cookie("", 0)); send(res, 200, { ok: true }); return true;
        }
        if (route === "/auth/password" && req.method === "POST") {
          await accounts.password(login.user.id, String(input.password ?? ""), String(input.currentPassword ?? "")); revoke(login.user.id);
          res.setHeader("set-cookie", cookie("", 0)); send(res, 200, { ok: true }); return true;
        }
        if (route.startsWith("/admin/users")) {
          if (login.user.role !== "admin") { send(res, 403, { error: "需要管理员权限" }); return true; }
          if (route === "/admin/users" && req.method === "GET") { send(res, 200, { users: await accounts.list() }); return true; }
          if (route === "/admin/users" && req.method === "POST") { send(res, 201, { user: await accounts.create(String(input.username ?? ""), String(input.password ?? "")) }); return true; }
          const match = /^\/admin\/users\/([\da-f-]+)\/(status|password)$/.exec(route);
          if (match && req.method === "POST") {
            if (match[2] === "status") { if (typeof input.disabled !== "boolean") throw new Error("状态无效"); await accounts.update(match[1], input.disabled); if (input.disabled) { revoke(match[1]); await cancelUser(match[1]); } }
            else { await accounts.password(match[1], String(input.password ?? "")); revoke(match[1]); }
            send(res, 200, { ok: true }); return true;
          }
        }
        if (route === "/account" && req.method === "GET") {
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.end(page('<a href="/">← 对话</a><h1>账号</h1><p id="name"></p><button id="logout">退出登录</button><button id="all">退出全部设备</button><form id="password"><h2>修改密码</h2><input name="currentPassword" type="password" autocomplete="current-password" placeholder="当前密码" required><input name="password" type="password" autocomplete="new-password" placeholder="新密码" minlength="6" required><button>保存</button></form><section id="admin" hidden><h2>用户管理</h2><form id="create"><input name="username" autocomplete="off" placeholder="用户名" required><input name="password" type="password" autocomplete="new-password" placeholder="初始密码" minlength="6" required><button>创建成员</button></form><div style="overflow-x:auto"><table><thead><tr><th>用户名</th><th>角色</th><th>状态</th><th>操作</th></tr></thead><tbody id="users"></tbody></table></div></section>', `
const out=async p=>{await api(p,{});location.href='/auth/login'};
document.getElementById('logout').onclick=()=>out('/auth/logout').catch(fail);document.getElementById('all').onclick=()=>out('/auth/logout-all').catch(fail);
document.getElementById('password').onsubmit=async e=>{e.preventDefault();try{await api('/auth/password',Object.fromEntries(new FormData(e.target)));location.href='/auth/login'}catch(e){fail(e)}};
const load=async()=>{const me=await api('/auth/me');document.getElementById('name').textContent=me.user.username;if(me.user.role!=='admin')return;document.getElementById('admin').hidden=false;const {users}=await api('/admin/users');const rows=document.getElementById('users');rows.replaceChildren();for(const user of users){const tr=document.createElement('tr');for(const text of [user.username,user.role==='admin'?'管理员':'成员',user.disabled?'已停用':'正常']){const td=document.createElement('td');td.textContent=text;tr.append(td)}const td=document.createElement('td');const state=document.createElement('button');state.textContent=user.disabled?'启用':'停用';state.onclick=async()=>{try{await api('/admin/users/'+user.id+'/status',{disabled:!user.disabled});await load()}catch(e){fail(e)}};const reset=document.createElement('button');reset.textContent='重置密码';const password=document.createElement('input');password.type='password';password.autocomplete='new-password';password.setAttribute('aria-label',user.username+'的新密码');password.style.width='9em';reset.onclick=async()=>{try{await api('/admin/users/'+user.id+'/password',{password:password.value});password.value='';await load()}catch(e){fail(e)}};td.append(state,password,reset);tr.append(td);rows.append(tr)}};
document.getElementById('create').onsubmit=async e=>{e.preventDefault();try{await api('/admin/users',Object.fromEntries(new FormData(e.target)));e.target.reset();await load()}catch(e){fail(e)}};load().catch(fail);`)); return true;
        }
        send(res, 404, { error: "接口不存在" }); return true;
      } catch (error) { send(res, route === "/auth/login" ? 401 : 400, { error: error instanceof Error ? error.message : "请求失败" }); return true; }
    },
  };
}
