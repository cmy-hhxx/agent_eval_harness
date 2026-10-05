import test from "node:test";
import assert from "node:assert/strict";
import { containsNumber, matchesReference } from "./numeric.js";

test("citation identifiers do not supply numeric answer values", () => {
  assert.equal(containsNumber("没有提供值[^12]", "12"), false);
  assert.equal(containsNumber('未提供<trace ref="1234567"/>', "1234567"), false);
  assert.equal(containsNumber("耗时12天[^12]", "12"), true);
  assert.equal(containsNumber("普通编号[12]", "12"), true);
});

test("reference precision uses decimal rounding, including units and negative ties", () => {
  for (const [actual, expected, scale, matches] of [
    ["9.36", "9.4", "1", true], ["10.14", "10.1", "1", true],
    ["21.87", "21.6256", "1", false], ["10.7143", "10.76", "1", false],
    ["1.005", "1.01", "1", true], ["-1.005", "-1.01", "1", true],
    ["0.0936", "9.4", "100", true], ["936000000", "9.4", "0.00000001", true],
    ["9.35", "9.3", "1", false], ["4", "4.00", "1", true],
  ] as const) assert.equal(matchesReference(actual, expected, scale, "rounded"), matches, `${actual} -> ${expected}`);
  assert.equal(matchesReference("3.4", "3", "1", "exact"), false);
  assert.equal(matchesReference("300", "3", "0.01", "exact"), true);
  assert.throws(() => matchesReference("NaN", "1", "1", "rounded"));
  assert.throws(() => matchesReference("1", "1", "0", "rounded"));
  assert.equal(containsNumber("9.40", "9.4", true), false);
  assert.equal(containsNumber("2023年为9.36%，另有19.4", "9.4"), false);
  assert.equal(containsNumber("金额1,234.00元", "1234"), true);
  assert.equal(containsNumber("收益率 −12.71%", "-12.71"), true);
  assert.equal(containsNumber("收益率 −12.71%", "12.71"), false);
});

test("scientific notation preserves the reference's significant precision", () => {
  assert.equal(containsNumber("1.13018E+12元", "1.13018e12", true), true);
  assert.equal(containsNumber("1.13018E+12元", "1130180000000", true), false);
  assert.equal(containsNumber("1.13018E+12元", "1130180000000"), true);
  assert.equal(matchesReference("1130181000000", "1.13018E+12", "1", "rounded"), true);
  assert.equal(matchesReference("1130181000000", "1.13018E+12", "1", "exact"), false);
  assert.equal(matchesReference("1130186000000", "1.13018E+12", "1", "rounded"), false);
  assert.equal(matchesReference("0.0000012344", "1.234e-6", "1", "rounded"), true);
  assert.equal(matchesReference("-1130185000000", "-1.13019e12", "1", "rounded"), true);
  assert.equal(containsNumber("1.13018E+12元", "12"), false);
  assert.throws(() => matchesReference("1e999999", "1", "1", "rounded"));
});

test("range separators are not minus signs but actual negative values retain their signs", () => {
  assert.equal(containsNumber("实控人提议1亿-2亿元回购", "2", true), true);
  assert.equal(containsNumber("范围1-2", "2", true), true);
  assert.equal(containsNumber("范围-2--1", "-1", true), true);
  assert.equal(containsNumber("2025年同比-2%", "-2", true), true);
  assert.equal(containsNumber("2025年同比-2%", "2", true), false);
  assert.equal(containsNumber("2020年-0.09854252，2021年0.01437126", "-0.09854252", true), true);
  assert.equal(containsNumber("2020年-0.09854252", "0.09854252", true), false);
  assert.equal(containsNumber("2021年2月 - 2.12%", "-2.12", true), true);
  assert.equal(containsNumber("2025年2月 - 1.51%", "-1.51", true), true);
  assert.equal(containsNumber("2021 -7.21%", "-7.21", true), true);
  assert.equal(containsNumber("中位数涨跌幅 +0.20% -0.02%", "-0.02", true), true);
});

test("spaced signs and explicit decline wording retain numeric direction", () => {
  assert.equal(containsNumber("跌幅为- 8.92%", "-8.92", true), true);
  assert.equal(containsNumber("变化值为 − 0.07%", "-0.07", true), true);
  assert.equal(containsNumber("同比下降约 **8.68%**", "-8.68"), true);
  assert.equal(containsNumber("同比下降3.7%", "-3.7"), true);
  assert.equal(containsNumber("净流出 **3.07亿元**", "-3.07"), true);
  assert.equal(containsNumber("三天平均微跌0.09%", "-0.09", true), true);
  assert.equal(containsNumber("收盘跌 0.375%", "-0.375", true), true);
  assert.equal(containsNumber("收盘止跌 0.375%", "-0.375", true), false);
  assert.equal(containsNumber("收盘未跌 0.375%", "-0.375", true), false);
  assert.equal(containsNumber("调研后首日平均跌约3.29个百分点", "-3.29", true), true);
  assert.equal(containsNumber("区间跌幅约 78.5%", "-78.5", true), true);
  assert.equal(containsNumber("区间跌幅约 78.5%", "78.5", true), true);
  assert.equal(containsNumber("下降趋势结束；同比增长3.7%", "-3.7"), false);
  assert.equal(containsNumber("2024年为3.7%", "-3.7"), false);
});

test("literal counts, arithmetic operands and adjoining calendar headings keep their boundaries", () => {
  assert.equal(containsNumber("消费主题基金有两只", "2"), true);
  assert.equal(containsNumber("消费主题基金有十二只", "2"), false);
  for (const quantity of ["六天", "六交易日", "六个交易日"])
    assert.equal(containsNumber(`命中${quantity}`, "6"), true);
  for (const quantity of ["二十六天", "二十六交易日", "二十六个交易日", "五月六日"])
    assert.equal(containsNumber(`记录${quantity}`, "6"), false);
  assert.equal(containsNumber("| 剩余现金 | 20000 − 19684 | 316.00 |", "19684"), true);
  assert.equal(containsNumber("| 支出 | −19,684.00 |", "19684"), false);
  assert.equal(containsNumber("极差=110.71−102.35=8.362025 年上半年指数", "8.36", true), true);
  assert.equal(containsNumber("数值为8.362025", "8.36", true), false);
  assert.equal(containsNumber("期限为8.362025年", "8.36", true), false);
});
