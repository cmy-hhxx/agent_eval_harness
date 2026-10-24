import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { AssistantAccounts } from "@eval/data";
import { AssistantSessions, RemoteStreamMuxClient, serveAssistant } from "@eval/runtime/assistant";
import { assistantEndpoints } from "@eval/assistant/server";
import { erisAccess } from "../../../apps/host/src/eris-auth.js";
import { waitForTestState } from "../../fixtures/wait.js";

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
  await once(socket, "open"); assert(socket.extensions.includes("permessage-deflate")); const closed = once(socket, "close");
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

test("the current access baseline belongs only to the authenticated namespace and remains open until cancellation", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "eris-access-stream-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const accounts = new AssistantAccounts(path.join(directory, "secrets")); await accounts.initialize("cmy", "fixture-password");
  const alice = await accounts.create("alice", "member-password"), bob = await accounts.create("bob", "member-password");
  const origin = "http://public.example:3928", access = await erisAccess(accounts, origin, async () => {});
  const server = await serveAssistant({ port: 0, userId: "unused", access, webDirectory: directory,
    endpoints: url => assistantEndpoints(new AssistantSessions({ directory, url, systemPrompt: "fixture", tools: [],
      model: { provider: "fixture", model: "fixture", api: "openai-responses", baseUrl: "http://127.0.0.1:1", apiKeyEnv: "UNUSED", thinking: "off", contextWindow: 10000, maxOutputTokens: 1000 },
    })),
  }); t.after(() => server.close());
  const login = await fetch(server.url + "/auth/login", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ username: "alice", password: "member-password" }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const denied = new WebSocket(`${server.url.replace("http", "ws")}/u/${bob.id}/api/remote.mux`, { origin, headers: { cookie } });
  await assert.rejects(once(denied, "open"));
  const client = new RemoteStreamMuxClient(() => new WebSocket(`${server.url.replace("http", "ws")}/u/${alice.id}/api/remote.mux`, { origin, headers: { cookie } }));
  client.start(); t.after(() => client.close());
  const controller = new AbortController();
  const stream = client.open("remoteAccess/follow", { args: {} }, AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]))[Symbol.asyncIterator]();
  assert.deepEqual((await stream.next()).value, { type: "baseline", owner: true });
  const pending = stream.next();
  assert.equal(await Promise.race([pending.then(() => false), delay(30).then(() => true)]), true, "the owner baseline must not cause a reconnect loop");
  controller.abort(); await assert.rejects(pending, { name: "AbortError" }); await stream.return?.();
  assert.equal((await fetch(server.url + "/admin/users", { headers: { cookie } })).status, 403, "namespace ownership does not grant administrator access");
});

test("suspension cancels a foreign owner's request while disabled internal credentials can only cancel", { timeout: 15000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "eris-foreign-suspension-"));
  let server: Awaited<ReturnType<typeof serveAssistant>> | undefined, gateway: Awaited<ReturnType<typeof serveAssistant>> | undefined;
  t.after(async () => { await gateway?.close(); await server?.close(); await rm(directory, { recursive: true, force: true }); });
  const accounts = new AssistantAccounts(path.join(directory, "secrets")); await accounts.initialize("cmy", "fixture-password");
  const member = await accounts.create("member", "member-password"), origin = "http://public.example:3928";
  const model = { provider: "fixture", model: "fixture", api: "openai-responses" as const, baseUrl: "http://127.0.0.1:1", apiKeyEnv: "UNUSED", thinking: "off" as const, contextWindow: 10000, maxOutputTokens: 1000 };
  let owner!: AssistantSessions, relay!: AssistantSessions;
  const ownerAccess = await erisAccess(accounts, origin, async userId => { for (const session of await owner.list(userId)) await owner.cancel(session); });
  const relayAccess = await erisAccess(accounts, origin, async userId => { for (const session of await relay.list(userId)) await relay.cancel(session); });
  let start!: () => void, stop!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; }), stopped = new Promise<void>(resolve => { stop = resolve; }), ownerMethods: string[] = [];
  let aborts = 0;
  server = await serveAssistant({ port: 0, userId: "unused", access: ownerAccess, webDirectory: directory, endpoints(url) {
    owner = new AssistantSessions({ directory, url, model, systemPrompt: "fixture", tools: [], internalAuthorization: ownerAccess.internalAuthorization,
      driver: async ({ event }) => ({
        async prompt(text) {
          await event({ type: "agent_start" }); await event({ type: "turn_start" });
          await event({ type: "message_end", message: { role: "user", content: [{ type: "text", text }] } });
          start(); await stopped; await event({ type: "agent_end" });
        },
        async steer() {}, async abort() { aborts++; stop(); }, async dispose() {},
      }),
    });
    const endpoints = assistantEndpoints(owner), call = endpoints.call;
    endpoints.call = (...args) => { ownerMethods.push(args[1]); return call(...args); };
    return endpoints;
  } });
  gateway = await serveAssistant({ port: 0, userId: "unused", access: relayAccess, webDirectory: directory, endpoints(url) {
    relay = new AssistantSessions({ directory, url, model, systemPrompt: "fixture", tools: [], internalAuthorization: relayAccess.internalAuthorization,
      driver: async () => { throw new Error("The gateway must forward to the existing owner"); },
    }); return assistantEndpoints(relay);
  } });
  const login = async (base: string, username: string, password: string) => {
    const response = await fetch(base + "/auth/login", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ username, password }) });
    assert.equal(response.status, 200); return response.headers.get("set-cookie")!.split(";")[0];
  };
  const memberCookie = await login(server.url, "member", "member-password"), adminCookie = await login(gateway.url, "cmy", "fixture-password");
  const rpc = async (method: string, request: object) => {
    const response = await fetch(`${server.url}/u/${member.id}/api/${method}`, { method: "POST", headers: { origin, cookie: memberCookie, "content-type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId: randomUUID(), method, payload: { args: { request } } }),
    }); assert.equal(response.status, 200); const result = await response.json(); assert.equal(result.result.ok, true); return result.result.value;
  };
  const { sessionId } = await rpc("session/create", {}), requestId = randomUUID();
  await rpc("session/prompt", { sessionId, requestId, mode: "queue", content: [{ type: "text", text: "Hold until cancelled" }] }); await started;
  const disabled = await fetch(`${gateway.url}/admin/users/${member.id}/status`, { method: "POST", headers: { origin, cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ disabled: true }) });
  assert.equal(disabled.status, 200); assert.equal(aborts, 1); assert(ownerMethods.includes("session/cancel"));
  await waitForTestState(() => owner.list(member.id), rows => rows[0].requests[requestId] === "interrupted", "The foreign owner did not settle its cancelled request");
  assert.equal((await fetch(server.url + "/auth/me", { headers: { cookie: memberCookie } })).status, 401);

  const authorization = relayAccess.internalAuthorization(member.id), cancellation = `/u/${member.id}/api/session/cancel`;
  const internal = (route: string, method = "session/cancel", proof = authorization) => fetch(server.url + route, { method: "POST", headers: { authorization: proof, "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId: randomUUID(), method, payload: { args: { request: { sessionId } } } }),
  });
  assert.equal((await internal(`/u/${member.id}/api/session/list`, "session/list")).status, 401);
  assert.equal((await internal(cancellation + "?ignored=true")).status, 401);
  assert.equal((await fetch(server.url + cancellation, { headers: { authorization } })).status, 401);
  const invalidProof = authorization.slice(0, -1) + (authorization.endsWith("A") ? "B" : "A");
  assert.equal((await internal(cancellation, "session/cancel", invalidProof)).status, 401);
  const unknown = randomUUID();
  assert.equal((await internal(`/u/${unknown}/api/session/cancel`, "session/cancel", relayAccess.internalAuthorization(unknown))).status, 401);
  const before = ownerMethods.length, mismatch = await internal(cancellation, "session/list");
  assert.equal(mismatch.status, 200); assert.equal((await mismatch.json()).result.error.code, "gateway/bad-request");
  assert.equal(ownerMethods.length, before, "a body method cannot change the URL's cancellation endpoint");
  const socket = new WebSocket(`${server.url.replace("http", "ws")}/u/${member.id}/api/remote.mux`, { headers: { authorization } });
  await assert.rejects(once(socket, "open"));
});
