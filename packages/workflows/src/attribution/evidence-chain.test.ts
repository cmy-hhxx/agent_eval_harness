import test from "node:test";
import assert from "node:assert/strict";
import { AgentRegistry } from "@eval/host";
import { compactAgent, type SessionCompact } from "@eval/agents/compact";
import { attributionAgent, evidenceMessageIndex, type SessionAttributionResult, type TraceAttributionResult } from "@eval/agents/attribution";
import { attributionPositionReference, parseEvidenceCoordinates, ValidationError, validateEvidenceBankSources, type JsonObject } from "@eval/contracts";
import { resolveEvidence, cite, evidenceSources, selectEvidenceSource } from "@eval/tools";
import { adapt, normalizeInput, sessionSource } from "@eval/workflows/inputs";
import { emptyAudit, fixtureConfig, criteriaResult, comparisonResult } from "../../../../tests/fixtures/comparison.js";
import { rm } from "node:fs/promises";
import { buildPlan } from "../comparison/input.js";
import { bindTask } from "../comparison/binding.js";
import type { TaskData } from "../comparison/types.js";
import type { RawInput } from "../inputs/types.js";
import { comparisonAgent } from "@eval/agents/comparison";
import { attributionEvidencePosition } from "@eval/contracts";
import { compactReceipt } from "../../../../tests/fixtures/compact.js";
import { compactSourceEvidence, verifiedCompact } from "../review/evidence-presentation.js";
import { attributionSessionSource } from "../review/public-trace.js";
import { comparisonAttribution } from "../comparison/comparison-attribution.js";
import { bindAttribution, planAttributionUnit, attributionWorkflow } from "./index.js";

function fixture() {
  const traces = [0, 1].map(index => ({ meta: { trace_id: `trace-${index}` },
    message_pool: [{ role: "system", content: "PRIVATE_RULE" }, { role: "tool", content: "原始安全叶子100。" }],
    messages: [
      { type: "user_question", role: "user", content: "查询当期收入。" },
      { type: "llm_turn", name: "planner-finquery", parent_span: "same-span", system_prompt: "PRIVATE_OUTER", input_messages: [0, 1],
        output: [{ tool_calls: [{ id: "same-call", function: { name: "shell", arguments: '{"command":"python finquery.py"}' } }] }] },
      { type: "tool_call", name: "shell", call_id: "same-call", parent_span: "same-span", input: { command: "python finquery.py" } },
      { type: "tool_result", name: "shell", call_id: "same-call", output: ' { "rows": [ {"value":100}, {"value":100} ], "error": "路径不存在" } ' },
      { type: "tool_call", name: "view_skill", call_id: "skill", input: { name: "finance" } },
      { type: "tool_result", name: "view_skill", call_id: "skill", output: '<skill_content name="finance">PRIVATE_SKILL</skill_content>' },
      { type: "final_answer", content: "当期收入100。" },
    ] }));
  const raw = { batch_id: "batch", case_id: "evidence-chain", meta: {}, traces }, session = normalizeInput(raw);
  const candidate = adapt(raw, { id: "a", name: "A", adapter: "b", sources: [] }, "fixture", 1);
  return { candidate, session, record: raw, inputs: { [candidate.input_id]: session }, tasks: planAttributionUnit(candidate).tasks,
    registry: new AgentRegistry([compactAgent, attributionAgent]) };
}
const problem = (index: number) => ({ component: "result-interpretation", actor_index: 1, label: "脚本路径错误", definition: "启动命令使用不存在的路径。",
  problem_phenomena: "规划 Agent 通过 shell 调用 finquery.py 失败。", reason: "请求、脚本返回共同定位到失败动作。",
  severity: "P1" as const, severity_reason: "没有取得结论所需数据。", evidence: [{ index, reason: "原始脚本返回。" }] });

test("independent responsibility choices in one trace survive resolution and session assembly", () => {
  const f = fixture(), task = f.tasks.find(task => task.stage === "attribution-trace" && (task.data as JsonObject).traceIndex === 1)!;
  const binding = bindAttribution(task, f.inputs, { compact: compactReceipt(2) });
  const prepared = f.registry.prepare(binding), index = prepared.evidenceBank.findIndex(id => parseEvidenceCoordinates(id)?.message_index === 10) + 1;
  assert(index > 0);
  const components = binding.request.input.components as {kind:string;name:string;component_index:number}[];
  const selected = [components.find(entry => entry.name === "planner-finquery")!, components.find(entry => entry.name === "shell")!];
  const result = f.registry.resolve(binding, { summary: "同一轮分别定位规划 Agent 和工具执行。",
    problems: selected.map(entry => ({ ...problem(index), component: entry.kind === "model" ? "argument-construction" : "shell", actor_index: entry.component_index })) },
  { ...emptyAudit(), evidenceBank: prepared.evidenceBank }) as TraceAttributionResult;
  assert.deepEqual(result.problem.map(item => item.component), ["动作参数生成", "shell"]);
  const receipt = { ...compactReceipt(2), evaluation: result };
  const sessionTask = f.tasks.find(task => task.stage === "attribution-session")!;
  const session = bindAttribution(sessionTask, f.inputs, { compact: compactReceipt(2), trace0: receipt, trace1: receipt });
  const combined = f.registry.resolve(session, { session_summary: "保留逐轮具体责任。", session_problem: [] },
    { ...emptyAudit(), evidenceBank: f.registry.prepare(session).evidenceBank }) as SessionAttributionResult;
  assert.deepEqual(combined.turns[1]!.problem, result.problem);
});

test("compact selections, code assembly, trace/session judgments and comparison retain the same original coordinate", () => {
  const f = fixture(), source = attributionSessionSource(f.session, f.candidate.input_id);
  const fieldTask = f.tasks.find(task => (task.data as JsonObject).compactField === "execution_chain" && (task.data as JsonObject).traceIndex === 1)!;
  const field = bindAttribution(fieldTask, f.inputs, {}), prepared = f.registry.prepare(field);
  const id = prepared.evidenceBank.find(id => {
    const point = parseEvidenceCoordinates(id);
    return point?.kind === "text" && point.message_index === 10 && point.path === "/output";
  })!;
  assert(id);
  const audit = { ...emptyAudit(), evidenceBank: prepared.evidenceBank };
  const value = f.registry.resolve(field, { value: [{ observation: "脚本返回路径不存在。", $evidence: [prepared.evidenceBank.indexOf(id) + 1] }] }, audit) as JsonObject;
  f.registry.validate(field, value, audit);
  const compact = compactReceipt(2).evaluation as SessionCompact;
  compact.turns[1]!.execution_chain = value.value;
  const refs = compactSourceEvidence(compact);
  assert.equal((refs[0]!.reference as JsonObject).evidence_id, id);
  assert.equal(refs[0]!.quote, resolveEvidence(source.original, { evidence_id: id }, "answer", audit, "/", f.candidate.input_id).quote);
  assert.deepEqual((refs[0]!.location as JsonObject).trace_index, 1);
  assert.deepEqual((refs[0]!.location as JsonObject).message_index, 3);
  assert(JSON.stringify(value).includes('"summary_origin"'));
  attributionWorkflow.advance!(fieldTask, { ...compactReceipt(2), evaluation: value, audit }, {} as never, f.inputs);
  const assemblyTask = f.tasks.find(task => task.stage === "attribution-compact")!;
  const dependencies = Object.fromEntries(Object.keys(assemblyTask.dependencies).map(key => [key, {
    ...compactReceipt(2), evaluation: { value: key === "1:execution_chain" ? value.value : key.includes(":") ? {} : {} },
  }]));
  const assembly = bindAttribution(assemblyTask, f.inputs, dependencies);
  assert.equal(assembly.agent, "compact");
  assert.deepEqual((assembly.computedResult as SessionCompact).turns[1]!.execution_chain, value.value);
  const receipt = { ...compactReceipt(2), evaluation: compact };
  const traceTask = f.tasks.find(task => task.stage === "attribution-trace" && (task.data as JsonObject).traceIndex === 1)!;
  const trace = bindAttribution(traceTask, f.inputs, { compact: receipt }), tracePrepared = f.registry.prepare(trace);
  validateEvidenceBankSources(tracePrepared.evidenceBank, new Map([[f.candidate.input_id, source.original]]));
  const index = tracePrepared.evidenceBank.indexOf(id) + 1;
  assert(index > 0, "compact's exact displayed span is immediately selectable without another read");
  assert(trace.presentedReads!.some(read => read.message_index === 10 && read.path === "/output"));
  const traceAudit = { ...emptyAudit(), evidenceBank: tracePrepared.evidenceBank };
  const result = f.registry.resolve(trace, { summary: "路径错误导致取数失败。", problems: [problem(index)] }, traceAudit) as TraceAttributionResult;
  assert.equal(attributionPositionReference(result.problem[0]!.evidence[0]!.position)!.evidence_id, id);
  assert.equal(evidenceMessageIndex(result.problem[0]!.evidence[0]!.position), 10, "downstream observation coordinates use the source index, not the local turn index");
  assert.equal(traceAudit.traceReads.length, 0);
  attributionWorkflow.advance!(traceTask, { ...receipt, evaluation: result, submitted: { problems: [problem(index)] }, audit: traceAudit }, {} as never, f.inputs);
  const sessionTask = f.tasks.find(task => task.stage === "attribution-session")!;
  const session = bindAttribution(sessionTask, f.inputs, { compact: receipt, trace0: { ...receipt, evaluation: result }, trace1: { ...receipt, evaluation: result } });
  const sessionPrepared = f.registry.prepare(session), sessionIndex = sessionPrepared.evidenceBank.indexOf(id) + 1;
  assert(sessionIndex > 0);
  const sessionResult = f.registry.resolve(session, { session_summary: "跨轮复用错误数据。", session_problem: [problem(sessionIndex)] },
    { ...emptyAudit(), evidenceBank: sessionPrepared.evidenceBank }) as SessionAttributionResult;
  const selected = sessionResult.session_problem[0]!.evidence[0]!;
  assert.equal(attributionPositionReference(selected.position)!.evidence_id, id);
  assert.equal(selected.quote, result.problem[0]!.evidence[0]!.quote);
  assert.equal(comparisonAttribution(sessionResult).Problem.at(-1)!.evidence[0]!.evidence_id, id);
  assert.deepEqual(source.positions[10], { trace_index: 1, message_index: 3 });
  assert.deepEqual(sessionSource(f.session).raw.messages, source.original.messages);
});

test("key_data preserves duplicate JSON values at distinct exact spans and never serializes a model summary as a quote", () => {
  const f = fixture(), task = f.tasks.find(task => (task.data as JsonObject).compactField === "key_data" && (task.data as JsonObject).traceIndex === 1)!;
  const binding = bindAttribution(task, f.inputs, {}), facts = binding.request.input.facts as JsonObject[];
  const selected = facts.find(fact => (fact.location as JsonObject).field_path === "/rows/1/value")!;
  const selectedId = (((selected.source_evidence as JsonObject[])[0]!.reference) as JsonObject).evidence_id as string;
  const prepared = f.registry.prepare(binding);
  const result = f.registry.resolve(binding, { value: { 自由结构: [{ $evidence: [prepared.evidenceBank.indexOf(selectedId) + 1], 用途: "结论关键数值。" }] } },
    { ...emptyAudit(), evidenceBank: prepared.evidenceBank }) as JsonObject;
  const data = ((result.value as { 自由结构: JsonObject[] }).自由结构[0]!.source_values as JsonObject[])[0]!;
  assert.equal(data.value, 100);
  const entry = (data.source_evidence as JsonObject[])[0]!, id = (entry.reference as { evidence_id: string }).evidence_id;
  const other = facts.find(fact => (fact.location as JsonObject).field_path === "/rows/0/value")!;
  assert.notEqual(id, (((other.source_evidence as JsonObject[])[0]!.reference) as JsonObject).evidence_id);
  const source = attributionSessionSource(f.session, f.candidate.input_id);
  assert.deepEqual(verifiedCompact(data, source.raw, source.original, f.candidate.input_id), data);
  const nested = { key_data: { value: { 自由指标: [data] } } };
  assert.equal(compactSourceEvidence(nested).length, 1, "a flexible object named value must not hide an original reference");
  const wrapped = compactReceipt(2).evaluation as SessionCompact;
  wrapped.turns[1]!.key_data = nested.key_data;
  const traceTask = f.tasks.find(task => task.stage === "attribution-trace" && (task.data as JsonObject).traceIndex === 1)!;
  const traced = f.registry.prepare(bindAttribution(traceTask, f.inputs, { compact: { ...compactReceipt(2), evaluation: wrapped } }));
  assert(traced.evidenceBank.includes(id), "nested compact evidence remains immediately selectable by Attribution");
  const forged = structuredClone(data);
  (forged.source_evidence as JsonObject[])[0]!.quote = "摘要声称100。";
  assert.throws(() => verifiedCompact(forged, source.raw, source.original, f.candidate.input_id), ValidationError);
});

test("key_data selects grouped original values through the same evidence numbers as every other field", () => {
  const f = fixture(), task = f.tasks.find(task => (task.data as JsonObject).compactField === "key_data" && (task.data as JsonObject).traceIndex === 1)!;
  const binding = bindAttribution(task, f.inputs, {}), prepared = f.registry.prepare(binding);
  const facts = (binding.request.input.facts as JsonObject[]).filter(fact =>
    ["/rows/0/value", "/rows/1/value"].includes((fact.location as JsonObject).field_path as string));
  assert.equal(facts.length, 2);
  const ids = facts.map(fact => ((fact.source_evidence as JsonObject[])[0]!.reference as JsonObject).evidence_id as string);
  const indices = ids.map(id => prepared.evidenceBank.indexOf(id) + 1);
  assert(indices.every(index => index > 0), "scalar menus use the original evidence directory, without a second facts.id namespace");
  const audit = { ...emptyAudit(), evidenceBank: prepared.evidenceBank };
  const result = f.registry.resolve(binding, { value: { 自由分组: [{ 用途: "比较两个原始数值。", $evidence: indices }] } }, audit) as JsonObject;
  const group = (result.value as { 自由分组: JsonObject[] }).自由分组[0]!;
  assert.deepEqual((group.source_values as JsonObject[]).map(value => value.value), [100, 100]);
  assert.deepEqual(compactSourceEvidence(group).map(value => (value.reference as JsonObject).evidence_id), ids);
  assert.equal(new Set(ids).size, 2, "equal numbers retain their distinct original positions");
});

test("compact keeps code-owned call counts and distinguishes empty planner output from a real answer", () => {
  const record = { batch_id: "batch", case_id: "counted-calls", meta: {}, messages: [
    { type: "user_question", content: "解释约束。" },
    { type: "llm_turn", name: "planner", output: [{ role: "assistant", content: "```json\n[]\n```" }] },
    ...Array.from({ length: 5 }, (_, index) => [
      { type: "tool_call", name: "web_search", call_id: String(index), input: { query: "约束" } },
      { type: "tool_result", name: "web_search", call_id: String(index), output: "结果" },
    ]).flat(),
    { type: "llm_turn", name: "answer-agent", output: [{ role: "assistant", content: "约束指限制条件。" }] },
    { type: "final_answer", content: "约束指限制条件。" },
  ] };
  const candidate = adapt(record, { id: "a", name: "A", adapter: "b", sources: [] }, "fixture", 1);
  const tasks = planAttributionUnit(candidate).tasks, inputs = { [candidate.input_id]: normalizeInput(record) };
  const task = tasks.find(t => (t.data as JsonObject).compactField === "execution_chain")!;
  const binding = bindAttribution(task, inputs, {}), turn = (binding.modelInput!.turns as JsonObject[])[0]!;
  const facts = turn.execution_facts as { tool_calls: { name: string; count: number }[]; model_outputs: { name: string; output_form: string }[] };
  assert.equal(facts.tool_calls.find(tool => tool.name === "web_search")!.count, 5);
  assert.equal(facts.model_outputs.find(model => model.name === "planner")!.output_form, "empty_json_array");
  assert.equal(facts.model_outputs.find(model => model.name === "answer-agent")!.output_form, "nonempty_text");
  const assembly = tasks.find(t => t.stage === "attribution-compact")!;
  const dependencies = Object.fromEntries(Object.keys(assembly.dependencies).map(key => [key, { ...compactReceipt(1), evaluation: { value: {} } }]));
  const compact = bindAttribution(assembly, inputs, dependencies).computedResult as SessionCompact;
  const stored = compact.turns[0]!.execution_facts as typeof facts;
  assert.deepEqual(stored.tool_calls.map(({ name, count }) => ({ name, count })), facts.tool_calls.map(({ name, count }) => ({ name, count })), "accepted model prose cannot overwrite code-owned call counts");
  assert.deepEqual(stored.model_outputs.map(({ name, output_form }) => ({ name, output_form })),
    facts.model_outputs.map(({ name, output_form }) => ({ name, output_form })));
});

test("turn-local call relations, pool expansion and privacy projection preserve exact leaf citations", () => {
  const f = fixture(), fieldTask = f.tasks.find(task => (task.data as JsonObject).compactField === "execution_chain" && (task.data as JsonObject).traceIndex === 1)!;
  const binding = bindAttribution(fieldTask, f.inputs, {}), prepared = f.registry.prepare(binding);
  const turn = (binding.modelInput!.turns as JsonObject[])[0]!, directory = turn.source_directory as JsonObject[];
  const returned = directory.find(row => row.message_index === 10)!;
  assert.equal(returned.call_message_index, 9, "identical earlier-turn call ids must not capture this return");
  const call = directory.find(row => row.message_index === 9)!;
  assert.equal((call.generated_arguments as JsonObject[])[0]!.model_message_index, 8);
  for (const text of [prepared.prompt, JSON.stringify(binding.request.sources)]) {
    assert(!text.includes("PRIVATE_RULE")); assert(!text.includes("PRIVATE_SKILL")); assert(!text.includes("PRIVATE_OUTER"));
    assert(text.includes("view_skill"));
  }
  assert(JSON.stringify(binding.request.sources).includes("原始安全叶子100。"));
  const source = attributionSessionSource(f.session, f.candidate.input_id), leaf = evidenceSources(source.raw.messages[8])
    .find(item => item.kind === "text" && item.path === "/input_messages/1/content")!;
  const evidence = cite(f.candidate.input_id, 8, leaf, 0, leaf.text.length);
  const navigation = { source_evidence: [{ quote: evidence.quote, reference: { evidence_id: evidence.evidence_id } }] };
  assert.deepEqual(verifiedCompact(navigation, source.raw, source.original, f.candidate.input_id), navigation);
  const parent = selectEvidenceSource(evidenceSources(source.raw.messages[8]), "/input_messages")!;
  const rewritten = cite(f.candidate.input_id, 8, parent.source, parent.start, parent.end);
  assert.throws(() => verifiedCompact({ source_evidence: [{ quote: rewritten.quote, reference: { evidence_id: rewritten.evidence_id } }] },
    source.raw, source.original, f.candidate.input_id), ValidationError);
});

test("Criteria and Comparison bind original multi-turn messages and accepted attribution references instead of synthetic QA sources", async t => {
  const data = fixture(), record = data.record as unknown as RawInput;
  const f = await fixtureConfig([[record], [], [record], []]);
  t.after(() => rm(f.directory, { recursive: true, force: true }));
  const plan = await buildPlan(f.config), task = plan.tasks.find(task => task.stage === "comparison")!;
  const criteria = plan.tasks.find(task => task.stage === "criteria")!;
  const criteriaBinding = bindTask(criteria, plan.inputs, {}, { tasks: plan.tasks });
  const sources = (task.data as TaskData).candidates;
  const dependencies = Object.fromEntries(Object.entries(sources).map(([label, candidate]) => {
    const original = sessionSource(plan.inputs[candidate.input_id] as RawInput).raw;
    const leaf = evidenceSources(original.messages[10]).find(source => source.kind === "text" && source.path === "/output")!;
    const evidence = cite(candidate.input_id, 10, leaf, 0, leaf.text.length);
    const result: SessionAttributionResult = { session_meta: {}, session_summary: "脚本调用失败。", session_problem: [],
      turns: [0, 1].map(turn => ({ meta: {}, summary: "已检查。", is_correct: null, correct_reason: "无标准。", problem: turn ? [{
        ...problem(1), problem_id: "p1", evidence: [{ position: attributionEvidencePosition(1, 3, evidence.evidence_id),
          component: "tool_call: shell", quote: evidence.quote, reason: "原始返回。" }],
      }] : [] })) };
    return [label, { ...compactReceipt(2), taskId: task.dependencies[label]!, evaluation: result }];
  }));
  const binding = bindTask(task, plan.inputs, { ...dependencies,
    criteria: { ...compactReceipt(2), taskId: criteria.id, evaluation: criteriaResult() } }, { tasks: plan.tasks });
  const prepared = new AgentRegistry([comparisonAgent]).prepare(binding);
  validateEvidenceBankSources(prepared.evidenceBank, new Map(Object.values(sources).map(candidate =>
    [candidate.input_id, sessionSource(plan.inputs[candidate.input_id] as RawInput).raw])));
  for (const [label, candidate] of Object.entries(sources)) {
    const original = sessionSource(plan.inputs[candidate.input_id] as RawInput);
    assert.deepEqual((binding.request.sources[label]!.value as RawInput).messages[10], original.raw.messages[10]);
    assert.equal((criteriaBinding.request.sources[label]!.value as RawInput).messages.length, 14);
    const material = (binding.request.input.candidates as Record<string, JsonObject>)[label]!;
    assert.deepEqual(material.final_message_indices, [6, 13]);
    assert.deepEqual(material.source_positions, original.positions);
    assert(prepared.evidenceBank.some(id => {
      const point = parseEvidenceCoordinates(id);
      return point?.input_id === candidate.input_id && point.message_index === 10;
    }));
    assert(binding.presentedReads!.some(read => read.candidate === label && read.message_index === 10));
  }
  assert(!prepared.prompt.includes("PRIVATE_RULE"));
  assert(!prepared.prompt.includes("PRIVATE_SKILL"));
  assert(!prepared.prompt.includes("PRIVATE_OUTER"));
  assert(!prepared.prompt.includes('"evidence_id":"p1:'));
  const verification = { ...task, id: "verify-source-chain", dependencies: { ...task.dependencies, draft: task.id },
    data: { ...task.data as TaskData, verificationAudit: true, verificationOf: { taskId: task.id } } };
  const check = bindTask(verification, plan.inputs, { ...dependencies,
    criteria: { ...compactReceipt(2), taskId: criteria.id, evaluation: criteriaResult() },
    draft: { ...compactReceipt(2), taskId: task.id, evaluation: comparisonResult() },
  }, { tasks: [...plan.tasks, verification] });
  const checked = new AgentRegistry([comparisonAgent]).prepare(check);
  assert(check.inspectionInput, "optional verification retains the same original source catalogue");
  const secondaryBank = [...checked.evidenceBank];
  check.projectModelInput!(check.inspectionInput, secondaryBank);
  assert(secondaryBank.some(id => parseEvidenceCoordinates(id)?.message_index === 10),
    "nonempty accepted findings retain their original tool quote during verification preparation");
  validateEvidenceBankSources(secondaryBank, new Map(Object.values(sources).map(candidate =>
    [candidate.input_id, sessionSource(plan.inputs[candidate.input_id] as RawInput).raw])));
});
