import test from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { buildChecklist, loadRubricStandard } from "./catalog.js";

const generic = Array.from({length:30}, (_, index) => ({
  id: `G${String(index + 1).padStart(2, "0")}`, grp: "表达", criterion: `criterion-${index}`,
  fail: `fail-${index}`, states: ["pass", "fail", "na"], na_when: null, needs: ["qa"], judge: "program",
}));
const fixture = {
  _meta: {name: "fixture"},
  generic: {scope: "全部分类适用", items: generic},
  categories: [{
    id: "FIN-L2-001", name: "示例分类", l1: "FIN-L1-01", l1_name: "示例一级",
    definition: "定义", core: "核心", question_count: 1,
    items: [
      {id: "FIN-L2-001/gate/L1", kind: "gate", criterion: "门槛", fail: "没做到", states: ["pass", "fail", "na"], na_when: "没有用户处境时不评。", needs: ["qa", "user_context"], judge: "model"},
      {id: "FIN-L2-001/quality/Q1", kind: "quality", criterion: "质量", pass: "做到", partial: "部分", fail: "没做到", states: ["pass", "partial", "fail", "na"], na_when: null, needs: ["qa"], judge: "model"},
    ],
  }],
};

function standard(doc: unknown) {
  const path = `/tmp/rubric-standard-${process.pid}-${Math.random().toString(36).slice(2)}.json`;
  writeFileSync(path, JSON.stringify(doc));
  try { return loadRubricStandard(path); } finally { rmSync(path, {force:true}); }
}

test("标准解析保留原文条目与允许状态", () => {
  const parsed = standard(fixture);
  assert.equal(parsed.id, "fixture");
  assert.equal(parsed.generic.length, 30);
  assert.equal(parsed.categories.size, 1);
  const category = parsed.categories.get("FIN-L2-001")!;
  assert.equal(category.name, "示例分类");
  assert.deepEqual(category.items[0]!.states, ["pass", "fail", "na"]);
  assert.equal(category.items[0]!.judge, "model");
  assert.equal(category.items[1]!.partial, "部分");
});

test("checklist 由通用 30 条加该二级分类条目不增不减", () => {
  const parsed = standard(fixture);
  const checklist = buildChecklist(parsed, "FIN-L2-001");
  assert.equal(checklist.length, 32);
  assert.deepEqual(checklist.map(item => item.index), Array.from({length:32}, (_, index) => index + 1));
  assert.equal(checklist[0]!.item_id, "G01");
  assert.equal(checklist[30]!.item_id, "FIN-L2-001/gate/L1");
  assert.equal(checklist[31]!.item_id, "FIN-L2-001/quality/Q1");
  assert.throws(() => buildChecklist(parsed, "FIN-L2-999"), /未知二级分类/u);
});

test("通用条目不足 30 条时拒绝加载", () => {
  const broken = {...fixture, generic: {items: generic.slice(0, 29)}};
  assert.throws(() => standard(broken), /30 条/u);
});

test("条目的允许状态超出四态时拒绝加载", () => {
  const broken = {...fixture, categories: [{...fixture.categories[0]!, items: [{...fixture.categories[0]!.items[0]!, states: ["pass", "score"]}]}]};
  assert.throws(() => standard(broken), /未知状态/u);
});

test("仓库内正式标准可解析且规模符合预期", () => {
  const path = "rubric/overseas-expert-v1.json";
  const parsed = loadRubricStandard(path);
  assert.equal(parsed.generic.length, 30);
  assert.equal(parsed.categories.size, 123);
  for (const category of parsed.categories.values()) {
    assert.ok(/^FIN-L2-[0-9]{3}$/u.test(category.id));
    assert.ok(category.items.length >= 4 && category.items.length <= 6, `${category.id} 条目数异常`);
    for (const item of category.items) {
      assert.deepEqual(item.states.filter(state => !["pass", "partial", "fail", "na"].includes(state)), []);
    }
  }
});
