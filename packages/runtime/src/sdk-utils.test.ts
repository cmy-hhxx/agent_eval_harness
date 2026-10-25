import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ModelConfig, ToolResult } from "@eval/contracts";
import type { AttributionSubmission } from "@eval/agents/attribution";
import type { ComparisonSubmission } from "@eval/agents/comparison";
import type { ClusteringSubmission } from "@eval/agents/clustering";
import { activeToolNames, contentToolName, inlineToolSchema, providerConfig, transformPayload } from "./sdk-utils.js";

test("initial and restored checkpoints select the current content tool without a file fallback", () => {
  assert.equal(contentToolName({ fileSubmission: false }, false), "submit_evaluation");
  assert.equal(contentToolName({ fileSubmission: true }, false), "submit_evaluation_file");
  for (const fileSubmission of [false, true]) {
    assert.equal(contentToolName({ fileSubmission, inspectionSchema: {} }, false), "inspect_material");
    assert.equal(contentToolName({ fileSubmission, inspectionSchema: {} }, true),
      fileSubmission ? "submit_evaluation_file" : "submit_evaluation");
  }
});

test("published tools intersect the current content phase with exploration and reserved budgets", () => {
  const names = ["search_trace", "read_trace", "execute_code", "inspect_material", "submit_evaluation_file"];
  const feedback = (remaining: number, covered = true): ToolResult => ({ content: [], details: { budget: {
    exploration: { remaining }, required_reads: { covered }, draft_writes: { remaining: 1, tools: ["execute_code"] },
  } } });
  assert.deepEqual(activeToolNames(feedback(2), names, "inspect_material"), names.filter(name => name !== "submit_evaluation_file"));
  assert.deepEqual(activeToolNames(feedback(0), names, "inspect_material"), ["execute_code", "inspect_material"]);
  assert.deepEqual(activeToolNames(feedback(0, false), names, "inspect_material"), ["read_trace", "execute_code", "inspect_material"]);
  assert.deepEqual(activeToolNames(feedback(2), names, "submit_evaluation_file"), names.filter(name => name !== "inspect_material"));
  assert.deepEqual(activeToolNames(feedback(0), names, "submit_evaluation_file"), ["execute_code", "submit_evaluation_file"]);
});

test("SDK keeps only registered reserved writers, submissions and uncovered mandatory reads after exploration runs out", () => {
  const names = ["search_trace", "read_trace", "execute_code", "save_draft", "submit_evaluation"];
  const feedback = (remaining: number, covered: boolean): ToolResult => ({ content: [], details: { budget: {
    exploration: { remaining: 0 }, required_reads: { covered },
    draft_writes: { used: 0, remaining, tools: ["save_draft", "unregistered_writer"] },
  } } });
  assert.deepEqual(activeToolNames(feedback(1, true), names, "submit_evaluation"), ["save_draft", "submit_evaluation"]);
  assert.deepEqual(activeToolNames(feedback(1, false), names, "submit_evaluation"), ["read_trace", "save_draft", "submit_evaluation"]);
  assert.deepEqual(activeToolNames(feedback(0, true), names, "submit_evaluation"), ["submit_evaluation"]);
  assert.deepEqual(activeToolNames(feedback(0, false), names, "submit_evaluation"), ["read_trace", "submit_evaluation"]);
  assert.deepEqual(activeToolNames({ content: [], details: { budget: { exploration: { remaining: 1 } } } }, names, "submit_evaluation"), names);
});

test("tool schema inlining preserves Criteria source selections, array constraints and the original schema", () => {
  const source = JSON.parse(readFileSync("schemas/criteria/submission.schema.json", "utf8"));
  const before = structuredClone(source);
  const inline = inlineToolSchema(source) as Record<string, unknown>;
  assert(!JSON.stringify(inline).includes('"$ref"'));
  assert(!Object.hasOwn(inline, "$defs"));
  assert.deepEqual(source, before);
  const originalValidate = new Ajv2020({ strict: false }).compile(source);
  const inlineValidate = new Ajv2020({ strict: false }).compile(inline);
  const criterion = { source_indices: [1], text: "Return ready" };
  const valid = { requirements: [criterion], scoring_points: [], red_flags: [] };
  for (const [source_indices, expected] of [
    [[1], true], [[1, 2], true],
    [[], false], [1, false], [{ item: 1 }, false],
    [[0], false], [[1.5], false], [["1"], false], [[1, 1], false],
  ] as const) {
    const sample = { ...valid, requirements: [{ ...criterion, source_indices }] };
    assert.equal(originalValidate(sample), expected);
    assert.equal(inlineValidate(sample), expected);
  }
  for (const sample of [{ ...valid, requirements: [] }, { ...valid, extra: true },
    { ...valid, requirements: [{ ...criterion, text: "" }] }]) {
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

// These payloads exercise the model-facing schema transport; Agent tests own business validation.
const submissions = {
  attribution: {
    summary: "回答完成计算。", is_correct: true, correctness_reason: "与标准一致。", correctness_evidence_indices: [1],
    meets_core: true, core_reason: "给出所求结果。", core_requirements: [1],
    criterion_assessments: [{ status: "met", evidence_status: "established", summary: "结果正确。", evidence_indices: [1] }],
    numeric_checks: [{ label: "结果", reference_index: 1, actual: "4", scale: "1", mode: "exact", evidence_index: 1 }],
    strengths: [], problems: [], investigation_facts: [],
  } satisfies AttributionSubmission,
  comparison: {
    a_summary: "已完成。", b_summary: "已完成。", preference: null, relative_preference: "A",
    tradeoff: "双方均完成核心要求。",
    comparisons: [{ importance: "high", better_candidate: null },
      { importance: "low" }],
  } satisfies ComparisonSubmission,
  rewrite: { rewrites: [{ id: "summary", text: "双方均完成核心要求。" }] },
  clustering: {
    assignments: [{ item_id: "O1", class_label: "算术错误" }, { item_id: "O2", new_class_index: 0 }],
    new_classes: [{ component: "模型自身推理", label: "单位换算遗漏", definition: "比较前没有统一单位。", novelty: "现有类未覆盖换算问题。", category_paths: [["数值可靠性"]] }],
    merges: [],
  } satisfies ClusteringSubmission,
};
for (const [stage, fixture] of Object.entries(submissions)) {
  test(`tool schema inlining preserves ${stage} submission acceptance and required fields`, () => {
    const source = JSON.parse(readFileSync(`schemas/${stage}/submission.schema.json`, "utf8"));
    const before = structuredClone(source);
    const inline = inlineToolSchema(source);
    const validators = [source, inline].map((schema) => new Ajv2020({ strict: false }).compile(schema));
    for (const validate of validators) assert.equal(validate(fixture), true, JSON.stringify(validate.errors));
    for (const key of source.required) {
      const invalid: Record<string, unknown> = structuredClone(fixture);
      delete invalid[key];
      for (const validate of validators) assert.equal(validate(invalid), false, key);
    }
    assert(!JSON.stringify(inline).includes('"$ref"'));
    assert.deepEqual(source, before);
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
  contextWindow: 200000, maxOutputTokens: 8192, supportsExplicitPromptCaching: true,
};
test("provider capabilities preserve explicit max reasoning and opt-out of developer roles", () => {
  const defaultProvider = providerConfig(model).models[0]!;
  assert.deepEqual(defaultProvider.thinkingLevelMap, { xhigh: "xhigh", max: "max" });
  assert.equal(defaultProvider.compat.supportsDeveloperRole, true);
  assert.equal(providerConfig({ ...model, thinking: "max", supportsDeveloperRole: false }).models[0]!.compat.supportsDeveloperRole, false);
  for (const api of ["openai-completions", "openai-responses"] as const) {
    const field = api === "openai-completions" ? "messages" : "input";
    const payload = { [field]: [{ role: "developer", content: "system contract" }, { role: "user", content: "task" },
      { type: "function_call", name: "read", arguments: "{}" }] };
    const original = structuredClone(payload);
    transformPayload(payload, { ...model, api });
    assert.deepEqual(payload, { ...original, parallel_tool_calls: false,
      ...(api === "openai-completions" ? { max_completion_tokens: 8192 } : { max_output_tokens: 8192 }) },
    "omitted capabilities preserve the SDK's role choices");
    transformPayload(payload, { ...model, api, supportsDeveloperRole: false });
    assert.deepEqual(payload[field], [{ role: "system", content: "system contract" }, original[field]![1], original[field]![2]]);
  }
});
const evaluation = (toolNames: string[]) => ({ systemPrompt: "Exact rules", toolNames, outputSchema: { type: "object" }, fileSubmission: false });
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

test("Responses channels do not receive explicit cache extensions without declaring support", () => {
  for (const support of [undefined, false]) {
    const config = { ...model, provider: "openai", model: "gpt-6-luna", supportsExplicitPromptCaching: support };
    const value = request();
    transformPayload(value, config, evaluation([]));
    assert.equal(JSON.stringify(value).includes("prompt_cache_breakpoint"), false);
    assert.equal("prompt_cache_options" in value, false);
    assert.equal(value.input[0].content, "Exact rules and attempt workspace");
  }
});

test("both provider APIs retain the current inspection and final model schemas without changing history", () => {
  const inspectionSchema = { type: "object", required: ["checks"], properties: { checks: {
    type: "array", items: { $ref: "#/$defs/check" },
  } }, $defs: { check: { type: "object", required: ["actual"], properties: { actual: { type: "string" } } } } };
  const outputSchema = { type: "object", required: ["ok"], properties: { ok: { const: true } } };
  const pathSchema = { type: "object", additionalProperties: false, required: ["path"],
    properties: { path: { type: "string", minLength: 1 } } };
  for (const api of ["openai-completions", "openai-responses"] as const) for (const fileSubmission of [false, true]) {
    const contract = { systemPrompt: "Exact rules", toolNames: ["inspect_material"], fileSubmission, inspectionSchema, outputSchema };
    const before = structuredClone(contract);
    const history = [{ role: "user", content: "Original facts" },
      { role: "assistant", content: JSON.stringify({ detail: {}, text: 'quoted "text"\\path\nline' }) }];
    const names = ["inspect_material", fileSubmission ? "submit_evaluation_file" : "submit_evaluation"];
    const tools = names.map(name => api === "openai-completions"
      ? { type: "function", function: { name, parameters: fileSubmission ? pathSchema : { type: "object" } } }
      : { type: "function", name, parameters: fileSubmission ? pathSchema : { type: "object" } });
    const payload = { tools, ...(api === "openai-completions" ? { messages: structuredClone(history) } : { input: structuredClone(history) }) };
    transformPayload(payload, { ...model, api }, contract);
    const parameters = payload.tools.map(tool => api === "openai-completions"
      ? (tool as { function: { parameters: unknown } }).function.parameters : (tool as { parameters: unknown }).parameters);
    assert.deepEqual(parameters, fileSubmission ? [pathSchema, pathSchema] : [inlineToolSchema(inspectionSchema), outputSchema]);
    assert.deepEqual("messages" in payload ? payload.messages : payload.input, history);
    assert.deepEqual(contract, before);
  }
});

test("evaluation caching changes only request controls, preserving content and generation settings", () => {
  const payload = request();
  const before = structuredClone(payload);
  const result = transformPayload(payload, model, evaluation([]));
  const { prompt_cache_retention: _retention, ...expected } = before;
  assert.deepEqual(result, {
    ...expected, prompt_cache_key: "evaluation", prompt_cache_options: { mode: "explicit" },
    input: [{ role: "developer", content: [
      { type: "input_text", text: "Exact rules", prompt_cache_breakpoint: { mode: "explicit" } },
      { type: "input_text", text: " and attempt workspace" },
    ] }, before.input[1]],
    max_output_tokens: 8192, parallel_tool_calls: false,
  });
  const another = request();
  another.prompt_cache_key = "another-sdk-session";
  assert.deepEqual(transformPayload(another, model, evaluation([])), result);
});

test("material-reading tasks and submission repairs retain multi-turn history caching", () => {
  for (const modelId of ["gpt-5.6-luna", "gpt-6-luna", "gpt-6.1-sol"]) {
    assert.equal((transformPayload(request(), { ...model, model: modelId }, evaluation(["read_trace"])) as
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
    const result = transformPayload(payload, model, evaluation([])) as Record<string, unknown>;
    assert.deepEqual(result.prompt_cache_options, { mode: "implicit" });
    const input = result.input as { content?: unknown }[];
    assert.deepEqual(input.slice(1), before.slice(1), "task and tool history stay verbatim");
    assert.equal((input[0].content as { text: string }[]).map(part => part.text).join(""),
      before[0].content, "splitting the fixed prefix preserves all system text");
  }
});

test("cache boundaries preserve the complete system text, roles and multimodal history", () => {
  for (const role of ["developer", "system"]) {
    const first = { role, content: "Exact rules\n\n<cwd>\n/attempt/unique\n</cwd>" };
    const image = { role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,eA==" }] };
    const payload = { ...request(), input: [first, image] };
    const before = structuredClone(payload);
    const result = transformPayload(payload, model, evaluation([])) as Record<string, unknown>;
    const input = result.input as { role: string; content: unknown }[];
    assert.equal(input[0].role, role);
    assert.equal((input[0].content as { text: string }[]).map(block => block.text).join(""), before.input[0].content);
    assert.deepEqual(input.slice(1), before.input.slice(1));
    assert.deepEqual(transformPayload(payload, model, evaluation([])), result, "reapplying controls is idempotent");
  }
});

test("assistant sessions, other models and Chat Completions keep their SDK cache controls", () => {
  for (const config of [
    { ...model, model: "gpt-5.5" },
    { ...model, model: "gateway-custom" },
    { ...model, model: "gpt-60" },
    { ...model, api: "openai-completions" as const },
  ]) {
    const payload: Record<string, unknown> = request();
    if (config.api === "openai-completions")
      payload.tools = [{ type: "function", function: { name: "submit_evaluation", parameters: { type: "object" } } }];
    transformPayload(payload, config, evaluation([]));
    assert.equal(payload.prompt_cache_key, "random-sdk-session");
    assert.equal(payload.prompt_cache_retention, "24h");
    assert(!Object.hasOwn(payload, "prompt_cache_options"));
  }
  const assistant = request();
  transformPayload(assistant, model);
  assert.equal(assistant.prompt_cache_key, "random-sdk-session");
  assert(!Object.hasOwn(assistant, "prompt_cache_options"));
});
