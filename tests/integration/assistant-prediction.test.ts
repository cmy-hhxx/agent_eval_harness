import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { body, listen } from "@eval/runtime/http";
import { object, type JsonObject, type ModelConfig } from "@eval/contracts";
import { erisPrompt } from "@eval/prompts";
import { createPiPrediction } from "../../packages/runtime/src/assistant-prediction.js";

for (const api of ["openai-responses", "openai-completions"] as const) for (const thinking of ["off", "high"] as const)
test(`prediction uses one bounded tool-free ${api} request with ${thinking} reasoning`, { timeout: 10000 }, async () => {
  const directory = await mkdtemp(tmpdir() + "/eris-prediction-sdk-");
  const previous = process.env.PREDICTION_TEST_KEY;
  process.env.PREDICTION_TEST_KEY = "fixture";
  const calls: JsonObject[] = [];
  const suggestion = "A与B的统计口径哪里不同？";
  const analysis = "A与B采用了不同口径。".repeat(250) + "B组完整分析。";
  const gateway = await listen(async (req, res) => {
    const payload = object(await body(req)); calls.push(payload);
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (api === "openai-responses") {
      const item = { type: "message", id: "msg-prediction", role: "assistant", status: "completed", content: [{ type: "output_text", text: suggestion, annotations: [] }] };
      const events = [
        { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id: "prediction", status: "completed", output: [item], usage: { input_tokens: 20, output_tokens: 15, total_tokens: 35 } } },
      ];
      res.end(events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(""));
    } else {
      res.end([{ choices: [{ index: 0, delta: { role: "assistant", content: suggestion }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 } }]
        .map(chunk => `data: ${JSON.stringify({ id: "prediction", object: "chat.completion.chunk", ...chunk })}\n\n`).join("") + "data: [DONE]\n\n");
    }
  });
  const model: ModelConfig = { provider: "openai", model: "gpt-6-luna", api, baseUrl: gateway.url + "/v1", apiKeyEnv: "PREDICTION_TEST_KEY", thinking, supportsDeveloperRole: false, contextWindow: 65536, maxOutputTokens: 8192 };
  try {
    const instructions = erisPrompt([]).predictionPrompt;
    const text = await createPiPrediction({ model, workdir: directory, instructions,
      history: [{ type: "user/message", seq: 0, time: 0, data: { content: [{ type: "text", text: "比较A与B的证据" }] } },
        { type: "assistant/message", seq: 1, time: 1, data: { message: { content: [{ type: "text", text: analysis }] } } },
        { type: "user/message", seq: 2, time: 2, data: { content: [{ type: "text", text: "先看看答案能帮用户做什么" }] } }],
      recentSuggestions: [], signal: new AbortController().signal });
    assert.equal(text, suggestion);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].tools, undefined);
    assert.equal(calls[0][api === "openai-responses" ? "max_output_tokens" : "max_completion_tokens"], 1024);
    if (api === "openai-responses") assert.deepEqual(calls[0].reasoning, { effort: thinking === "off" ? "none" : "low" });
    assert.match(JSON.stringify(calls[0]), /比较A与B的证据/);
    const messages = (calls[0].messages ?? calls[0].input) as JsonObject[];
    const messageText = (message: JsonObject) => typeof message.content === "string" ? message.content :
      (message.content as JsonObject[]).map(block => block.text).join("");
    const users = messages.filter(message => message.role === "user");
    assert.equal(users.length, 1);
    assert.equal(messages[0].role, "system");
    assert.equal(messageText(messages[0]), instructions, "prediction instructions stay separate from dialogue data");
    const content = users[0].content;
    const material = JSON.parse(typeof content === "string" ? content : (content as JsonObject[]).map(block => block.text).join(""));
    assert.deepEqual(material.initialRequest, { text: "比较A与B的证据", truncated: false });
    assert.deepEqual(material.currentRequest, { text: "先看看答案能帮用户做什么", truncated: false });
    assert.equal(material.dialogue.at(-1).text, material.currentRequest.text);
    assert.equal(material.dialogue[1].truncated, true);
    assert.equal([...material.dialogue[1].text].length, 2400);
    assert(material.dialogue[1].text.startsWith("A与B采用了不同口径。"));
    assert(material.dialogue[1].text.endsWith("B组完整分析。"));
    const abort = new AbortController(); abort.abort();
    await assert.rejects(createPiPrediction({ model, workdir: directory, instructions: "test", history: [], recentSuggestions: [], signal: abort.signal }));
    assert.equal(calls.length, 1, "aborted predictions must not reach the gateway");
  } finally { await gateway.close(); await rm(directory, { recursive: true, force: true });
    if (previous === undefined) delete process.env.PREDICTION_TEST_KEY; else process.env.PREDICTION_TEST_KEY = previous;
  }
});
