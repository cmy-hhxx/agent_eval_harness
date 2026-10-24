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
for (const scenario of ["complete", "continue", "repair", "mixed", "counterevidence", "source", "restored-source"] as const) test(`comparison completion: ${scenario}`, { timeout: 10000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "eris-completion-"));
  const scope = { userId: "alice", sessionId: crypto.randomUUID() };
  const previous = process.env.ERIS_COMPLETION_TEST_KEY;
  process.env.ERIS_COMPLETION_TEST_KEY = "fixture";
  const reference = { collectionId: "0_wencai/0_daily_eval", runId: "run", taskId: "comparison" };
  const args = { reference, title: "核对计算依据", reason: "B保留了计算依据，A只有结论。", complete: scenario !== "continue",
    candidates: ["a", "b"].map(model => ({ model, summary: `${model}的答案`, paths: [{ title: "依据", evidence: "已读取原文。", counterEvidence: null, impact: "可核对。", assessment: "strength" }] })) };
  const counterEvidence = "本轮已生成K线资源；最终引用异常，图表内容尚未核验。";
  const sourceText = JSON.stringify({ kind: "accepted-result", reference,
    text: scenario === "counterevidence" ? counterEvidence : "原文：有相关能力，目标用途未证实。" });
  const needsSource = scenario === "source" || scenario === "counterevidence" || scenario === "restored-source";
  const formal = { kind: "accepted-result", reference, result: { status: "decided" }, comparisonScope: { comparisons: [{
    result: "win", resultLabel: "B胜", models: [{ model: "a", modelName: "A", result: "loss" }, { model: "b", modelName: "B", result: "win" }],
  }] } };
  const currentCase = { kind: "case", reference, question: "请核对计算依据", formal,
    answers: ["a", "b"].map(model => ({ model, reference: { collectionId: "0_wencai/0_daily_eval", runId: reference.runId, inputId: model }, answer: { text: `${model}的完整回答`, complete: true } })) };
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected dependency call"); };
  const eris = createEris({
    search: { search: unexpected }, web: { read: unexpected }, data: { list: unexpected, search: unexpected, image: unexpected,
      async read(ref, options) { assert.deepEqual(ref, reference); assert.deepEqual(options, { view: "case" }); return currentCase; },
    } });
  let modelCalls = 0, checkCalls = 0;
  const checkedSources: { tool: string; material: JsonObject }[][] = [];
  const errors: unknown[] = [];
  const gateway = await listen(async (req, res) => {
    const request = await body(req) as JsonObject;
    const isCheck = !(request.tools as unknown[] | undefined)?.length;
    if (isCheck) {
      checkCalls++;
      const messages = request.messages as JsonObject[];
      assert.equal(messages.length, 3, "check requests contain instructions, evidence and the draft, no session reasoning");
      assert.equal(request.model, "fixture");
      assert.equal(request.max_completion_tokens, 4096);
      assert.equal((request.response_format as { json_schema: { strict: boolean } }).json_schema.strict, true);
      checkedSources.push((messages[1]!.content as JsonObject[]).flatMap(block => JSON.parse(block.text as string).sources));
      const { draft } = JSON.parse(messages[2]!.content as string);
      assert(draft.candidates, "counterevidence remains in the exact draft");
      assert(!JSON.stringify(messages).includes("错误的先前推理"), "the check sees original evidence, not the main model's reasoning");
      if (scenario === "counterevidence") assert.equal(draft.candidates[1].paths[0].counterEvidence, checkCalls === 1 ? null : counterEvidence,
        "a rejected draft must be corrected before it can pass the second check");
    } else modelCalls++;
    const chartCall = !isCheck && (scenario === "restored-source" ? modelCalls === 3 : needsSource ? modelCalls === 2 || scenario === "counterevidence" && modelCalls === 3 : modelCalls === 1 || scenario === "repair" && modelCalls === 2);
    const sourceCall = !isCheck && needsSource && modelCalls === 1;
    const corrected = scenario === "counterevidence" && modelCalls === 3;
    if (!isCheck && corrected) {
      const feedback = (request.messages as JsonObject[]).find(message => message.role === "tool" && String(message.content).includes('"kind":"comparison-check"'));
      assert(feedback, "the main model receives the rejected draft's review before revising");
    }
    const calls = [{ index: 0, id: `chart-${modelCalls}`, type: "function", function: { name: "show_comparison",
      arguments: JSON.stringify({ ...args, ...(corrected ? { candidates: args.candidates.map((candidate, index) => index === 1
        ? { ...candidate, paths: candidate.paths.map(item => ({ ...item, counterEvidence })) } : candidate) } : {}),
        ...(scenario === "repair" && modelCalls === 1 ? { title: "" } : {}) }) } }];
    if (scenario === "mixed" && modelCalls === 1) calls.push({ index: 1, id: "extra-evidence", type: "function", function: { name: "read_more", arguments: "{}" } });
    const issues = scenario === "counterevidence" && checkCalls === 1 ? [{ path: "/draft", reason: "三日形态待核卡片遗漏了本轮已生成K线资源的反证；最终引用异常，图表内容尚未核验，应补充这两点。" }] : [];
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
  const createSessions = () => new AssistantSessions({ directory, url: "http://127.0.0.1:1", model, systemPrompt: "fixture", tools: [
    eris.tools.find(tool => tool.name === "show_comparison")!,
    { name: "read_more", description: "Read another source", readOnly: true, inputSchema: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: "新增证据" }] }) },
    { name: "read_data", description: "Read original source", readOnly: true, inputSchema: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: sourceText }] }) },
  ], onError: error => errors.push(error) });
  let sessions = createSessions();
  try {
    await sessions.create(scope.userId, scope.sessionId);
    const prompts = scenario === "restored-source" ? ["先读取原始材料", "根据上轮材料核对并作图"] : ["核对并作图"];
    for (const [turn, text] of prompts.entries()) {
      if (turn > 0) {
        await sessions.dispose();
        sessions = createSessions();
      }
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
    for (const sources of checkedSources) assert.deepEqual(sources,
      [{ tool: "read_case", material: currentCase }, ...(needsSource ? [{ tool: "read_data", material: JSON.parse(sourceText) }] : [])],
      "the checker always loads current answers and preserves observed evidence, including after session restoration");
    assert.equal(modelCalls, scenario === "complete" ? 1 : ["counterevidence", "restored-source"].includes(scenario) ? 3 : 2);
    assert.equal(checkCalls, scenario === "counterevidence" ? 2 : 1);
    const journal = (await readFile(path.join(assistantDirectory(directory, scope), "events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const results = journal.filter(row => row.event?.type === "tool/result");
    const chart = results.find(row => !row.event.data.message.isError && row.event.data.message.content.some((part: JsonObject) => typeof part.text === "string" && part.text.includes('"kind":"comparison-diagram"')));
    assert(chart, "the full chart is persisted before completion and survives refresh");
    assert.deepEqual(chart.event.data.meta.reference, reference, "evidence coordinates remain available");
    assert.equal(chart.event.data.meta.consistencyCheck.usage.totalTokens, 60, "extra model work is recorded, not hidden in tool I/O");
    assert.equal(results.filter(row => row.event.data.message.isError).length, ["repair", "counterevidence"].includes(scenario) ? 1 : 0);
    if (scenario === "counterevidence") {
      const diagrams = results.filter(row => row.event.data.message.content.some((part: JsonObject) => typeof part.text === "string" && part.text.includes('"kind":"comparison-diagram"')));
      assert.equal(diagrams.length, 1, "only the corrected, checked draft is published");
      assert(JSON.parse(chart.event.data.message.content[0].text).diagram.candidates[1].paths[0].evidence.includes(counterEvidence));
    }
    assert.deepEqual(errors, []);
  } finally {
    await sessions.dispose(); await gateway.close(); await rm(directory, { recursive: true, force: true });
    if (previous === undefined) delete process.env.ERIS_COMPLETION_TEST_KEY; else process.env.ERIS_COMPLETION_TEST_KEY = previous;
  }
});
