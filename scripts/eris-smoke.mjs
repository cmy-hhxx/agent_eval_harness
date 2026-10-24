import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { RemoteStreamMuxClient } from "@eval/runtime/assistant";

const base = process.env.ERIS_SERVER_URL || "http://127.0.0.1:5004";
const origin = process.env.ERIS_PUBLIC_ORIGIN || "http://117.50.195.94:3928";
const password = process.env.ERIS_SMOKE_PASSWORD; delete process.env.ERIS_SMOKE_PASSWORD;
if (!password) throw new Error("ERIS_SMOKE_PASSWORD is required");
assert.equal((await fetch(base + "/health")).status, 200);
assert.equal((await fetch(base + "/u/unauthorized/api/session/list", { method: "POST" })).status, 401);
const login = await fetch(base + "/auth/login", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ username: "cmy", password }) });
assert.equal(login.status, 200, "administrator login");
const cookie = login.headers.get("set-cookie").split(";")[0], { user } = await login.json();
async function rpc(method, request = {}) {
  const response = await fetch(`${base}/u/${user.id}/api/${method}`, { method: "POST", headers: { origin, cookie, "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId: randomUUID(), method, payload: { args: { request } } }),
  });
  assert.equal(response.status, 200, method); const envelope = await response.json();
  if (!envelope.result?.ok) throw new Error(`${method} failed: ${envelope.result?.error?.message}`);
  return envelope.result.value;
}
let client;
const follow = async sessionId => {
  client = new RemoteStreamMuxClient(`${base.replace(/^http/, "ws")}/u/${user.id}/api/remote.mux`, url => new WebSocket(url, { origin, headers: { cookie } }));
  client.start();
  const controller = new AbortController(), stream = client.open("session/follow", { args: { request: { address: { kind: "session", sessionId }, assistantStream: true } } }, controller.signal)[Symbol.asyncIterator]();
  const first = await Promise.race([stream.next(), delay(15000).then(() => { throw new Error("stream timeout"); })]);
  assert.equal(first.value.type, "snapshot"); return { stream, controller };
};
try {
  const catalog = await rpc("session/modelCatalog");
  assert(catalog.groups.some(group => group.models.some(model => model.id === "deepseek-v4.1-flash")));
  const { sessionId } = await rpc("session/create"), requestId = randomUUID();
  const first = await follow(sessionId);
  await rpc("session/prompt", { sessionId, requestId, mode: "queue", content: [{ type: "text", text: "请调用 list_data，参数仅为 {limit:30}，不传 view。列出已有正式运行的 collectionId、runId、workflow；不要读取个案，不要搜索外网。" }] });
  first.controller.abort(); await first.stream.return?.(); await client.close();
  const second = await follow(sessionId); second.controller.abort(); await second.stream.return?.();
  let records = [];
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    records = (await rpc("session/page", { sessionId, maxMessages: 1000 })).records;
    const state = records.filter(record => record.event?.type === "assistant/request" && record.event.data.requestId === requestId).at(-1)?.event.data.status;
    if (state === "completed") break;
    if (state === "interrupted") throw new Error("conversation interrupted");
    await delay(1000);
  }
  const requests = records.filter(record => record.event?.type === "assistant/request" && record.event.data.requestId === requestId);
  assert.equal(requests.at(-1)?.event.data.status, "completed", "model completion");
  assert.equal(requests.filter(record => record.event.data.status === "queued").length, 1, "reconnect does not resubmit");
  const toolResults = records.filter(record => record.event?.type === "tool/result");
  assert(toolResults.length > 0, "real model used read-only data tools");
  const pages = toolResults.flatMap(record => record.event.data.message.content ?? []).filter(block => block.type === "text").flatMap(block => { try { return [JSON.parse(block.text)]; } catch { return []; } });
  const runs = pages.flatMap(page => page.items ?? []);
  assert(runs.some(run => run.workflow === "answer-review"), "current AIME runs are visible");
  assert(runs.some(run => run.workflow === "comparison"), "current Comparison runs are visible");
  await rpc("session/rename", { sessionId, title: "部署验收" });
  await rpc("workspace/archiveSession", { sessionId });
  console.log(JSON.stringify({ health: true, login: true, model: "deepseek-v4.1-flash", reconnect: true, requestCount: 1, readOnlyToolResults: toolResults.length, workflowTypes: [...new Set(runs.map(run => run.workflow))] }));
} finally {
  await client?.close();
  await fetch(base + "/auth/logout", { method: "POST", headers: { origin, cookie, "content-type": "application/json" }, body: "{}" });
}
