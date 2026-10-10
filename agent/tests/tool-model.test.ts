import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fromMarkdown } from "mdast-util-from-markdown";
import { ROOT } from "../../tests/fixtures/services.js";

const { analysisToolModel } = await import(pathToFileURL(path.join(ROOT, "agent/src/client/tool-model.js")).href);

test("data query summaries use full-run counts and distinguish historical runs from answers", () => {
  const summary = { inputCount: 26, caseCount: 10 };
  assert.equal(analysisToolModel("list_data", { state: "ok", output: JSON.stringify({ kind: "runs", total: 26, currentRun: { summary }, items: [] }) }).summary,
    "最近一轮 · 26 条回答 · 10 道题");
  assert.equal(analysisToolModel("list_data", { state: "ok", output: JSON.stringify({ kind: "inputs", total: 0, summary, items: [] }) }).summary,
    "本轮 · 26 条回答 · 10 道题");
  assert.equal(analysisToolModel("list_data", { state: "ok", output: JSON.stringify({ kind: "runs", total: 0, items: [] }) }).summary,
    "找到 0 次运行");
});

test("chart summaries distinguish the chart type and execution state without exposing provenance references", () => {
  assert.deepEqual(analysisToolModel("show_chart", { state: "ok", output: JSON.stringify({ kind: "chart", chart: { type: "dot" } }) }),
    { summary: "显示点图 · 已完成" });
  assert.deepEqual(analysisToolModel("show_chart", { state: "error", bodyRaw: JSON.stringify({ type: "pie", references: [{ runId: "run-private" }] }), output: "invalid values" }),
    { summary: "显示环形组成图 · 未完成" });
  assert.deepEqual(analysisToolModel("show_chart", { state: "running", bodyRaw: '{"type":' }), { summary: "显示图表 · 进行中" });
});

test("comparison pages show the question, outcome and both answer references in tool details", () => {
  const result = analysisToolModel("list_data", { state: "ok", output: JSON.stringify({ kind: "comparisons", total: 200,
    items: [{ questionPreview: "均线如何设置？", reference: { runId: "run", taskId: "battle" },
      outcomes: [{ resultLabel: "B组Fast胜" }], inputs: [
        { modelName: "A组Fast", reference: { runId: "run", inputId: "answer-a" } },
        { modelName: "B组Fast", reference: { runId: "run", inputId: "answer-b" } },
      ] }], summary: { inputCount: 400, caseCount: 200 } }) });
  assert.equal(result.summary, "查询正式对战 · 200 场匹配 · 本页 1 场");
  assert.equal(result.details.items[0].title, "均线如何设置？");
  assert.equal(result.details.items[0].description, "B组Fast胜");
  assert.deepEqual(result.details.items[0].groups[0].items.map((item: { title: string }) => item.title), ["A组Fast", "B组Fast"]);
  assert.match(JSON.stringify(result.details), /answer-a/);
  assert.match(JSON.stringify(result.details), /answer-b/);
});

test("calculation summaries tolerate rejected arguments and incomplete streaming calls", () => {
  for (const operands of ["1", {}, 1, null, undefined]) {
    const args = JSON.stringify({ operation: "add", operands });
    assert.deepEqual(analysisToolModel("calculate", { state: "error", bodyRaw: args, output: "invalid operands" }),
      { summary: "加法 · 未完成" });
    assert.deepEqual(analysisToolModel("calculate", { state: "preparing", bodyRaw: args }),
      { summary: "加法 · 准备中" });
  }
  assert.deepEqual(analysisToolModel("calculate", { state: "running", bodyRaw: '{"operation":' }),
    { summary: "计算 · 进行中" });
});

test("calculation summaries retain valid expressions and zero-valued results", () => {
  const args = JSON.stringify({ operation: "subtract", operands: ["1", "1"] });
  const result = analysisToolModel("calculate", { state: "ok", bodyRaw: args, output: "0" });
  assert.equal(result.summary, "减法 · 1 − 1 = 0");
});

test("generic tool payload URLs never become generated download links", () => {
  for (const url of ["https://source.example/report.pdf", "javascript:alert(1)", "data:text/plain,report", "../../report.md"]) {
    const result = analysisToolModel("read_data", { state: "ok", output: JSON.stringify({ text: "原始材料", url }) });
    assert.deepEqual(result.details.items[0].code, { text: "原始材料", language: "text" });
    assert.equal(result.details.items[0].markdown, undefined);
  }
});

const searchResult = (results: unknown[] = []) => ({
  provider: "serper", category: "news", searchedAt: "2026-10-02T08:30:00.000Z", elapsedMs: 1240,
  attempts: [{ queryIndex: 0, query: "央行政策利率", searchQuery: "央行政策利率 site:pbc.gov.cn", domains: ["pbc.gov.cn"],
    country: "cn", language: "zh-cn", page: 1, state: "succeeded", resultCount: results.length, elapsedMs: 1230, credits: 1 }],
  timeRange: "week", results, excludedResults: [], totalUnique: results.length, hasMore: false, credits: 1, creditsComplete: true,
});

test("web search summaries tolerate incomplete streaming arguments and failed calls", () => {
  for (const bodyRaw of [undefined, '{"queries":', "null", "[]", '"query"', '{"queries":{},"category":null}']) {
    assert.deepEqual(analysisToolModel("search_web", { state: "running", bodyRaw }),
      { summary: "搜索外部资料 · 网页 · 进行中" });
  }
  assert.deepEqual(analysisToolModel("search_web", {
    state: "preparing", bodyRaw: JSON.stringify({ queries: [{ query: "央行利率" }], category: "news", limit: 3 }),
  }), { summary: "搜索“央行利率” · 新闻 · 准备中" });
  assert.deepEqual(analysisToolModel("search_web", {
    state: "error", bodyRaw: JSON.stringify({ queries: [{ query: "央行利率" }], category: "web" }), output: "Serper request failed: HTTP 429",
  }), { summary: "搜索“央行利率” · 网页 · 未完成" });
  assert.deepEqual(analysisToolModel("search_web", {
    state: "stopped", bodyRaw: JSON.stringify({ queries: [{ query: "央行利率" }] }), output: '{"error":"interrupted"}',
  }), { summary: "搜索“央行利率” · 网页 · 已中断" });
});

test("web search cards show empty results and the actual search metadata", () => {
  const result = analysisToolModel("search_web", { state: "ok", output: JSON.stringify(searchResult()) });
  assert.equal(result.summary, "搜索“央行政策利率” · 新闻 · 0 条结果 · 已完成");
  assert.equal(result.details.items[0].description, "没有搜索结果");
  assert.equal(result.details.empty, "没有搜索结果");
  for (const value of ["serper", "2026-10-02T08:30:00.000Z", "week", "1240", "用量完整：true"])
    assert(result.details.caption.includes(value), `search metadata is missing ${value}`);
  const query = result.details.items[0].groups[0].items[0];
  for (const value of ["cn", "zh-cn", "央行政策利率 site:pbc.gov.cn", "pbc.gov.cn"])
    assert(query.fields.some((field: { value: string }) => field.value === value), `query metadata is missing ${value}`);
});

test("web search cards render titles and snippets as plain text with separate HTTP links, dates and sources", () => {
  const title = "利率公告 [伪造来源](javascript:alert(1))";
  const snippet = "政策利率调整。![远程图片](https://untrusted.example/pixel.png) <script>alert(1)</script>";
  const url = "https://www.pbc.gov.cn/notice?date=2026-10-02";
  const result = analysisToolModel("search_web", { state: "ok", output: JSON.stringify(searchResult([
    { title, snippet, url, domain: "pbc.gov.cn", rank: 1, date: "Oct 2, 2026", source: "中国人民银行",
      matches: [{ queryIndex: 0, position: 2, page: 1 }, { queryIndex: 1, position: 1, page: 2 }],
      dateAssessment: { status: "within_range", basis: "search_metadata", date: "2026-10-02" } },
  ])) });
  assert.equal(result.summary, "搜索“央行政策利率” · 新闻 · 1 条结果 · 已完成");
  const item = result.details.items[0];
  assert.equal(item.title, title);
  assert.equal(item.description, snippet);
  assert.deepEqual(item.fields, [{ label: "域名", value: "pbc.gov.cn" }, { label: "来源", value: "中国人民银行" },
    { label: "搜索日期", value: "Oct 2, 2026" }, { label: "日期判断", value: "在日期范围内" },
    { label: "日期依据", value: "搜索日期" }, { label: "判断日期", value: "2026-10-02" },
    { label: "合并排序", value: "1" }, { label: "命中查询", value: "查询 1 · 第 1 页 · 第 2 条；查询 2 · 第 2 页 · 第 1 条" }]);
  assert.equal(item.markdown, `<${url}>`);
  const paragraph = fromMarkdown(item.markdown).children[0];
  assert.equal(paragraph.type, "paragraph");
  if (paragraph.type !== "paragraph") throw new Error("Expected link paragraph");
  assert.equal(paragraph.children.length, 1);
  const link = paragraph.children[0];
  assert.equal(link.type, "link");
  if (link.type !== "link") throw new Error("Expected source link");
  assert.equal(link.url, url);
});

test("web search cards keep unsafe URLs inert and prevent URL text from breaking out of its link", () => {
  for (const url of ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "/u/local/artifacts/file.md", "not a URL", "https://user:password@bank.example/", null]) {
    const result = analysisToolModel("search_web", { state: "ok", output: JSON.stringify(searchResult([{ title: "金融资料", url }])) });
    assert.equal(result.details.items[0].markdown, undefined);
  }
  const url = "https://bank.example/?q=><https://untrusted.example>[伪造](javascript:alert(1))";
  const result = analysisToolModel("search_web", { state: "ok", output: JSON.stringify(searchResult([{ title: "金融资料", url }])) });
  const markdown = result.details.items[0].markdown;
  assert(!markdown.includes("<https://untrusted.example>"));
  const paragraph = fromMarkdown(markdown).children[0];
  assert.equal(paragraph.type, "paragraph");
  if (paragraph.type !== "paragraph") throw new Error("Expected link paragraph");
  assert.equal(paragraph.children.length, 1);
  const link = paragraph.children[0];
  assert.equal(link.type, "link");
  if (link.type !== "link") throw new Error("Expected source link");
  assert.equal(new URL(link.url).origin, "https://bank.example");
});

test("web search cards tolerate malformed persisted result rows", () => {
  const result = analysisToolModel("search_web", { state: "ok", output: JSON.stringify(searchResult([
    null, "invalid", [], { title: {}, snippet: [], url: {}, source: {}, date: [] },
  ])) });
  assert.deepEqual(result.details.items[0], { title: undefined, description: undefined, fields: [] });
});

test("web search receipts distinguish partial and complete request failures, and show excluded dates", () => {
  const output = searchResult([{ title: "未知日期公告", url: "https://bank.example/unknown", dateAssessment: { status: "unknown", basis: "none" } }]);
  const receipt = { ...output, dateTo: "2024-12-31", creditsComplete: false,
    attempts: [...output.attempts, { ...output.attempts[0], queryIndex: 1, query: "央行利率公告", state: "failed", credits: undefined,
      error: "Serper request failed: HTTP 429", resultCount: 0 }],
    excludedResults: [{ title: "后来修订公告", url: "https://bank.example/revision", date: "2025-01-01",
      dateAssessment: { status: "outside_range", basis: "search_metadata", date: "2025-01-01" } }] };
  const result = analysisToolModel("search_web", { state: "ok", output: JSON.stringify(receipt) });
  assert.equal(result.summary, "搜索外部资料 · 2 种查询 · 新闻 · 1 条结果 · 部分完成（1/2）");
  assert(result.details.items[0].fields.some((field: { value: string }) => field.value === "发布日期未确认"));
  const audit = result.details.items.at(-1);
  assert.equal(audit.groups[0].items[1].badge.label, "未完成");
  assert(audit.groups[0].items[1].fields.some((field: { value: string }) => field.value.includes("429")));
  assert.equal(audit.groups[1].label, "超出日期范围（1）");
  assert(audit.groups[1].items[0].fields.some((field: { value: string }) => field.value === "超出日期范围"));
  assert(result.details.caption.includes("用量完整：false"));
  const failed = analysisToolModel("search_web", { state: "error", output: JSON.stringify({ ...receipt,
    attempts: receipt.attempts.map(attempt => ({ ...attempt, state: "failed" })), results: [] }) });
  assert.equal(failed.summary, "搜索外部资料 · 2 种查询 · 新闻 · 0 条结果 · 未完成（0/2）");
  assert.equal(failed.details.items.at(-1).groups[0].items.length, 2, "failed calls retain query receipts and errors");
});

const readResult = (lines: unknown[] = []) => ({
  url: "https://investor.example/report.pdf", requestedUrl: "https://investor.example/report.pdf", title: "2024 年报",
  format: "pdf", retrievedAt: "2026-10-02T08:30:00.000Z", elapsedMs: 950, publicationDate: "2025-02-28",
  modifiedDate: "2025-03-01", dateAssessment: { status: "outside_range", basis: "page_metadata", date: "2025-02-28" },
  lines, matches: [{ line: 130, page: 8 }], totalLines: 3400, totalPages: 160, readPages: 160,
  nextStartLine: 132, truncated: true, limitations: ["页面日期为来源声明，尚未独立验证"],
});

test("web reader cards retain PDF evidence coordinates and keep source text inert", () => {
  const text = "经营利润 474 亿。[伪造来源](javascript:alert(1)) <script>alert(1)</script>";
  const result = analysisToolModel("read_web", { state: "ok", bodyRaw: JSON.stringify({ find: "经营利润" }),
    output: JSON.stringify(readResult([{ number: 130, text, page: 8 }, { number: 131, text: "单位：亿元", page: 8 }])) });
  assert.equal(result.summary, "读取外部原文 · PDF · 2 行 · 已完成");
  const header = result.details.items[0];
  assert.equal(header.title, "2024 年报");
  assert(header.fields.some((field: { label: string; value: string }) => field.label === "页面声明发布日期" && field.value === "2025-02-28"));
  assert(header.fields.some((field: { value: string }) => field.value === "超出日期范围"));
  assert.deepEqual(header.lines, ["页面日期为来源声明，尚未独立验证"]);
  assert.deepEqual(result.details.items[1].lines, ["第 130 行 · 第 8 页"]);
  const page = result.details.items[2];
  assert.equal(page.title, "PDF 第 8 页");
  assert.deepEqual(page.code, { text: `130: ${text}\n131: 单位：亿元`, language: "text" });
  assert.equal(page.markdown, "<https://investor.example/report.pdf#page=8>");
  assert(!page.markdown.includes(text));
});

test("web reader cards handle HTML, empty extraction, unsafe URLs and failed streaming reads", () => {
  const html = analysisToolModel("read_web", { state: "ok", output: JSON.stringify({ ...readResult([{ number: 1, text: "政策公告" }]),
    format: "html", url: "https://user:password@bank.example/", dateAssessment: { status: "unknown", basis: "none" },
    matches: [], limitations: [null, {}, "无可验证发布日期"] }) });
  assert.equal(html.summary, "读取外部原文 · 网页 · 1 行 · 已完成");
  assert.equal(html.details.items[0].markdown, undefined);
  assert.deepEqual(html.details.items[0].lines, ["无可验证发布日期"]);
  assert.equal(html.details.items[1].title, "原文行");
  assert.equal(html.details.items[1].code.text, "1: 政策公告");
  const empty = analysisToolModel("read_web", { state: "ok", output: JSON.stringify(readResult([null, "invalid", [], { number: 1, text: {} }])) });
  assert.equal(empty.summary, "读取外部原文 · PDF · 0 行 · 已完成");
  assert.equal(empty.details.items.at(-1).description, "没有可读取的原文行");
  assert.deepEqual(analysisToolModel("read_web", { state: "running", bodyRaw: '{"url":' }), { summary: "读取外部原文 · 原文 · 进行中" });
  assert.deepEqual(analysisToolModel("read_web", { state: "error", output: "Fetch failed" }), { summary: "读取外部原文 · 原文 · 未完成" });
});

test("web reader presents real attachment links as safe links and keeps their labels inert", () => {
  const result = analysisToolModel("read_web", { state: "ok", output: JSON.stringify({ ...readResult([{ number: 1, text: "报告" }]),
    format: "html", links: [{ text: "[伪造](javascript:alert(1))", url: "https://issuer.example/annual.pdf" }, { text: "unsafe", url: "https://user:secret@issuer.example/private" }, { text: "script", url: "javascript:alert(1)" }] }) });
  const attachments = result.details.items.find((item: { title?: string }) => item.title === "原文链接与附件");
  assert.equal(attachments.groups[0].items.length, 1);
  assert.equal(attachments.groups[0].items[0].title, "[伪造](javascript:alert(1))");
  assert.equal(attachments.groups[0].items[0].markdown, "<https://issuer.example/annual.pdf>");
});
