import test from "node:test";
import assert from "node:assert/strict";
import { raw, sessionRaw } from "../../../../tests/fixtures/comparison.js";
import { normalizeInput, normalizeTraceInput } from "./normalize.js";
import { adapt } from "./records.js";
import { originalAnswerUsage } from "../comparison/experience.js";
import { answerTurnContexts, normativeSources, originalUserTimestamp } from "@eval/tools";

const version = { id: "independent", name: "Independent", adapter: "a", sources: [] };

function pooledTrace() {
  const pool = [{ role: "system", content: "核对数据。" }, { role: "user", content: "收入是多少？" },
    { role: "tool", content: "收入 42 亿元。" }];
  const tools = [{ type: "function", function: { name: "finquery", parameters: { type: "object" } } }];
  const messages = [{ type: "user_question", content: "收入是多少？" },
    { type: "llm_turn", input_messages: { messages: [pool[0], pool[1]], tools, extra: "keep" }, output: [] },
    { type: "llm_turn", input_messages: [pool[0], pool[1], pool[2]], output: [{ role: "assistant", content: "42 亿元。" }] },
    { type: "final_answer", content: "42 亿元。" }];
  const slim = { messages: messages.map((message, index) => index === 1
    ? { ...message, input_messages: { messages: [0, 1], tools: 0, extra: "keep" } }
    : index === 2 ? { ...message, input_messages: [0, 1, 2] } : message), message_pool: pool, tool_sets: [tools] };
  return { messages, slim };
}

test("slim message pools restore exact evidence paths and share repeated snapshots without changing the source", () => {
  const { messages, slim } = pooledTrace(), before = structuredClone(slim);
  const flat = normalizeInput(slim);
  assert.deepEqual(flat.messages, messages);
  assert.equal(JSON.stringify(flat.messages), JSON.stringify(messages), "JSON parent offsets and property order must survive expansion");
  assert.equal(Object.hasOwn(flat, "message_pool"), false);
  assert.equal(Object.hasOwn(flat, "tool_sets"), false);
  const first = flat.messages[1].input_messages as { messages: unknown[] }, second = flat.messages[2].input_messages as unknown[];
  assert.equal(first.messages[0], second[0], "shared messages are not deep-copied for every model turn");
  const source = { case_id: "pooled", meta: {}, traces: [{ ...slim, meta: { trace_id: "first" } },
    { messages, meta: { trace_id: "second" } }] };
  for (const index of [0, 1]) assert.deepEqual(normalizeTraceInput(source, index).messages, messages);
  assert.deepEqual(slim, before);
  assert.deepEqual(normalizeInput(flat), flat);
  const contexts = answerTurnContexts(flat);
  assert.deepEqual(contexts, answerTurnContexts({ messages }));
});

test("slim input rejects dangling, fractional and malformed references instead of losing evidence", () => {
  for (const reference of [-1, 3, 1.5, "0", null, {}]) {
    const { slim } = pooledTrace();
    slim.messages[2].input_messages = [reference] as never;
    assert.throws(() => normalizeInput(slim), /message_pool/u);
  }
  const { slim } = pooledTrace();
  (slim.messages[1].input_messages as { tools: number }).tools = 2;
  assert.throws(() => normalizeInput(slim), /tool_sets/u);
  assert.throws(() => normalizeInput({ messages: slim.messages, message_pool: {} }), /message_pool/u);
});

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
    assert.equal(record.trace_id, "session-trace");
    assert.equal(record.turns?.[0].trace_id, "trace-q1");
    assert.equal(record.llm, "session-model");
    assert.equal(record.answer_timing.finish_seconds, 1.2);
    const openai = { ...source, traces: [{ ...source.traces[0], messages: raw().messages }] };
    assert.equal(adapt(openai, { ...version, adapter }, "fixture", 1, "batch").final_index, 1);
  }
  const material = normalizeInput(source);
  assert.equal(material.messages, source.traces[0].messages);
  assert.equal(material.request_time, undefined, "trace timestamp is not a request timestamp");
  assert.equal(originalUserTimestamp(material), null);
  assert.equal(originalAnswerUsage(normalizeTraceInput(material, 0)).total_tokens, 30, "trace usage overrides session totals in the trace view");
  assert.equal(material.turns?.length, 1, "session turn directory stays addressable");
  assert.equal(material.turns?.[0]?.messages, source.traces[0].messages);
  assert.deepEqual(source.traces, before.traces, "source content and message indices stay intact");
  const plain = raw();
  assert.equal(normalizeInput(plain), plain, "current flat inputs pass through unchanged");
});

test("session inputs preserve every valid trace and reject ambiguous or incomplete rounds", () => {
  const source = sessionRaw();
  for (const traces of [null, {}, [], [null],
    [{ ...source.traces[0], messages: [] }], [{ ...source.traces[0], messages: [null] }]])
    assert.throws(() => normalizeInput({ ...source, traces }));
  assert.throws(() => normalizeInput({ ...source, messages: raw().messages }), /同时包含/);
  assert.throws(() => normalizeInput({ ...source, meta: { ...source.meta, n_traces: 2 } }), /n_traces/);
  assert.throws(() => normalizeInput({ ...source, meta: { ...source.meta, n_messages: "2" } }), /n_messages/);
  assert.throws(() => normalizeInput({ ...source, traces: [{ ...source.traces[0],
    meta: { ...source.traces[0].meta, session_id: "another" } }] }), /session_id.*冲突/);
  assert.throws(() => normalizeInput({ ...source, case_id: "outer", traces: [{ ...source.traces[0],
    meta: { ...source.traces[0].meta, case_id: "inner" } }] }), /case_id.*冲突/);
  assert.throws(() => adapt({ ...source, meta: { ...source.meta, ok: false } }, version, "fixture", 1, "batch"), /采集失败/);
  assert.throws(() => adapt({ ...source, traces: [{ ...source.traces[0],
    meta: { ...source.traces[0].meta, ok: false } }] }, version, "fixture", 1, "batch"), /采集失败/);
  assert.throws(() => adapt({ ...source, traces: [{ ...source.traces[0], messages: [source.traces[0].messages[0],
    { type: "llm_turn", role: "assistant", content: "unfinished" }] }] }, version, "fixture", 1, "batch"), /完整最终回答/);
  const second = structuredClone(source.traces[0]!) as typeof source.traces[number];
  second.meta = { ...second.meta!, trace_id: "trace-q2", n_messages: 2 };
  second.messages = [
    { type: "user_question", content: "计算3+3" },
    { type: "final_answer", content: "3+3=6" },
  ];
  const multiple = normalizeInput({ ...source, meta: { ...source.meta, n_traces: 2, n_messages: 4 },
    traces: [source.traces[0], second] });
  assert.equal(multiple.turns?.length, 2);
  assert.deepEqual(multiple.turns?.map(trace => trace.messages.length), [2, 2]);
  const record = adapt({ ...source, meta: { ...source.meta, n_traces: 2, n_messages: 4 },
    traces: [source.traces[0], second] }, version, "fixture", 1, "batch");
  assert.equal(record.turns?.length, 2);
  assert.deepEqual(record.turns?.map(trace => trace.question), ["计算2+2", "计算3+3"]);
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
