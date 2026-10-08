import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createEris } from "@eval/assistant";
import { AssistantSessions } from "@eval/runtime/assistant";
import { body, listen } from "@eval/runtime/http";
import { AssistantJournal, assistantDirectory } from "@eval/data";
import { object, type AssistantTool, type JsonObject, type ModelConfig } from "@eval/contracts";

for (const scenario of ["repair", "repeat", "unknown", "budget", "reset"] as const) test(`Eris harness: ${scenario}`, { timeout: 15000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "eris-harness-"));
  const scope = { userId: "test", sessionId: crypto.randomUUID() };
  const env = "ERIS_HARNESS_TEST_KEY", previous = process.env[env];
  process.env[env] = "fixture";
  let modelCalls = 0, executions = 0;
  const errors: unknown[] = [];
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected dependency call"); };
  const eris = createEris({
    data: { list: async () => { executions++; return { kind: "runs", currentRun: null, items: [] }; }, read: unexpected, search: unexpected, image: unexpected },
    specialists: { invoke: unexpected, read: unexpected }, search: { search: unexpected }, web: { read: unexpected }, save: unexpected,
  });
  const tools: AssistantTool[] = scenario === "reset" ? [{
    name: "list_data", description: "read changing state", readOnly: true, inputSchema: { type: "object", properties: {} },
    async execute() { executions++; return { isError: ![3, 6].includes(executions), content: [{ type: "text", text: "state" }] }; },
  }] : eris.tools;
  const gateway = await listen(async (req, res) => {
    const request = object(await body(req)); modelCalls++;
    const messages = request.messages as JsonObject[];
    const outputs = messages.filter(message => message.role === "tool");
    if (scenario === "repair" && modelCalls === 2) {
      const text = JSON.stringify(outputs);
      assert.match(text, /\/limit.*schema_type/);
      assert.equal(executions, 1, "invalid calls never execute; independent valid calls still finish");
      assert.equal(outputs.length, 2, "both success and rejection reach the model before repair");
    }
    const done = scenario === "repair" && modelCalls === 3 || scenario === "reset" && modelCalls === 7;
    let args: JsonObject = {};
    if (scenario === "repair" && modelCalls === 1) args = { limit: "5" };
    if (scenario === "repeat") args = modelCalls % 2 ? { runId: ".", query: "." } : { query: ".", runId: "." };
    const delta = done ? { role: "assistant", content: "已完成核对。" } : {
      role: "assistant", tool_calls: [{ index: 0, id: `call-${modelCalls}`, type: "function",
        function: { name: scenario === "unknown" ? "missing_tool" : "list_data", arguments: JSON.stringify(args) } },
        ...(scenario === "repair" && modelCalls === 1 ? [{ index: 1, id: "independent", type: "function", function: { name: "list_data", arguments: "{}" } }] : [])],
    };
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = { id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture" };
    res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: done ? "stop" : "tool_calls" }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  const model: ModelConfig = { provider: "fixture", model: "fixture", baseUrl: gateway.url + "/v1", api: "openai-completions",
    apiKeyEnv: env, thinking: "off", contextWindow: 131072, maxOutputTokens: 4096 };
  const sessions = new AssistantSessions({ directory, url: "http://127.0.0.1:1", model, systemPrompt: eris.systemPrompt, tools, onError: error => errors.push(error) });
  const run = async () => {
    const requestId = crypto.randomUUID();
    await sessions.prompt(scope.userId, { ...scope, requestId, mode: "queue", content: [{ type: "text", text: "核对数据" }] });
    for (let n = 0; n < 1000; n++) {
      const state = (await sessions.list(scope.userId))[0].requests[requestId];
      if (state === "completed" || state === "interrupted") return state;
      await delay(10);
    }
    throw new Error("Request did not settle");
  };
  try {
    await sessions.create(scope.userId, scope.sessionId);
    assert.equal(await run(), ["repair", "reset"].includes(scenario) ? "completed" : "interrupted");
    assert.equal(modelCalls, scenario === "budget" ? 32 : scenario === "reset" ? 7 : 3);
    assert.equal(executions, scenario === "budget" ? 32 : scenario === "repair" ? 2 : scenario === "reset" ? 6 : 0);
    const rows = (await readFile(path.join(assistantDirectory(directory, scope), "events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const results = rows.filter(row => row.event?.type === "tool/result");
    assert.equal(results.length, scenario === "repair" ? 3 : scenario === "reset" ? 6 : modelCalls, "every result is durable even when the loop stops");
    if (scenario === "repeat" || scenario === "unknown") {
      assert.match(JSON.stringify(rows), /相同参数失败3次/);
      assert.equal(await run(), "interrupted");
      assert.equal(modelCalls, 6, "loop accounting resets for the next user request");
    }
    if (scenario === "budget") assert.match(JSON.stringify(rows), /32次模型请求上限/);
    // Pi may surface provider wrapper failures as model error messages rather than throws.
    for (const error of errors) assert.match(String(error), /相同参数失败3次|32次模型请求上限/);
  } finally {
    await sessions.dispose(); await gateway.close(); await rm(directory, { recursive: true, force: true });
    if (previous === undefined) delete process.env[env]; else process.env[env] = previous;
  }
});

for (const mode of ["throws", "error-result", "compacted"] as const) test(`source replay preserves the conversation: ${mode}`, { timeout: 10000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "eris-replay-"));
  const scope = { userId: "test", sessionId: crypto.randomUUID() };
  const env = "ERIS_REPLAY_TEST_KEY", previous = process.env[env];
  process.env[env] = "fixture";
  let modelCalls = 0, missing = false, reads = 0;
  const errors: unknown[] = [];
  const reader: AssistantTool = { name: "read_data", description: "read original source", readOnly: true,
    inputSchema: { type: "object", properties: {} },
    async execute() {
      reads++;
      if (missing) {
        if (mode === "error-result") return { isError: true, content: [{ type: "text", text: "original input removed" }] };
        throw new Error("original input removed");
      }
      return { content: [{ type: "text", text: "original evidence" }], details: { sourceRead: { tool: "read_data", args: {} } } };
    },
  };
  const gateway = await listen(async (req, res) => {
    const request = object(await body(req)); modelCalls++;
    const messages = request.messages as JsonObject[];
    if (missing) {
      assert.match(JSON.stringify(messages), mode === "compacted" ? /已核对材料，原始读取已压缩/ : /original input removed/);
      assert(!messages.some(message => message.role === "tool" && JSON.stringify(message).includes("original evidence")));
    }
    const delta = modelCalls === 1 ? { role: "assistant", tool_calls: [{ index: 0, id: "source", type: "function", function: { name: "read_data", arguments: "{}" } }] }
      : { role: "assistant", content: missing ? "原始材料当前不可读。" : "已读取。" };
    const chunk = { id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture" };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: modelCalls === 1 ? "tool_calls" : "stop" }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  const options = { directory, url: "http://127.0.0.1:1", tools: [reader], systemPrompt: "Use the original evidence.",
    model: { provider: "fixture", model: "fixture", baseUrl: gateway.url + "/v1", api: "openai-completions", apiKeyEnv: env,
      thinking: "off", contextWindow: 65536, maxOutputTokens: 4096 } as ModelConfig, onError: (error: unknown) => errors.push(error) };
  let sessions = new AssistantSessions(options);
  const run = async () => {
    const requestId = crypto.randomUUID();
    await sessions.prompt(scope.userId, { ...scope, requestId, mode: "queue", content: [{ type: "text", text: "继续" }] });
    for (let n = 0; n < 500; n++) {
      const status = (await sessions.list(scope.userId))[0].requests[requestId];
      if (status === "completed") return;
      assert.notEqual(status, "interrupted", JSON.stringify(errors));
      await delay(10);
    }
    throw new Error("Request did not settle");
  };
  try {
    await sessions.create(scope.userId, scope.sessionId); await run();
    await sessions.dispose(); missing = true;
    if (mode === "compacted") {
      const journal = await AssistantJournal.load(directory, scope);
      const last = journal.events.findLast(event => event.type === "assistant/message")!;
      await journal.append({ kind: "compaction", summary: "已核对材料，原始读取已压缩", firstKeptEntryId: String(last.data.entryId), tokensBefore: 2000 });
    }
    sessions = new AssistantSessions(options); await run();
    assert.equal(modelCalls, 3); assert.equal(reads, mode === "compacted" ? 1 : 2); assert.deepEqual(errors, []);
  } finally {
    await sessions.dispose(); await gateway.close(); await rm(directory, { recursive: true, force: true });
    if (previous === undefined) delete process.env[env]; else process.env[env] = previous;
  }
});
