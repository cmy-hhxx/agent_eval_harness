import test from "node:test";
import assert from "node:assert/strict";
import { analysisTraceMap } from "../review/analysis.js";

test("case maps link id-less source spans only by a unique tool name and recorded completion time", () => {
  const call = (name: string, end: string, extra = {}) => ({ type: "tool_call", name, end, ...extra });
  const result = (name: string, end: string, extra = {}) => ({ type: "tool_result", name, end, ...extra });
  const nodes = analysisTraceMap({ messages: [
    call("shell", "t1"), call("search", "t2"), result("search", "t2"), result("shell", "t1"),
    call("shell", "ambiguous"), call("shell", "ambiguous"), result("shell", "ambiguous"),
    call("shell", "duplicate"), result("shell", "duplicate"), result("shell", "duplicate"),
    result("shell", "before"), call("shell", "before"),
    call("shell", "explicit", { call_id: "a" }), result("shell", "explicit", { call_id: "missing" }),
    call("shell", ""), result("shell", ""),
    call("shell", "mixed"), call("shell", "mixed", { call_id: "known" }), result("shell", "mixed"),
  ] }, { runId: "run", inputId: "input" }, 16).nodes;
  assert.equal(nodes[2].callMessageIndex, 1);
  assert.equal(nodes[3].callMessageIndex, 0, "parallel execution is not linked by adjacency");
  for (const i of [6, 8, 9, 10, 13, 15, 18]) assert.equal(nodes[i].callMessageIndex, undefined);
});

test("case maps expose direct answer and tool coordinates without copied model input history", () => {
  const reference = { runId: "run", inputId: "input" };
  const map = analysisTraceMap({ messages: [
    { role: "user", type: "message", content: "问题" },
    { type: "llm_turn", input_messages: [{ content: "PRIVATE_HISTORY".repeat(10000) }], output: [{ content: "中间推理正文" }] },
    { type: "function_call", call_id: "call", name: "Search", arguments: '{"query":"目标问题"}' },
    { type: "function_call_output", call_id: "call", output: "Error: unavailable" },
    { type: "tool_result", name: "shell", output: "工具正文".repeat(10000) },
    { type: "final_answer", role: "assistant", content: "最终回答" },
  ] }, reference, 5);
  assert.equal(map.finalMessageIndex, 5);
  assert.equal(map.toolCalls, 1);
  assert.equal(map.nodes[3].name, "Search");
  assert.equal(map.nodes[3].callMessageIndex, 2);
  assert.equal(map.nodes[3].preview, "Error: unavailable");
  assert.equal(map.nodes[4].callMessageIndex, undefined, "missing linkage is not guessed from adjacency");
  assert.equal(map.nodes[4].preview?.length, 160);
  assert.equal(map.nodes[4].previewTruncated, true);
  assert.deepEqual(map.nodes[5].reference, { ...reference, messageIndex: 5 });
  assert.doesNotMatch(JSON.stringify(map), /PRIVATE_HISTORY|中间推理正文|最终回答/);
  assert(JSON.stringify(map).length < 3000);
});

test("display previews expand to 2000 characters while model maps stay compact", () => {
  const raw = { messages: [{ type: "function_call_output", output: "证据正文".repeat(1000) }] };
  const ref = { runId: "run", inputId: "input" };
  const display = analysisTraceMap(raw, ref, 1, "user").nodes[0];
  assert.equal(display.preview?.length, 2000);
  assert.equal(display.previewTruncated, true);
  assert.equal(analysisTraceMap(raw, ref, 1).nodes[0].preview?.length, 160);
  assert.equal(analysisTraceMap({ messages: [{ type: "tool_result", output: "完整" }] }, ref, 1, "user").nodes[0].previewTruncated, false);
});

test("model call previews expose the recorded intent ahead of long command wrappers without changing source previews", () => {
  const input = { command: "python /long/path/".repeat(20), description: "核对目标公司9:30至10:00区间涨跌幅", timeout: 10 };
  const raw = { messages: [{ type: "tool_call", name: "shell", input }] };
  const ref = { runId: "run", inputId: "input" };
  const node = analysisTraceMap(raw, ref, 1).nodes[0];
  assert(node.preview?.startsWith(input.description + "\n"));
  assert.equal(node.preview?.length, 160);
  assert.equal(node.previewTruncated, true);
  assert.equal(analysisTraceMap(raw, ref, 1, "user").nodes[0].preview, JSON.stringify(input));
});

test("display maps expose recorded reasoning summaries and request output without input history", () => {
  const raw = { messages: [
    { type: "reasoning", summary: [{ type: "summary_text", text: "原始条件仅命中3只，不足要求的8只。" }] },
    { type: "reasoning", content: [{ type: "text", text: "核对板块和分时条件。" }] },
    { type: "reasoning", summary: [], encrypted_content: "ENCRYPTED", id: "reasoning-id" },
    { type: "llm_turn", input_messages: [{ content: "PRIVATE_HISTORY" }], output: [{ role: "assistant", content: null, tool_calls: [{ function: { name: "Search", arguments: "{}" } }] }] },
    { type: "message", role: "system", content: [{ type: "text", text: "系统要求" }] },
  ] };
  const reference = { runId: "run", inputId: "input" };
  const nodes = analysisTraceMap(raw, reference, 5, "user").nodes;
  assert.equal(nodes[0].preview, "原始条件仅命中3只，不足要求的8只。");
  assert.equal(nodes[0].previewKind, "summary");
  assert.equal(nodes[1].preview, "核对板块和分时条件。");
  assert.equal(nodes[2].preview, undefined);
  assert.match(nodes[3].preview!, /Search/);
  assert.equal(nodes[4].preview, "系统要求");
  assert.doesNotMatch(JSON.stringify(nodes), /PRIVATE_HISTORY|ENCRYPTED|reasoning-id/);
  assert(analysisTraceMap(raw, reference, 5).nodes.every(node => node.preview === undefined), "display expansion never inflates model material");
});

test("display reasoning uses the complete recorded body before its summary, with no preview truncation", () => {
  const body = "完整推理原文。".repeat(1000), summary = "只有源摘要。".repeat(1000);
  const raw = { messages: [
    { type: "reasoning", content: [{ type: "reasoning_text", text: body }], summary: [{ type: "summary_text", text: "短摘要" }] },
    { type: "reasoning", summary: [{ type: "summary_text", text: summary }] },
  ] };
  const reference = { runId: "run", inputId: "input" };
  const nodes = analysisTraceMap(raw, reference, 2, "user").nodes;
  assert.equal(nodes[0].preview, body);
  assert.equal(nodes[0].previewKind, undefined);
  assert.equal(nodes[0].previewTruncated, false);
  assert.equal(nodes[1].preview, summary);
  assert.equal(nodes[1].previewKind, "summary");
  assert.equal(nodes[1].previewTruncated, false);
  assert(analysisTraceMap(raw, reference, 2).nodes.every(node => node.preview === undefined));
});
