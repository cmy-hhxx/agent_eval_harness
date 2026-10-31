import test from "node:test";
import assert from "node:assert/strict";
import { AgentRegistry } from "@eval/host";
import { attributionAgent } from "@eval/agents/attribution";
import { compactAgent } from "@eval/agents/compact";
import { cite, evidenceSources, parseEvidenceCoordinates } from "@eval/tools";
import { ValidationError } from "@eval/contracts";
import { adapt } from "../inputs/records.js";
import { processMaterial } from "../review/process-material.js";
import { attributionTrace } from "../review/public-trace.js";
import { bindAttribution, planAttributionUnit, attributionWorkflow } from "./index.js";
import { compactReceipt, sourceCompactReceipt, componentDraft, componentTask } from "../../../../tests/fixtures/compact.js";
import { emptyAudit } from "../../../../tests/fixtures/comparison.js";

function fixture() {
  const raw = { batch_id: "batch", case_id: "process", messages: [
    { type: "user_question", content: "查询本期营收。" },
    { type: "llm_turn", name: "llm-call-7", parent_span: "plan", system_prompt: "PRIVATE_SYSTEM_SENTINEL", output: "先查询上期营收。" },
    { type: "tool_call", name: "new-data-tool", call_id: "1", parent_span: "plan", input: { period: "上期" } },
    { type: "tool_result", name: "new-data-tool", call_id: "1", output: "营收为100亿元。" },
    { type: "final_answer", content: "本期营收100亿元。" },
  ] };
  const candidate = adapt(raw, { id: "answer", name: "Answer", adapter: "b", sources: [] }, "fixture", 1);
  const tasks = planAttributionUnit(candidate).tasks, inputs = { [candidate.input_id]: raw };
  const registry = new AgentRegistry([compactAgent, attributionAgent]);
  return { raw, candidate, tasks, inputs, registry, get compact() {
    return sourceCompactReceipt(candidate, raw);
  } };
}
test("anonymous planning receives related tool receipts and binds its responsibility without a selector", () => {
  const f = fixture(), task = componentTask(f.candidate, f.compact, "规划");
  const binding = bindAttribution(task, f.inputs, { compact: f.compact }), prepared = f.registry.prepare(binding);
  assert(!prepared.prompt.includes("PRIVATE_SYSTEM_SENTINEL"));
  assert(prepared.prompt.includes("new-data-tool"));
  assert(!prepared.prompt.includes("session_overview"));
  const index = prepared.evidenceBank.findIndex(id => parseEvidenceCoordinates(id)?.message_index === 1) + 1;
  const problem = { label: "查询期间错误", definition: "请求期间偏离用户要求。",
    problem_phenomena: "用户问本期，实际查上期。", reason: "参数来自可见规划。", severity: "P1", severity_reason: "关键数据期间错误。",
    evidence: [{ index, reason: "规划明确查询上期。" }] };
  const audit = { ...emptyAudit(), evidenceBank: prepared.evidenceBank };
  const draft = componentDraft([problem]);
  const result = f.registry.resolve(binding, draft, audit) as { problem?: { component: string }[]; turns?: { problem: { component: string }[] }[] };
  f.registry.validate(binding, result, audit);
  assert.equal((result.problem ?? result.turns![0]!.problem)[0]!.component, "规划");
  assert(!("actor_index" in (result.problem ?? result.turns![0]!.problem)[0]!));
  assert(!("component_reviews" in result), "component checks are transient submission data");
  assert.throws(() => f.registry.resolve(binding, { ...draft, problems: [{ ...problem, tool_error_indices: [], component: "llm-call-7" }] }, audit), ValidationError);
  assert.throws(() => f.registry.resolve(binding, { ...draft, problems: [{ ...problem, tool_error_indices: [], evidence: [{ index: 999, reason: "不存在。" }] }] }, audit), ValidationError);
});
test("privacy projection placeholders cannot become original execution failure evidence", () => {
  const f = fixture(), task = componentTask(f.candidate, f.compact, "规划");
  const binding = bindAttribution(task, f.inputs, { compact: f.compact });
  const publicRaw = binding.request.sources.answer.value as typeof f.raw;
  const source = evidenceSources(publicRaw.messages[1]).find(source => source.path === "/system_prompt")!;
  const id = cite(f.candidate.input_id, 1, source, 0, source.text.length).evidence_id;
  const receipt = { ...compactReceipt(), taskId: task.id, submitted: { evidence: [], tool_error_reviews: [], problems: [{ evidence: [{ index: 1 }] }] },
    evaluation: { problem: [{ evidence: [{ quote: source.text }] }] }, audit: { ...emptyAudit(), evidenceBank: [id] } };
  assert.throws(() => attributionWorkflow.advance!(task, receipt, {} as never, f.inputs), ValidationError);
  const reviewed = { ...receipt, submitted: { tool_error_reviews: [], problems: [], content: "不把裁剪后的规范父对象当原文。", evidence: [1] }, evaluation: { problem: [] } };
  assert.throws(() => attributionWorkflow.advance!(task, reviewed, {} as never, f.inputs), error =>
    error instanceof ValidationError && error.issues!.some(issue => issue.path === "/evidence/0"));
});

for (const length of [650, 1000]) test(`a ${length}-character quote offers valid short selections before result-schema validation`, () => {
  const f = fixture();
  f.raw.messages[3]!.output = "连续原文。".repeat(length).slice(0, length);
  const task = componentTask(f.candidate, f.compact, "规划"), binding = bindAttribution(task, f.inputs, { compact: f.compact });
  const prepared = f.registry.prepare(binding), source = evidenceSources((binding.request.sources.answer.value as typeof f.raw).messages[3])
    .find(item => item.kind === "text" && item.path === "/output")!;
  const bank = [...prepared.evidenceBank, cite(f.candidate.input_id, 3, source, 0, length).evidence_id];
  const audit = { ...emptyAudit(), evidenceBank: bank, traceReads: [{ candidate: "answer", message_index: 3,
    kind: "text" as const, path: "/output", start: 0, end: length }] };
  const draft = componentDraft([{ label: "返回解读错误", definition: "误读原始返回。",
    problem_phenomena: "误读返回数据。", reason: "原文与解释不符。", severity: "P2", severity_reason: "局部解读偏差。",
    evidence: [{ index: bank.length, reason: "原始返回。" }, { index: bank.length, reason: "同一原文的另一个判断。" }] }]);
  let replacement = 0;
  assert.throws(() => f.registry.resolve(binding, draft, audit), error => {
    if (!(error instanceof ValidationError)) return false;
    assert.equal(error.issues!.length, 2, "one rejection reports all overlong selections without spending a repair on each");
    const issue = error.issues![0]!, expected = issue.expected as { validation_limit: number; suggested_evidence: { evidence_index: number; quote: string }[] };
    assert.equal(issue.code, "quote_too_long"); assert.equal(expected.validation_limit, 400);
    assert(expected.suggested_evidence.every(item => item.quote.length <= 400));
    replacement = expected.suggested_evidence[0]!.evidence_index;
    return true;
  });
  assert.equal(draft.problems[0]!.evidence[0]!.index, prepared.evidenceBank.length + 1, "rejection never silently crops the selected quote");
  draft.problems[0]!.evidence[0]!.index = replacement;
  draft.problems[0]!.evidence[1]!.index = replacement;
  const result = f.registry.resolve(binding, draft, audit);
  f.registry.validate(binding, result, audit);
});
test("long process material is bounded across messages and preserves exact numerical payloads and continuation coordinates", () => {
  const f = fixture();
  f.raw.messages[3]!.output = "开始" + "数字与口径。".repeat(10000) + "结束100.25亿元";
  const raw = attributionTrace(f.raw);
  const material = processMaterial(raw, f.raw, f.candidate.input_id, "answer", 1600);
  assert(material.process_evidence.reduce((sum, item) => sum + item.quote.length, 0) <= 1600);
  assert(material.process_evidence.some(item => item.quote.includes("100.25亿元")));
  assert.equal(material.source_directory[3]!.call_message_index, 2);
  assert.equal(material.process_evidence.some(item => item.quote.includes("PRIVATE_SYSTEM_SENTINEL")), false);
  assert(material.process_evidence.some(item => item.partial && item.read_request.message_index === 3));
});

test("process excerpts retain numeric-only and mixed table results rather than dropping their numerical values", () => {
  const f = fixture();
  for (const output of [{ rows: [{ revenue: 100.25, ratio: 0.125 }] }, { rows: [{ period: "2024年", revenue: 100.25 }] }]) {
    const raw = { messages: [{ type: "tool_result", output }] };
    const material = processMaterial(raw, raw, f.candidate.input_id, "answer");
    assert(material.process_evidence.some(item => item.quote.includes("100.25")));
    assert(material.process_evidence.every(item => item.quote.length <= 400));
  }
});

test("key_data sees only final claims and never the tool's original values or units", () => {
  const f = fixture(); f.raw.messages[3]!.output = 'TOOL_ONLY_SENTINEL: revenue=24630, unit=USD millions';
  f.raw.messages[4]!.content = 'FDX CY2026 revenue was $24.63B; CY2027 consensus EPS $20.86.';
  const task = f.tasks.find(task => (task.data as { compactField?: string }).compactField === "key_data")!;
  const prepared = f.registry.prepare(bindAttribution(task, f.inputs, {}));
  assert(!prepared.prompt.includes("TOOL_ONLY_SENTINEL")); assert(!prepared.prompt.includes("24630"));
  assert(!prepared.prompt.includes('"facts":')); assert(prepared.prompt.includes("$24.63B"));
  assert(prepared.evidenceBank.every(id => parseEvidenceCoordinates(id)?.message_index === 4));
});

test("key_data receives conclusion context beyond the short overview and compact retains display coverage", () => {
  const f = fixture(), text = "开头。" + "过程说明。".repeat(400) + "结论依赖的指标为10.7亿元。";
  f.raw.messages[4]!.content = text;
  f.raw.messages[3]!.output = "完整工具返回。".repeat(600);
  const field = (name: string) => f.tasks.find(t => t.stage === "attribution-compact-field" && (t.data as { compactField: string }).compactField === name)!;
  const keyData = bindAttribution(field("key_data"), f.inputs, {}).modelInput!.turns as any[];
  assert.equal(keyData[0].final_evidence.map((entry: any) => entry.quote).join(""), text);
  assert.equal(keyData[0].final_context.partial, false);
  const execution = bindAttribution(field("execution_chain"), f.inputs, {}).modelInput!.turns as any[];
  assert.equal(execution[0].final_context, undefined, "process extraction does not consume final-answer statements");
  assert(execution[0].process_excerpts.some((entry: any) => entry.partial === true && entry.total_chars > entry.quote.length));
});

test("process-only fields cannot reconstruct execution from a final answer or its captured generation", () => {
  const f = fixture(), claim = "FINAL_ONLY_CLAIM：文件已经生成且校验通过。";
  f.raw.messages[4]!.content = claim;
  f.raw.messages[1]!.output = claim;
  (f.raw.messages[1] as Record<string, unknown>).input_messages = [{ role: "user", content: "查询本期营收。" }, { role: "tool", name: "shell", tool_call_id: "guard",
    content: "Tool execution is forbidden: MODEL_INPUT_OBSERVATION：后续执行被禁止。" }];
  f.raw.messages[3]!.output = "原始执行观察：请求被拒绝，未创建资源。";
  for (const name of ["plans", "reasoning_chain", "execution_chain", "reflections", "tool_errors"]) {
    const task = f.tasks.find(task => (task.data as { compactField?: string }).compactField === name)!;
    const prepared = f.registry.prepare(bindAttribution(task, f.inputs, {}));
    assert(!prepared.prompt.includes(claim), `${name} must not consume delivery statements as process evidence`);
    if (["execution_chain", "tool_errors", "components"].includes(name)) {
      if (name !== "tool_errors") assert(prepared.prompt.includes("请求被拒绝"));
      else assert(!prepared.prompt.includes("请求被拒绝"), "a business rejection without execution-error evidence is not a tool_error");
      assert(prepared.prompt.includes("MODEL_INPUT_OBSERVATION"), "actual tool observations stay in tool-oriented fields");
    } else assert(!prepared.prompt.includes("请求被拒绝"), "model-only fields cannot repeat tool returns as reasoning or plans");
  }
  const answerTask = f.tasks.find(task => (task.data as { compactField?: string }).compactField === "session_overview")!;
  assert(f.registry.prepare(bindAttribution(answerTask, f.inputs, {})).prompt.includes(claim));
});

test("each received turn keeps its process and numeric budget without renumbering source messages", () => {
  const observation = "前置说明。".repeat(35) + "目标执行观察：参数被拒绝，尚未创建资源。" + "后续说明。".repeat(35);
  const metric = "Revenue Growth Year-on-Year [2026-09-30]";
  const first = [{ type: "user_question", content: "前一轮任务。" },
    ...Array.from({ length: 250 }, () => ({ type: "llm_turn", output: { noise: 123 } })),
    { type: "final_answer", content: "前一轮结论。" }];
  const second = [{ type: "user_question", content: "当前轮任务。" },
    { type: "tool_result", name: "service", output: observation },
    { type: "tool_result", name: "service", output: { [metric]: "001.50" } },
    { type: "final_answer", content: "原回答称任务完成。" }];
  const raw = { batch_id: "batch", case_id: "scoped", meta: {}, traces: [{ meta: {}, messages: first }, { meta: {}, messages: second }] };
  const candidate = adapt(raw, { id: "answer", name: "Answer", adapter: "b", sources: [] }, "fixture", 1);
  const tasks = planAttributionUnit(candidate).tasks, inputs = { [candidate.input_id]: raw };
  const field = (name: string) => tasks.find(task => (task.data as {compactField?:string;traceIndex?:number}).compactField === name &&
    (task.data as {traceIndex?:number}).traceIndex === 1)!;
  const execution = bindAttribution(field("execution_chain"), inputs, {}).modelInput!.turns as any[];
  assert(execution[0].process_excerpts.some((entry: any) => entry.quote.includes("目标执行观察：参数被拒绝")));
  const keyData = bindAttribution(field("key_data"), inputs, {}).modelInput!;
  assert.equal(keyData.facts, undefined);
  assert(!JSON.stringify(keyData).includes("001.50"), "key_data must not copy a tool value absent from the final answer");
  assert(JSON.stringify(keyData).includes("原回答称任务完成"));
});


test("reasoning and tool execution consume distinct original roles rather than repeating structured plans", () => {
  const f = fixture();
  f.raw.messages[1]!.output = '[{"type":"finquery","content":"查询本期营收。"}]';
  (f.raw.messages[1] as Record<string, unknown>).reasoning_content = "需要本期口径，不能用上期数值代替。";
  const field = (name: string) => f.tasks.find(task => (task.data as { compactField?: string }).compactField === name)!;
  const reasoning = bindAttribution(field("reasoning_chain"), f.inputs, {}).modelInput!.turns as { process_excerpts: {quote:string}[] }[];
  assert(reasoning[0]!.process_excerpts.some(entry => entry.quote.includes("不能用上期数值")));
  assert(!reasoning[0]!.process_excerpts.some(entry => entry.quote.includes('"type":"finquery"') || entry.quote.includes("营收为100")));
  const execution = bindAttribution(field("execution_chain"), f.inputs, {}).modelInput!.turns as { process_excerpts: {message_index:number;quote:string}[] }[];
  assert(execution[0]!.process_excerpts.every(entry => [2, 3].includes(entry.message_index)));
  assert(execution[0]!.process_excerpts.some(entry => entry.quote.includes("营收为100")));
});

test("components retain script identity navigation when a long command has no complete short sentence", () => {
  const f = fixture();
  (f.raw.messages[2] as Record<string, unknown>).input = {
    command: "printf '%s' '" + "前置环境参数 ".repeat(120) + "' && python /opt/skills-aime/finquery.py query '" + "后续参数 ".repeat(120) + "'",
  };
  const task = f.tasks.find(task => (task.data as { compactField?: string }).compactField === "components")!;
  const binding = bindAttribution(task, f.inputs, {}), prepared = f.registry.prepare(binding);
  const excerpt = (binding.modelInput!.recorded_components as { source_evidence: {quote:string;reference:{evidence_id:string}}[] }[])
    .flatMap(actor => actor.source_evidence).find(entry => entry.quote.includes("/opt/skills-aime/finquery.py"));
  assert(excerpt, "the real script remains in the source directory without manufacturing a clipped action summary");
  assert(excerpt.quote.length <= 400);
  assert(prepared.evidenceBank.includes(excerpt.reference.evidence_id));
});
