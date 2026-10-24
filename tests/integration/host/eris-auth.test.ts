import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import WebSocket from "ws";
import { AssistantAccounts } from "@eval/data";
import { AssistantSessions, serveAssistant } from "@eval/runtime/assistant";
import { erisAccess } from "../../../apps/host/src/eris-auth.js";

test("HTTP and stream authentication bind users and revoke existing connections", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "eris-http-auth-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const accounts = new AssistantAccounts(path.join(directory, "secrets")); await accounts.initialize("cmy", "fixture-password");
  const alice = await accounts.create("alice", "member-password"), bob = await accounts.create("bob", "member-password");
  const origin = "http://public.example:3928", cancelled: string[] = [];
  const access = await erisAccess(accounts, origin, async id => { cancelled.push(id); });
  const server = await serveAssistant({ port: 0, userId: "unused", access, webDirectory: directory,
    endpoints: () => ({ async call(userId) { return { userId }; }, async stream(userId) { return (async function* () { yield { userId }; })(); }, async dispose() {} }),
  }); t.after(() => server.close());
  const request = (route: string, data?: unknown, cookie?: string, source = origin) => fetch(server.url + route, {
    method: data === undefined ? "GET" : "POST", redirect: "manual", headers: { origin: source, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  assert.equal((await request("/health")).status, 200);
  assert.equal((await request("/")).status, 303);
  assert.equal((await request(`/u/${alice.id}/api/session/list`, {})).status, 401);
  const login = await request("/auth/login", { username: "alice", password: "member-password" });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  assert(cookie.startsWith("eris_session=")); assert(!cookie.includes("workbench"));
  const call = { type: "client-request", rpcId: "test", method: "session/list", payload: { args: { request: { userId: bob.id } } } };
  const response = await request(`/u/${alice.id}/api/session/list`, call, cookie);
  assert.equal(response.status, 200); assert((await response.text()).includes(alice.id));
  assert.equal((await request(`/u/${bob.id}/api/session/list`, call, cookie)).status, 404);
  assert.equal((await request(`/u/${alice.id}/api/session/list`, call, cookie, "http://evil.example")).status, 403);
  assert.equal((await request("/admin/users", undefined, cookie)).status, 403);
  const socket = new WebSocket(server.url.replace("http", "ws") + `/u/${alice.id}/api/remote.mux`, { origin, headers: { cookie } });
  await once(socket, "open"); const closed = once(socket, "close");
  await request("/auth/logout-all", {}, cookie); await closed;
  assert.equal((await request("/auth/me", undefined, cookie)).status, 401);
  const adminLogin = await request("/auth/login", { username: "cmy", password: "fixture-password" });
  const adminCookie = adminLogin.headers.get("set-cookie")!.split(";")[0];
  const relogin = await request("/auth/login", { username: "alice", password: "member-password" });
  const active = relogin.headers.get("set-cookie")!.split(";")[0];
  assert.equal((await request(`/admin/users/${alice.id}/status`, { disabled: true }, adminCookie)).status, 200);
  assert.deepEqual(cancelled, [alice.id]); assert.equal((await request("/auth/me", undefined, active)).status, 401);
  const internal = await fetch(server.url + `/u/${bob.id}/api/session/list`, { method: "POST", headers: { authorization: access.internalAuthorization(bob.id), "content-type": "application/json" }, body: JSON.stringify(call) });
  assert.equal(internal.status, 200);
  const forwarded = new AssistantSessions({ directory, url: "http://127.0.0.1:1", systemPrompt: "fixture", tools: [],
    model: { provider: "fixture", model: "fixture", api: "openai-responses", baseUrl: "http://127.0.0.1:1", apiKeyEnv: "UNUSED", thinking: "off", contextWindow: 10000, maxOutputTokens: 1000 },
    internalAuthorization: access.internalAuthorization,
    ownership: { async locate() { return { url: server.url, pid: process.pid, instanceId: "foreign" }; }, async claim() { throw new Error("Unexpected ownership claim"); } },
  }); t.after(() => forwarded.dispose());
  assert.deepEqual(await forwarded.page({ userId: bob.id, sessionId: "remote" }), { userId: bob.id });
  const controller = new AbortController(), events = forwarded.events({ userId: bob.id, sessionId: "remote" }, controller.signal)[Symbol.asyncIterator]();
  assert.deepEqual((await events.next()).value, { userId: bob.id }); controller.abort(); await events.return?.();
  const internalSocket = new WebSocket(server.url.replace("http", "ws") + `/u/${bob.id}/api/remote.mux`, { headers: { authorization: access.internalAuthorization(bob.id) } });
  await once(internalSocket, "open"); const internalClosed = once(internalSocket, "close");
  await request(`/admin/users/${bob.id}/status`, { disabled: true }, adminCookie); await internalClosed;
  await assert.rejects(serveAssistant({ port: Number(new URL(server.url).port), userId: "unused", webDirectory: directory,
    endpoints: () => ({ async call() {}, async stream() { return (async function* () {})(); }, async dispose() {} }),
  }), /EADDRINUSE/);
  assert.equal((await request("/health")).status, 200, "port conflicts preserve the existing listener");
});
