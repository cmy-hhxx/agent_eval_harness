import { bindAttributionFixture as bindAttribution, componentTask, componentDraft, memberIndex, sourceCompactReceipt } from "../../../../tests/fixtures/compact.js";
import test from "node:test";
import assert from "node:assert/strict";
import { evidenceId, ValidationError, type JsonObject } from "@eval/contracts";
import { AgentRegistry } from "@eval/host";
import { attributionAgent, type SessionAttributionResult, type TraceAttributionResult } from "@eval/agents/attribution";
import { adapt, normalizeInput } from "@eval/workflows/inputs";
import { parseEvidenceCoordinates } from "@eval/tools";
import { emptyAudit } from "../../../../tests/fixtures/comparison.js";
import { planAttributionUnit } from "./index.js";

function fixture(secondAnswer = "仍然保持10%仓位。") {
  const raw = { batch_id: "batch", case_id: "positions", meta: { session_id: "positions" }, traces: [
    { meta: { trace_id: "first" }, messages: [
      { role: "user", content: [{ text: "我的仓位是10%。" }, { text: "请保持这一前提。" }] },
      { role: "tool", content: "TOOL_NOT_FOR_SESSION" }, { role: "assistant", content: "按10%仓位分析。" }] },
    { meta: { trace_id: "second" }, messages: [
      { role: "user", content: "我的仓位没有变化，请继续。" },
      { role: "tool", content: "TOOL_NOT_FOR_SESSION" }, { role: "assistant", content: secondAnswer }] },
  ] };
  const candidate = adapt(raw, { id: "answer", name: "Answer", adapter: "a", sources: [] }, "fixture.jsonl", 1);
  const task = planAttributionUnit(candidate).session;
  const turns: TraceAttributionResult[] = raw.traces.map(trace => ({ meta: trace.meta,
    summary: "仓位评语：10%与70%冲突。", problem: [], is_correct: null, correct_reason: "评测意见。" }));
  const bind = () => bindAttribution(task, { [candidate.input_id]: normalizeInput(raw) }, {
    trace0: { evaluation: turns[0] } as never, trace1: { evaluation: turns[1] } as never });
  return { bind, turns, candidate, registry: new AgentRegistry([attributionAgent]) };
}

test("session receives ordered trace findings and original QA without unrelated tool noise", () => {
  const f = fixture(), binding = f.bind(), prepared = f.registry.prepare(binding);
  const qa = binding.modelInput!.qa as { question: { quote: string }[] }[];
  assert.equal(qa[0]!.question.map(item => item.quote).join("\n"), "我的仓位是10%。\n请保持这一前提。");
  assert(prepared.prompt.includes("仓位评语")); assert(!prepared.prompt.includes("TOOL_NOT_FOR_SESSION"));
  assert(prepared.prompt.indexOf("按10%仓位分析") < prepared.prompt.indexOf("仍然保持10%仓位"));
  const result = f.registry.resolve(binding, { session_summary: "仓位保持一致。", session_problem: [] }, { ...emptyAudit(), evidenceBank: prepared.evidenceBank }) as SessionAttributionResult;
  assert.deepEqual(result.session_problem, []); assert.strictEqual(result.turns[0], f.turns[0]); assert.strictEqual(result.turns[1], f.turns[1]);
});

test("cross-turn findings require original evidence from both turns and retain native coordinates", () => {
  const f = fixture("你的仓位是70%。"), binding = f.bind(), prepared = f.registry.prepare(binding);
  const indices = [2, 5].map(message => prepared.evidenceBank.findIndex(id => parseEvidenceCoordinates(id)?.message_index === message) + 1);
  assert(indices.every(index => index > 0));
  const actor = (binding.request.input.components as JsonObject[]).find(actor => actor.name === "答案合成")!;
  const draft = { session_summary: "同一仓位前后矛盾。", session_problem: [{ actor_index: actor.component_index,
    label: "仓位前后矛盾", definition: "无条件更新却改变仓位。", problem_phenomena: "先称10%，后称70%。",
    reason: "用户说明仓位未变。", severity: "P1", severity_reason: "需重新确认仓位后使用分析。",
    evidence: indices.map(index => ({ index, reason: "原始回答的仓位陈述。" })) }] };
  const audit = { ...emptyAudit(), evidenceBank: prepared.evidenceBank };
  const result = f.registry.resolve(binding, draft, audit) as SessionAttributionResult; f.registry.validate(binding, result, audit);
  assert.equal(result.session_problem[0]!.component, actor.name);
  assert.equal(result.session_problem[0]!.component_family, "answer_synthesis");
  assert.equal(result.session_problem[0]!.component_role, "delivery");
  assert.deepEqual(result.session_problem[0]!.evidence.map(item => item.quote), ["按10%仓位分析。", "你的仓位是70%。"]);
  assert(result.session_problem[0]!.evidence[1]!.position.startsWith("trace_index 1 / message_index 2 /"));
  for (const index of [0, -1, 1.5, 999]) {
    const invalid = structuredClone(draft); invalid.session_problem[0]!.evidence[0]!.index = index;
    assert.throws(() => f.registry.resolve(binding, invalid, audit), ValidationError);
  }
  const oneTurn = structuredClone(draft); oneTurn.session_problem[0]!.evidence = [oneTurn.session_problem[0]!.evidence[1]!];
  assert.throws(() => f.registry.resolve(binding, oneTurn, audit), /至少两个/);
  const invalidBank = [...prepared.evidenceBank]; invalidBank[indices[0]! - 1] = evidenceId(f.candidate.input_id, 1, "text", "/content", 0, 9999);
  assert.throws(() => f.registry.resolve(binding, draft, { ...audit, evidenceBank: invalidBank }), ValidationError);
});

test("light session review preserves complete sentences and has original continuation entrypoints", () => {
  const text = "完整原文。".repeat(200), f = fixture(text), binding = f.bind();
  const qa = (binding.modelInput!.qa as { answer: { quote: string }[]; read_request: { message_index: number } }[])[1]!;
  assert.equal(qa.answer.map(entry => entry.quote).join(""), text);
  assert(qa.answer.every(entry => entry.quote.length <= 400)); assert.equal(qa.read_request.message_index, 5);
});

for (const [shape, content, path, quote] of [
  ["form", [{ header: "错误类型", selected: ["分隔符错误"] }, { header: "粘贴条件", selected: ["合并单元格"] }], "/content/1/selected/0", "合并单元格"],
  ["query", { datajson: '{"task":{"entity_code":"000001"}}', contentConfigComefrom: "174", query: "查看业绩" }, "/content/query", "查看业绩"],
] as const) test(`structured ${shape} component input preserves unchanged user leaf coordinates`, () => {
  const raw = { batch_id: "batch", case_id: "form", messages: [{ role: "user", content }, { role: "assistant", content: "按这两项条件检查。" }] }, original = structuredClone(raw);
  const candidate = adapt(raw, { id: "answer", name: "Answer", adapter: "a", sources: [] }, "fixture", 1);
  const receipt = sourceCompactReceipt(candidate, normalizeInput(raw));
  const inputs = { [candidate.input_id]: raw }, binding = bindAttribution(componentTask(candidate, receipt, inputs, "答案合成·取值"), inputs, { compact: receipt });
  const registry = new AgentRegistry([attributionAgent]), prepared = registry.prepare(binding);
  assert.equal(((binding.request.sources.answer.value as { messages: Record<string, unknown>[] }).messages[1]!).type, "final_answer");
  assert.deepEqual(raw, original);
  const index = prepared.evidenceBank.findIndex(id => { const point = parseEvidenceCoordinates(id);
    return point?.kind === "text" && point.message_index === 0 && point.path === path; }) + 1;
  assert(index > 0);
  const draft = componentDraft([{ label: "条件遗漏", definition: "遗漏已确认条件。", problem_phenomena: "忽略选择条件。", reason: "用户已选择。",
    severity: "P2", severity_reason: "需要补充检查。", evidence: [{ index, reason: "原始选择。" }] }], memberIndex(binding.request.input.components as JsonObject[], "答案合成·取值"));
  const audit = { ...emptyAudit(), evidenceBank: prepared.evidenceBank };
  const result = registry.resolve(binding, draft, audit) as { problem: { evidence: { quote: string; position: string }[] }[] };
  registry.validate(binding, result, audit); assert.equal(result.problem[0]!.evidence[0]!.quote, quote);
  const forged = [...prepared.evidenceBank]; forged[index - 1] = evidenceId(candidate.input_id, 0, "text", path, 0, 9999);
  assert.throws(() => registry.resolve(binding, draft, { ...audit, evidenceBank: forged }), ValidationError);
});
