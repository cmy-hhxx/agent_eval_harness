import test from "node:test";
import assert from "node:assert/strict";
import { compactFinalMaterial, compactProcessExcerpts, compactTextRanges } from "./compact-material.js";
import { imagePlaceholder, overlapsImagePlaceholder } from "@eval/contracts";

const id = "11111111-1111-4111-8111-111111111111";
test("source matching requires unchanged text at the same original path", () => {
  const original = { messages: [
    { type: "llm_turn", reasoning: "可移位的原文。", thinking: "保留的原文。", analysis: "原始分析。" },
    { type: "final_answer", content: "完成。" },
  ] };
  const raw = structuredClone(original);
  raw.messages[0]!.reasoning = "被改写的文字。";
  raw.messages[0]!.analysis = "可移位的原文。";
  const excerpts = compactProcessExcerpts("reasoning_chain", raw, original, id, [{ trace_index: 0 }, { trace_index: 0 }], 0, 1);
  assert.deepEqual(excerpts.map(row => row.quote), ["保留的原文。"]);
});

test("large tool receipts do not block material assembly with repeated source scans", () => {
  const raw = { messages: [
    { type: "tool_result", output: { datas: Array.from({ length: 30_000 }, (_, index) => ({ label: `row-${index}`, value: `value-${index}` })) } },
    { type: "final_answer", content: "完成。" },
  ] };
  const started = performance.now();
  const excerpts = compactProcessExcerpts("plans", raw, raw, id, [{ trace_index: 0 }, { trace_index: 0 }], 0, 1);
  const elapsed = performance.now() - started;
  assert.deepEqual(excerpts, []);
  assert(elapsed < 3000, `source matching blocked material assembly for ${Math.round(elapsed)}ms`);
});

test("text evidence never includes or bridges image placeholders", () => {
  const text = JSON.stringify({ before: "原始返回。".repeat(35), image: imagePlaceholder, after: "后续事实。".repeat(60) });
  const ranges = compactTextRanges(text);
  assert(ranges.length > 0);
  assert(ranges.every(range => !overlapsImagePlaceholder(text, range.start, range.end)));
  assert(ranges.some(range => text.slice(range.start, range.end).includes("原始返回。")));
  assert(ranges.some(range => text.slice(range.start, range.end).includes("后续事实。")));
  assert.deepEqual(compactTextRanges("图片：" + imagePlaceholder), []);
  assert(compactTextRanges("正常段落。\n\n" + imagePlaceholder + "\n\n" + "完整段落。".repeat(100))
    .every(range => !overlapsImagePlaceholder("正常段落。\n\n" + imagePlaceholder + "\n\n" + "完整段落。".repeat(100), range.start, range.end)));
});

test("field selection precedes allocation and keeps a complete workbook exception", () => {
  const error = 'Traceback (most recent call last):\n  File "make.py", line 137, in <module>\n    ws.cell(row=rr,column=cc).value=h\nAttributeError: MergedCell object value is read-only';
  const raw = { messages: [
    ...Array.from({ length: 200 }, () => ({ type: "llm_turn", output: "不相关规划。".repeat(100) })),
    { type: "tool_call", name: "shell", input: { command: "python make.py" } },
    { type: "tool_result", name: "shell", output: { exit_code: 1, stderr: error } },
    { type: "final_answer", content: "构建失败。" },
  ] };
  const excerpts = compactProcessExcerpts("tool_errors", raw, raw, id, raw.messages.map(() => ({ trace_index: 0 })), 0, 202, 600);
  assert(excerpts.some(excerpt => excerpt.quote === error));
  assert(!JSON.stringify(excerpts).includes("不相关规划"));
  assert(excerpts.every(excerpt => [200, 201].includes(Number(excerpt.message_index))));
});

test("long text uses complete paragraphs or sentences and never spends the remainder on fragments", () => {
  const paragraph = "完整说明包含期间2026年、金额24.63亿美元以及未经核验的限定词。";
  const text = Array.from({ length: 30 }, () => paragraph).join("\n\n");
  const ranges = compactTextRanges(text);
  assert(ranges.every(range => range.end - range.start <= 400));
  assert(ranges.every(range => text.slice(range.start, range.end).split("\n\n").every(part => part === paragraph)));
  const raw = { messages: [{ type: "final_answer", content: text }] };
  const final = compactFinalMaterial(0, raw, id, 410);
  assert(final.final_context.partial);
  assert(final.final_evidence.every(item => item.quote.endsWith("限定词。")));
  assert.equal(compactFinalMaterial(0, { messages: [{ content: "长而无任何句段边界".repeat(100) }] }, id).final_context.partial, true);
});

test("minified JSON receipts retain complete labelled rows and exact original offsets", () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ ticker: `OCGN-${i}`, period: "2026Q1", field: "Total Revenue (MRQ)", value: 1488000 + i, unit: "USD" }));
  const text = JSON.stringify({ columns: ["ticker", "period", "field", "value", "unit"], datas: rows });
  const ranges = compactTextRanges(text);
  assert(ranges.length > 1);
  assert(ranges.every(range => range.end - range.start <= 400));
  for (const row of rows) assert(ranges.some(range => text.slice(range.start, range.end).includes(JSON.stringify(row))));
});

test("component receipt allocation excludes service prompt scaffolding before preserving actual table fields", () => {
  const raw = { messages: [
    { type: "tool_call", name: "finquery", input: { query: "OCGN revenue TTM" } },
    { type: "tool_result", name: "finquery", output: { QTime: 1, prompt: { placeHolder: Array.from({ length: 100 }, (_, i) => ({ key: `menu-${i}`, value: "UNRELATED_MENU_SENTINEL 候选股票与模板，不是实际回执。" })) },
      columns: [{ key: "Total Revenue (MRQ)", unit: "USD" }], datas: [{ ticker: "OCGN", period: "2026Q1", "Total Revenue (MRQ)": 1488000 }], status_code: 0 } },
    { type: "final_answer", content: "TTM revenue $1.5M。" },
  ] };
  const excerpts = compactProcessExcerpts("component_investigation", raw, raw, id, raw.messages.map(() => ({ trace_index: 0 })), 0, 2, 800, new Set([1]));
  const text = JSON.stringify(excerpts);
  for (const value of ["Total Revenue (MRQ)", "2026Q1", "1488000", "USD"]) assert(text.includes(value));
  assert(!text.includes("UNRELATED_PROMPT_SENTINEL"));
  assert(!text.includes("UNRELATED_MENU_SENTINEL"));
});
