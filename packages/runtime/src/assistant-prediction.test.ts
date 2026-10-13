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
  assert.equal(initialRequest, "核对A与B的证据分歧");
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.slice(0, 2), [{ role: "user", text: "核对A与B的证据分歧" }, { role: "assistant", text: "已核对原文" }]);
  assert.match(rows[2].text, /收入与利润/);
  assert.doesNotMatch(JSON.stringify(rows), /隐藏|原文当成|失败图表|read_case/);
  const bounded = predictionContext(Array.from({ length: 20 }, () => event("user/message", text("😀".repeat(4000)))));
  assert.equal(bounded.dialogue.length, 10);
  assert.equal([...bounded.dialogue[0].text].length, 2400);
  assert.equal([...bounded.initialRequest].length, 2400);
});

test("prediction accepts one short question and rejects malformed or repeated output", () => {
  assert.equal(predictionText("  A与B的统计口径哪里不同？ ", []), "A与B的统计口径哪里不同？");
  for (const text of ["", "无建议", "NONE", "建议：核对证据", "第一问？第二问？", "- 核对证据", "1. 核对证据", "问句\n解释", "```问句```", "“还有哪些证据？”", "问".repeat(61)])
    assert.equal(predictionText(text, []), null, text);
  assert.equal(predictionText("A与B的统计口径哪里不同？", ["A 与 B 的统计口径哪里不同"]), null);
});

test("long prediction conversations retain the user's original goal alongside the latest dialogue", () => {
  const message = (role: "user" | "assistant", text: string): AssistantEvent => ({ type: `${role}/message`, seq: 0, time: 0,
    data: role === "user" ? { content: [{ type: "text", text }] } : { message: { content: [{ type: "text", text }] } } });
  const history = [message("user", "帮我判断这次评测最值得优先改进的问题")];
  for (let i = 0; i < 6; i++) history.push(message("assistant", "这部分数据没有返回，无法继续拆分"), message("user", `第${i + 1}次追问细节`));
  const context = predictionContext(history);
  assert.equal(context.initialRequest, "帮我判断这次评测最值得优先改进的问题");
  assert.equal(context.dialogue.length, 10);
  assert.equal(context.dialogue.at(-1)?.text, "第6次追问细节");
  history.push(message("user", "先不看评测了，解释一下二分查找"));
  const changed = predictionContext(history);
  assert.equal(changed.currentRequest, "先不看评测了，解释一下二分查找");
  assert.equal(changed.initialRequest, "帮我判断这次评测最值得优先改进的问题");
  assert.equal(changed.dialogue.at(-1)?.text, changed.currentRequest);
});
