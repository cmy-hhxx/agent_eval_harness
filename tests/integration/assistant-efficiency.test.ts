import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AssistantSessions } from "@eval/runtime/assistant";
import { body, listen } from "@eval/runtime/http";
import { assistantDirectory } from "@eval/data";
import { object, type AssistantTool, type JsonObject, type ModelConfig } from "@eval/contracts";

const scenarios = {
  parallel: "Pi overlaps independent reads with a four-call bound and persists every result before continuing",
  writable: "Pi preserves declared ordering when a tool batch includes a write",
  cancel: "Pi cancels active reads without starting the queued reads or another model request",
};
for (const scenario of ["parallel", "writable", "cancel"] as const) test(scenarios[scenario], { timeout: 10000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "assistant-efficiency-"));
  const scope = { userId: "alice", sessionId: crypto.randomUUID() };
  const secretBefore = process.env.ERIS_EFFICIENCY_TEST_KEY;
  process.env.ERIS_EFFICIENCY_TEST_KEY = "fixture";
  let active = 0, peak = 0, timedOut = false, modelCalls = 0;
  let release = () => {};
  const firstBatch = new Promise<void>(resolve => { release = resolve; });
  const started: number[] = [], completed: number[] = [], errors: unknown[] = [];
  const parallelFlags: unknown[] = [];
  const lookup: AssistantTool = { name: "lookup", description: "Read independent evidence", readOnly: true,
    inputSchema: { type: "object", properties: { index: { type: "integer" } }, required: ["index"] },
    async execute(value, context) {
      const index = Number(object(value).index);
      started.push(index);
      active++; peak = Math.max(peak, active);
      if (active === 4) release();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (scenario === "parallel")
          await Promise.race([firstBatch, new Promise<void>(resolve => { timer = setTimeout(() => { timedOut = true; resolve(); }, 300); })]);
        if (scenario === "cancel") {
          await new Promise<void>(resolve => {
            if (context.signal.aborted) resolve();
            else context.signal.addEventListener("abort", () => resolve(), { once: true });
          });
        } else await delay(10);
        completed.push(index);
        return { isError: index === 2, content: [{ type: "text", text: index === 2 ? "source unavailable" : `evidence ${index}` }] };
      } finally { clearTimeout(timer); active--; }
    },
  };
  const gateway = await listen(async (req, res) => {
    const request = object(await body(req)); modelCalls++;
    parallelFlags.push(request.parallel_tool_calls);
    const hasTools = (request.messages as JsonObject[]).some(message => message.role === "tool");
    if (hasTools) {
      const journal = (await readFile(path.join(assistantDirectory(directory, scope), "events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
      assert.equal(journal.filter(row => row.event?.type === "tool/result").length, 6);
      assert.equal(journal.find(row => row.event?.type === "tool/result" && row.event.data.message.toolCallId === "read-2").event.data.message.isError, true);
      assert.equal(completed.length, 6);
      assert.equal((request.messages as JsonObject[]).filter(message => message.role === "tool").length, 6);
    }
    const delta = hasTools ? { role: "assistant", content: "已核对，缺少一份来源。" } : { role: "assistant", tool_calls: Array.from({ length: 6 }, (_, index) => ({ index, id: `read-${index}`, type: "function", function: { name: scenario === "writable" && index === 2 ? "save" : "lookup", arguments: JSON.stringify({ index }) } })) };
    const chunk = { id: "efficiency-fixture", object: "chat.completion.chunk", created: 1, model: "fixture" };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: hasTools ? "stop" : "tool_calls" }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  const model: ModelConfig = { provider: "fixture", model: "fixture", baseUrl: gateway.url + "/v1", api: "openai-completions", apiKeyEnv: "ERIS_EFFICIENCY_TEST_KEY", thinking: "off", contextWindow: 65536, maxOutputTokens: 4096 };
  const sessions = new AssistantSessions({ directory, url: "http://127.0.0.1:1", model, systemPrompt: "Read the independent evidence together.", tools: [lookup, { ...lookup, name: "save", readOnly: false }], onError: error => errors.push(error) });
  try {
    await sessions.create(scope.userId, scope.sessionId);
    const requestId = crypto.randomUUID();
    await sessions.prompt(scope.userId, { ...scope, requestId, mode: "queue", content: [{ type: "text", text: "核对六份材料" }] });
    if (scenario === "cancel") {
      const waiting = new AbortController();
      try { await Promise.race([firstBatch, delay(3000, undefined, { signal: waiting.signal }).then(() => { throw new Error("Read batch did not start"); })]); }
      finally { waiting.abort(); }
      await sessions.cancel(scope);
    }
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const state = (await sessions.list(scope.userId)).find(item => item.sessionId === scope.sessionId)!;
      if (["completed", "interrupted"].includes(state.requests[requestId])) break;
      await delay(10);
    }
    assert(parallelFlags.length > 0 && parallelFlags.every(flag => flag === true), "Eris must enable parallel calls in every actual provider payload");
    assert.equal(timedOut, false, "independent reads must start together, without waiting for earlier reads to finish");
    assert.equal(peak, scenario === "writable" ? 1 : 4);
    assert.deepEqual(started, scenario === "cancel" ? [0, 1, 2, 3] : [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(scenario === "writable" ? completed : completed.sort(), scenario === "cancel" ? [0, 1, 2, 3] : [0, 1, 2, 3, 4, 5]);
    assert.equal(modelCalls, scenario === "cancel" ? 1 : 2);
    assert.deepEqual(errors, []);
  } finally {
    release(); await sessions.dispose(); await gateway.close(); await rm(directory, { recursive: true, force: true });
    if (secretBefore === undefined) delete process.env.ERIS_EFFICIENCY_TEST_KEY; else process.env.ERIS_EFFICIENCY_TEST_KEY = secretBefore;
  }
});
