import { attributionJudgment } from "../../../../tests/fixtures/attribution-judgment.js";
import { resolveJudgment } from "./resolve.js";
import { canonicalEvidence } from "../../../../tests/fixtures/evidence.js";
import { setFixtureNormDirectory } from "../../../../tests/fixtures/attribution-submission.js";
import test from "node:test";
import assert from "node:assert/strict";
import { ValidationError } from "@eval/contracts";
import { AgentRegistry } from "@eval/host";
import { attributionAgent, attributionProfile } from "./index.js";
import type { AttributionResult } from "./types.js";
import example from "./fixtures/example.json" with { type: "json" };

const audit = { calls: 0, requiredReadCalls: 0, viewedImages: [], traceReads: [], calculations: [], artifacts: [] };
const registry = new AgentRegistry([attributionAgent]);
function fixture(reference: string | number, answer: string, checks: AttributionResult["numeric_checks"] = []) {
  const request = structuredClone(example.request);
  Object.assign(request.input.ground_truth, { value: reference });
  request.sources.answer.value.messages[1]!.content = answer;
  request.input.answer.final_answer = answer;
  const result = structuredClone(example.result) as AttributionResult;
  result.correctness_evidence = [canonicalEvidence(example.request.sources.answer.id, 1, answer)];
  result.criterion_assessments.forEach((item) => { item.evidence = result.correctness_evidence; });
  result.findings = [];
  result.numeric_checks = checks;
  return { request, result, validate: () => attributionProfile.validate!(request, result, audit) };
}
function taskFixture(question: string, reference: string | number, answer: string, reason: string,
  checks: AttributionResult["numeric_checks"] = []) {
  const value = fixture(reference, answer, checks), { request, result } = value;
  request.input.answer.question = question;
  request.sources.answer.value.messages[0]!.content = question;
  Object.assign(request.sources.answer.value.meta, { ground_truth: reference });
  request.input.task_analysis = { task_type: "数值核验", goal: question,
    requirements: [{ id: "r1", text: question, applies_to: [], acceptance_rule: "按原题和标准答案核验最终交付。" }],
    scoring_points: [], red_flags: [] };
  result.task_analysis = structuredClone(request.input.task_analysis);
  result.correctness_reason = reason;
  result.summary = reason;
  result.core_assessment = { meets_core: true, reason, criterion_ids: ["r1"] };
  result.criterion_assessments = [{ criterion_id: "r1", status: "met", evidence_status: "established", summary: reason,
    evidence: [canonicalEvidence(request.sources.answer.id, 0, question), ...result.correctness_evidence] }];
  setFixtureNormDirectory(request);
  return value;
}
function submit(value: ReturnType<typeof fixture>) {
  return resolveJudgment(value.request, attributionJudgment(value.request, value.result), audit) as AttributionResult;
}
function validateEmptyLedger(value: ReturnType<typeof fixture>) {
  // These checks preserve a supplied semantic assessment; they do not prove the original numerical rule.
  value.validate();
  const resolved = submit(value);
  registry.validate({ agent: "attribution", profile: "default", request: value.request }, resolved, audit);
  assert.deepEqual(resolved.numeric_checks, []);
  assert.equal(resolved.is_correct, value.result.is_correct);
  assert.equal(resolved.correctness_reason, value.result.correctness_reason);
}
function check(expected: string, actual: string | null, scale = "1"): AttributionResult["numeric_checks"][number] {
  return { label: "目标结果", expected, actual, scale, mode: "rounded", matches: true, evidence_index: 0 };
}
const code = (wanted: string) => (error: unknown) => error instanceof ValidationError &&
  !!error.issues?.some((issue) => issue.code === wanted);

test("double rounding remains an arithmetic observation rather than overriding an evidenced judgment", () => {
  const value = taskFixture("计算264天占409个交易日的比例。", "64.5%", "264/409，约64.55%。",
    "264/409×100=64.547677…%，按一位或两位小数分别为64.5%和64.55%。两者来自同一计算，展示精度不同，不构成答案错误。",
    [{ ...check("64.5", "64.55"), matches: false }]);
  value.validate();
  const result = submit(value);
  registry.validate({ agent: "attribution", profile: "default", request: value.request }, result, audit);
  assert.equal(result.numeric_checks[0].matches, false, "the arithmetic observation remains honest");
  assert.equal(result.is_correct, true);
  assert.equal(result.core_assessment.meets_core, true);
  assert.equal(result.correctness_reason, value.result.correctness_reason);
});

test("citation numbers cannot borrow a table header unit to replace missing data", () => {
  const answer = "| 名称 | 耗时(天) |\n|---|---|\n| 测试 | 未提供[^12] |";
  assert.throws(fixture("耗时为12天", answer, [check("12", "12")]).validate,
    code("numeric_answer_context_missing"));
  fixture("耗时为12天", "| 名称 | 耗时(天) |\n|---|---|\n| 测试 | 12[^12] |",
    [check("12", "12")]).validate();
});

test("an explicit question tolerance can be reviewed outside the ledger for string and numeric standards", () => {
  for (const reference of ["10.0", 10]) {
    validateEmptyLedger(taskFixture("测量长度，以标准答案为基准，允许误差±1。", reference, "长度为10.5。",
      "原题允许误差±1；回答10.5与标准10相差0.5，在允许范围内。"));
  }
  validateEmptyLedger(taskFixture("测量长度，按标准答案明确给出的容差判断。", "10.0±1", "长度为10.5。",
    "标准允许10.0±1；回答10.5处于9至11范围内。"));
});

test("an interval and its permitted point estimate retain their original semantic assessment", () => {
  validateEmptyLedger(taskFixture("给出区间[9,11]内的一个估计值，标准答案为中值。", "10.0", "估计值为10.5。",
    "原题允许区间内的任一估计值，10.5落在[9,11]内；中值10.0不是唯一允许值。"));
  validateEmptyLedger(taskFixture("按标准答案给出的区间，选取一个区间内的估计值。", "[9.0,11.0]", "估计值为10.0。",
    "任务允许选取区间内的估计值，回答10.0位于标准区间内。"));
});

test("upper and lower limits remain inequality assessments even with scalar-looking standards", () => {
  for (const [question, reference, answer, reason] of [
    ["提交一个不超过10元的预算。", "10.0元", "预算为9元。", "原题给出10元上限；回答9元未超过上限。"],
    ["按标准答案的预算上限给出预算。", "上限为10.0元", "预算为9元。", "标准上限为10元；回答9元符合该上限。"],
    ["提交一个至少10元的预算。", "10.0元", "预算为11元。", "原题给出10元下限；回答11元达到下限。"],
    ["按标准答案的预算下限给出预算。", "最低为10.0元", "预算为11元。", "标准最低为10元；回答11元达到下限。"],
  ] as const) validateEmptyLedger(taskFixture(question, reference, answer, reason));
});

test("a fraction can retain its derived comparison without inventing a delivered decimal actual", () => {
  const value = taskFixture("计算1除以3，允许用分数作答。", "0.3333", "结果为1/3。",
    "回答原文为1/3；计算该分数并按标准四位小数舍入为0.3333，与标准一致，不将自算小数填入actual。");
  validateEmptyLedger(value);
  value.result.numeric_checks = [check("0.3333", "0.3333")];
  assert.throws(() => submit(value), code("numeric_answer_missing"));
  assert.throws(value.validate, code("numeric_answer_missing"));
});

test("an evidenced wrong answer remains wrong without deriving the verdict from a numeric flag", () => {
  const wrong = taskFixture("给出长度，与标准答案按末位精度核对。", "10.0", "长度为10.5。",
    "回答10.5与标准10.0不符，原题没有容差或其他等价依据。", [{ ...check("10.0", "10.5"), matches: false }]);
  wrong.result.is_correct = false;
  wrong.result.core_assessment = { meets_core: false, reason: wrong.result.correctness_reason, criterion_ids: ["r1"] };
  wrong.result.criterion_assessments[0]!.status = "unmet";
  wrong.result.criterion_assessments[0]!.summary = wrong.result.correctness_reason;
  const resolved = submit(wrong);
  registry.validate({ agent: "attribution", profile: "default", request: wrong.request }, resolved, audit);
  assert.equal(resolved.is_correct, false);
  assert.equal(resolved.numeric_checks[0].matches, false);
  wrong.validate();
  wrong.result.numeric_checks[0].matches = true;
  assert.throws(wrong.validate, code("numeric_rounding_mismatch"));
});

test("arithmetic equality does not override a semantic unit mismatch", () => {
  const value = taskFixture("给出总销量。", "1087.4万千升", "总销量为1087.4万吨。",
    "回答把体积万千升写成质量万吨，未提供密度；数值相同不能证明所求销量正确。", [check("1087.4", "1087.4")]);
  value.result.is_correct = false;
  value.result.core_assessment.meets_core = false;
  value.result.criterion_assessments[0].status = "unmet";
  value.validate();
  const result = submit(value);
  assert.equal(result.numeric_checks[0].matches, true);
  assert.equal(result.is_correct, false);
});

test("unit scale is derived from the cited number's adjacent units", () => {
  fixture("1087.4万千升", "10,874,000千升", [check("1087.4", "10874000", "0.0001")]).validate();
  fixture("1.13018E+12元", "1130181百万元", [check("1.13018E+12", "1130181", "1000000")]).validate();
  const wrong = fixture("1087.4万千升", "1087.4万升", [check("1087.4", "1087.4")]);
  assert.throws(wrong.validate, code("numeric_scale_mismatch"));
  assert.throws(fixture("10元", "5元", [check("10", "5", "2")]).validate, code("numeric_scale_mismatch"));
});

test("an evidenced compound-unit conversion does not depend on a unit whitelist", () => {
  const value = taskFixture("给出每吨能耗，以千瓦时/吨表示。", "1千瓦时/吨", "每吨能耗1000瓦时/吨。",
    "每吨能耗1000瓦时/吨，按1000瓦时=1千瓦时换算为1千瓦时/吨，与标准相同。",
    [check("1", "1000", "0.001")]);
  value.validate();
  const result = submit(value);
  registry.validate({ agent: "attribution", profile: "default", request: value.request }, result, audit);
  assert.equal(result.is_correct, true);
  assert.equal(result.numeric_checks[0].matches, true);
  assert.equal(result.correctness_reason, value.result.correctness_reason);
});

test("glass weight-box magnitudes verify the scale in the actual-to-standard direction", () => {
  const value = fixture("9.69亿重量箱", "2023年12月产量8499.9万重量箱", [
    { ...check("9.69", "8499.9", "0.0001"), matches: false },
  ]);
  value.result.is_correct = false;
  value.validate();
  value.result.numeric_checks[0].scale = "10000";
  assert.throws(value.validate, code("numeric_scale_mismatch"));
  fixture("0.84999亿重量箱", "8499.9万重量箱", [check("0.84999", "8499.9", "0.0001")]).validate();
});

test("count magnitudes in prose and table headers preserve their exact delivered numeric value", () => {
  for(const answer of ["销量454.54万辆。","| 期间 | 销量（万辆） |\n| --- | --- |\n| 全年 | 454.54 |"]){
    fixture("4545400",answer,[check("4545400","4545400")]).validate();
    assert.throws(fixture("4545400",answer,[check("4545400","4545500")]).validate,code("numeric_answer_missing"));
  }
});

test("a missing point value preserves the agent's supported incomplete-delivery judgment", () => {
  const missing = taskFixture("给出总销量。", "1087.4万千升", "没有查到销量。", "回答未交付总销量。",
    [{ ...check("1087.4", null), matches: false }]);
  missing.result.is_correct = false;
  missing.result.core_assessment.meets_core = false;
  missing.result.criterion_assessments[0]!.status = "unmet";
  const result = submit(missing);
  registry.validate({ agent: "attribution", profile: "default", request: missing.request }, result, audit);
  assert.equal(result.numeric_checks[0].actual, null);
  assert.equal(result.is_correct, false);
  missing.validate();
});

test("cropped numeric evidence still verifies a complete original token", () => {
  const repeated = fixture("1087.4万千升", "销量1087.4万千升；重量1087.4万吨。", [check("1087.4", "1087.4")]);
  repeated.result.correctness_evidence[0] = canonicalEvidence(example.request.sources.answer.id, 1, "销量1087.4");
  repeated.validate();
  const substring = fixture("1087.4万千升", "销量21087.4万千升", [check("1087.4", "1087.4")]);
  substring.result.correctness_evidence[0] = canonicalEvidence(example.request.sources.answer.id, 1, "1087.4", "/content", 3);
  assert.throws(substring.validate, code("numeric_answer_context_missing"));
});

test("a unit-bearing table header is tied to the cited target cell's column", () => {
  const table = "| 指标 | 销量（千升） |\n| --- | --- |\n| 总销量 | 10874000 |";
  const valid = fixture("1087.4万千升", table, [check("1087.4", "10874000", "0.0001")]);
  valid.validate();
  valid.result.correctness_evidence[0] = canonicalEvidence(example.request.sources.answer.id, 1, "10874000", "/content", table.indexOf("10874000"));
  valid.validate();
  valid.result.correctness_evidence[0] = canonicalEvidence(example.request.sources.answer.id, 1, JSON.stringify(valid.request.sources.answer.value.messages[1], null, 2), "", 0, "json");
  valid.validate();
  valid.result.numeric_checks[0].scale = "1";
  assert.throws(valid.validate, code("numeric_scale_mismatch"));
});

test("an explicit unit immediately before a table covers its bare numeric cells", () => {
  const answer = "最高值出现在2023年2月，为12.9%。\n\n达标月份的具体数值如下（单位：%）：\n\n" +
    "| 月份 | M2同比 |\n| --- | --- |\n| 2023-01 | 12.6 |\n| 2023-02 | 12.9 |";
  fixture("最高为12.9%", answer, [check("12.9", "12.9")]).validate();
});

test("a table's declared unit cannot turn a date or identifier column into a quantity", () => {
  for (const header of ["日期", "月份", "股票代码", "编号"]) {
    const answer = `单位：元\n\n| ${header} | 价格 |\n| --- | --- |\n| 10 | 8 |`;
    assert.throws(fixture("10元", answer, [check("10", "10")]).validate,
      code("numeric_answer_context_missing"), header);
  }
});

test("an explicit column unit takes precedence over a table declaration", () => {
  fixture("12.9亿元", "单位：%\n\n| 指标 | 收入（亿元） |\n| --- | --- |\n| 收入 | 12.9 |",
    [check("12.9", "12.9")]).validate();
});

test("trading-day counts stay distinct from calendar coordinates in the same evidence", () => {
  const answer = "2026 年 5 月 6 日至 5 月 29 日，最高价在 11 元以上的有 6 天。\n\n" +
    "最高价 ≥ 11 元的 6 个交易日：\n- 5月6日：11.49 元\n- 5月7日：11.22 元";
  const count = fixture("13天", answer, [{ ...check("13", "6"), mode: "exact", matches: false }]);
  count.result.is_correct = false;
  count.validate();
  assert.throws(fixture("6天", "最高价在2026年5月6日为11.49元。", [check("6", "6")]).validate,
    code("numeric_answer_context_missing"));
});

test("equal numerals with different meanings do not veto a supported count assessment", () => {
  const value = taskFixture("给出命中天数。", "6天", "命中6天，占总天数的6%。",
    "回答明确交付命中6天，与标准天数一致；另一个6%是比例，不能用它的单位否定天数。",
    [{ ...check("6", "6"), mode: "exact" }]);
  value.validate();
  assert.equal(submit(value).is_correct, true);
});

test("a trading-day unit header identifies a count rather than a calendar coordinate", () => {
  const answer = "| 指标 | 交易日 |\n| --- | --- |\n| 最高价超过11元 | 6 |";
  fixture("6天", answer, [{ ...check("6", "6"), mode: "exact" }]).validate();
});

test("single-character Chinese day counts stay literal without cropping compound numerals or dates", () => {
  for (const answer of ["共六天", "共六交易日", "共六个交易日"])
    fixture("6天", answer, [{ ...check("6", "6"), mode: "exact" }]).validate();
  for (const answer of ["共二十六天", "共二十六交易日", "日期为2026年5月六日"])
    assert.throws(fixture("6天", answer, [{ ...check("6", "6"), mode: "exact" }]).validate,
      code("numeric_answer_context_missing"), answer);
});

test("unverifiable conversions still require a supported pending-review state", () => {
  const pending = fixture("1087.4万千升", "总销量为3/7个标准容器，资料未说明容器容量。");
  pending.result.is_correct = null;
  pending.result.core_assessment.meets_core = null;
  pending.result.core_assessment.reason = "无法确定容器容量，不能核实最终销量；需要独立复核。";
  pending.result.criterion_assessments[0].status = "unknown";
  pending.result.criterion_assessments[0].evidence_status = "uncertain";
  pending.result.correctness_reason = "标准以万千升表示，回答使用分数容器；容量未知，不能编造换算比例，待复核。";
  pending.validate();
  pending.result.core_assessment.meets_core = true;
  assert.throws(pending.validate, code("correctness_required"));
  pending.result.core_assessment.meets_core = null;
  pending.result.correctness_reason = " ";
  assert.throws(pending.validate, code("correctness_reason_required"));
  pending.result.correctness_reason = "缺少可信换算依据，待复核。";
  pending.result.correctness_evidence = [];
  assert.throws(pending.validate, code("correctness_evidence_required"));
});
