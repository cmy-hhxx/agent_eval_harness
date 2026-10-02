import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ModelConfig } from "@eval/contracts";
import { inlineToolSchema, transformPayload } from "./sdk-utils.js";

test("tool schema inlining preserves real Criteria validation, array types and the original schema", () => {
  const source = JSON.parse(readFileSync("schemas/criteria/result.schema.json", "utf8"));
  const before = structuredClone(source);
  const inline = inlineToolSchema(source) as Record<string, unknown>;
  assert(!JSON.stringify(inline).includes('"$ref"'));
  assert(!Object.hasOwn(inline, "$defs"));
  assert.deepEqual(source, before);
  const originalValidate = new Ajv2020({ strict: false }).compile(source);
  const inlineValidate = new Ajv2020({ strict: false }).compile(inline);
  const criterion = { id: "r1", text: "Return ready", applies_to: [], acceptance_rule: "Contains ready" };
  const valid = { task_type: "fixture", goal: "Return ready", requirements: [criterion], scoring_points: [], red_flags: [] };
  for (const [applies_to, expected] of [
    [[], true], [["11111111-1111-4111-8111-111111111111"], true],
    ["", false], [{ item: "11111111-1111-4111-8111-111111111111" }, false],
    [["bad-uuid"], false], [["11111111-1111-4111-8111-111111111111", "11111111-1111-4111-8111-111111111111"], false],
  ] as const) {
    const sample = { ...valid, requirements: [{ ...criterion, applies_to }] };
    assert.equal(originalValidate(sample), expected);
    assert.equal(inlineValidate(sample), expected);
  }
  for (const sample of [{ ...valid, requirements: [] }, { ...valid, extra: true }, { ...valid, goal: "" }]) {
    assert.equal(originalValidate(sample), false);
    assert.equal(inlineValidate(sample), false);
  }
});

test("tool schema references preserve sibling constraints through conjunction and resolve escaped local pointers", () => {
  const schema = {
    $defs: { "a/b~c": { type: "number", minimum: 5 }, chained: { $ref: "#/$defs/a~1b~0c" } },
    definitions: { yes: true, no: false }, type: "object",
    properties: {
      n: { $ref: "#/$defs/chained", minimum: 0, maximum: 8, description: "bounded value" },
      pass: { $ref: "#/definitions/yes" }, block: { $ref: "#/definitions/no" },
      $defs: { type: "string" }, definitions: { type: "string" },
    },
  };
  const inline = inlineToolSchema(schema) as typeof schema;
  assert.equal(inline.properties.pass, true);
  assert.equal(inline.properties.block, false);
  assert.deepEqual(inline.properties.$defs, { type: "string" });
  assert.deepEqual(inline.properties.definitions, { type: "string" });
  const validators = [schema, inline].map((value) => new Ajv2020({ strict: false }).compile(value));
  for (const [sample, valid] of [[{ n: 6 }, true], [{ n: 3 }, false], [{ n: 9 }, false], [{ block: 1 }, false]] as const)
    for (const validate of validators) assert.equal(validate(sample), valid);
  assert.equal(inlineToolSchema(true), true);
  assert.equal(inlineToolSchema(false), false);
});

for (const stage of ["attribution", "comparison", "rewrite", "clustering"]) {
  test(`tool schema inlining preserves ${stage} fixture acceptance and required fields`, () => {
    const source = JSON.parse(readFileSync(`schemas/${stage}/result.schema.json`, "utf8"));
    const fixture = JSON.parse(readFileSync(`packages/agents/src/${stage}/fixtures/example.json`, "utf8")).result;
    const inline = inlineToolSchema(source);
    const validators = [source, inline].map((schema) => new Ajv2020({ strict: false }).compile(schema));
    for (const validate of validators) assert.equal(validate(fixture), true, JSON.stringify(validate.errors));
    for (const key of source.required) {
      const invalid = structuredClone(fixture);
      delete invalid[key];
      for (const validate of validators) assert.equal(validate(invalid), false, key);
    }
    assert(!JSON.stringify(inline).includes('"$ref"'));
  });
}

test("tool schema inlining leaves instance literals containing $ref and definition keys unchanged", () => {
  const literal = { $ref: "https://example.test/data", $defs: { keep: true }, definitions: { keep: false } };
  const schema = { type: "object", properties: { value: { const: literal, default: literal, examples: [literal], enum: [literal] } } };
  assert.deepEqual(inlineToolSchema(schema), schema);
});

test("tool schema reference siblings retain evaluated-property scope and existing allOf constraints", () => {
  const schema = {
    $defs: { shape: { type: "object", properties: { value: { type: "string", minLength: 2 } } } },
    $ref: "#/$defs/shape", unevaluatedProperties: false,
    allOf: [{ minProperties: 1 }],
  };
  const validators = [schema, inlineToolSchema(schema)].map((value) => new Ajv2020({ strict: false }).compile(value));
  for (const [sample, expected] of [[{ value: "ok" }, true], [{ value: "x" }, false], [{ extra: true }, false], [{}, false]] as const)
    for (const validate of validators) assert.equal(validate(sample), expected);
});

test("tool schema inlining rejects external, unresolved, non-schema and circular references clearly", () => {
  for (const [schema, error] of [
    [{ $ref: "https://example.test/schema.json" }, /external.*reference/i],
    [{ $ref: "#anchor" }, /JSON pointer/i],
    [{ $ref: "#/$defs/missing" }, /unresolved.*reference/i],
    [{ $ref: "#/$defs/bad~2escape", $defs: { "bad~2escape": true } }, /JSON pointer/i],
    [{ $ref: "#/title", title: "not a schema" }, /schema.*object.*boolean/i],
    [{ $ref: "#" }, /circular.*reference/i],
    [{ $defs: { a: { $ref: "#/$defs/b" }, b: { $ref: "#/$defs/a" } }, $ref: "#/$defs/a" }, /circular.*reference/i],
    [{ $dynamicRef: "#node" }, /dynamic.*reference.*unsupported/i],
    [{ $recursiveRef: "#" }, /recursive.*reference.*unsupported/i],
    [{ properties: { value: { $id: "nested.json", $ref: "#/properties/value" } } }, /nested.*\$id.*unsupported/i],
  ] as const) assert.throws(() => inlineToolSchema(schema), error);
});

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
