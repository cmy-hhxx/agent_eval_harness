import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ValidationError } from "@eval/contracts";
import { resolveDerivations, validateDerivations, type DerivationOperandSubmission, type DerivationSubmission } from "./derivations.js";

const operand = (value: string, role: string, evidence_index = 1, unit = "USD", period = "current"): DerivationOperandSubmission =>
  ({ value, role, evidence_index, unit, period });
const base = (fields: Partial<DerivationSubmission>): DerivationSubmission => ({
  label: "核验关键推导", operation: "ratio", operands: {}, result: "0", scale: "1", decimal_places: 2,
  result_unit: "ratio", result_period: "current", assumptions: [], ...fields,
});
const resolve = (row: DerivationSubmission, quote: string) => resolveDerivations([row], () => ({ evidence_id: "source", quote }));
const rejects = (row: DerivationSubmission, quote: string, code: string) => assert.throws(() => resolve(row, quote),
  (error: unknown) => error instanceof ValidationError && Boolean(error.issues?.some(issue => issue.code === code)));

describe("source-bound attribution derivations", () => {
  it("distinguishes cost above market value from loss using cost as denominator", () => {
    const costAboveMarket = base({ operation: "relative_change", operands: {
      base: operand("2.28", "当前市值"), observed: operand("3.08", "累计成本"),
    }, denominator_role: "当前市值", scale: "100", result: "35.09", result_unit: "%" });
    const lossFromCost = base({ operation: "relative_change", operands: {
      base: operand("3.08", "累计成本"), observed: operand("2.28", "当前市值"),
    }, denominator_role: "累计成本", scale: "100", result: "-25.97", result_unit: "%" });
    const quote = "累计成本3.08亿元，当前市值2.28亿元。";
    assert.equal(resolve(costAboveMarket, quote)[0].result, "35.09");
    assert.equal(resolve(lossFromCost, quote)[0].result, "-25.97");
    rejects({ ...lossFromCost, result: "-35.09" }, quote, "derivation_result_mismatch");
    rejects({ ...lossFromCost, denominator_role: "当前市值" }, quote, "derivation_invalid");
    rejects({ ...lossFromCost, scale: "1", result: "-0.26" }, quote, "derivation_invalid");
  });

  it("reverses positive denominator bounds for BE's guidance valuation range", () => {
    const row = base({ operands: {
      numerator: operand("56.618", "市值", 1, "billion USD", "2026-10-26"),
      denominator_lower: operand("4.4", "全年收入指引", 1, "billion USD", "FY2026"),
      denominator_upper: operand("4.6", "全年收入指引", 1, "billion USD", "FY2026"),
    }, denominator_role: "全年收入指引", result: { lower: "12.31", upper: "12.87", include_lower: true, include_upper: true }, result_unit: "x", result_period: "FY2026 guidance" });
    const quote = "market cap 56.618 billion; FY2026 revenue guidance 4.4–4.6 billion";
    assert.equal(resolve(row, quote).length, 1);
    rejects({ ...row, result: { lower: "12.87", upper: "12.31", include_lower: true, include_upper: true } }, quote, "derivation_result_mismatch");
    rejects({ ...row, result: "40" }, quote, "derivation_invalid");
  });

  it("retains Q3 times four as an assumption-bound run rate rather than annual guidance", () => {
    const row = base({ operation: "annualization", operands: { value: operand("1.235837", "季度收入", 1, "billion USD", "2026Q3") },
      factor: "4", observation_period: "2026Q3", target_period: "annual run rate", result_period: "annual run rate", result_basis: "run_rate",
      assumptions: ["假设其他季度收入等同于Q3；该估计不是全年指引。"], result: "4.943348", decimal_places: 6, result_unit: "billion USD" });
    const quote = "2026Q3 revenue was 1.235837 billion USD";
    const resolved = resolve(row, quote)[0];
    assert.equal(resolved.result_basis, "run_rate");
    assert.deepEqual(resolved.assumptions, row.assumptions);
    rejects({ ...row, result_basis: "guidance" as "run_rate" }, quote, "derivation_invalid");
    rejects({ ...row, observation_period: "FY2026" }, quote, "derivation_invalid");
    rejects({ ...row, assumptions: [] }, quote, "derivation_invalid");
  });

  it("rejects invented operands, number substrings, unbound constants and incorrect output", () => {
    const row = base({ operands: { numerator: operand("123", "值"), denominator: operand("3", "分母") }, denominator_role: "分母", result: "41" });
    rejects(row, "原始值1234，分母3", "derivation_operand_not_in_evidence");
    rejects({ ...row, result: "42" }, "原始值123，分母3", "derivation_result_mismatch");
    rejects(base({ operation: "arithmetic", operands: { source: operand("3", "值") }, formula: "source*999", result: "2997" }), "原始值3", "derivation_invalid");
    rejects(base({ operation: "arithmetic", operands: { display_scale: operand("3", "值") }, formula: "display_scale", result: "1" }), "原始值3", "derivation_invalid");
    const [resolved] = resolve(row, "原始值123，分母3");
    assert.equal(validateDerivations([resolved], () => undefined)[0].code, "derivation_operand_not_in_evidence");
  });

  it("keeps exact decimal arithmetic, explicit units and evidence IDs without rewriting results", () => {
    const row = base({ operation: "arithmetic", operands: { amount: operand("1,000.01", "金额"), divisor: operand("3", "人数", 1, "persons") },
      formula: "amount/divisor", result: "333.34", result_unit: "USD/person" });
    const [resolved] = resolve(row, "金额1,000.01，人数3");
    assert.equal(resolved.result, "333.34");
    assert.deepEqual(resolved.operands.amount, { value: "1,000.01", role: "金额", unit: "USD", period: "current", evidence_id: "source" });
    const incompatible = base({ operation: "relative_change", operands: { base: operand("3", "基数"), observed: operand("4", "现值", 1, "million USD") }, denominator_role: "基数", result: "0.33" });
    rejects(incompatible, "基数3，现值4", "derivation_invalid");
  });

  it("checks cumulative compound growth and half-even rounding exactly", () => {
    const row = base({ operation: "compound_growth", operands: { base: operand("100", "本金"), rate: operand("0.1", "每期增长率", 1, "ratio"), periods: operand("2", "期数", 1, "periods") }, result: "121", result_unit: "USD" });
    assert.equal(resolve(row, "本金100，每期增长率0.1，期数2").length, 1);
    const round = base({ operation: "ratio", operands: { numerator: operand("1", "分子"), denominator: operand("8", "分母") }, denominator_role: "分母", result: "0.12" });
    assert.equal(resolve(round, "分子1，分母8").length, 1);
    rejects({ ...round, result: "0.13" }, "分子1，分母8", "derivation_result_mismatch");
  });

  it("expresses declared unit conversions without inventing a source operand for a mathematical constant", () => {
    const row = base({ operation: "arithmetic", operands: { revenue: operand("1235.837", "季度收入", 1, "million USD", "2026Q3") },
      formula: "revenue/1000", result: "1.235837", decimal_places: 6, result_unit: "billion USD", result_period: "2026Q3",
      assumptions: ["1 billion USD = 1000 million USD；仅换算数量单位，不改变观察期间。"] });
    assert.equal(resolve(row, "2026Q3 revenue 1235.837 million USD")[0].result, "1.235837");
    assert.equal(resolve({ ...row, formula: "revenue*1e-3" }, "2026Q3 revenue 1235.837 million USD").length, 1);
    rejects({ ...row, assumptions: [] }, "2026Q3 revenue 1235.837 million USD", "derivation_invalid");
    rejects({ ...row, formula: "revenue/999" }, "2026Q3 revenue 1235.837 million USD", "derivation_invalid");
    const loss = base({ operation: "arithmetic", operands: { cost: operand("3.08", "累计成本"), market: operand("2.28", "市值") },
      formula: "(1-market/cost)", result: "25.97", scale: "100", result_unit: "%" });
    assert.equal(resolve(loss, "成本3.08，市值2.28").length, 1);
  });

  it("calculates a 9 percent eight-year growth multiple without inventing a source base of one", () => {
    const row = base({ operation: "compound_growth", operands: { rate: operand("9", "年收益率", 1, "%", "annual"),
      periods: operand("8", "复利年数", 1, "periods", "years") }, result: "1.99", result_unit: "ratio", result_period: "8 years" });
    const [resolved] = resolve(row, "每年收益率9%，持续8年。");
    assert.equal(resolved.result, "1.99");
    assert(!Object.hasOwn(resolved.operands, "base"));
    rejects({ ...row, result_unit: "USD" }, "每年收益率9%，持续8年。", "derivation_invalid");
  });
});
