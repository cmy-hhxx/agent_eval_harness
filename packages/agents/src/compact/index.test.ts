import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_POLICY, ValidationError } from "@eval/contracts";
import { AgentRegistry } from "@eval/host";
import { compactAgent } from "./index.js";
import { cite, displayEvidence, evidenceSources } from "@eval/tools";
import { emptyAudit } from "../../../../tests/fixtures/comparison.js";

test("key_data keeps a flexible structure and code restores selected original facts exactly", () => {
  const id = "11111111-1111-4111-8111-111111111111", raw = { messages: [{ output: "2.492108" }] };
  const original = cite(id, 0, evidenceSources(raw.messages[0]).find(source => source.path === "/output")!, 0, 8);
  const facts = [{ value: 2.492108, location: { trace_index: 1, message_index: 3, path: "/output", field_path: "/rows/0/weight" }, source_evidence: [displayEvidence(original)] }];
  const binding = { agent: "compact", profile: "key_data", request: { sources: { answer: { id, value: raw } }, input: { facts, source_positions: [{ trace_index: 1, message_index: 3 }] } } };
  const registry = new AgentRegistry([compactAgent]), draft = { value: { 自定义口径: [{ $evidence: [1], 用途: "结论依赖的持仓权重。" }] } };
  const before = structuredClone(draft);
  const audit = { ...emptyAudit(), evidenceBank: [original.evidence_id] };
  const result = registry.resolve(binding, draft, audit);
  registry.validate(binding, result, emptyAudit());
  assert.deepEqual(result, { value: { 自定义口径: [{ source_values: facts, 用途: "结论依赖的持仓权重。", summary_origin: { agent: "compact", field: "key_data" } }] } });
  assert.deepEqual(draft, before);
  assert.throws(() => registry.resolve(binding, { value: { wrong: { $evidence: [2] } } }, audit), ValidationError);
  assert.throws(() => registry.resolve(binding, { value: { wrong: { $evidence: 1 } } }, audit), error =>
    error instanceof ValidationError && error.issues?.[0]?.path === "/value/wrong/$evidence");
  assert.throws(() => registry.resolve(binding, { value: { wrong: { evidence: [1] } } }, audit), error =>
    error instanceof ValidationError && error.issues?.[0]?.path === "/value/wrong/evidence");
});

test("component extraction requires the actual script name in the selected original source", () => {
  const id = "11111111-1111-4111-8111-111111111111", raw = { messages: [{ type: "tool_call", name: "shell", input: { command: "python /work/render.py" } }] };
  const source = evidenceSources(raw.messages[0]).find(source => source.path === "/input/command")!;
  const original = cite(id, 0, source, 0, source.text.length), registry = new AgentRegistry([compactAgent]);
  const binding = { agent: "compact", profile: "components", request: { sources: { answer: { id, value: raw } },
    input: { source_positions: [{ trace_index: 0, message_index: 0 }] } } };
  const audit = { ...emptyAudit(), evidenceBank: [original.evidence_id] };
  const draft = { value: [{ kind: "script", name: "/work/render.py", details: { purpose: "生成预览。" }, $evidence: [1] }] };
  const result = registry.resolve(binding, draft, audit) as { value: Record<string, unknown>[] };
  registry.validate(binding, result, audit);
  assert.deepEqual(result.value[0]!.details, draft.value[0]!.details);
  assert.throws(() => registry.resolve(binding, { value: [{ ...draft.value[0], name: "限制披露" }] }, audit), error =>
    error instanceof ValidationError && error.issues?.[0]?.code === "component_source_name");
  assert.throws(() => registry.resolve(binding, { value: [{ kind: "script", name: "/work/render.py" }] }, audit), ValidationError);
});

test("field prompts identify the field, value type, complete example and one targeted structural repair", () => {
  const registry = new AgentRegistry([compactAgent]);
  const binding = { agent: "compact", profile: "artifacts", request: { sources: {}, input: {} }, projectModelInput: (input: Record<string, unknown>) => input };
  const prepared = registry.prepare(binding);
  assert(prepared.prompt.includes('"target_field":"artifacts"'));
  assert(prepared.prompt.includes('"field_value_type":"array"'));
  assert(prepared.evaluation.systemPrompt.includes("只提取 artifacts"));
  assert(prepared.prompt.includes('"submission_example":{"value":[{"description":"交付资源描述"}]}'));
  const draft = { value: { artifacts: [{ description: "实际交付的文件。" }] } };
  const prompt = prepared.renderAttempt({ ...DEFAULT_POLICY, repairAttempts: 0 }, {
    draft, errors: [{ category: "structure", code: "schema_type", path: "/value", message: "must be array" }],
    attemptId: "failed-artifacts", contentSubmissions: 1, fileErrors: 0, repeatedErrors: 0, stopped: true,
  });
  assert(prompt.includes('"field_repair"'));
  assert(prompt.includes(JSON.stringify(draft)));
  assert(prompt.includes("仅修复反馈指出的封装"));
  const value = { value: [{ any_shape: { count: 3 } }, "交付说明"] };
  registry.validate(binding, registry.resolve(binding, value, emptyAudit()), emptyAudit());
  const keyData = compactAgent.profiles.key_data!.renderPrompt({ facts: [{ value: 1234, reference: { evidence_index: 1 } }],
    turns: [{ final_evidence: [{ quote: "结论使用股价100元。", reference: { evidence_index: 7 } }] }] });
  assert.deepEqual(JSON.parse(keyData.slice(keyData.indexOf("\n") + 1)).submission_example,
    { value: { 关键指标: [{ 用途: "说明该指标支撑的结论。", $evidence: [7] }] } });
  assert(!keyData.includes('"field_instruction"'), "the field task belongs to the system instruction, outside original material");
});
