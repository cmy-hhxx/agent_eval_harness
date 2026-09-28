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

async function settled(sessions: AssistantSessions, id: string, requestId: string) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const state = (await sessions.list("alice")).find((s) => s.sessionId === id)!;
    if (["completed", "interrupted"].includes(state.requests[requestId])) return state;
    await delay(20);
  }
  throw new Error("Assistant did not settle");
}

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
