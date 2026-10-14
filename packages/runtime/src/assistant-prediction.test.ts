import test from "node:test";
import assert from "node:assert/strict";
import { predictionContext, predictionText } from "./assistant-prediction.js";
import type { AssistantEvent, JsonObject } from "@eval/contracts";

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
  assert.deepEqual(context.dialogue, [
    { role: "assistant", text: excerpt, truncated: true },
    { role: "assistant", text: excerpt, truncated: false },
  ]);
  assert.match(JSON.stringify(history[0]), /B组完整回答/);
  assert.deepEqual(context.initialRequest, { text: "", truncated: false });
  assert.deepEqual(context.currentRequest, { text: "", truncated: false });
});

test("prediction accepts short follow-ups and rejects long output without truncating it", () => {
  assert.equal(predictionText("  A与B的统计口径哪里不同？ ", []), "A与B的统计口径哪里不同？");
  for (const text of ["B也缺依据，为什么还能赢？", "A把哪天的下跌说成了上涨？", "换一例看看？", "😀".repeat(39) + "？"])
    assert.equal(predictionText(text, []), text);
  for (const text of ["", "无建议", "NONE", "- 核对证据", "1. 核对证据", "问句\n解释", "```问句```", "“还有哪些证据？”", "😀".repeat(40) + "？",
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
