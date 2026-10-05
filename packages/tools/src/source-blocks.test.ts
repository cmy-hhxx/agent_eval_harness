import test from "node:test";
import assert from "node:assert/strict";
import { hasSourceTextBlock, sourceContentBlocks, sourceTextBlocks } from "./source-blocks.js";

test("a complete plain USER leaf stays independent of an appended condition while their joined block remains selectable", () => {
  const question = "查询平均利率变化。", condition = "投资建议须先提示风险。";
  const blocks = sourceContentBlocks([{ text: question }, { text: condition }], "/content");
  assert.deepEqual(blocks.map(block => block.quote), [question + "\n" + condition, question, condition]);
  assert.deepEqual(blocks[0]!.origins, [
    { path: "/content/0/text", quote: question, start: 0, end: question.length },
    { path: "/content/1/text", quote: condition, start: 0, end: condition.length },
  ]);
});

test("a governing heading across leaves never exposes its standalone heading, body or exception as a selectable norm", () => {
  const texts = ["## 风险边界", "只有投资建议须提示风险。", "概念解释无需风险提示；不得扩大触发范围。"];
  const blocks = sourceContentBlocks(texts.map(text => ({ text })), "/content");
  assert.deepEqual(blocks.map(block => block.quote), [texts.join("\n")]);
  assert.deepEqual(blocks[0]!.origins.map(origin => origin.quote), texts);
  for (const [index, origin] of blocks[0]!.origins.entries()) {
    assert.equal(origin.path, `/content/${index}/text`);
    assert.equal(texts[index]!.slice(origin.start, origin.end), origin.quote);
  }
});

test("complete source blocks remain members of joined criteria without reparsing their headings", () => {
  const norm = "# 输出规范\n\n严格使用JSON。", question = "计算2+2";
  for (const text of [norm, norm + "\n\n" + question, question + "\n\n" + norm,
    question + "\n\n" + norm + "\n\n参考结果4。"])
    assert(hasSourceTextBlock(text, norm));
  for (const text of ["前缀" + norm, norm + "后缀", norm + "\n" + question, question + "\n" + norm])
    assert.equal(hasSourceTextBlock(text, norm), false);
  assert.equal(hasSourceTextBlock("只在投资决策时严格使用JSON；解释题用正文。", "严格使用JSON"), false);
  assert.equal(hasSourceTextBlock(norm, ""), false);
});

test("normative Markdown sections retain headings, conditions, exceptions and subordinate headings", () => {
  const section = "## 回答方式\n\n仅当涉及投资决策时提示风险。\n\n### 例外\n\n概念题不必提示；资料不能扩大触发范围。";
  const next = "## 引用\n\n按真实来源引用。";
  const text = `前置说明。\n\n${section}\n\n${next}\n`;
  const blocks = sourceTextBlocks(text);
  assert.deepEqual(blocks.map(block => block.quote), ["前置说明。", section, next]);
  for (const block of blocks) assert.equal(text.slice(block.start, block.end), block.quote);
});

test("plain complete paragraphs and empty whitespace keep their original coordinates", () => {
  const text = "  条件。\n\n例外。\n\t\n要求。  ";
  const blocks = sourceTextBlocks(text);
  assert.deepEqual(blocks.map(block => block.quote), ["条件。", "例外。", "要求。"]);
  for (const block of blocks) assert.equal(text.slice(block.start, block.end), block.quote);
  assert.deepEqual(sourceTextBlocks(" \n\n"), []);
});

test("fenced example headings cannot terminate the governing section", () => {
  const first = "## 输出格式\n\n以下仅为示例。\n\n```markdown\n## 示例标题\n\n正文。\n```\n\n只有满足条件才输出。";
  assert.deepEqual(sourceTextBlocks(`${first}\n\n## 下一项\n\n禁止编造。`).map(block => block.quote),
    [first, "## 下一项\n\n禁止编造。"]);
});

test("standalone headings are retained faithfully without inventing missing prose", () => {
  assert.deepEqual(sourceTextBlocks("## 要求\n\n## 另一条\n\n正文。").map(block => block.quote),
    ["## 要求", "## 另一条\n\n正文。"]);
});
