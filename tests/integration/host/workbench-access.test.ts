import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { scryptSync } from "node:crypto";
import { createWorkbenchAccess } from "../../../apps/host/src/workbench-access.js";

test("Workbench reads are public and execution requires an origin-checked login session", async t => {
  const salt = "0123456789abcdef0123456789abcdef", passwordHash = `scrypt$${salt}$${scryptSync("fixture-password", Buffer.from(salt, "hex"), 64).toString("hex")}`;
  let origin = "", executions = 0; const events: string[] = [];
  let handler: ReturnType<typeof createWorkbenchAccess>;
  const server = http.createServer((req, res) => { void (async () => {
    if (await handler(req, res, new URL(req.url!, origin))) return;
    if (req.method === "POST") executions++;
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true }));
  })().catch(error => { res.writeHead(500); res.end(error.message); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  handler = createWorkbenchAccess({ publicOrigin: origin, secrets: { adminUser: "operator", passwordHash, relayToken: "relay" }, loginEvent: async event => { events.push(event); } });
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  for (const route of ["/", "/workbench-assets/workbench.bundle.js", "/runtime/api/daily", "/runtime/api/dashboard/runs", "/data/aime/dashboard-data"])
    assert.equal((await fetch(origin + route)).status, 200, route);
  assert.deepEqual(await (await fetch(origin + "/session")).json(), { authenticated: false });
  const denied = await fetch(origin + "/runtime/api/daily/wencai/control", { method: "POST", headers: { origin }, body: "{}" });
  assert.equal(denied.status, 401); assert.equal((await denied.json()).code, "login_required"); assert.equal(executions, 0);
  assert.equal((await fetch(origin + "/login", { method: "POST", headers: { origin: "http://other.test" }, body: "username=operator&password=fixture-password" })).status, 403);
  const wrong = await fetch(origin + "/login", { method: "POST", headers: { origin }, body: "username=operator&password=wrong" }); assert.equal(wrong.status, 401);
  const login = await fetch(origin + "/login", { method: "POST", headers: { origin }, body: "username=operator&password=fixture-password" });
  assert.equal(login.status, 200); assert.deepEqual(await login.json(), { authenticated: true });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]; assert.match(login.headers.get("set-cookie")!, /HttpOnly.*SameSite=Strict/);
  assert.equal((await fetch(origin + "/session", { headers: { cookie } }).then(r => r.json())).authenticated, true);
  assert.equal((await fetch(origin + "/runtime/api/daily/wencai/control", { method: "POST", headers: { origin, cookie }, body: "{}" })).status, 200); assert.equal(executions, 1);
  assert.equal((await fetch(origin + "/runtime/api/daily/aime/control", { method: "POST", headers: { origin: "http://other.test", cookie }, body: "{}" })).status, 403); assert.equal(executions, 1);
  assert.equal((await fetch(origin + "/runtime/api/relay/records")).status, 401);
  assert.equal((await fetch(origin + "/runtime/api/relay/records", { headers: { authorization: "Bearer relay" } })).status, 200);
  assert.equal((await fetch(origin + "/logout", { method: "POST", headers: { origin, cookie } })).status, 200);
  assert.equal((await fetch(origin + "/runtime/api/daily/wencai/control", { method: "POST", headers: { origin, cookie }, body: "{}" })).status, 401);
  assert.deepEqual(events, ["login_failed", "login_succeeded"]);
  for (let i = 0; i < 5; i++) assert.equal((await fetch(origin + "/login", { method: "POST", headers: { origin }, body: "username=operator&password=wrong" })).status, 401);
  assert.equal((await fetch(origin + "/login", { method: "POST", headers: { origin }, body: "username=operator&password=fixture-password" })).status, 429);
});
