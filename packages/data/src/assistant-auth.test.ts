import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AssistantAccounts, ASSISTANT_LOGIN_MS } from "./assistant-auth.js";

test("accounts persist identities and seven-day logins without storing plaintext passwords", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "eris-auth-")); t.after(() => rm(root, { recursive: true, force: true }));
  let now = Date.now();
  const accounts = new AssistantAccounts(root, () => now);
  await accounts.initialize("cmy", "fixture-password");
  const user = await accounts.create("alice", "member-password");
  const one = await accounts.login("alice", "member-password"), two = await accounts.login("alice", "member-password");
  assert.notEqual(one.loginId, two.loginId); assert.equal(one.user.id, user.id);
  const restarted = new AssistantAccounts(root, () => now);
  await restarted.initialize("cmy");
  assert.equal((await restarted.authenticate(one.loginId))?.user.id, user.id);
  const text = await readFile(path.join(root, "accounts.json"), "utf8");
  assert(!text.includes("fixture-password")); assert(!text.includes("member-password"));
  assert.equal((await stat(path.join(root, "accounts.json"))).mode & 0o777, 0o600);
  await accounts.logout(one.loginId); assert.equal(await accounts.authenticate(one.loginId), undefined);
  assert(await accounts.authenticate(two.loginId));
  now += ASSISTANT_LOGIN_MS; assert.equal(await restarted.authenticate(two.loginId), undefined);
});

test("password resets, disable and logout-all revoke every device; last administrator is protected", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "eris-users-")); t.after(() => rm(root, { recursive: true, force: true }));
  const accounts = new AssistantAccounts(root); await accounts.initialize("cmy", "fixture-password");
  const user = await accounts.create("alice", "member-password");
  await assert.rejects(accounts.create("alice", "other-password"), /已存在/);
  const login = await accounts.login("alice", "member-password");
  await assert.rejects(accounts.password(user.id, "new-password", "wrong-password"), /当前密码/);
  await accounts.password(user.id, "new-password", "member-password");
  assert.equal(await accounts.authenticate(login.loginId), undefined);
  await assert.rejects(accounts.login("alice", "member-password"), /用户名或密码/);
  const next = await accounts.login("alice", "new-password");
  await accounts.logoutAll(user.id); assert.equal(await accounts.authenticate(next.loginId), undefined);
  await accounts.update(user.id, true); await assert.rejects(accounts.login("alice", "new-password"), /用户名或密码/);
  await accounts.update(user.id, false); assert(await accounts.login("alice", "new-password"));
  const admin = (await accounts.list()).find(user => user.role === "admin")!;
  await assert.rejects(accounts.update(admin.id, true), /最后一位管理员/);
});
