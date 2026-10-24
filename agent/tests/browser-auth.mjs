import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "node:net";
import { once } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { AssistantAccounts } from "@eval/data";
import { AssistantSessions, serveAssistant } from "@eval/runtime/assistant";
import { assistantEndpoints } from "@eval/assistant/server";
import { erisAccess } from "../../dist/apps/host/src/eris-auth.js";

const directory = await mkdtemp(path.join(tmpdir(), "eris-auth-browser-"));
const reservation = createServer().listen(0, "127.0.0.1"); await once(reservation, "listening");
const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const accounts = new AssistantAccounts(path.join(directory, "secrets")); await accounts.initialize("cmy", "fixture-password");
const admin = (await accounts.list())[0]; let sessions;
const access = await erisAccess(accounts, `http://127.0.0.1:${port}`, async id => { for (const session of await sessions.list(id)) await sessions.cancel(session); });
const server = await serveAssistant({ port, userId: "unused", access, webDirectory: process.cwd() + "/dist/agent/web",
  endpoints: url => assistantEndpoints(sessions = new AssistantSessions({ directory: path.join(directory, "chat"), url, systemPrompt: "fixture", tools: [], driver: async ({ event }) => ({
    async prompt(text) { await event({ type: 'agent_start' }); await event({ type: 'turn_start' });
      await event({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text }] } });
      await event({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'fixture' }], stopReason: 'stop' } });
      await event({ type: 'turn_end' }); await event({ type: 'agent_end' }); }, async steer() {}, async abort() {}, async dispose() {},
  }), model: {
    provider: "fixture", model: "deepseek-fixture", api: "openai-responses", baseUrl: "http://127.0.0.1:1", apiKeyEnv: "UNUSED", thinking: "off", contextWindow: 10000, maxOutputTokens: 1000,
  } })),
});
const shared = randomUUID();
async function seed(userId, title) {
  await sessions.create(userId, shared);
  const requestId = randomUUID(); await sessions.prompt(userId, { sessionId: shared, requestId, mode: 'queue', content: [{ type: 'text', text: title }] });
  for (let attempt = 0; attempt < 100 && (await sessions.list(userId))[0].requests[requestId] !== 'completed'; attempt++) await delay(50);
  await sessions.rename({ userId, sessionId: shared }, title);
}
await seed(admin.id, "管理员私有聊天");
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } }), page = await context.newPage();
  const login = async (page, name, password) => {
    await page.goto(server.url); await page.locator('input[name=username]').fill(name); await page.locator('input[name=password]').fill(password);
    const response = page.waitForResponse(response => response.url().endsWith("/auth/login") && response.request().method() === "POST");
    await page.getByRole("button", { name: "登录", exact: true }).click(); assert.equal((await response).status(), 200, "login response"); await page.locator('[contenteditable=true]').waitFor();
  };
  await login(page, "cmy", "fixture-password");
  assert.equal(await page.evaluate(() => document.compatMode), "CSS1Compat");
  await page.getByRole("link", { name: "账号", exact: true }).click();
  const create = page.locator("#create"); await create.locator('[name=username]').fill("alice"); await create.locator('[name=password]').fill("member-password");
  await create.getByRole("button", { name: "创建成员" }).click(); await page.getByText("alice", { exact: true }).waitFor();
  const member = (await accounts.list()).find(account => account.username === "alice");
  await seed(member.id, "成员私有聊天");
  const otherContext = await browser.newContext(), other = await otherContext.newPage();
  await login(other, "alice", "member-password"); await other.getByText("成员私有聊天", { exact: true }).first().waitFor();
  assert.equal(await other.getByText("管理员私有聊天", { exact: true }).count(), 0);
  assert.equal(await other.evaluate(async () => (await fetch("/admin/users")).status), 403);
  const row = () => page.locator("tr").filter({ has: page.getByText("alice", { exact: true }) });
  await row().getByRole("button", { name: "停用", exact: true }).click(); await other.waitForURL("**/auth/login");
  await row().getByRole("button", { name: "启用", exact: true }).click(); await row().getByRole("button", { name: "停用", exact: true }).waitFor();
  await row().getByLabel("alice的新密码").fill("replacement-password"); await row().getByRole("button", { name: "重置密码" }).click();
  await page.waitForFunction(() => document.querySelector('input[aria-label="alice的新密码"]')?.value === "");
  await login(other, "alice", "replacement-password"); await other.getByText("成员私有聊天", { exact: true }).first().waitFor();
  await other.getByRole("link", { name: "账号", exact: true }).click();
  assert.equal(await other.locator("#admin").isVisible(), false);
  const shots = path.join(process.cwd(), ".artifacts/agent-browser"); await mkdir(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, "accounts.png"), fullPage: true });
  await other.setViewportSize({ width: 390, height: 844 }); await other.screenshot({ path: path.join(shots, "account-mobile.png"), fullPage: true });
  console.log("Login, account administration, private chats, revocation and password reset: passed");
} finally { await browser?.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
