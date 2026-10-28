import test from "node:test";
import assert from "node:assert/strict";
import { evidenceId, ValidationError } from "@eval/contracts";
import { AgentRegistry } from "@eval/host";
import { attributionAgent, type SessionAttributionResult, type TraceAttributionResult } from "@eval/agents/attribution";
import { adapt, normalizeInput } from "@eval/workflows/inputs";
import { parseEvidenceCoordinates } from "@eval/tools";
import { emptyAudit } from "../../../../tests/fixtures/comparison.js";
import { bindAttribution, planAttributionUnit } from "./index.js";

function fixture(secondAnswer = "仍然保持10%仓位。") {
  const raw = { batch_id: "batch", case_id: "positions", meta: { session_id: "positions" }, traces: [
    { meta: { trace_id: "first" }, messages: [
      { role: "user", content: [{ text: "我的仓位是10%。" }, { text: "请保持这一前提。" }] },
      { role: "tool", content: "TOOL_NOT_FOR_SESSION" },
      { role: "assistant", content: "按10%仓位分析。" },
    ] },
    { meta: { trace_id: "second" }, messages: [
      { role: "user", content: "我的仓位没有变化，请继续。" },
      { role: "tool", content: "TOOL_NOT_FOR_SESSION" },
      { role: "assistant", content: secondAnswer },
    ] },
  ] };
  const candidate = adapt(raw, { id: "answer", name: "Answer", adapter: "a", sources: [] }, "fixture.jsonl", 1);
  const task = planAttributionUnit(candidate).session;
  const turns: TraceAttributionResult[] = raw.traces.map(trace => ({ meta: trace.meta,
    summary: "仓位评语：10%与70%冲突。", problem: [], is_correct: null, correct_reason: "评测意见。" }));
  const bind = () => bindAttribution(task, { [candidate.input_id]: normalizeInput(raw) }, {
    trace0: { evaluation: turns[0] } as never, trace1: { evaluation: turns[1] } as never,
  });
  return { bind, turns, candidate, registry: new AgentRegistry([attributionAgent]) };
}

test("session model material contains complete ordered QA and is independent of trace opinions", () => {
  const f = fixture(), before = f.bind(), prepared = f.registry.prepare(before);
  assert.equal((before.modelInput!.qa as { question: string }[])[0]!.question, "我的仓位是10%。\n请保持这一前提。");
  assert(!prepared.prompt.includes("仓位评语"));
  assert(!prepared.prompt.includes("TOOL_NOT_FOR_SESSION"));
  assert(prepared.prompt.indexOf("按10%仓位分析") < prepared.prompt.indexOf("仍然保持10%仓位"));
  f.turns[0]!.summary = "完全相反的新评语";
  f.turns[0]!.problem = [{ problem_id: "p1", component: "评测器", label: "评语矛盾", definition: "评语冲突",
    problem_phenomena: "评语互相矛盾", reason: "评测意见，不是原始回答", evidence: [] }];
  f.turns[1]!.is_correct = 0;
  const after = f.bind();
  assert.deepEqual(after.modelInput, before.modelInput);
  assert.equal(f.registry.prepare(after).prompt, prepared.prompt);
  const result = f.registry.resolve(after, { session_summary: "原始QA仓位一致。", session_problem: [] }, emptyAudit()) as SessionAttributionResult;
  assert.deepEqual(result.session_problem, []);
  assert.strictEqual(result.turns[0], f.turns[0]);
  assert.strictEqual(result.turns[1], f.turns[1]);
});

test("session evidence resolves cross-QA contradictions directly to original text and coordinates", () => {
  const f = fixture("你的仓位是70%。"), binding = f.bind(), prepared = f.registry.prepare(binding);
  const indices = [1, 3].map(message => prepared.evidenceBank.findIndex(id => parseEvidenceCoordinates(id)?.message_index === message) + 1);
  const draft = { session_summary: "对同一仓位前后矛盾。", session_problem: [{ label: "仓位前后矛盾", definition: "无条件更新却改变仓位。",
    problem_phenomena: "先称10%，后称70%。", reason: "用户明确说明仓位未变。",
    evidence: indices.map(index => ({ index, reason: "原始回答的仓位陈述。" })) }] };
  const audit = { ...emptyAudit(), evidenceBank: prepared.evidenceBank };
  const result = f.registry.resolve(binding, draft, audit) as SessionAttributionResult;
  f.registry.validate(binding, result, audit);
  assert.deepEqual(result.session_problem[0]!.evidence.map(item => item.quote), ["按10%仓位分析。", "你的仓位是70%。"]);
  assert.deepEqual(result.session_problem[0]!.evidence.map(item => item.position), [
    "trace_index 0 / message_index 2 / path /content", "trace_index 1 / message_index 2 / path /content",
  ]);
  for (const index of [0, -1, 1.5, 999]) {
    const invalid = structuredClone(draft); invalid.session_problem[0]!.evidence[0]!.index = index;
    assert.throws(() => f.registry.resolve(binding, invalid, audit), ValidationError);
  }
  const invalidBank = [...prepared.evidenceBank];
  invalidBank[indices[0]! - 1] = evidenceId(f.candidate.input_id, 1, "text", "/content", 0, 9999);
  assert.throws(() => f.registry.resolve(binding, draft, { ...audit, evidenceBank: invalidBank }), ValidationError);
  const old = structuredClone(draft) as unknown as { session_problem: { evidence: unknown[] }[] };
  old.session_problem[0]!.evidence = [{ trace_index: 0, problem_index: 0, reason: "评语" }];
  assert.throws(() => f.registry.resolve(binding, old, audit), ValidationError);
});

test("session evidence covers long QA without truncating or rewriting the original text", () => {
  const text = "完整原文。".repeat(200), f = fixture(text), binding = f.bind();
  const prepared = f.registry.prepare(binding);
  assert.equal((binding.modelInput!.qa as { answer: string }[])[1]!.answer, text);
  const points = prepared.evidenceBank.map(parseEvidenceCoordinates).filter(point => point?.message_index === 3);
  assert.deepEqual(points.map(point => point && point.kind !== "image" ? [point.start, point.end] : null), [[0, 400], [400, 800], [800, 1000]]);
});
