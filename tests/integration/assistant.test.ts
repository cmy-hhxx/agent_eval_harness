import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AssistantSessions } from "@eval/runtime/assistant";
import { body, listen } from "@eval/runtime/http";
import { assistantDirectory } from "@eval/data";
import { object, type AssistantPrompt, type JsonObject, type ModelConfig } from "@eval/contracts";
import { createEris } from "@eval/assistant";
import { createSerperSearch } from "@eval/tools";
import { waitForTestState } from "../fixtures/wait.js";

async function settled(sessions: AssistantSessions, id: string, requestId: string) {
  return waitForTestState(
    async () => (await sessions.list("alice")).find((s) => s.sessionId === id)!,
    state => ["completed", "interrupted"].includes(state.requests[requestId]),
    `Assistant request ${requestId} did not settle`,
    6000,
  );
}

test("stopping during conversation preparation never starts a model turn", { timeout: 10000 }, async (t) => {
  for (const phase of ["models", "driver"] as const) for (const stop of ["cancel", "dispose"] as const)
    await t.test(`${stop} while preparing ${phase}`, async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "assistant-stop-"));
      const scope = { userId: "alice", sessionId: randomUUID() };
      const model: ModelConfig = { provider: "fixture", model: "fixture", api: "openai-completions",
        baseUrl: "http://127.0.0.1:1", apiKeyEnv: "UNUSED_KEY", thinking: "off", contextWindow: 4096, maxOutputTokens: 1024 };
      let enter = () => {}, release = () => {};
      const entered = new Promise<void>((resolve) => { enter = resolve; });
      const waiting = new Promise<void>((resolve) => { release = resolve; });
      const prompts: string[] = [], errors: unknown[] = [], histories: JsonObject[][] = [];
      const wait = async () => { enter(); await waiting; };
      const selection = { provider: model.provider, model: model.model };
      const sessions = new AssistantSessions({ directory, url: "http://127.0.0.1:1", model, systemPrompt: "test", tools: [],
        models: {
          async list() { if (phase === "models") await wait(); return { models: [], favorites: [], default: selection }; },
          async resolve() { return model; }, async favorites() {}, async readFavorites() { return []; },
        },
        driver: async ({ event, history }) => {
          histories.push(history.filter((entry) => entry.type === "user/message").map((entry) => entry.data));
          if (phase === "driver") await wait();
          return { async prompt(text) {
            prompts.push(text);
            await event({ type: "agent_start" }); await event({ type: "turn_start" });
            await event({ type: "message_end", message: { role: "user", content: [{ type: "text", text }] } });
            await event({ type: "turn_end" }); await event({ type: "agent_end" });
          }, async steer() {}, async abort() {}, async dispose() {} };
        }, onError: (error) => errors.push(error),
      });
      let disposing: Promise<void> | undefined;
      try {
        await sessions.create(scope.userId, scope.sessionId);
        const requestId = randomUUID();
        await sessions.prompt(scope.userId, { sessionId: scope.sessionId, requestId, mode: "queue", content: [{ type: "text", text: "stop this turn" }] });
        await entered;
        const stopping = stop === "cancel" ? sessions.cancel(scope) : (disposing = sessions.dispose());
        if (stop === "cancel") await stopping;
        release();
        await stopping;
        assert.equal((await settled(sessions, scope.sessionId, requestId)).requests[requestId], "interrupted");
        assert.deepEqual(prompts, [], "a stopped request must not reach the model or its tools");
        assert.deepEqual(errors, [], "user cancellation is not an execution error");
        if (stop === "cancel") {
          const page = await sessions.page(scope) as { records: { event: { type: string; data: JsonObject } }[] };
          assert.equal(page.records.filter((row) => row.event.type === "user/message").length, 1, "keep the interrupted user's message");
          assert(page.records.some((row) => row.event.type === "turn/end" && object(row.event.data.reason).kind === "aborted"));
          const nextId = randomUUID();
          await sessions.prompt(scope.userId, { sessionId: scope.sessionId, requestId: nextId, mode: "queue", content: [{ type: "text", text: "continue" }] });
          assert.equal((await settled(sessions, scope.sessionId, nextId)).requests[nextId], "completed");
          assert.deepEqual(prompts, ["continue"], "cancellation must not poison the next request");
          assert.equal(histories.length, phase === "models" ? 1 : 2);
          assert(JSON.stringify(histories.at(-1)).includes("stop this turn"), "recreate a prepared driver from the interrupted history");
        }
      } finally { release(); await (disposing ?? sessions.dispose()); await rm(directory, { recursive: true, force: true }); }
    });
});

test("Eris cross-checks financial sources, saves cited summaries and restores search and raw evidence without re-querying", { timeout: 30000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "assistant-search-"));
  const scope = { userId: "alice", sessionId: randomUUID() };
  const reference = { runId: "finance-run", taskId: "finance-comparison" };
  const sourceUrl = "https://www.pbc.gov.cn/announcement.html";
  const query = "人民银行 2026年9月 利率 公告";
  const markdown = `正式结果：模型 A 缺少利率口径。\n\n外部核对：[央行公告](${sourceUrl})，发布日期 2026-09-20。`;
  const accepted = { conclusion: "模型 A 缺少利率口径。" };
  const saved: string[] = [], errors: unknown[] = [];
  let searches = 0, readings = 0;
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected dependency call"); };
  const previousSecret = process.env.ASSISTANT_TEST_KEY;
  process.env.ASSISTANT_TEST_KEY = "fixture-model-secret";
  const eris = createEris({
    data: {
      list: unexpected, search: unexpected, image: unexpected,
      async read(ref) { assert.deepEqual(ref, reference); return { result: accepted, evaluatorVersion: "fixture" }; },
    },
    specialists: { invoke: unexpected, read: unexpected },
    search: createSerperSearch({ apiKey: "fixture-serper-secret", async fetch(endpoint, init) {
      searches++;
      assert.equal(endpoint, "https://google.serper.dev/search");
      assert.equal(new Headers(init?.headers).get("X-API-KEY"), "fixture-serper-secret");
      assert.deepEqual(JSON.parse(String(init?.body)), { q: `${query} (site:pbc.gov.cn)`, gl: "cn", hl: "zh-cn", num: 10, page: 1 });
      return Response.json({ organic: [{ title: "央行公告", link: sourceUrl, snippet: "央行发布利率公告。", date: "2026-09-20", position: 1 }], credits: 1 });
    } }),
    web: { async read(args, signal) {
      readings++;
      assert.deepEqual(args, { url: sourceUrl, find: "利率" }); assert(!signal.aborted);
      return { requestedUrl: sourceUrl, url: sourceUrl, title: "央行公告", format: "html", retrievedAt: "2026-10-02T00:00:00.000Z", elapsedMs: 10, publicationDate: "2026-09-20", dateAssessment: { status: "not_requested", basis: "page_metadata", date: "2026-09-20" }, lines: [{ number: 1, text: "2026年9月20日 利率公告" }, { number: 2, text: "央行发布利率口径。" }], matches: [{ line: 1 }, { line: 2 }], totalLines: 2, truncated: false, limitations: [] };
    } },
    async save(_, text) { saved.push(text); return { name: "summary.md", url: "/summary.md" }; },
  });
  const gateway = await listen(async (req, res) => {
    const request = object(await body(req));
    assert(!JSON.stringify(request).includes("fixture-serper-secret"));
    const tools = request.tools as { function: { name: string } }[];
    assert(tools.some(tool => tool.function.name === "search_web"));
    const messages = request.messages as JsonObject[];
    const results = messages.filter(message => message.role === "tool");
    const next = results.length === 0 ? { name: "read_data", arguments: { reference } }
      : results.length === 1 ? { name: "search_web", arguments: { queries: [{ query, domains: ["pbc.gov.cn"] }] } }
      : results.length === 2 ? { name: "read_web", arguments: { url: sourceUrl, find: "利率" } }
      : results.length === 3 ? { name: "save_summary", arguments: { markdown, references: [{ reference }] } } : undefined;
    if (results.length >= 2) {
      const search = JSON.parse(String(results[1].content));
      assert.equal(search.results[0].url, sourceUrl);
      assert.equal(search.results[0].date, "2026-09-20");
      assert(!Number.isNaN(Date.parse(search.searchedAt)));
      assert.deepEqual(JSON.parse(String(results[0].content)).result, accepted, "external facts leave accepted conclusions intact");
    }
    if (results.length >= 3) {
      const raw = JSON.parse(String(results[2].content));
      assert.equal(raw.lines[1].number, 2); assert.equal(raw.lines[1].text, "央行发布利率口径。");
    }
    const delta = next ? { role: "assistant", tool_calls: [{ index: 0, id: `financial-call-${results.length}`, type: "function", function: { name: next.name, arguments: JSON.stringify(next.arguments) } }] }
      : { role: "assistant", content: `已结合正式结果与[央行公告](${sourceUrl})保存总结。` };
    const chunk = { id: "financial-fixture", object: "chat.completion.chunk", created: 1, model: "fixture" };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: next ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  const model: ModelConfig = { provider: "test-gateway", baseUrl: gateway.url + "/v1", api: "openai-completions", apiKeyEnv: "ASSISTANT_TEST_KEY", model: "fixture", thinking: "off", contextWindow: 65536, maxOutputTokens: 4096 };
  const options = { directory, url: "http://127.0.0.1:1", model, ...eris, onError: (error: unknown) => errors.push(error) };
  let sessions = new AssistantSessions(options);
  try {
    await sessions.create(scope.userId, scope.sessionId);
    const prompt: AssistantPrompt = { ...scope, requestId: randomUUID(), mode: "queue", content: [{ type: "text", text: "用央行公告交叉核对这份点评，保存总结。" }] };
    await sessions.prompt(scope.userId, prompt);
    assert.equal((await settled(sessions, scope.sessionId, prompt.requestId)).requests[prompt.requestId], "completed", JSON.stringify(errors));
    assert.equal(searches, 1); assert.equal(readings, 1);
    assert.deepEqual(saved, [markdown]);
    const journal = await readFile(path.join(assistantDirectory(directory, scope), "events.jsonl"), "utf8");
    assert(!journal.includes("fixture-serper-secret"));
    const rows = journal.trim().split("\n").map(line => JSON.parse(line));
    const searchRecord = rows.find(row => row.event?.type === "tool/result" && row.event.data.message?.toolCallId === "financial-call-1");
    assert(searchRecord, "search result is recorded for later conversation and inspection");
    assert(!searchRecord.event.data.meta?.sourceRead, "external search must not be re-executed as a local source reader");
    const rawRecord = rows.find(row => row.event?.type === "tool/result" && row.event.data.message?.toolCallId === "financial-call-2");
    assert(rawRecord, "raw evidence and exact coordinates are retained");
    assert(!rawRecord.event.data.meta?.sourceRead, "web reading must not be rerun during restore");
    await sessions.dispose();
    sessions = new AssistantSessions(options);
    const next = { ...prompt, requestId: randomUUID(), content: [{ type: "text" as const, text: "继续解释刚才的核对结果。" }] };
    await sessions.prompt(scope.userId, next);
    assert.equal((await settled(sessions, scope.sessionId, next.requestId)).requests[next.requestId], "completed", JSON.stringify(errors));
    assert.equal(searches, 1, "resume uses the persisted retrieval timestamp and sources without another paid request");
    assert.equal(readings, 1, "resume uses persisted raw evidence without another network read");
    assert.deepEqual(saved, [markdown]);
    assert.deepEqual(errors, []);
  } finally {
    await sessions.dispose(); await gateway.close(); await rm(directory, { recursive: true, force: true });
    if (previousSecret === undefined) delete process.env.ASSISTANT_TEST_KEY; else process.env.ASSISTANT_TEST_KEY = previousSecret;
  }
});

test("Pi conversation preserves source read errors without re-executing failed tools on restoration", { timeout: 10000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "assistant-tool-error-"));
  const scope = { userId: "alice", sessionId: randomUUID() };
  const requests: JsonObject[] = [], errors: unknown[] = [];
  const previousSecret = process.env.ASSISTANT_TEST_KEY;
  process.env.ASSISTANT_TEST_KEY = "fixture-secret";
  const gateway = await listen(async (req, res) => {
    const request = object(await body(req)); requests.push(request);
    const hasTool = (request.messages as JsonObject[]).some(message => message.role === "tool");
    const delta = hasTool ? { role: "assistant", content: "材料读取失败。" }
      : { role: "assistant", tool_calls: [{ index: 0, id: "failed-lookup", type: "function", function: { name: "lookup", arguments: "{}" } }] };
    const chunk = { id: "tool-error-fixture", object: "chat.completion.chunk", created: 1, model: "fixture" };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: hasTool ? "stop" : "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  const model: ModelConfig = { provider: "test-gateway", baseUrl: gateway.url + "/v1", api: "openai-completions", apiKeyEnv: "ASSISTANT_TEST_KEY", model: "fixture", thinking: "off", contextWindow: 65536, maxOutputTokens: 4096 };
  let toolExecutions = 0;
  const options = { directory, url: "http://127.0.0.1:1", model, systemPrompt: "Use lookup, then explain.", tools: [{ name: "lookup", readOnly: true, description: "Read source material.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, execute: async () => {
    toolExecutions++;
    return { isError: true, content: [{ type: "text" as const, text: "Source reader unavailable" }], details: { sourceRead: { tool: "lookup", args: {} } } };
  } }], onError: (error: unknown) => errors.push(error) };
  let sessions = new AssistantSessions(options);
  try {
    await sessions.create(scope.userId, scope.sessionId);
    const prompt: AssistantPrompt = { sessionId: scope.sessionId, requestId: randomUUID(), mode: "queue", content: [{ type: "text", text: "读取材料" }] };
    await sessions.prompt(scope.userId, prompt);
    assert.equal((await settled(sessions, scope.sessionId, prompt.requestId)).requests[prompt.requestId], "completed", JSON.stringify(errors));
    const page = object(await sessions.page(scope));
    const rows = page.records as { event: { type: string; data: JsonObject } }[];
    const result = rows.find(row => row.event.type === "tool/result")!.event.data;
    assert.equal(object(result.message).isError, true, "a returned tool failure must not become a successful SDK result");
    assert(JSON.stringify(object(result.message).content).includes("Source reader unavailable"));
    assert.deepEqual(object(result.meta ?? {}).sourceRead, { tool: "lookup", args: {} }, "locator metadata does not authorize replay of a failed read");
    await assert.rejects(sessions.toolResult(scope, "failed-lookup"), /没有可读取/);
    assert.equal(toolExecutions, 1);
    assert.equal(requests.length, 2, "the model can explain a tool failure without failing the whole turn");
    await sessions.dispose(); sessions = new AssistantSessions(options);
    const next = { ...prompt, requestId: randomUUID(), content: [{ type: "text" as const, text: "继续说明读取失败" }] };
    await sessions.prompt(scope.userId, next);
    assert.equal((await settled(sessions, scope.sessionId, next.requestId)).requests[next.requestId], "completed", JSON.stringify(errors));
    assert.equal(toolExecutions, 1, "restoration must not execute a failed source reader again");
    assert(JSON.stringify(requests.at(-1)!.messages).includes("Source reader unavailable"));
    assert.deepEqual(errors, []);
  } finally {
    await sessions.dispose(); await gateway.close(); await rm(directory, { recursive: true, force: true });
    if (previousSecret === undefined) delete process.env.ASSISTANT_TEST_KEY; else process.env.ASSISTANT_TEST_KEY = previousSecret;
  }
});

test("Pi conversation checkpoints before requests, deduplicates, invokes tools, and restores one authoritative history", { timeout: 30000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "assistant-pi-"));
  const scope = { userId: "alice", sessionId: randomUUID() };
  const requests: JsonObject[] = [], errors: unknown[] = [];
  const previousSecret = process.env.ASSISTANT_TEST_KEY;
  process.env.ASSISTANT_TEST_KEY = "fixture-secret";
  const gateway = await listen(async (req, res) => {
    const request = object(await body(req)); requests.push(request);
    const journal = await readFile(path.join(assistantDirectory(directory, scope), "events.jsonl"), "utf8");
    assert(journal.includes('"type":"user/message"'), "message must be durable before network request");
    const messages = request.messages as JsonObject[], tools = request.tools as { function: { name: string } }[];
    assert.deepEqual(tools.map((tool) => tool.function.name), ["lookup"]);
    const hasTool = messages.some((message) => message.role === "tool");
    if (hasTool) assert(journal.includes('"type":"tool/result"'), "tool result must be durable before next network request");
    const chunk = { id: `fixture-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "fixture" };
    res.writeHead(200, { "content-type": "text/event-stream" });
    const delta = hasTool ? { role: "assistant", content: "已读取正式评测结果。" } : { role: "assistant", tool_calls: [{ index: 0, id: "lookup-call", type: "function", function: { name: "lookup", arguments: "{}" } }] };
    res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    await delay(25);
    res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: hasTool ? "stop" : "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  const model: ModelConfig = { provider: "test-gateway", baseUrl: gateway.url + "/v1", api: "openai-completions", apiKeyEnv: "ASSISTANT_TEST_KEY", model: "fixture", thinking: "off", contextWindow: 65536, maxOutputTokens: 4096 };
  let toolExecutions = 0;
  const options = { directory, url: "http://127.0.0.1:1", model, systemPrompt: "Use lookup, then explain.", tools: [{ name: "lookup", readOnly: true, description: "Read accepted results.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, execute: async () => { toolExecutions++; return { content: [{ type: "text" as const, text: "accepted:r6" }], details: { sourceRead: { tool: "lookup", args: {} } } }; } }], onError: (error: unknown) => errors.push(error) };
  let sessions = new AssistantSessions(options);
  try {
    await sessions.create(scope.userId, scope.sessionId);
    const prompt: AssistantPrompt = { sessionId: scope.sessionId, requestId: randomUUID(), mode: "queue", content: [{ type: "text", text: "第一轮：读取评测" }] };
    await Promise.all([sessions.prompt("alice", prompt), sessions.prompt("alice", prompt)]);
    const state = await settled(sessions, scope.sessionId, prompt.requestId);
    assert.equal(state.requests[prompt.requestId], "completed", JSON.stringify(errors));
    assert.equal(toolExecutions, 1); assert.equal(requests.length, 2);
    assert.deepEqual(await sessions.list("bob"), []);
    await assert.rejects(sessions.page({ userId: "bob", sessionId: scope.sessionId }), /ENOENT/);
    await assert.rejects(sessions.prompt("alice", { ...prompt, content: [{ type: "text", text: "conflicting UUID" }] }), /different content/);
    await sessions.dispose();
    sessions = new AssistantSessions(options);
    const next: AssistantPrompt = { ...prompt, requestId: randomUUID(), content: [{ type: "text", text: "第二轮：继续解释" }] };
    await sessions.prompt("alice", next);
    assert.equal((await settled(sessions, scope.sessionId, next.requestId)).requests[next.requestId], "completed", JSON.stringify(errors));
    const last = JSON.stringify(requests.at(-1)!.messages);
    assert(last.includes("第一轮：读取评测")); assert(last.includes("已读取正式评测结果。")); assert(last.includes("accepted:r6"));
    const journal = (await readFile(path.join(assistantDirectory(directory, scope), "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(journal.filter((r) => r.event?.type === "user/message").length, 2);
    assert.equal(journal.filter((r) => r.event?.type === "tool/result").length, 1);
    assert.equal(toolExecutions, 2, "only the read-only source is rehydrated on resume");
    assert(!JSON.stringify(journal).includes("accepted:r6"), "original source bodies are not copied into the session journal");
    const beforeInspect = await readFile(path.join(assistantDirectory(directory, scope), "events.jsonl"), "utf8");
    assert.equal((await sessions.toolResult(scope, "lookup-call")).content[0].text, "accepted:r6");
    assert.equal(toolExecutions, 3);
    assert.equal(await readFile(path.join(assistantDirectory(directory, scope), "events.jsonl"), "utf8"), beforeInspect, "inspection does not add source bodies or replay events");
    await assert.rejects(sessions.toolResult(scope, "unrecorded"), /没有可读取/);
    await assert.rejects(sessions.toolResult({ ...scope, userId: "bob" }, "lookup-call"), /ENOENT/);
    assert.equal(toolExecutions, 3, "unrecorded and foreign calls never reach a source reader");
    options.tools[0].readOnly = false;
    await assert.rejects(sessions.toolResult(scope, "lookup-call"), /Source reader unavailable/);
    assert.equal(toolExecutions, 3, "inspection cannot execute a writable tool even if a journal entry names it");
    assert.deepEqual(errors, []);
  } finally {
    await sessions.dispose(); await gateway.close(); await rm(directory, { recursive: true, force: true });
    if (previousSecret === undefined) delete process.env.ASSISTANT_TEST_KEY; else process.env.ASSISTANT_TEST_KEY = previousSecret;
  }
});
