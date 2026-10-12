import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AssistantSessions } from "@eval/runtime/assistant";
import { AssistantJournal } from "@eval/data";
import { body, listen } from "@eval/runtime/http";
import { object, type JsonObject, type ModelConfig } from "@eval/contracts";
import { waitForTestState } from "../fixtures/wait.js";

for (const scenario of ["threshold", "overflow", "failure"] as const) test(`Eris compaction: ${scenario} preserves a durable, recoverable tool loop`, { timeout: 15000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "eris-tool-compaction-"));
  const scope = { userId: "test", sessionId: crypto.randomUUID() };
  const env = "ERIS_TOOL_COMPACTION_TEST_KEY", previous = process.env[env];
  process.env[env] = "fixture";
  let turns = 0, summaries = 0, reads = 0;
  let persistedBeforeContinuation = false;
  const errors: unknown[] = [];
  const payloads: JsonObject[] = [];
  const gateway = await listen(async (req, res) => {
    const request = object(await body(req)); payloads.push(request);
    const summary = !(request.tools as unknown[] | undefined)?.length;
    if (summary) summaries++; else turns++;
    if (scenario === "failure" && summary) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "summary unavailable", type: "invalid_request_error" } }));
      return;
    }
    if (scenario === "overflow" && turns === 3 && !summary) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "context_length_exceeded", code: "context_length_exceeded", type: "invalid_request_error" } }));
      return;
    }
    if (!summary && turns === (scenario === "overflow" ? 4 : 3)) {
      const journal = await AssistantJournal.load(directory, scope);
      persistedBeforeContinuation = journal.records.some(record => record.kind === "compaction");
    }
    const done = summary || turns >= 3;
    const delta = done ? { role: "assistant", content: summary ? "已核对前两份材料，继续回答当前问题。" : "分析完成。" }
      : { role: "assistant", tool_calls: [{ index: 0, id: `read-${turns}`, type: "function", function: { name: "lookup", arguments: "{}" } }] };
    const chunk = { id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture" };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    // Zero usage exercises message-size accounting, including the new tool results.
    res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: done ? "stop" : "tool_calls" }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  const model: ModelConfig = { provider: "fixture", model: "fixture", api: "openai-completions", baseUrl: gateway.url + "/v1",
    apiKeyEnv: env, thinking: "off", contextWindow: 65536, maxOutputTokens: 4096 };
  const options = { directory, url: "http://127.0.0.1:1", model, systemPrompt: "核对两份材料后回答。", onError: (error: unknown) => errors.push(error),
    tools: [{ name: "lookup", description: "Read evidence", readOnly: true, inputSchema: { type: "object", properties: {} },
      async execute() { reads++; return { content: [{ type: "text" as const, text: `材料${reads}：` + "evidence ".repeat(scenario === "overflow" ? 7000 : 12500) }] }; } }],
  };
  let sessions = new AssistantSessions(options);
  const send = async (text: string) => {
    const requestId = crypto.randomUUID();
    await sessions.prompt(scope.userId, { ...scope, requestId, mode: "queue", content: [{ type: "text", text }] });
    await waitForTestState(async () => (await sessions.list(scope.userId))[0], state => state.status === "idle" && ["completed", "interrupted"].includes(state.requests[requestId]), "compaction turn should settle");
    assert.equal((await sessions.list(scope.userId))[0].requests[requestId], scenario === "failure" ? "interrupted" : "completed", JSON.stringify(errors));
  };
  try {
    await sessions.create(scope.userId, scope.sessionId);
    await send("请详细分析");
    assert.equal(reads, 2); assert.equal(summaries, 1, "two tool outputs cross 80% without another user turn");
    if (scenario === "failure") {
      assert.equal(turns, 2, "failed compaction must stop before sending the oversized context again");
      await waitForTestState(async () => errors, value => value.length > 0, "compaction failure callback should settle");
      assert.match(String(errors[0]), /上下文压缩失败/);
      return;
    }
    assert(persistedBeforeContinuation, "persist compaction before the next model request");
    const journal = await AssistantJournal.load(directory, scope);
    const endings = journal.events.filter(event => event.type === "turn/end");
    assert.equal(endings.length, 1, "automatic recovery must not prematurely end the user's turn");
    assert.equal(object(endings[0].data.reason).kind, "completed");
    await sessions.dispose(); sessions = new AssistantSessions(options);
    await send("继续");
    assert.match(JSON.stringify(payloads.at(-1)), /已核对前两份材料/);
    assert.equal(reads, 2, "restoring compacted history does not rerun tools");
    assert.deepEqual(errors, []);
  } finally {
    await sessions.dispose(); await gateway.close(); await rm(directory, { recursive: true, force: true });
    if (previous === undefined) delete process.env[env]; else process.env[env] = previous;
  }
});
