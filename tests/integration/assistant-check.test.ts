import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { body, listen } from "@eval/runtime/http";
import { object, type AssistantTool, type JsonObject, type ModelConfig } from "@eval/contracts";
import { createPiConversation } from "../../packages/runtime/src/assistant-pi.js";

const cases: { thinking: ModelConfig["thinking"]; maxThinking?: ModelConfig["thinking"]; expected: ModelConfig["thinking"]; supportsExplicitPromptCaching: boolean }[] = [
  { thinking: "high", maxThinking: "low", expected: "low", supportsExplicitPromptCaching: false },
  { thinking: "high", maxThinking: "low", expected: "low", supportsExplicitPromptCaching: true },
  { thinking: "low", maxThinking: "low", expected: "low", supportsExplicitPromptCaching: false },
  { thinking: "minimal", maxThinking: "low", expected: "minimal", supportsExplicitPromptCaching: false },
  { thinking: "off", maxThinking: "low", expected: "off", supportsExplicitPromptCaching: false },
  { thinking: "high", expected: "high", supportsExplicitPromptCaching: false },
];
for (const api of ["openai-responses", "openai-completions"] as const)
for (const { thinking, maxThinking, expected, supportsExplicitPromptCaching } of cases) test(`tool checks preserve evidence with isolated reasoning: ${api}, ${thinking}, cap=${maxThinking}, cache=${supportsExplicitPromptCaching}`, { timeout: 15000 }, async () => {
  const directory = await mkdtemp(tmpdir() + "/eris-check-");
  const previous = process.env.ERIS_CHECK_TEST_KEY;
  process.env.ERIS_CHECK_TEST_KEY = "fixture";
  const checks: JsonObject[] = [], main: JsonObject[] = [], results: unknown[] = [];
  const material = { reference: { collectionId: "0_wencai/0_daily_eval", runId: "run", inputId: "a", messageIndex: 2 }, text: '原文支持结论\n但存在 "限定条件"。',
    offset: 0, hasMore: true, nextOffset: 20 };
  const schema = { type: "object", properties: { issues: { type: "array", items: { type: "string" } } }, required: ["issues"], additionalProperties: false };
  const gateway = await listen(async (req, res) => {
    const payload = object(await body(req));
    const checking = Boolean(payload.response_format || object(payload.text ?? {}).format);
    if (checking) checks.push(payload); else main.push(payload);
    const mainCalls = main.length;
    const text = checking ? JSON.stringify({ issues: checks.length === 1 ? ["保留限定条件"] : [] }) : "已核对。";
    const call = !checking && mainCalls <= 3 ? { id: `call-${mainCalls}`, name: mainCalls === 1 ? "read_source" : "verify",
      arguments: JSON.stringify(mainCalls === 1 ? {} : { revision: mainCalls - 1 }) } : undefined;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (api === "openai-responses") {
      const item = call ? { type: "function_call", id: `fc-${call.id}`, call_id: call.id, name: call.name, arguments: call.arguments }
        : { type: "message", id: "msg-check", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
      const events = [
        { type: "response.output_item.added", output_index: 0, item: call ? { ...item, arguments: "" } : { ...item, content: [] } },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id: "check", status: "completed", output: [item], usage: { input_tokens: 50, output_tokens: 15, total_tokens: 65 } } },
      ];
      res.end(events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(""));
    } else {
      const delta = call ? { role: "assistant", tool_calls: [{ index: 0, id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } }] }
        : { role: "assistant", content: text };
      res.end([{ choices: [{ index: 0, delta, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 50, completion_tokens: 15, total_tokens: 65 } }]
        .map(chunk => `data: ${JSON.stringify({ id: "check", object: "chat.completion.chunk", created: 1, model: "gpt-6-luna", ...chunk })}\n\n`).join("") + "data: [DONE]\n\n");
    }
  });
  const model: ModelConfig = { provider: "openai", model: "gpt-6-luna", api, baseUrl: gateway.url + "/v1", apiKeyEnv: "ERIS_CHECK_TEST_KEY",
    thinking, contextWindow: 65536, maxOutputTokens: 8192, supportsExplicitPromptCaching };
  const tools: AssistantTool[] = [
    { name: "read_source", description: "Read source", readOnly: true, inputSchema: { type: "object", properties: {} },
      async execute() { return { content: [{ type: "text", text: JSON.stringify(material) }] }; } },
    { name: "verify", description: "Verify draft", readOnly: true,
      inputSchema: { type: "object", properties: { revision: { type: "integer" } }, required: ["revision"] },
      async execute(args, context) {
        const result = await context.complete!({ systemPrompt: "Check evidence against the draft.", maxThinking, draft: object(args), outputSchema: schema, sourceTools: ["read_source"] });
        results.push(result);
        return { content: [{ type: "text", text: result.text }], isError: JSON.parse(result.text).issues.length > 0 };
      } },
  ];
  let conversation: Awaited<ReturnType<typeof createPiConversation>> | undefined;
  try {
    conversation = await createPiConversation({ model, workdir: directory, scope: { userId: "test", sessionId: crypto.randomUUID() },
      systemPrompt: "Read, verify and repair the draft.", tools, history: [], records: [], async compact() {}, async event() {}, async checkpoint() {}, progress() {} });
    await conversation.prompt("核对原文");
    assert.equal(main.length, 4);
    assert.equal(model.thinking, thinking, "the session configuration is never mutated by a tool check");
    const effort = (payload: JsonObject) => api === "openai-responses" ? object(payload.reasoning ?? {}).effort : payload.reasoning_effort;
    for (const payload of main) assert.equal(effort(payload), thinking === "off" ? undefined : thinking,
      "main analysis keeps its configured reasoning before and after failed and successful checks");
    assert.equal(checks.length, 2, "one model check per submitted draft, without hidden retries or reusing a previous verdict");
    assert.equal(results.length, 2);
    const users = checks.map(payload => ((payload.messages ?? payload.input) as JsonObject[]).filter(message => message.role === "user"));
    const text = (message: JsonObject) => typeof message.content === "string" ? message.content : (message.content as JsonObject[]).map(block => block.text).join("");
    assert.equal(users[0].length, 2);
    assert.equal(text(users[0][0]), text(users[1][0]), "repairs retain the exact same evidence prefix");
    assert.deepEqual(JSON.parse(text(users[0][0])), { sources: [{ tool: "read_source", material }] });
    assert.deepEqual(users.map(messages => JSON.parse(text(messages[1]))), [{ draft: { revision: 1 } }, { draft: { revision: 2 } }]);
    for (const payload of checks) {
      assert.equal(payload.model, model.model);
      assert.equal(payload.tools, undefined);
      assert.equal(effort(payload), expected === "off" ? undefined : expected);
      assert.equal(payload[api === "openai-responses" ? "max_output_tokens" : "max_completion_tokens"], model.maxOutputTokens);
      assert.deepEqual(api === "openai-responses" ? object(object(payload.text).format).schema : object(object(payload.response_format).json_schema).schema, schema);
      assert.deepEqual(payload.prompt_cache_options, api === "openai-responses" && supportsExplicitPromptCaching ? { mode: "implicit" } : undefined);
    }
  } finally {
    await conversation?.dispose(); await gateway.close(); await rm(directory, { recursive: true, force: true });
    if (previous === undefined) delete process.env.ERIS_CHECK_TEST_KEY; else process.env.ERIS_CHECK_TEST_KEY = previous;
  }
});
