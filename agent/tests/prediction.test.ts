import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { AssistantSessions, serveAssistant } from "@eval/runtime/assistant";
import { assistantEndpoints } from "@eval/assistant/server";
import type { ModelConfig } from "@eval/contracts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("predictions follow the owning replica, stay out of history, and cancel on input, model change and shutdown", { timeout: 10000 }, async () => {
  const directory = await mkdtemp(tmpdir() + "/eris-prediction-");
  let started = deferred<AbortSignal>(), release = deferred<string | null>();
  let calls = 0;
  let sessions!: AssistantSessions;
  const server = await serveAssistant({ port: 0, userId: "local", webDirectory: directory,
    endpoints: url => assistantEndpoints(sessions = new AssistantSessions({ directory, url, model: { provider: "test", model: "test" } as ModelConfig,
    systemPrompt: "test", predictionPrompt: "predict", tools: [],
    predictor: async options => { calls++; assert(options.history.some(row => row.type === "user/message")); started.resolve(options.signal); return release.promise; },
    driver: async ({ event }) => ({ async prompt(text) {
      await event({ type: "turn_start" });
      await event({ type: "message_end", message: { role: "user", content: [{ type: "text", text }] } });
      await event({ type: "message_end", message: { role: "assistant", provider: "test", model: "test", content: [{ type: "text", text: "口径存在差异" }], stopReason: text === "failed" ? "error" : "stop" } });
      await event({ type: "agent_end" });
    }, async steer() {}, async abort() {}, async dispose() {} }),
  })) });
  const replica = new AssistantSessions({ ...sessions.options, url: "http://127.0.0.1:2" });
  let closed = false;
  try {
    const scope = await sessions.create("local");
    const signal = new AbortController().signal;
    assert.deepEqual(await sessions.predict(scope, 1, [], signal), { text: null });
    const send = async (text: string) => {
      const requestId = randomUUID();
      await sessions.prompt("local", { sessionId: scope.sessionId, requestId, mode: "queue", content: [{ type: "text", text }] });
      for (let i = 0; i < 200; i++) {
        const state = (await sessions.list("local"))[0];
        if (state.status === "idle" && ["completed", "interrupted"].includes(state.requests[requestId])) return;
        await delay(10);
      }
      throw new Error("Turn did not settle");
    };
    await send("比较证据");
    const before = JSON.stringify(await sessions.page(scope));
    const first = replica.predict(scope, 1, [], signal);
    await started.promise; release.resolve("A与B的统计口径哪里不同？");
    assert.deepEqual(await first, { text: "A与B的统计口径哪里不同？" });
    assert.equal(JSON.stringify(await sessions.page(scope)), before);
    assert.equal(calls, 1);
    assert.deepEqual(await sessions.predict(scope, 9, [], signal), { text: null });
    for (const action of ["input", "model", "caller"]) {
      started = deferred<AbortSignal>(); release = deferred<string | null>();
      const caller = new AbortController();
      const pending = sessions.predict(scope, action === "input" ? 1 : 2, [], caller.signal);
      const active = await started.promise;
      if (action === "input") await send("继续核对");
      if (action === "model") await sessions.selectModel(scope, { provider: "test", model: "test", reasoningEffort: "off" });
      if (action === "caller") caller.abort();
      assert.equal(active.aborted, true, action);
      release.resolve("过期的下一问不应显示？");
      assert.deepEqual(await pending, { text: null });
    }
    const callsBeforeFailure = calls;
    await send("failed");
    assert.deepEqual(await sessions.predict(scope, 3, [], signal), { text: null });
    assert.equal(calls, callsBeforeFailure, "failed turns must not invoke prediction");
    await send("重新核对");
    started = deferred<AbortSignal>(); release = deferred<string | null>();
    const closing = sessions.predict(scope, 4, [], signal);
    const active = await started.promise;
    await server.close(); closed = true;
    assert.equal(active.aborted, true, "shutdown");
    release.resolve("过期的下一问不应显示？");
    assert.deepEqual(await closing, { text: null });
  } finally { release.resolve(null); await replica.dispose(); if (!closed) await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("prediction endpoint rejects malformed requests before dispatch", async () => {
  const directory = await mkdtemp(tmpdir() + "/eris-prediction-input-");
  const sessions = new AssistantSessions({ directory, url: "http://127.0.0.1:1", model: {} as ModelConfig, systemPrompt: "test", tools: [] });
  try {
    const endpoints = assistantEndpoints(sessions);
    for (const request of [{ sourceTurn: "1", recentSuggestions: [] }, { sourceTurn: -1, recentSuggestions: [] },
      { sourceTurn: 1, recentSuggestions: [3] }, { sourceTurn: 1, recentSuggestions: ["问".repeat(61)] },
      { sourceTurn: 1, recentSuggestions: Array(17).fill("下一问") }])
      await assert.rejects(endpoints.call("local", "assistant/predict", { args: { request } }, new AbortController().signal), /Invalid prediction/);
  } finally { await sessions.dispose(); await rm(directory, { recursive: true, force: true }); }
});
