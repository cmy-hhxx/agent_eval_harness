import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fromMarkdown } from "mdast-util-from-markdown";
import { ROOT } from "../../tests/fixtures/services.js";

const { analysisToolModel } = await import(pathToFileURL(path.join(ROOT, "agent/src/client/tool-model.js")).href);

test("asset inspection exposes the original page and saved coordinates", () => {
  const reference = { collectionId: "1_aime/0_daily_eval", assetId: "cluster/cluster_tree.jsonl" };
  const model = analysisToolModel("read_asset", { state: "ok", output: JSON.stringify({ name: "cluster_tree.jsonl", reference, text: "真实原文", offset: 8 }) });
  assert.equal(model.details.items[0].code.text, "真实原文");
  assert(model.details.items[0].fields.some((field: { label: string; value: string }) => field.label === "资产" && field.value === reference.assetId));
  const saved = analysisToolModel("read_asset", { state: "ok", output: JSON.stringify({ sourceRead: { tool: "read_asset", args: { reference, offset: 8 } } }) });
  assert(saved.details.items[0].title.includes(reference.assetId));
  assert(!JSON.stringify(saved).includes("真实原文"));
});

test("batched search displays a compact query count while retaining the complete result", () => {
  const output = { queries: [{ query: "PCB", total: 2 }, { query: "铜缆", total: 1 }], total: 3, matches: [] };
  const model = analysisToolModel("search_data", { state: "ok", bodyRaw: JSON.stringify({ query: ["PCB", "铜缆"] }), output: JSON.stringify(output) });
  assert.equal(model.summary, "搜索 2 个关键词 · 3 处匹配");
});

test("batch evidence details distinguish missing, partial and complete nodes without repeating quotes", () => {
  const reference = { collectionId: "0_wencai/0_daily_eval", runId: "run", inputId: "input" };
  const items = [
    { reference: { ...reference, messageIndex: 3 }, text: "已读内容", evidence: [{ evidence_id: "source-3", quote: "已读内容" }], hasMore: true, nextOffset: 2000 },
    { reference: { ...reference, messageIndex: 7 }, text: "完整内容", hasMore: false, nextOffset: null },
    { reference: { ...reference, messageIndex: 99 }, error: "Message index out of range" },
  ];
  const model = analysisToolModel("read_evidence", { state: "ok", output: JSON.stringify({ kind: "evidence", items }) });
  assert.equal(model.summary, "批量读取证据 · 读取 2/3 个节点 · 部分完成");
  assert.deepEqual(model.details.items.map((item: { badge: { label: string } }) => item.badge.label), ["尚有后文", "已完整读取", "读取失败"]);
  assert(model.details.items[0].fields.some((field: { label: string; value: string }) => field.label === "下一页" && field.value === "2000"));
  assert.equal(model.details.items[0].groups[0].items[0].title, "source-3");
  assert.equal(JSON.stringify(model.details).split("已读内容").length - 1, 1);
  assert.equal(model.details.items[2].description, items[2].error);
  const failure = analysisToolModel("read_evidence", { state: "error", output: JSON.stringify({ kind: "evidence", items: [items[2]] }) });
  assert.match(failure.summary, /未完成/);
  assert.equal(failure.details.items[0].description, items[2].error);
  const tail = analysisToolModel("read_evidence", { state: "ok", output: JSON.stringify({ kind: "evidence", items: [{ ...items[1], offset: 2000 }] }) });
  assert.equal(tail.details.items[0].badge.label, "已读至结尾", "the last page alone is not the complete message");
});

test("case details show each answer with an independently expandable trace map", () => {
  const output = { kind: "case", question: "用户想比较什么", answers: [{ modelName: "B组Expert", answer: { text: "实际回答", complete: true },
    trace: { messageCount: 40, toolCalls: 14, finalMessageIndex: 39, nodes: [
      { messageIndex: 3, type: "tool_result", name: "memory", preview: "Error: missing argument", reference: { collectionId: "0_wencai/0_daily_eval", runId: "run", inputId: "input", messageIndex: 3 } },
      { messageIndex: 39, type: "final_answer", reference: { collectionId: "0_wencai/0_daily_eval", runId: "run", inputId: "input", messageIndex: 39 } },
    ] } }] };
  const model = analysisToolModel("read_case", { state: "ok", output: JSON.stringify(output) });
  assert.equal(model.summary, "读取案例 · 1 条回答 · 已完成");
  assert.equal(model.details.items[0].description, output.question);
  const groups = model.details.items[1].groups;
  assert.equal(groups[0].items[0].code.text, "实际回答");
  assert.equal(groups[1].label, "链路地图（2 个节点）");
  assert.equal(groups[1].items[0].title, "3 · Tool result · memory");
  assert.equal(groups[1].items[0].description, "Error: missing argument");
  assert.equal(groups[1].items[1].title, "39 · Final answer");
});

test("data query summaries use full-run counts and distinguish historical runs from answers", () => {
  const summary = { inputCount: 26, caseCount: 10 };
  assert.equal(analysisToolModel("list_data", { state: "ok", output: JSON.stringify({ kind: "runs", total: 26, currentRun: { summary }, items: [] }) }).summary,
    "最近一轮 · 26 条回答 · 10 道题");
  assert.equal(analysisToolModel("list_data", { state: "ok", output: JSON.stringify({ kind: "inputs", total: 0, summary, items: [] }) }).summary,
    "本轮 · 26 条回答 · 10 道题");
  assert.equal(analysisToolModel("list_data", { state: "ok", output: JSON.stringify({ kind: "runs", total: 0, items: [] }) }).summary,
    "找到 0 次运行");
});

test("run statistics display each run's state and progress without summing overlapping results", () => {
  const result = analysisToolModel("list_data", { state: "ok", bodyRaw: '{"view":"statistics"}', output: JSON.stringify({
    kind: "statistics", runs: [
      { collectionId: "0_wencai/0_daily_eval", runId: "run", status: "finished", summary: {
        inputCount: 20, caseCount: 10, evaluatedInputCount: 20, attributionCompletionRate: 100,
        formalComparisonsAccepted: 10, battleCompletionRate: 100, tasks: { total: 30, states: { succeeded: 30 } } } },
      { collectionId: "1_aime/0_daily_eval", runId: "run", status: "interrupted", summary: {
        inputCount: 20, caseCount: 10, evaluatedInputCount: 8, attributionCompletionRate: 40,
        formalComparisonsAccepted: 3, battleCompletionRate: 30, tasks: { total: 30, states: { succeeded: 11 } } } },
    ], total: 4, offset: 0, limit: 2, hasMore: true, nextOffset: 2, additive: false,
  }) });
  assert.equal(result.summary, "运行统计 · 本页 2 / 4 次运行");
  assert.deepEqual(result.details.items.map((item: { title: string }) => item.title), ["0_wencai/0_daily_eval · run", "1_aime/0_daily_eval · run"]);
  const first = Object.fromEntries(result.details.items[0].fields.map((field: { label: string; value: string }) => [field.label, field.value]));
  assert.deepEqual(first, { "状态": "已结束", "回答数": "20", "题目数": "10", "已归因回答": "20", "归因完成率": "100.00%", "正式对战": "10", "对战完成率": "100.00%", "任务完成": "30 / 30" });
  assert.equal(result.details.items[1].fields[0].value, "已中断");
  assert(!JSON.stringify(result).includes("累计"));
});

test("run statistics retain zero counts and unknown rates and tolerate unfinished calls", () => {
  const result = analysisToolModel("list_data", { state: "ok", output: JSON.stringify({ kind: "statistics", total: 1,
    runs: [{ runId: "empty-run", status: "running", summary: { inputCount: 0, caseCount: 0,
      evaluatedInputCount: 0, attributionCompletionRate: null, formalComparisonsAccepted: 0, battleCompletionRate: null } }] }) });
  const values = result.details.items[0].fields.map((field: { value: string }) => field.value).join(" ");
  assert.match(values, /进行中/);
  assert.match(values, /未知/);
  assert(!/0\.00%|NaN|undefined/.test(values));
  assert.equal(analysisToolModel("list_data", { state: "running", bodyRaw: '{"view":"statistics"}' }).details, undefined);
  assert.equal(analysisToolModel("list_data", { state: "error", bodyRaw: '{"view":"statistics"}', output: "读取失败" }).summary, "运行统计 · 未完成");
});

test("partial run directories display their read errors without claiming there are no runs", () => {
  const runDirectory = { complete: false, errors: [{ runId: "broken", message: "索引读取失败" }] };
  const statistics = analysisToolModel("list_data", { state: "ok", output: JSON.stringify({ kind: "statistics", runs: [], total: 0, runDirectory }) });
  assert.match(statistics.summary, /运行目录不完整/);
  assert.equal(statistics.details.items[0].description, "索引读取失败");
  const directory = analysisToolModel("list_data", { state: "ok", output: JSON.stringify({ kind: "runs", total: 0, items: [], runDirectory }) });
  assert.match(directory.summary, /运行目录不完整/);
  assert.equal(directory.details.items[0].description, "索引读取失败");
});

test("chart summaries distinguish the chart type and execution state without exposing provenance references", () => {
  assert.deepEqual(analysisToolModel("show_chart", { state: "ok", output: JSON.stringify({ kind: "chart", chart: { type: "heatmap" } }) }),
    { summary: "显示热力矩阵 · 已完成" });
  assert.deepEqual(analysisToolModel("show_chart", { state: "error", bodyRaw: JSON.stringify({ type: "pie", references: [{ collectionId: "0_wencai/0_daily_eval", runId: "run-private" }] }), output: "invalid values" }),
    { summary: "显示环形组成图 · 未完成" });
  assert.deepEqual(analysisToolModel("show_chart", { state: "running", bodyRaw: '{"type":' }), { summary: "显示图表 · 进行中" });
});

test("comparison pages show the question, outcome and both answer references in tool details", () => {
  for (const question of [{ questionPreview: "均线如何设置？" }, { question: "均线如何设置？" }]) {
    const result = analysisToolModel("list_data", { state: "ok", output: JSON.stringify({ kind: "comparisons", total: 200,
      items: [{ ...question, reference: { collectionId: "0_wencai/0_daily_eval", runId: "run", taskId: "battle" },
        outcomes: [{ resultLabel: "B组Fast胜" }], inputs: [
          { modelName: "A组Fast", reference: { collectionId: "0_wencai/0_daily_eval", runId: "run", inputId: "answer-a" } },
          { modelName: "B组Fast", reference: { collectionId: "0_wencai/0_daily_eval", runId: "run", inputId: "answer-b" } },
        ] }], summary: { inputCount: 400, caseCount: 200 } }) });
    assert.equal(result.summary, "查询正式对战 · 200 场匹配 · 本页 1 场");
    assert.equal(result.details.items[0].title, "均线如何设置？");
    assert.equal(result.details.items[0].description, "B组Fast胜");
    assert.deepEqual(result.details.items[0].groups[0].items.map((item: { title: string }) => item.title), ["A组Fast", "B组Fast"]);
    assert.match(JSON.stringify(result.details), /answer-a/);
    assert.match(JSON.stringify(result.details), /answer-b/);
  }
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
