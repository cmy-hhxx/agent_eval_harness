import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_POLICY, ValidationError } from "@eval/contracts";
import { AgentRegistry } from "@eval/host";
import { compactAgent } from "./index.js";
import { cite, evidenceSources } from "@eval/tools";
import { emptyAudit } from "../../../../tests/fixtures/comparison.js";

function fixture(profile: string, text = "2.492108") {
  const id = "11111111-1111-4111-8111-111111111111", raw = { messages: [{ content: text, output: text }] };
  const original = cite(id, 0, evidenceSources(raw.messages[0]).find(source => source.path === (profile === "key_data" ? "/content" : "/output"))!, 0, text.length);
  return { registry: new AgentRegistry([compactAgent]), original,
    binding: { agent: "compact", profile, request: { sources: { answer: { id, value: raw } },
      input: { source_positions: [{ trace_index: 1, message_index: 3 }], trace_index: 1, final_message_index: 0,
        recorded_components: profile === "components" ? [{ component_index: 1, kind: "script", name: "/work/render.py", source_evidence: [{ reference: { evidence_id: original.evidence_id }, quote: original.quote, message_index: 0 }] }] : [] } } },
    audit: { ...emptyAudit(), evidenceBank: [original.evidence_id] } };
}

test("fixed flat key_data assigns indices and resolves original values without generated source nesting", () => {
  const f = fixture("key_data"), draft = { value: [{ evidence: [1] }] };
  const before = structuredClone(draft), result = f.registry.resolve(f.binding, draft, f.audit);
  f.registry.validate(f.binding, result, f.audit);
  assert.deepEqual(result, { value: [{ key_data_idx: 1, key_data_content: "2.492108",
    evidence: [{ evidence_id: f.original.evidence_id, quote: "2.492108" }] }] });
  assert.deepEqual(draft, before);
  for (const extra of [{ key_data_idx: 99 }, { key_data_content: { nested: "不采用" } }, { extra: {} }])
    assert.deepEqual(f.registry.resolve(f.binding, { value: [{ ...draft.value[0], ...extra }] }, f.audit), result,
      "extra fields are removed before program-owned values are bound");
  for (const value of [
    { 任意分组: draft.value }, [{ ...draft.value[0], evidence: [] }],
    [{ ...draft.value[0], evidence: [2] }], [{ ...draft.value[0], evidence: [1, 1] }],
  ]) assert.throws(() => f.registry.resolve(f.binding, { value }, f.audit), ValidationError);
  assert.throws(() => f.registry.resolve({ ...f.binding, request: { ...f.binding.request,
    input: { ...f.binding.request.input, trace_index: 0 } } }, draft, f.audit), ValidationError);
});

test("key_data copies FDX final units and qualifiers without recomputing or correcting them", () => {
  const claim = "FDX CY2027 consensus EPS is about $20.86; roughly 8.5x, not independently verified.";
  const f = fixture("key_data", claim);
  const result = f.registry.resolve(f.binding, { value: [{ evidence: [1] }] }, f.audit) as { value: { key_data_content: string }[] };
  assert.equal(result.value[0]!.key_data_content, claim, "even an incorrect final multiple stays unchanged for attribution to check");
  const raw = f.binding.request.sources.answer.value;
  const tool = cite(f.binding.request.sources.answer.id, 0, evidenceSources(raw.messages[0]).find(source => source.path === "/output")!, 0, claim.length);
  assert.throws(() => f.registry.resolve(f.binding, { value: [{ evidence: [2] }] }, { ...f.audit, evidenceBank: [...f.audit.evidenceBank, tool.evidence_id] }), /只能选择本轮最终回复/);
});

test("only field summaries prohibited from restating invocation counts are rejected", () => {
  const f = fixture("session_overview");
  for (const text of ["共32次工具调用。", "第147次shell调用被拒绝。", "调用了工具27次。"])
    assert.throws(() => f.registry.resolve(f.binding, { value: ["用户问租金。", text] }, f.audit), /调用次数由程序/);
  assert.doesNotThrow(() => f.registry.resolve(f.binding, { value: ["用户问每年一次的租金调增。", "脚本失败，未交付工作簿。"] }, f.audit));
  assert.doesNotThrow(() => f.registry.resolve(f.binding, { value: ["用户问AIP与同业。", "调用 finquery.py 一次性批量查询，取得数据。"] }, f.audit));
  const errors = fixture("tool_errors");
  assert.throws(() => errors.registry.resolve(errors.binding,
    { value: [{ tool_error_content: "共2次调用 shell 报错。", evidence: [1] }] }, errors.audit), /调用次数由程序/);
  const components = fixture("components", "python /work/render.py");
  assert.doesNotThrow(() => components.registry.resolve(components.binding, { value: [{ components_kind: "script", components_name: "/work/render.py",
    components_content: "为生成预览，连续调用两次 render.py；第二次成功。", actor_indices: [1], evidence: [1] }] }, components.audit));
});

test("component extraction requires the exact actual script name in selected source", () => {
  const f = fixture("components", "python /work/render.py");
  const draft = { value: [{ components_kind: "script", components_name: "/work/render.py", components_content: "生成预览。", actor_indices: [1], evidence: [1] }] };
  const result = f.registry.resolve(f.binding, draft, f.audit);
  f.registry.validate(f.binding, result, f.audit);
  assert.throws(() => f.registry.resolve(f.binding, { value: [{ ...draft.value[0], components_name: "模型推理生成" }] }, f.audit), error =>
    error instanceof ValidationError && error.issues?.some(issue => issue.code === "component_actor_name") === true);
  assert.deepEqual(f.registry.resolve(f.binding, { value: [{ ...draft.value[0], details: { purpose: "多余层" } }] }, f.audit), result);
});

test("field prompts contain a fixed example and permit one targeted structural repair", () => {
  const registry = new AgentRegistry([compactAgent]);
  const binding = { agent: "compact", profile: "artifacts", request: { sources: {}, input: {} }, projectModelInput: (input: Record<string, unknown>) => input };
  const prepared = registry.prepare(binding);
  assert(prepared.prompt.includes('"target_field":"artifacts"'));
  assert(prepared.prompt.includes('"field_value_type":"array"'));
  const draft = { value: { artifacts: [{ artifacts_content: "文件。" }] } };
  const repaired = prepared.renderAttempt({ ...DEFAULT_POLICY, repairAttempts: 0 }, {
    draft, errors: [{ category: "structure", code: "schema_type", path: "/value", message: "must be array" }],
    attemptId: "failed-artifacts", contentSubmissions: 1, fileErrors: 0, repeatedErrors: 0, stopped: true,
  });
  assert(repaired.includes('"field_repair"')); assert(repaired.includes(JSON.stringify(draft)));
  assert.throws(() => registry.resolve(binding, { value: [{ any_shape: { count: 3 } }] }, emptyAudit()), ValidationError);
  const rendered = compactAgent.profiles.key_data!.renderPrompt({ turns: [{ final_evidence: [{ quote: "原文。", reference: { evidence_index: 7 } }] }] });
  assert.deepEqual(JSON.parse(rendered.slice(rendered.indexOf("\n") + 1)).submission_example,
    { value: [{ evidence: [7] }] });
});


test("historical tools cannot enter the current directory through empty source selections", () => {
  const f = fixture("components", "历史上下文曾使用 web_search 与 finance skill。");
  for (const kind of ["tool", "skill", "script"]) assert.throws(() => f.registry.resolve(f.binding, { value: [{
    components_kind: kind, components_name: "web_search", components_content: "历史回执。", actor_indices: [], evidence: [1],
  }] }, f.audit), ValidationError);
});

test("component repair enumerates all duplicate rows and source unions in one feedback", () => {
  const f = fixture("components", "python /work/render.py");
  const entry = { components_kind: "script", components_name: "/work/render.py", components_content: "为生成产物运行脚本，保存预览。", actor_indices: [1], evidence: [1] };
  const draft = { value: [entry, { ...entry }] };
  let issues: NonNullable<ValidationError["issues"]> = [];
  assert.throws(() => f.registry.resolve(f.binding, draft, f.audit), error => {
    if (!(error instanceof ValidationError)) return false;
    issues = error.issues!;
    assert.equal(issues[0]!.code, "component_duplicate");
    assert.deepEqual(issues[0]!.expected, { merge_groups: [{ name: "/work/render.py", actor_indices: [1], evidence: [1],
      rows: [{ row: 0, content: "为生成产物运行脚本，保存预览。" }, { row: 1, content: "为生成产物运行脚本，保存预览。" }] }] });
    return true;
  });
  const rendered = compactAgent.profiles.components!.renderPrompt({ turns: [] }, DEFAULT_POLICY, {
    draft, errors: issues, attemptId: "repair", contentSubmissions: 2, fileErrors: 0, repeatedErrors: 0, stopped: true,
  });
  assert(rendered.includes('"merge_groups"') && rendered.includes('"/work/render.py"'));
  assert(rendered.includes('"content":"为生成产物运行脚本，保存预览。"'));
  assert.doesNotThrow(() => f.registry.resolve(f.binding, { value: [entry] }, f.audit));
});

test("reading a JSON data file does not make that file an executable script component", () => {
  const f = fixture("components", "python -c \"import json; json.load(open('/tmp/data.json'))\"");
  const draft = { value: [{ components_kind: "script", components_name: "data.json", components_content: "被读取的数据文件。", actor_indices: [1], evidence: [1] }] };
  assert.throws(() => f.registry.resolve(f.binding, draft, f.audit), error => error instanceof ValidationError &&
    error.issues?.some(issue => issue.code === "component_data_file") === true);
});

test("component examples use the actual source numbers and types, grouping model calls", () => {
  const rendered = compactAgent.profiles.components!.renderPrompt({ recorded_components: [
    { actor_index: 1, kind: "model", name: "llm-call-0" }, { actor_index: 3, kind: "model", name: "planner-finquery" },
    { actor_index: 2, kind: "tool", name: "shell" },
    { actor_index: 5, kind: "model", name: "llm-call-1" }, { actor_index: 7, kind: "script", name: "/work/render.py" },
  ], turns: [{ process_excerpts: [{ quote: "原文。", reference: { evidence_index: 4 } }] }] });
  const example = JSON.parse(rendered.slice(rendered.indexOf("\n") + 1)).submission_example.value;
  assert.deepEqual(example.map((entry: Record<string,unknown>) => [entry.components_kind, entry.actor_indices]),
    [["model", [1]], ["model", [5]], ["model", [3]], ["tool", [2]], ["script", [7]]]);
  assert.equal(example[0].components_name, "规划");
  assert.equal(example[1].components_name, "答案合成");
  assert(example.every((entry: {evidence:number[]}) => entry.evidence[0] === 4));
});
