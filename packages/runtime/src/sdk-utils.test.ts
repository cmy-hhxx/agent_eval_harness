import test from "node:test";
import assert from "node:assert/strict";
import type { ModelConfig } from "@eval/contracts";
import { transformPayload } from "./sdk-utils.js";

const model: ModelConfig = {
  provider: "fixture", baseUrl: "http://127.0.0.1:1/v1", api: "openai-responses",
  apiKeyEnv: "FIXTURE_KEY", model: "gpt-6-luna", thinking: "high",
  contextWindow: 200000, maxOutputTokens: 8192,
};
const request = () => ({
  model: model.model,
  input: [
    { role: "developer", content: "Exact rules and attempt workspace" },
    { role: "user", content: [{ type: "input_text", text: "Exact task material and budget" }] },
  ],
  tools: [{ type: "function", name: "submit_evaluation", parameters: { type: "object" } }],
  reasoning: { effort: "high" },
  prompt_cache_key: "random-sdk-session",
  prompt_cache_retention: "24h",
});

test("evaluation caching changes only request controls, preserving content and generation settings", () => {
  const payload = request();
  const before = structuredClone(payload);
  const result = transformPayload(payload, model, { toolNames: [] });
  const { prompt_cache_retention: _retention, ...expected } = before;
  assert.deepEqual(result, {
    ...expected, prompt_cache_key: "evaluation", prompt_cache_options: { mode: "explicit" },
    max_output_tokens: 8192, parallel_tool_calls: false,
  });
  const another = request();
  another.prompt_cache_key = "another-sdk-session";
  assert.deepEqual(transformPayload(another, model, { toolNames: [] }), result);
});

test("material-reading tasks and submission repairs retain multi-turn history caching", () => {
  for (const modelId of ["gpt-5.6-luna", "gpt-6-luna", "gpt-6.1-sol"]) {
    assert.equal((transformPayload(request(), { ...model, model: modelId }, { toolNames: ["read_trace"] }) as
      { prompt_cache_options: { mode: string } }).prompt_cache_options.mode, "implicit");
  }
  for (const history of [
    { type: "function_call", name: "submit_evaluation", arguments: "{}" },
    { type: "function_call_output", output: "Fix the rejected field" },
    { role: "assistant", content: "Draft" },
    { type: "reasoning", encrypted_content: "preserve-verbatim" },
  ]) {
    const payload = { ...request(), input: [...request().input, history] };
    const before = structuredClone(payload.input);
    const result = transformPayload(payload, model, { toolNames: [] }) as Record<string, unknown>;
    assert.deepEqual(result.prompt_cache_options, { mode: "implicit" });
    assert.deepEqual(result.input, before);
  }
});

test("assistant sessions, other models and Chat Completions keep their SDK cache controls", () => {
  for (const config of [
    { ...model, model: "gpt-5.5" },
    { ...model, model: "gateway-custom" },
    { ...model, model: "gpt-60" },
    { ...model, api: "openai-completions" as const },
  ]) {
    const payload = request();
    transformPayload(payload, config, { toolNames: [] });
    assert.equal(payload.prompt_cache_key, "random-sdk-session");
    assert.equal(payload.prompt_cache_retention, "24h");
    assert(!Object.hasOwn(payload, "prompt_cache_options"));
  }
  const assistant = request();
  transformPayload(assistant, model);
  assert.equal(assistant.prompt_cache_key, "random-sdk-session");
  assert(!Object.hasOwn(assistant, "prompt_cache_options"));
});
