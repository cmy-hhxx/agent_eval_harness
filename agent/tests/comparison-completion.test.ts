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
for (const scenario of ["complete", "continue", "repair", "mixed", "counterevidence", "source"] as const) test(`comparison completion: ${scenario}`, { timeout: 10000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "eris-completion-"));
  const scope = { userId: "alice", sessionId: crypto.randomUUID() };
  const previous = process.env.ERIS_COMPLETION_TEST_KEY;
  process.env.ERIS_COMPLETION_TEST_KEY = "fixture";
  const reference = { runId: "run", taskId: "comparison" };
  const args = { reference, title: "核对计算依据", reason: "B保留了计算依据，A只有结论。", complete: scenario !== "continue",
    candidates: ["a", "b"].map(model => ({ model, summary: `${model}的答案`, paths: [{ title: "依据", evidence: "已读取原文。", counterEvidence: null, impact: "可核对。", assessment: "strength" }] })) };
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected dependency call"); };
  const eris = createEris({ code: { execute: unexpected, read: unexpected }, specialists: { invoke: unexpected, read: unexpected },
    search: { search: unexpected }, web: { read: unexpected }, data: { list: unexpected, search: unexpected, image: unexpected,
      async read() { return { kind: "accepted-result", reference, result: { status: "decided" }, comparisonScope: { comparisons: [{
        result: "win", resultLabel: "B胜", models: [{ model: "a", modelName: "A", result: "loss" }, { model: "b", modelName: "B", result: "win" }],
      }] } }; },
    } });
  let modelCalls = 0, checkCalls = 0;
  const errors: unknown[] = [];
  const gateway = await listen(async (req, res) => {
    const request = await body(req) as JsonObject;
    const isCheck = !(request.tools as unknown[] | undefined)?.length;
    if (isCheck) {
      checkCalls++;
      const messages = request.messages as JsonObject[];
      assert.equal(messages.length, 2, "check requests contain only instructions and the draft, no session history");
      assert.equal(request.model, "fixture");
      assert.equal(request.max_completion_tokens, 4096);
      assert.equal((request.response_format as { json_schema: { strict: boolean } }).json_schema.strict, true);
      const material = JSON.parse(messages[1]!.content as string);
      if (scenario === "source") {
        assert(JSON.parse(material.draft).candidates);
        assert.deepEqual(material.sources, [{ tool: "read_data", content: [{ type: "text", text: "原文：有相关能力，目标用途未证实。" }] }]);
        assert(!JSON.stringify(material).includes("错误的先前推理"), "the check sees original evidence, not the main model's reasoning");
      } else assert(material.candidates, "counterevidence remains in the exact draft");
    } else modelCalls++;
    const chartCall = !isCheck && (scenario === "source" ? modelCalls === 2 : modelCalls === 1 || (["repair", "counterevidence"].includes(scenario) && modelCalls === 2));
    const sourceCall = !isCheck && scenario === "source" && modelCalls === 1;
    const calls = [{ index: 0, id: `chart-${modelCalls}`, type: "function", function: { name: "show_comparison",
      arguments: JSON.stringify({ ...args, ...(scenario === "repair" && modelCalls === 1 ? { title: "" } : {}) }) } }];
    if (scenario === "mixed" && modelCalls === 1) calls.push({ index: 1, id: "extra-evidence", type: "function", function: { name: "read_more", arguments: "{}" } });
    const issues = scenario === "counterevidence" && checkCalls === 1 ? [{ path: "/candidates/0/paths/0", reason: "目标用途未核验，不能当成不符合。" }] : [];
    const delta = sourceCall ? { role: "assistant", content: "错误的先前推理", tool_calls: [{ index: 0, id: "source", type: "function", function: { name: "read_data", arguments: "{}" } }] }
      : isCheck ? { role: "assistant", content: JSON.stringify({ issues }) }
      : chartCall ? { role: "assistant", tool_calls: calls } : { role: "assistant", content: "补充证据已核对。" };
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = { id: "completion", object: "chat.completion.chunk", created: 1, model: "fixture" };
    res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: chartCall || sourceCall ? "tool_calls" : "stop" }], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  const model: ModelConfig = { provider: "fixture", model: "fixture", baseUrl: gateway.url + "/v1", api: "openai-completions", apiKeyEnv: "ERIS_COMPLETION_TEST_KEY", thinking: "off", contextWindow: 65536, maxOutputTokens: 4096 };
  const sessions = new AssistantSessions({ directory, url: "http://127.0.0.1:1", model, systemPrompt: "fixture", tools: [
    eris.tools.find(tool => tool.name === "show_comparison")!,
    { name: "read_more", description: "Read another source", readOnly: true, inputSchema: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: "新增证据" }] }) },
    { name: "read_data", description: "Read original source", readOnly: true, inputSchema: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: "原文：有相关能力，目标用途未证实。" }] }) },
  ], onError: error => errors.push(error) });
  try {
    await sessions.create(scope.userId, scope.sessionId);
    const requestId = crypto.randomUUID();
    await sessions.prompt(scope.userId, { ...scope, requestId, mode: "queue", content: [{ type: "text", text: "核对并作图" }] });
    let completed = false;
    for (let attempt = 0; attempt < 600; attempt++) {
      const state = (await sessions.list(scope.userId)).find(item => item.sessionId === scope.sessionId)!;
      if (state.requests[requestId] === "completed") { completed = true; break; }
      await delay(10);
    }
    assert(completed, "a terminal chart is a successful response, not an interruption");
    assert.equal(modelCalls, scenario === "complete" ? 1 : 2);
    assert.equal(checkCalls, scenario === "counterevidence" ? 2 : 1);
    const journal = (await readFile(path.join(assistantDirectory(directory, scope), "events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const results = journal.filter(row => row.event?.type === "tool/result");
    const chart = results.find(row => !row.event.data.message.isError && row.event.data.message.content.some((part: JsonObject) => typeof part.text === "string" && part.text.includes('"kind":"comparison-diagram"')));
    assert(chart, "the full chart is persisted before completion and survives refresh");
    assert.deepEqual(chart.event.data.meta.reference, reference, "evidence coordinates remain available");
    assert.equal(chart.event.data.meta.consistencyCheck.usage.totalTokens, 60, "extra model work is recorded, not hidden in tool I/O");
    assert.equal(results.filter(row => row.event.data.message.isError).length, ["repair", "counterevidence"].includes(scenario) ? 1 : 0);
    assert.deepEqual(errors, []);
  } finally {
    await sessions.dispose(); await gateway.close(); await rm(directory, { recursive: true, force: true });
    if (previous === undefined) delete process.env.ERIS_COMPLETION_TEST_KEY; else process.env.ERIS_COMPLETION_TEST_KEY = previous;
  }
});
