import test from "node:test";
import assert from "node:assert/strict";
import { parseEvidenceCoordinates, resolveEvidence } from "@eval/tools";
import { emptyAudit } from "../../../../tests/fixtures/comparison.js";
import { traceOverview } from "./trace-overview.js";

const id = "296439d0-d228-45fc-8c5e-35f42990547e";
test("GPT tool spans retain output coordinates without promoting reasoning metadata or thinking to tool evidence", () => {
  const raw = { messages: [
    { type: "span", name: "reasoning", duration: 165200 },
    { type: "span", name: "thinking", output: "内部思考" },
    { type: "span", name: "tool-web-search", output: "搜索来源原文", start: 100, end: 200 },
  ] };
  const before = structuredClone(raw), overview = traceOverview(raw, "answer", id);
  assert.equal(overview.entries.length, 1);
  const entry = overview.entries[0];
  assert.equal(entry.message_index, 2);
  assert.equal(entry.kind, "return");
  assert.equal(entry.name, "tool-web-search");
  assert.equal(entry.call_message_index, undefined);
  const highlight = entry.highlights[0];
  assert.equal(highlight.path, "/output");
  assert.equal(resolveEvidence(raw, highlight.reference, "answer", emptyAudit(), "/evidence", id).quote, "搜索来源原文");
  assert.deepEqual(raw, before);
});

test("overview completes compact results before spending space on long call prefixes", () => {
  const result = "计算参数与结果\n" + "背景说明。".repeat(40) + "\n下期阈值：27.42；本期阈值：26.18。";
  const raw = { messages: [
    { type: "tool_call", arguments: "代码前缀。".repeat(400) },
    { type: "tool_result", output: result },
  ] };
  const overview = traceOverview(raw, "answer", id, 2400);
  const highlight = overview.entries[1]!.highlights[0]!;
  assert.equal(highlight.quote, result);
  assert.equal(highlight.has_more, false);
  assert(!Object.hasOwn(highlight, "read_request"));
  assert(JSON.stringify(overview).length <= 2400);
});
test("overview scans every return field and long tails without repeating history or treating signals as verdicts", () => {
  const raw = { messages: [
    { type: "tool_call", name: "Calc", arguments: "price.shift(0)", input_messages: [{ content: "HIDDEN_HISTORY".repeat(1000) }] },
    { type: "function_call_output", output: [{ text: "normal table\n".repeat(2000) },
      { text: "traceback context\n".repeat(500) + "AttributeError: scalar has no shift" }], isError: true },
    { type: "tool_call", name: "Calc", arguments: "price" },
    { type: "function_call_output", output: "16.55" },
  ] };
  const before = structuredClone(raw), overview = traceOverview(raw, "answer", id);
  assert.equal(overview.entries.length, 4);
  const returned = overview.entries[1]!;
  assert.equal(returned.text_fields, 2);
  assert(returned.highlights.some(item => item.path === "/output/1/text" && item.anomaly && item.quote.includes("AttributeError")));
  assert.deepEqual(returned.signals, [{ path: "/isError", value: true }]);
  assert(!JSON.stringify(overview).includes("HIDDEN_HISTORY"));
  assert(!Object.hasOwn(returned, "success"));
  assert.equal(overview.entries[3]!.highlights[0]!.has_more, false);
  assert(!Object.hasOwn(overview.entries[3]!.highlights[0]!, "read_request"), "complete short results do not invite another read");
  for (const entry of overview.entries) for (const item of entry.highlights) {
    assert.equal(parseEvidenceCoordinates(item.reference.evidence_id)!.message_index, entry.message_index);
    assert.equal(resolveEvidence(raw, item.reference, "answer", emptyAudit(), "/evidence", id).quote, item.quote);
  }
  assert.deepEqual(raw, before);
});

test("normal return previews expose useful text before transport identifiers", () => {
  const overview = traceOverview({ messages: [{ type: "tool_result", output: { items: [
    { ref: "ref_1", id: "opaque-id", uid: "opaque-uid", type: "text", title: "实际新闻标题", text: "监管口径已实施", extra: "未展示的其他原文" },
  ] } }] }, "answer", id);
  assert.deepEqual(overview.entries[0]!.highlights.map(item => item.quote), ["实际新闻标题", "监管口径已实施"]);
  assert.equal(overview.entries[0]!.omitted_highlights, 1, "unshown normal fields are a real navigation gap");
});

test("overview stays bounded and gives late error signals priority with explicit coverage gaps", () => {
  const raw = { messages: [...Array.from({ length: 80 }, () => ({ type: "tool_result", output: "ordinary result ".repeat(200) })),
    { type: "tool_result", output: [{ text: "ok" }, { text: "ValueError: bad argument" }] }] };
  const overview = traceOverview(raw, "answer", id, 1800);
  assert(JSON.stringify(overview).length <= 1800);
  assert(overview.omitted_entries > 0);
  assert.equal(overview.anomaly_fields, 1);
  assert(overview.entries.some(entry => entry.message_index === 80 && entry.highlights.some(item => item.quote.includes("ValueError"))));
});
test("ordinary mentions of failure do not monopolize the overview or displace later result navigation", () => {
  const messages = Array.from({ length: 6 }, () => ({ type: "tool_result", output: Array.from({ length: 8 }, () => ({
    text: "业务背景与正常结果。".repeat(30) + "失败率是被统计的业务指标。",
  })) }));
  const raw = { messages: [...messages, { type: "tool_result", output: "原值: 部分=12, 总量=80; 比例=15%" }] };
  const overview = traceOverview(raw, "answer", id, 5000);
  assert(JSON.stringify(overview).length <= 5000);
  assert.equal(overview.omitted_entries, 0);
  assert.equal(overview.entries.at(-1)!.highlights[0]!.quote, raw.messages.at(-1)!.output);
  assert(overview.entries.every(entry => entry.diagnostic_fields === 0));
});
test("text wrappers do not consume the only normal preview and typed runtime errors outrank prose mentions", () => {
  const raw = { messages: [{ type: "tool_result", output: [
    { text: "<result>\nID: 12\n" }, { text: "原始结果：部分=12，总量=80" },
    { text: "交易异常和失败率只是研究内容。" }, { text: "ValueError: unsupported argument" }, { text: "</result>" },
  ] }] };
  const overview = traceOverview(raw, "answer", id);
  assert.equal(overview.entries[0]!.highlights[0]!.diagnostic, true);
  assert(overview.entries[0]!.highlights.some(item => item.quote.includes("原始结果")));
  assert(!overview.entries[0]!.highlights.some(item => /<\/?result>/u.test(item.quote)));
});
