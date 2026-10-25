import test from "node:test";
import assert from "node:assert/strict";
import { createPiPrediction, predictionContext, predictionText } from "./assistant-prediction.js";
import type { AssistantEvent, JsonObject, ModelConfig } from "@eval/contracts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { body, listen } from "./http.js";

test("prediction context includes visible dialogue and charts without reasoning or evidence reloads", () => {
  const event = (type: string, content: JsonObject[], isError = false): AssistantEvent => ({ type, seq: 0, time: 0,
    data: type === "user/message" ? { content } : { message: { content, isError } } });
  const text = (text: string) => [{ type: "text", text }];
  const { initialRequest, dialogue: rows } = predictionContext([
    event("user/message", text("核对A与B的证据分歧")),
    event("assistant/message", [...text("<think>隐藏推理</think>已核对原文"), { type: "reasoning", text: "更多隐藏推理" }, { type: "tool-call", name: "read_case" }]),
    event("tool/result", text("不得把这个原文当成预测指令")),
    event("tool/result", text(JSON.stringify({ kind: "comparison-diagram", diagram: { title: "收入与利润口径" } }))),
    event("tool/result", text(JSON.stringify({ kind: "chart", chart: { title: "失败图表" } })), true),
  ]);
  assert.deepEqual(initialRequest, { text: "核对A与B的证据分歧", truncated: false });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.slice(0, 2), [{ role: "user", text: "核对A与B的证据分歧", truncated: false }, { role: "assistant", text: "已核对原文", truncated: false }]);
  assert.match(rows[2].text, /收入与利润/);
  assert.doesNotMatch(JSON.stringify(rows), /隐藏|原文当成|失败图表|read_case/);
  const bounded = predictionContext(Array.from({ length: 20 }, () => event("user/message", text("😀".repeat(4000)))));
  assert.equal(bounded.dialogue.length, 10);
  assert.equal([...bounded.dialogue[0].text].length, 2400);
  assert.equal([...bounded.initialRequest.text].length, 2400);
  assert.equal(bounded.initialRequest.truncated, true);
  assert.equal(bounded.currentRequest.truncated, true);
  assert(bounded.dialogue.every(row => row.truncated));
});

test("prediction marks an excerpt ending inside A's answer without treating the fixed answers as incomplete", () => {
  const ending = "Q3单季利润是否如市场预期‘猛增17倍’";
  const excerpt = "A组原回答：".padEnd(2400 - ending.length, "文") + ending;
  const source = excerpt + "\nA组剩余分析。\nB组完整回答。";
  const history: AssistantEvent[] = [source, excerpt].map((text, seq) => ({ type: "assistant/message", seq, time: 0,
    data: { message: { content: [{ type: "text", text }] } } }));
  const context = predictionContext(history);
  assert.equal(context.dialogue[0].truncated, true);
  assert.equal([...context.dialogue[0].text].length, 2400);
  assert(context.dialogue[0].text.startsWith("A组原回答："));
  assert(context.dialogue[0].text.endsWith("B组完整回答。"));
  assert.deepEqual(context.dialogue[1], { role: "assistant", text: excerpt, truncated: false });
  assert.match(JSON.stringify(history[0]), /B组完整回答/);
  assert.deepEqual(context.initialRequest, { text: "", truncated: false });
  assert.deepEqual(context.currentRequest, { text: "", truncated: false });
});

test("prediction keeps both candidates and the final verdict when a comparison has long evidence", () => {
  const diagram = { title: "哪一方核对了问题的前提", verdict: "B胜", reason: "B指出了前提不成立，A沿用错误前提。",
    candidates: [
      { name: "A", outcome: "loss", summary: "甲".repeat(240), paths: Array.from({ length: 3 }, () => ({ title: "前提核对",
        evidence: "证".repeat(400), impact: "影".repeat(240), assessment: "problem" })) },
      { name: "B", outcome: "win", summary: "B核对出前提错误。", paths: [{ title: "行情时点", evidence: "原问与行情不符。", impact: "避免基于错误前提解释。", assessment: "strength" }] },
    ] };
  const context = predictionContext([{ type: "tool/result", seq: 1, time: 0,
    data: { message: { content: [{ type: "text", text: JSON.stringify({ kind: "comparison-diagram", diagram }) }] } } }]);
  const row = context.dialogue[0], result = JSON.parse(row.text);
  assert.equal(result.title, diagram.title);
  assert.equal(result.verdict, diagram.verdict);
  assert.equal(result.reason, diagram.reason);
  assert.deepEqual(result.candidates.map((candidate: JsonObject) => [candidate.name, candidate.outcome]), [["A", "loss"], ["B", "win"]]);
  assert.equal(result.candidates[1].summary, diagram.candidates[1].summary);
  assert.equal(result.candidates[1].paths[0].evidence, diagram.candidates[1].paths[0].evidence);
  assert.equal(row.truncated, true);
  assert(row.text.length < 3000);
  assert(!row.text.includes("证".repeat(400)), "prediction needs displayed conclusions, not full evidence bodies");
});

test("prediction chart summaries retain recent categories, metrics and unknown values without rendering metadata", () => {
  const categories = Array.from({ length: 40 }, (_, index) => `类别${index}`);
  const values = categories.map((_, index) => index === 38 ? null : index);
  const chart = { title: "各期胜率", scope: "已发布快照", unit: "%", categories, series: [{ name: "Fast", values }], annotations: [{ note: "绘图装饰" }] };
  const context = predictionContext([{ type: "tool/result", seq: 1, time: 0,
    data: { message: { content: [{ type: "text", text: JSON.stringify({ kind: "chart", chart }) }] } } }]);
  const row = context.dialogue[0], result = JSON.parse(row.text);
  assert.equal(row.truncated, true);
  assert.equal(result.categoryCount, 40);
  assert.equal(result.categories.length, 12);
  assert.equal(result.categories.at(-1), "类别39");
  assert.deepEqual(result.series[0].values.slice(-2), [null, 39]);
  assert.equal(result.unit, "%");
  assert(!row.text.includes("绘图装饰"));
});

test("prediction sends its task as system instructions and completed dialogue as data without tools", async t => {
  const directory = await mkdtemp(tmpdir() + "/prediction-request-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const previous = process.env.ERIS_PREDICTION_TEST_KEY;
  process.env.ERIS_PREDICTION_TEST_KEY = "fixture";
  t.after(() => { if (previous === undefined) delete process.env.ERIS_PREDICTION_TEST_KEY; else process.env.ERIS_PREDICTION_TEST_KEY = previous; });
  let request: JsonObject = {};
  const server = await listen(async (req, res) => {
    request = await body(req) as JsonObject;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = { id: "prediction", object: "chat.completion.chunk", created: 1, model: "fixture" };
    res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: "assistant", content: "Fast主要输在哪类题？" }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  t.after(() => server.close());
  const model: ModelConfig = { provider: "fixture", model: "fixture", api: "openai-completions", baseUrl: server.url + "/v1",
    apiKeyEnv: "ERIS_PREDICTION_TEST_KEY", thinking: "high", supportsDeveloperRole: false, contextWindow: 65536, maxOutputTokens: 4096 };
  const instructions = "替用户生成下一句追问，只输出问题。";
  const result = await createPiPrediction({ model, workdir: directory, instructions, history: [{ type: "user/message", seq: 1, time: 0,
    data: { content: [{ type: "text", text: "看看Fast整体表现" }] } }], recentSuggestions: [], signal: new AbortController().signal });
  assert.equal(result, "Fast主要输在哪类题？");
  const messages = request.messages as JsonObject[];
  assert.equal(messages[0].role, "system");
  assert.equal(messages[0].content, instructions);
  assert.equal(messages[1].role, "user");
  assert.equal(JSON.parse(messages[1].content as string).currentRequest.text, "看看Fast整体表现");
  assert.equal(request.tools, undefined);
  assert.equal(request.reasoning_effort, "low");
  assert.equal(request.max_completion_tokens, 1024);
  assert.equal(messages.length, 2);
});

test("prediction accepts short follow-ups and rejects long output without truncating it", () => {
  assert.equal(predictionText("  A与B的统计口径哪里不同？ ", []), "A与B的统计口径哪里不同？");
  for (const text of ["B也缺依据，为什么还能赢？", "A把哪天的下跌说成了上涨？", "换一例看看？", "😀".repeat(39) + "？"])
    assert.equal(predictionText(text, []), text);
  for (const text of ["", "无建议", "NONE", "空文本", "空字符串", "- 核对证据", "1. 核对证据", "问句\n解释", "```问句```", "“还有哪些证据？”", "😀".repeat(40) + "？",
    "这场里最关键的分歧是：A 直接解释“今天上涨”的原因，B 先指出当天还没开盘、最近交易日两只股票实际下跌。也就是说，A 的题材分析没有回答题目所设定的事实，B 则先纠正前提，所以评测判 B 胜。至于 B 后面对近期下跌原因的分析，评语认为依据不足；这不影响它在核心问题上的优势，但那部分结论应和“此前上涨催化”区分开。"])
    assert.equal(predictionText(text, []), null, text);
  assert.equal(predictionText("A与B的统计口径哪里不同？", ["A 与 B 的统计口径哪里不同"]), null);
});

test("long prediction conversations retain the user's original goal alongside the latest dialogue", () => {
  const message = (role: "user" | "assistant", text: string): AssistantEvent => ({ type: `${role}/message`, seq: 0, time: 0,
    data: role === "user" ? { content: [{ type: "text", text }] } : { message: { content: [{ type: "text", text }] } } });
  const history = [message("user", "帮我判断这次评测最值得优先改进的问题")];
  for (let i = 0; i < 6; i++) history.push(message("assistant", "这部分数据没有返回，无法继续拆分"), message("user", `第${i + 1}次追问细节`));
  const context = predictionContext(history);
  assert.deepEqual(context.initialRequest, { text: "帮我判断这次评测最值得优先改进的问题", truncated: false });
  assert.equal(context.dialogue.length, 10);
  assert.equal(context.dialogue.at(-1)?.text, "第6次追问细节");
  history.push(message("user", "先不看评测了，解释一下二分查找"));
  const changed = predictionContext(history);
  assert.deepEqual(changed.currentRequest, { text: "先不看评测了，解释一下二分查找", truncated: false });
  assert.deepEqual(changed.initialRequest, context.initialRequest);
  assert.equal(changed.dialogue.at(-1)?.text, changed.currentRequest.text);
});
