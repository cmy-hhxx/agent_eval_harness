import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createEris } from "@eval/assistant";
import { AssistantSessions } from "@eval/runtime/assistant";
import { body, listen } from "@eval/runtime/http";
import { assistantDirectory } from "@eval/data";
import { type JsonObject, type ModelConfig } from "@eval/contracts";

// Exercise the actual Eris tool, schema, Pi loop and journal together. An empty
// final prose response must not require another model request after a final chart.
for (const scenario of ["complete", "continue", "repair", "mixed"] as const) test(`comparison completion: ${scenario}`, { timeout: 10000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "eris-completion-"));
  const scope = { userId: "alice", sessionId: crypto.randomUUID() };
  const previous = process.env.ERIS_COMPLETION_TEST_KEY;
  process.env.ERIS_COMPLETION_TEST_KEY = "fixture";
  const reference = { collectionId: "0_wencai/0_daily_eval", runId: "run", taskId: "comparison" };
  const args = { reference, title: "核对计算依据", reason: "B保留了计算依据，A只有结论。", complete: scenario !== "continue",
    candidates: ["a", "b"].map(model => ({ model, summary: `${model}的答案`, paths: [{ title: "依据", evidence: "已读取原文。", counterEvidence: null, impact: "可核对。", assessment: "strength" }] })) };
  const formal = { kind: "accepted-result", reference, result: { status: "decided" }, comparisonScope: { comparisons: [{
    result: "win", resultLabel: "B胜", models: [{ model: "a", modelName: "A", result: "loss" }, { model: "b", modelName: "B", result: "win" }],
  }] } };
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected dependency call"); };
  const eris = createEris({
    search: { search: unexpected }, web: { read: unexpected }, data: { list: unexpected, search: unexpected, image: unexpected,
      async read(ref, options) { assert.deepEqual(ref, reference); assert.equal(options, undefined); return formal; },
    } });
  let modelCalls = 0;
  const errors: unknown[] = [];
  const gateway = await listen(async (req, res) => {
    const request = await body(req) as JsonObject;
    assert((request.tools as unknown[]).length > 0, "there is no hidden model request for chart review");
    modelCalls++;
    const chartCall = modelCalls === 1 || scenario === "repair" && modelCalls === 2;
    const calls = [{ index: 0, id: `chart-${modelCalls}`, type: "function", function: { name: "show_comparison",
      arguments: JSON.stringify({ ...args, ...(scenario === "repair" && modelCalls === 1 ? { title: "" } : {}) }) } }];
    if (scenario === "mixed" && modelCalls === 1) calls.push({ index: 1, id: "extra-evidence", type: "function", function: { name: "read_more", arguments: "{}" } });
    const delta = chartCall ? { role: "assistant", tool_calls: calls } : { role: "assistant", content: "补充说明。" };
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = { id: "completion", object: "chat.completion.chunk", created: 1, model: "fixture" };
    res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: chartCall ? "tool_calls" : "stop" }], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  const model: ModelConfig = { provider: "fixture", model: "fixture", baseUrl: gateway.url + "/v1", api: "openai-completions", apiKeyEnv: "ERIS_COMPLETION_TEST_KEY", thinking: "off", contextWindow: 65536, maxOutputTokens: 4096 };
  const createSessions = () => new AssistantSessions({ directory, url: "http://127.0.0.1:1", model, systemPrompt: "fixture", tools: [
    eris.tools.find(tool => tool.name === "show_comparison")!,
    { name: "read_more", description: "Read another source", readOnly: true, inputSchema: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: "新增证据" }] }) },
  ], onError: error => errors.push(error) });
  let sessions = createSessions();
  try {
    await sessions.create(scope.userId, scope.sessionId);
    {
      const text = "分析并作图";
      const requestId = crypto.randomUUID();
      await sessions.prompt(scope.userId, { ...scope, requestId, mode: "queue", content: [{ type: "text", text }] });
      let completed = false;
      for (let attempt = 0; attempt < 600; attempt++) {
        const state = (await sessions.list(scope.userId)).find(item => item.sessionId === scope.sessionId)!;
        if (state.requests[requestId] === "completed") { completed = true; break; }
        await delay(10);
      }
      assert(completed, "a terminal chart is a successful response, not an interruption");
    }
    assert.equal(modelCalls, scenario === "complete" ? 1 : 2);
    const journal = (await readFile(path.join(assistantDirectory(directory, scope), "events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const results = journal.filter(row => row.event?.type === "tool/result");
    const chart = results.find(row => !row.event.data.message.isError && row.event.data.message.content.some((part: JsonObject) => typeof part.text === "string" && part.text.includes('"kind":"comparison-diagram"')));
    assert(chart, "the full chart is persisted before completion and survives refresh");
    assert.deepEqual(chart.event.data.meta.reference, reference, "evidence coordinates remain available");
    assert.equal(chart.event.data.meta.consistencyCheck, undefined);
    assert.equal(results.filter(row => row.event.data.message.isError).length, scenario === "repair" ? 1 : 0);
    assert.deepEqual(errors, []);
  } finally {
    await sessions.dispose(); await gateway.close(); await rm(directory, { recursive: true, force: true });
    if (previous === undefined) delete process.env.ERIS_COMPLETION_TEST_KEY; else process.env.ERIS_COMPLETION_TEST_KEY = previous;
  }
});
