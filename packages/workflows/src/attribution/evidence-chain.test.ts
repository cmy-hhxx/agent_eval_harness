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
import { compactReceipt, sourceCompactReceipt, componentTask, componentDraft, memberIndex } from "../../../../tests/fixtures/compact.js";
import { verifiedCompact } from "../review/evidence-presentation.js";
import { attributionSessionSource } from "../review/public-trace.js";
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
      { type: "tool_result", name: "view_skill", call_id: "skill", output: '<skill_content name="finance">LOADED_SKILL_BODY</skill_content>' },
      { type: "final_answer", content: "当期收入100。" },
    ] }));
  const raw = { batch_id: "batch", case_id: "evidence-chain", meta: {}, traces }, session = normalizeInput(raw);
  const candidate = adapt(raw, { id: "a", name: "A", adapter: "b", sources: [] }, "fixture", 1);
  return { candidate, session, record: raw, inputs: { [candidate.input_id]: session }, tasks: planAttributionUnit(candidate).tasks,
    registry: new AgentRegistry([compactAgent, attributionAgent]) };
}
const problem = (index: number) => ({ label: "脚本路径错误", definition: "启动命令使用不存在的路径。",
  problem_phenomena: "规划 Agent 通过 shell 调用 finquery.py 失败。", reason: "请求、脚本返回共同定位到失败动作。",
  severity: "P1" as const, severity_reason: "没有取得结论所需数据。", evidence: [{ index, reason: "原始脚本返回。" }] });

test("component findings merge in fixed directory order and survive trace/session summarization", () => {
  const f = fixture(), receipt = sourceCompactReceipt(f.candidate, f.session);
  const task = componentTask(f.candidate, receipt, f.inputs, "planner-finquery", 1);
  const binding = bindAttribution(task, f.inputs, { compact: receipt }), prepared = f.registry.prepare(binding);
  const index = prepared.evidenceBank.findIndex(id => parseEvidenceCoordinates(id)?.message_index === 10) + 1;
  assert(index > 0);
  const draft = componentDraft([problem(index)], memberIndex(binding.request.input.components as JsonObject[], "planner-finquery"));
  const audit = { ...emptyAudit(), evidenceBank: prepared.evidenceBank };
  const component = f.registry.resolve(binding, draft, audit) as { problem: JsonObject[] };
  assert.equal(component.problem[0]!.component, "planner-finquery");
  attributionWorkflow.advance!(task, { ...receipt, evaluation: component, submitted: draft, audit }, {} as never, f.inputs);
  const traceTask = f.tasks.find(task => task.stage === "attribution-trace" && (task.data as JsonObject).traceIndex === 1)!;
  const trace = bindAttribution(traceTask, f.inputs, { compact: receipt,
    [`group:${(task.data as JsonObject).componentGroup}`]: { ...receipt, evaluation: component } });
  const reviewed = f.registry.resolve(trace, { summary: "规划请求偏差影响取数。" }, emptyAudit()) as TraceAttributionResult;
  assert.deepEqual(reviewed.problem, component.problem);
  assert(reviewed.summary.startsWith("评测覆盖不完整"));
  const session = bindAttribution(f.tasks.find(task => task.stage === "attribution-session")!, f.inputs, {
    compact: receipt, trace0: { ...receipt, evaluation: reviewed }, trace1: { ...receipt, evaluation: reviewed } });
  const combined = f.registry.resolve(session, { session_summary: "保留逐轮具体责任。", session_problem: [] }, emptyAudit()) as SessionAttributionResult;
  assert.deepEqual(combined.turns[1]!.problem, component.problem);
});

test("Compact original spans flow through component investigation and code-merged formal evidence", () => {
  const f = fixture(), source = attributionSessionSource(f.session);
  const fieldTask = f.tasks.find(task => (task.data as JsonObject).compactField === "execution_chain" && (task.data as JsonObject).traceIndex === 1)!;
  const field = bindAttribution(fieldTask, f.inputs, {}), prepared = f.registry.prepare(field);
  const id = prepared.evidenceBank.find(id => { const point = parseEvidenceCoordinates(id);
    return point?.kind === "text" && point.message_index === 10 && point.path === "/output"; })!;
  assert(id);
  const value = f.registry.resolve(field, { value: [{ content: "脚本返回路径不存在。", evidence: [prepared.evidenceBank.indexOf(id) + 1] }] },
    { ...emptyAudit(), evidenceBank: prepared.evidenceBank }) as JsonObject;
  const receipt = sourceCompactReceipt(f.candidate, f.session);
  (receipt.evaluation as SessionCompact).turns[1]!.execution_chain = value.value;
  const task = componentTask(f.candidate, receipt, f.inputs, "finquery.py", 1), binding = bindAttribution(task, f.inputs, { compact: receipt });
  const investigation = f.registry.prepare(binding), index = investigation.evidenceBank.indexOf(id) + 1;
  assert(index > 0, "original spans are immediately selectable without citing Compact prose");
  validateEvidenceBankSources(investigation.evidenceBank, new Map([[f.candidate.input_id, source.original]]));
  const audit = { ...emptyAudit(), evidenceBank: investigation.evidenceBank };
  const draft = componentDraft([problem(index)], memberIndex(binding.request.input.components as JsonObject[], "finquery.py"));
  const component = f.registry.resolve(binding, draft, audit) as { problem: { evidence: { position: string; quote: string }[] }[] };
  f.registry.validate(binding, component, audit);
  const proof = component.problem[0]!.evidence[0]!;
  assert.equal(attributionPositionReference(proof.position)!.evidence_id, id);
  assert.equal(evidenceMessageIndex(proof.position), 10);
  assert.equal(proof.quote, resolveEvidence(source.original, { evidence_id: id }, "answer", audit, "/", f.candidate.input_id).quote);
  assert.deepEqual(source.positions[10], { trace_index: 1, message_index: 3 });
  attributionWorkflow.advance!(task, { ...receipt, evaluation: component, submitted: draft, audit }, {} as never, f.inputs);
});

test("key_data copies final claims and reaches component review without reformatting numeric bytes", () => {
  const f = fixture(), task = f.tasks.find(task => (task.data as JsonObject).compactField === "key_data" && (task.data as JsonObject).traceIndex === 1)!;
  const binding = bindAttribution(task, f.inputs, {}), prepared = f.registry.prepare(binding);
  const ids = prepared.evidenceBank.filter(id => { const point = parseEvidenceCoordinates(id);
    return point?.kind === "text" && point.message_index === 13 && point.path === "/content"; });
  assert.equal(ids.length, 1);
  const result = f.registry.resolve(binding, { value: [{ evidence: ids.map(id => prepared.evidenceBank.indexOf(id) + 1) }] },
    { ...emptyAudit(), evidenceBank: prepared.evidenceBank }) as JsonObject;
  const entries = result.value as JsonObject[];
  assert.equal(entries[0]!.key_data_content, "当期收入100。");
  const source = attributionSessionSource(f.session);
  assert.deepEqual(verifiedCompact(entries, source.raw, source.original, f.candidate.input_id), entries);
  const receipt = sourceCompactReceipt(f.candidate, f.session);
  (receipt.evaluation as SessionCompact).turns[1]!.key_data = entries;
  // The original final output owns the claim; a planning call is not treated as its generator.
  const component = componentTask(f.candidate, receipt, f.inputs, "答案合成·取值", 1);
  const reviewed = f.registry.prepare(bindAttribution(component, f.inputs, { compact: receipt }));
  assert(ids.every(id => reviewed.evidenceBank.includes(id)));
  const forged = structuredClone(entries); (forged[0]!.evidence as JsonObject[])[0]!.quote = "摘要声称100。";
  assert.throws(() => verifiedCompact(forged, source.raw, source.original, f.candidate.input_id), ValidationError);
});

test("compact overview uses code-owned call counts while field input distinguishes empty planner output", () => {
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
  assert.equal(facts.model_outputs, undefined, "tool execution extraction does not repeat model-output bookkeeping");
  const assembly = tasks.find(t => t.stage === "attribution-compact")!;
  const dependencies = Object.fromEntries(Object.keys(assembly.dependencies).map(key => [key, { ...compactReceipt(1), evaluation: { value: key.includes(":") ? [] : ["用户询问约束。", "模型解释约束。"] } }]));
  const compact = bindAttribution(assembly, inputs, dependencies).computedResult as SessionCompact;
  assert(compact.session_overview[1]!.includes("web_search 5 次"));
  assert(compact.session_overview[1]!.includes("实际工具报错 0 次"));
  assert.equal(compact.turns[0]!.final_answer, "约束指限制条件。");
  assert.equal(compact.turns[0]!.execution_facts, undefined);

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
    assert(!text.includes("PRIVATE_RULE")); assert(!text.includes("PRIVATE_OUTER"));
    assert(text.includes("view_skill"));
  }
  assert(JSON.stringify(binding.request.sources).includes("原始安全叶子100。"));
  assert(JSON.stringify(binding.request.sources).includes("LOADED_SKILL_BODY"));
  const source = attributionSessionSource(f.session), leaf = evidenceSources(source.raw.messages[8])
    .find(item => item.kind === "text" && item.path === "/input_messages/1/content")!;
  const evidence = cite(f.candidate.input_id, 8, leaf, 0, leaf.text.length);
  const navigation = { evidence: [{ quote: evidence.quote, evidence_id: evidence.evidence_id }] };
  assert.deepEqual(verifiedCompact(navigation, source.raw, source.original, f.candidate.input_id), navigation);
  const parent = selectEvidenceSource(evidenceSources(source.raw.messages[8]), "/input_messages")!;
  const rewritten = cite(f.candidate.input_id, 8, parent.source, parent.start, parent.end);
  assert.throws(() => verifiedCompact({ evidence: [{ quote: rewritten.quote, evidence_id: rewritten.evidence_id }] },
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
    const description = problem(1);
    const result: SessionAttributionResult = { session_meta: {}, session_summary: "脚本调用失败。", session_problem: [],
      turns: [0, 1].map(turn => ({ meta: {}, summary: "已检查。", is_correct: null, correct_reason: "无标准。", problem: turn ? [{
        ...description, component: "planner-finquery", component_family: "finquery", component_role: "planning" as const,
        evidence: [{ position: attributionEvidencePosition(1, 3, evidence.evidence_id),
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
  assert(prepared.prompt.includes("LOADED_SKILL_BODY"));
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
