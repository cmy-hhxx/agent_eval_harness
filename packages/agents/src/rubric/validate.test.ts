import test from "node:test";
import assert from "node:assert/strict";
import { ValidationError, type AgentRequest } from "@eval/contracts";
import type { RubricCase, RubricResult } from "./types.js";
import { validateRubric } from "./validate.js";
import { emptyAudit } from "../../../../tests/fixtures/comparison.js";

const caseId = "thread_00000000000000000000000000000001";
const inputId = "00000000-0000-4000-8000-000000000001";

function caseMaterial(): RubricCase {
  return {
    case_id: caseId, trace_index: 0, batch_id: "rsi_test", version: "aime_expert",
    category: {id: "FIN-L2-053", name: "投资行动决策", l1: "FIN-L1-08", l1_name: "投资决策与交易建议", definition: "定义", core: "核心"},
    task_question: "买入还是等待？", answer: "等待。", availability: {answer: "available", trace: "available", user_context: "partial"},
    checklist: [
      {index: 1, item_id: "G01", source: "generic", grp: "表达", criterion: "答案放在最前", fail: "要翻过铺垫", states: ["pass", "partial", "fail", "na"], na_when: null, needs: ["qa"], judge: "model"},
      {index: 2, item_id: "G03", source: "generic", grp: "表达", criterion: "内部内容没外露", fail: "露出标记", states: ["pass", "fail", "na"], na_when: null, needs: ["qa"], judge: "program"},
      {index: 3, item_id: "FIN-L2-053/gate/L1", source: "category", kind: "gate", criterion: "动作符合用户当前状态", fail: "未持仓谈减持", states: ["pass", "fail", "na"], na_when: "没有用户处境时不评。", needs: ["qa", "user_context"], judge: "model"},
    ],
  };
}

function request(value: RubricCase = caseMaterial()): AgentRequest {
  return {
    input: value as unknown as AgentRequest["input"],
    sources: {answer: {id: inputId, value: {messages: [{type: "final_answer", role: "assistant", content: "等待。"}]}}},
  };
}

function result(overrides: Partial<RubricResult> = {}): RubricResult {
  return {
    case_id: caseId, trace_index: 0, batch_id: "rsi_test", version: "aime_expert",
    category_id: "FIN-L2-053", category_name: "投资行动决策", checklist_size: 3,
    l1_id: "FIN-L1-08", l1_name: "投资决策与交易建议",
    counts: {pass: 2, partial: 0, fail: 0, na: 1},
    verdicts: [
      {item_index: 1, item_id: "G01", source: "generic", state: "pass", reason: "首句即结论。", evidence: [{evidence_id: `ev_${inputId}_0_text_0_2_`, message_index: 0, quote: "等待"}]},
      {item_index: 2, item_id: "G03", source: "generic", state: "pass", reason: "无工具标记。", evidence: [{evidence_id: `ev_${inputId}_0_text_0_2_`, message_index: 0, quote: "等待"}]},
      {item_index: 3, item_id: "FIN-L2-053/gate/L1", source: "category", kind: "gate", state: "na", reason: "无持仓信息。", na_reason: "题面与对话历史没有给出用户处境。", evidence: []},
    ],
    ...overrides,
  };
}

const audit = emptyAudit();

test("合法 checklist 判定通过", () => {
  assert.doesNotThrow(() => validateRubric(request(), result(), audit));
});

test("后续批次沿用完整 checklist 编号，不按批内位置重编号", () => {
  const material = caseMaterial();
  material.checklist = material.checklist.slice(2);
  const value = result({checklist_size: 1, counts: {pass: 0, partial: 0, fail: 0, na: 1}});
  value.verdicts = value.verdicts.slice(2);
  assert.doesNotThrow(() => validateRubric(request(material), value, audit));
});

test("状态必须落在该条允许范围内", () => {
  const broken = result();
  broken.verdicts[2] = {...broken.verdicts[2]!, state: "partial"};
  assert.throws(() => validateRubric(request(), broken, audit), (error: unknown) =>
    error instanceof ValidationError && JSON.stringify(error.issues).includes("只允许"));
});

test("判 na 必须写 na_reason", () => {
  const broken = result();
  delete broken.verdicts[2]!.na_reason;
  assert.throws(() => validateRubric(request(), broken, audit), /na_reason/u);
});

test("非 na 判定必须有原文证据", () => {
  const broken = result();
  broken.verdicts[0] = {...broken.verdicts[0]!, evidence: []};
  assert.throws(() => validateRubric(request(), broken, audit), /证据/u);
});

test("非 na 判定不能填 na_reason", () => {
  const broken = result();
  broken.verdicts[0] = {...broken.verdicts[0]!, na_reason: "不适用"};
  assert.throws(() => validateRubric(request(), broken, audit), /na_reason/u);
});

test("缺条目或重复条目都拒绝", () => {
  const missing = result();
  missing.verdicts = missing.verdicts.slice(0, 2);
  missing.counts = {pass: 2, partial: 0, fail: 0, na: 0};
  missing.checklist_size = 3;
  assert.throws(() => validateRubric(request(), missing, audit), /缺少编号 3/u);
  const duplicate = result();
  duplicate.verdicts = [...duplicate.verdicts, duplicate.verdicts[0]!];
  assert.throws(() => validateRubric(request(), duplicate, audit), /重复判定/u);
});

test("计数必须与逐条判定一致", () => {
  const broken = result();
  broken.counts = {pass: 3, partial: 0, fail: 0, na: 0};
  assert.throws(() => validateRubric(request(), broken, audit), /状态计数/u);
});

test("不能改写条目 ID、来源或二级分类", () => {
  const broken = result();
  broken.verdicts[1] = {...broken.verdicts[1]!, item_id: "G99"};
  assert.throws(() => validateRubric(request(), broken, audit), /条目ID/u);
  const category = result();
  category.category_id = "FIN-L2-001";
  assert.throws(() => validateRubric(request(), category, audit), /二级分类/u);
});
