import test from "node:test";
import assert from "node:assert/strict";
import { raw, sessionRaw } from "../../../../tests/fixtures/comparison.js";
import { normalizeInput } from "./normalize.js";
import { adapt } from "./records.js";
import { originalAnswerUsage } from "../comparison/experience.js";
import { answerTurnContexts, normativeSources, originalUserTimestamp } from "@eval/tools";

const version = { id: "independent", name: "Independent", adapter: "a", sources: [] };

test("a single trace without timing uses explicit session milliseconds without replacing trace values", () => {
  const source = sessionRaw();
  const trace = source.traces[0].meta as Record<string, unknown>;
  Object.assign(source.meta, { first_token_time_cost: 593, finish_answer_time_cost: 14931 });
  delete trace.first_token_time_cost;
  delete trace.finish_answer_time_cost;
  assert.equal(adapt(source, version, "fixture", 1, "batch").answer_timing.first_token_seconds, .593);
  assert.equal(adapt(source, version, "fixture", 1, "batch").answer_timing.finish_seconds, 14.931);
  trace.finish_answer_time_cost = 1200;
  assert.equal(adapt(source, version, "fixture", 1, "batch").answer_timing.finish_seconds, 1.2);
  trace.finish_answer_time_cost = null;
  assert.equal(adapt(source, version, "fixture", 1, "batch").answer_timing.finish_seconds, null);
});

test("single-trace input selects its message format independently of the configured model adapter", () => {
  const source = sessionRaw(), before = structuredClone(source);
  Object.assign(source.meta, { usage: { input_tokens: 999 }, model: "session-agent", trace_id: "session-trace" });
  for (const adapter of ["a", "b"]) {
    const record = adapt(source, { ...version, adapter }, "fixture", 1, "batch");
    assert.equal(record.batch_id, "batch");
    assert.equal(record.case_id, "q1");
    assert.equal(record.final_index, 1);
    assert.equal(record.question, "计算2+2");
    assert.equal(record.reference, "4");
    assert.equal(record.trace_id, "trace-q1");
    assert.equal(record.llm, "session-model");
    assert.equal(record.answer_timing.finish_seconds, 1.2);
    const openai = { ...source, traces: [{ ...source.traces[0], messages: raw().messages }] };
    assert.equal(adapt(openai, { ...version, adapter }, "fixture", 1, "batch").final_index, 1);
  }
  const material = normalizeInput(source);
  assert.equal(material.messages, source.traces[0].messages);
  assert.equal(material.request_time, undefined, "trace timestamp is not a request timestamp");
  assert.equal(originalUserTimestamp(material), null);
  assert.equal(originalAnswerUsage(material).total_tokens, 30, "trace usage overrides session totals");
  assert(!Object.hasOwn(material, "traces"), "material contains only one copy of the messages");
  assert.deepEqual(source.traces, before.traces, "source content and message indices stay intact");
  const plain = raw();
  assert.equal(normalizeInput(plain), plain, "current flat inputs pass through unchanged");
});

test("session inputs reject ambiguous, incomplete and multiple traces without choosing a round", () => {
  const source = sessionRaw();
  for (const traces of [null, {}, [], [null], [source.traces[0], source.traces[0]],
    [{ ...source.traces[0], messages: [] }], [{ ...source.traces[0], messages: [null] }]])
    assert.throws(() => normalizeInput({ ...source, traces }));
  assert.throws(() => normalizeInput({ ...source, messages: raw().messages }), /同时包含/);
  assert.throws(() => normalizeInput({ ...source, meta: { ...source.meta, n_traces: 2 } }), /n_traces/);
  assert.throws(() => normalizeInput({ ...source, meta: { ...source.meta, n_messages: "2" } }), /n_messages/);
  assert.throws(() => normalizeInput({ ...source, traces: [{ ...source.traces[0],
    meta: { ...source.traces[0].meta, session_id: "another" } }] }), /session_id.*冲突/);
  assert.throws(() => normalizeInput({ ...source, case_id: "outer", traces: [{ ...source.traces[0],
    meta: { ...source.traces[0].meta, case_id: "inner" } }] }), /case_id.*冲突/);
  assert.throws(() => adapt({ meta: {}, traces: [{ ...source.traces[0],
    meta: { ...source.traces[0].meta, case_id: "inner" } }] }, version, "fixture", 1, "batch"), /case_id/);
  assert.throws(() => adapt({ ...source, meta: { ...source.meta, ok: false } }, version, "fixture", 1, "batch"), /采集失败/);
  assert.throws(() => adapt({ ...source, traces: [{ ...source.traces[0],
    meta: { ...source.traces[0].meta, ok: false } }] }, version, "fixture", 1, "batch"), /采集失败/);
  assert.throws(() => adapt({ ...source, traces: [{ ...source.traces[0], messages: [source.traces[0].messages[0],
    { type: "llm_turn", role: "assistant", content: "unfinished" }] }] }, version, "fixture", 1, "batch"), /完整最终回答/);
});

test("type-only question and final markers preserve governing context, timestamps and exact evidence", () => {
  const source = sessionRaw(), timestamp = "2026-10-14T10:00:00+08:00";
  const messages = [
    { type: "user_question", content: "计算2+2", timestamp },
    { type: "llm_turn", input_messages: [{ role: "system", content: "说明计算结果。" }],
      output: [{ role: "assistant", content: "2+2=4" }] },
    { type: "final_answer", content: "2+2=4" },
  ];
  const material = normalizeInput({ ...source, meta: { ...source.meta, n_messages: 3 },
    traces: [{ meta: { ...source.traces[0].meta, n_messages: 3 }, messages }] });
  assert.equal(originalUserTimestamp(material), timestamp);
  assert.deepEqual(answerTurnContexts(material), [{ message_index: 1, path: "/input_messages" }]);
  const norms = normativeSources(material, "11111111-1111-4111-8111-111111111111");
  assert.deepEqual(norms.map(norm => norm.role), ["user", "system"]);
  assert.equal(norms[1].evidence[0].message_index, 1);
  assert.equal(norms[1].evidence[0].quote, "说明计算结果。");
  assert.equal(material.messages, messages);
});
