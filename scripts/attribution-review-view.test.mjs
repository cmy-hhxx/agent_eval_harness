import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM, VirtualConsole } from "jsdom";
import { renderAttributionReview } from "./attribution-review-view.mjs";

const baseCss = await readFile(new URL("../apps/host/dashboard/dashboard.css", import.meta.url), "utf8");
const problemCss = await readFile(new URL("../apps/host/dashboard/problems.css", import.meta.url), "utf8");
const modelIds = ["a_fast", "a_expert", "b_fast", "b_expert"];
const groupId = (model, index = 1) => (modelIds.indexOf(model) + 1) + "0000000-0000-4000-8000-00000000000" + index;
function fixture() {
  const labels = ["引用格式失效", "关键步骤遗漏", "alert 参数缺失", "任务边界误判"];
  const samples = [], nodes = [], pending = { label: "待观察池", samples: [], observations: [] };
  const observation = (sample, findingId, summary, libraryStatus = "deferred") => ({ sampleId: sample.id, findingId, summary,
    components: libraryStatus === "unlocated" ? [] : ["模型推断与生成/事实关系推导"], evidenceStatus: "已确认", importance: "high", libraryStatus });
  for (const [modelIndex, model] of modelIds.entries()) {
    const own = Array.from({ length: modelIndex < 2 ? 8 : 7 }, (_, index) => {
      const id = "sample-" + (samples.length + index + 1), clean = modelIndex < 2 && index === 7;
      return { id, inputId: "answer-" + id, taskId: "task-" + id, date: "2026-10-0" + (index % 3 + 1), caseId: "case-" + id,
        model, modelName: model, taskSummary: "整理过的任务摘要 " + id, hasStandard: index % 2 === 0,
        problemCount: 0, summary: clean ? "无已确认问题" : "整理过的问题摘要 " + id,
        components: clean ? [] : ["模型推断与生成/事实关系推导"], importance: clean ? null : "high", evidenceStatus: clean ? null : "已确认",
        source: { label: "源引用", href: "./source.jsonl#" + id }, resultLink: "./" + model + ".jsonl#" + id, groupIds: [] };
    });
    samples.push(...own);
    for (const [index, members] of [[1, own.slice(0, 3)], [2, own.slice(2, 5)]]) {
      const label = index === 1 ? labels[modelIndex] : model + " 的补充核验缺口", id = groupId(model, index);
      nodes.push({ id, model, category: index === 1 ? "输出准确性" : "需求满足", label, definition: label + "的一句定义。",
        observations: members.map(sample => observation(sample, id, label + " " + sample.id)),
        samples: members.map(sample => sample.id), sampleCount: members.length, problemCount: members.length });
    }
    for (const [index, sample] of own.slice(5, 7).entries()) {
      pending.samples.push(sample.id); pending.observations.push(observation(sample, "pending", "池内问题 " + sample.id, index ? "unlocated" : "deferred"));
    }
  }
  nodes[0].observations.push(observation(samples[0], "extra-1", "同组额外问题一"), observation(samples[0], "extra-2", "同组额外问题二"));
  nodes[0].problemCount += 2;
  for (const item of [...nodes.flatMap(node => node.observations), ...pending.observations]) samples.find(sample => sample.id === item.sampleId).problemCount++;
  for (const sample of samples) sample.groupIds = nodes.filter(node => node.samples.includes(sample.id)).map(node => node.id);
  const models = modelIds.map(model => ({ id: model, model, label: model, sampleCount: samples.filter(sample => sample.model === model).length,
    targetCount: samples.filter(sample => sample.model === model).length, unfinishedCount: 0,
    problemCount: samples.filter(sample => sample.model === model).reduce((count, sample) => count + sample.problemCount, 0), nodeCount: nodes.filter(node => node.model === model).length }));
  pending.sampleCount = pending.samples.length; pending.problemCount = pending.observations.length;
  return { attributionTree: { models, nodes, samples, unfinished: [], pending, totals: { samples: 30, targetSamples: 30, unfinishedSamples: 0, problems: samples.reduce((count, sample) => count + sample.problemCount, 0) } },
    rows: [{ question: "绝不内嵌的原问题正文", standard: "绝不内嵌的标准答案正文", raw: { summary: "绝不内嵌的原始点评全文" } }],
    ledgers: [{ secret: "绝不内嵌的运行账本" }], notes: "绝不内嵌的修复建议" };
}
function paginationFixture() {
  const data = fixture(), tree = data.attributionTree;
  for (let index = 8; index < 30; index++) tree.samples.push({ ...tree.samples[7], id: "extra-" + index, inputId: "extra-answer-" + index,
    taskId: "extra-task-" + index, caseId: "extra-case-" + index, date: "2026-10-0" + (index % 3 + 1), hasStandard: index % 2 === 0 });
  tree.models[0].sampleCount = 30; tree.models[0].targetCount = 30; tree.totals.samples = tree.samples.length;
  return data;
}
function view(t, data = fixture()) {
  const errors = [], console = new VirtualConsole(); console.on("jsdomError", error => errors.push(error));
  const html = renderAttributionReview(data, baseCss, problemCss), dom = new JSDOM(html, { runScripts: "dangerously", virtualConsole: console, url: "file:///safe/review.html" });
  t.after(() => dom.window.close());
  const document = dom.window.document;
  const select = (id, value) => { document.getElementById(id).value = String(value); document.getElementById(id).dispatchEvent(new dom.window.Event(id === "problem-search" ? "input" : "change")); };
  const tab = model => [...document.querySelectorAll("[role=tab]")].find(node => node.dataset.model === model);
  const tableRows = () => [...document.querySelectorAll("tbody tr[data-sample-id]")];
  const treeNodes = () => {
    for (const category of document.querySelectorAll('[data-node-kind="category"][aria-expanded="false"]')) category.click();
    return [...document.querySelectorAll('[data-node-kind="node"]')];
  };
  const group = id => treeNodes().find(node => node.dataset.problem === id);
  return { data, dom, document, html, errors, select, tab, tableRows, treeNodes, group };
}

test("curated page defaults to A Fast with four model tabs and excludes original bodies and metadata", t => {
  const data = fixture(); Object.defineProperty(data, "files", { get() { throw new Error("the view must not read download data"); } });
  const { document, html, errors, tableRows } = view(t, data);
  assert.equal(document.querySelectorAll("[role=tab]").length, 4);
  assert.equal(document.querySelector('[role=tab][aria-selected=true]').dataset.model, "a_fast");
  assert.equal(document.getElementById("problem-detail").dataset.nodeId, groupId("a_fast"));
  assert.equal(document.querySelector(".problem-definition").textContent, "引用格式失效的一句定义。");
  assert.equal(tableRows().length, 3);
  assert.deepEqual([...document.querySelectorAll("thead th")].map(node => node.textContent), ["日期", "模型", "样本编号", "任务摘要", "本节点问题摘要", "责任", "影响程度", "证据状态"]);
  assert.equal(document.querySelectorAll("nav,#files,a,[download]").length, 0);
  assert.equal(tableRows()[0].querySelector(".review-sample-id").textContent, "sample-1");
  assert.equal(document.querySelectorAll("details,#run-records,#review-notes,#footer,.review-model-distribution").length, 0);
  assert(html.includes(problemCss)); assert(html.includes(baseCss));
  assert.equal(document.querySelector(".problem-search>svg").getAttribute("viewBox"), "0 0 20 20");
  for (const value of ["绝不内嵌的原问题正文", "绝不内嵌的标准答案正文", "绝不内嵌的原始点评全文", "绝不内嵌的运行账本", "绝不内嵌的修复建议"]) assert(!html.includes(value), value);
  const payload = JSON.parse(document.getElementById("report-data").textContent);
  assert.deepEqual(Object.keys(payload), ["attributionTree"]);
  assert.equal(payload.attributionTree.samples[0].resultLink, data.attributionTree.samples[0].resultLink);
  assert.deepEqual(payload.attributionTree.samples[0].source, data.attributionTree.samples[0].source);
  assert.deepEqual(errors, []);
});

test("four model trees have independent UUIDs, labels, members and support, with isolated recall of all 30 answers", t => {
  const { data, document, tab, tableRows, treeNodes, errors } = view(t), seen = [], labelSets = [];
  for (const model of modelIds) {
    tab(model).click();
    const own = data.attributionTree.nodes.filter(node => node.model === model), buttons = treeNodes();
    assert.deepEqual(buttons.map(button => button.dataset.problem), own.map(node => node.id));
    assert.equal(document.getElementById("problem-detail").dataset.nodeId, own[0].id);
    assert.match(document.querySelector(".review-stats").textContent, new RegExp("^3 关联回答"));
    assert.deepEqual(tableRows().map(row => row.dataset.sampleId), own[0].samples);
    assert(tableRows().every(row => row.querySelector(".review-model").textContent === model));
    assert(!buttons.some(button => data.attributionTree.nodes.find(node => node.id === button.dataset.problem).model !== model));
    labelSets.push(buttons.map(button => button.querySelector(".tree-label").textContent).join("|"));
    document.getElementById("all-samples").click();
    assert.equal(tableRows().length, data.attributionTree.models.find(item => item.model === model).sampleCount);
    assert(tableRows().every(row => row.querySelector(".review-model").textContent === model));
    seen.push(...tableRows().map(row => row.dataset.inputId));
    assert.match(document.getElementById("all-samples").textContent, /^本模型已接受样本/u);
    document.getElementById("pending-pool").click(); assert.equal(tableRows().length, 2);
    assert(tableRows().every(row => row.querySelector(".review-model").textContent === model));
  }
  assert.equal(new Set(labelSets).size, 4); assert.equal(new Set(data.attributionTree.nodes.map(node => node.id)).size, 8);
  assert.equal(seen.length, 30); assert.equal(new Set(seen).size, 30);
  assert.deepEqual(errors, []);
});

test("model switching remembers each model's own node without borrowing another model's selection", t => {
  const { document, tab, group, tableRows, errors } = view(t);
  group(groupId("a_fast", 2)).click(); tab("a_expert").click();
  assert.equal(document.activeElement.dataset.model, "a_expert");
  assert.equal(document.getElementById("problem-detail").dataset.nodeId, groupId("a_expert"));
  assert.equal(group(groupId("a_fast", 2)), undefined);
  group(groupId("a_expert", 2)).click(); tab("b_fast").click();
  assert.equal(document.getElementById("problem-detail").dataset.nodeId, groupId("b_fast"));
  tab("a_fast").click(); assert.equal(document.getElementById("problem-detail").dataset.nodeId, groupId("a_fast", 2));
  assert(tableRows().every(row => row.querySelector(".review-model").textContent === "a_fast"));
  tab("a_expert").click(); assert.equal(document.getElementById("problem-detail").dataset.nodeId, groupId("a_expert", 2));
  assert.deepEqual(errors, []);
});

test("coverage follows the active model's totals and remains unchanged by recall filters", t => {
  const data = fixture(), tree = data.attributionTree, moved = tree.nodes.find(node => node.id === groupId("b_fast", 2));
  tree.nodes = tree.nodes.filter(node => node !== moved);
  tree.pending.observations.push(...moved.observations);
  tree.pending.samples = [...new Set([...tree.pending.samples, ...moved.samples])];
  const { document, tab, select, errors } = view(t, data);
  const counts = () => [...document.querySelectorAll("#coverage b")].map(node => Number(node.textContent));
  for (const model of modelIds) {
    tab(model).click();
    const record = tree.models.find(item => item.model === model);
    const expected = [record.targetCount, record.sampleCount, record.unfinishedCount, record.problemCount, tree.nodes.filter(node => node.model === model).length,
      tree.pending.observations.filter(item => tree.samples.find(sample => sample.id === item.sampleId).model === model).length];
    assert.deepEqual(counts(), expected);
    select("problem-search", "不匹配任何样本"); select("date", "2026-10-01");
    assert.deepEqual(counts(), expected, "filters change table recall rather than the model's total coverage");
    document.getElementById("reset").click();
  }
  assert.deepEqual(errors, []);
});

test("pagination deduplicates multiple findings and provides 10/20/50 rows within the selected model", t => {
  const { document, select, tableRows, errors } = view(t, paginationFixture());
  assert.equal(tableRows().filter(row => row.dataset.sampleId === "sample-1").length, 1, "three findings share one answer row");
  assert.match(tableRows()[0].querySelector(".review-problem-summary").textContent, /同组额外问题一.*同组额外问题二/u);
  assert(!document.querySelector("tbody").textContent.includes("补充核验缺口"));
  document.getElementById("all-samples").click();
  const seen = [];
  for (let page = 1; page <= 3; page++) {
    assert.equal(document.getElementById("page-status").textContent, page + " / 3 页");
    assert(tableRows().every(row => row.querySelector(".review-model").textContent === "a_fast"));
    seen.push(...tableRows().map(row => row.dataset.inputId));
    if (page < 3) document.getElementById("page-next").click();
  }
  assert.equal(seen.length, 30); assert.equal(new Set(seen).size, 30); assert.equal(document.getElementById("page-next").disabled, true);
  select("page-size", 20); assert.equal(tableRows().length, 20); assert.equal(document.getElementById("page-status").textContent, "1 / 2 页");
  document.getElementById("page-next").click(); assert.equal(tableRows().length, 10);
  select("page-size", 50); assert.equal(tableRows().length, 30); assert.equal(document.getElementById("page-status").textContent, "1 / 1 页");
  assert.deepEqual(errors, []);
});

test("four 100-answer model selections paginate independently at 10, 20 and 50 without missing or borrowed answers", t => {
  const data = fixture(), tree = data.attributionTree;
  for (const model of modelIds) {
    const own = tree.samples.filter(sample => sample.model === model), template = own[0];
    for (let index = own.length; index < 100; index++) tree.samples.push({ ...template, id: model + "-extra-" + index,
      inputId: model + "-input-" + index, taskId: model + "-task-" + index, caseId: model + "-case-" + index,
      problemCount: 0, summary: "无已确认问题", components: [], importance: null, evidenceStatus: null, groupIds: [] });
    tree.models.find(item => item.model === model).sampleCount = 100;
    tree.models.find(item => item.model === model).targetCount = 100;
  }
  tree.totals.samples = 400;
  const { document, tab, select, tableRows, errors } = view(t, data), all = new Set();
  for (const model of modelIds) {
    tab(model).click(); document.getElementById("all-samples").click();
    for (const size of [10, 20, 50]) {
      select("page-size", size);
      const seen = [];
      for (let page = 1; page <= 100 / size; page++) {
        assert.equal(tableRows().length, size); assert.equal(document.getElementById("page-status").textContent, page + " / " + 100 / size + " 页");
        assert(tableRows().every(row => row.querySelector(".review-model").textContent === model));
        seen.push(...tableRows().map(row => row.dataset.inputId));
        if (page < 100 / size) document.getElementById("page-next").click();
      }
      assert.equal(seen.length, 100); assert.equal(new Set(seen).size, 100);
      if (size === 50) for (const id of seen) all.add(id);
      assert.equal(document.getElementById("page-next").disabled, true);
    }
  }
  assert.equal(all.size, 400); assert.equal(document.querySelectorAll("nav,a,[download]").length, 0);
  assert.deepEqual(errors, []);
});

test("partial 400-answer targets separate accepted and unfinished pagination, including a model with no accepted answers", t => {
  const data = fixture(), tree = data.attributionTree, removed = new Set(tree.samples.filter(sample => sample.model === "b_expert").map(sample => sample.id));
  tree.samples = tree.samples.filter(sample => !removed.has(sample.id)); tree.nodes = tree.nodes.filter(node => node.model !== "b_expert");
  tree.pending.samples = tree.pending.samples.filter(id => !removed.has(id)); tree.pending.observations = tree.pending.observations.filter(item => !removed.has(item.sampleId));
  for (const model of tree.models) {
    model.sampleCount = tree.samples.filter(sample => sample.model === model.model).length; model.targetCount = 100; model.unfinishedCount = 100 - model.sampleCount;
    model.problemCount = tree.samples.filter(sample => sample.model === model.model).reduce((sum, sample) => sum + sample.problemCount, 0);
    for (let index = model.sampleCount; index < 100; index++) tree.unfinished.push({ id: model.model + "-unfinished-" + index, inputId: model.model + "-remaining-" + index,
      model: model.model, modelName: model.model, date: "2026-10-14", caseId: "remaining-" + index, taskSummary: "未完成任务摘要 " + index, hasStandard: true });
  }
  const { document, tab, select, tableRows, errors } = view(t, data);
  document.getElementById("all-samples").click(); assert.equal(tableRows().length, 8);
  select("focus", "no_problem"); assert.deepEqual(tableRows().map(row => row.dataset.sampleId), ["sample-8"]);
  document.getElementById("unfinished-samples").click(); assert.equal(document.getElementById("focus").value, "");
  assert.deepEqual([...document.querySelectorAll("thead th")].map(node => node.textContent), ["日期", "模型", "样本编号", "任务摘要"]);
  assert.equal(document.querySelectorAll(".review-problem-summary,.review-responsibility,.review-evidence").length, 0);
  for (const size of [10, 20, 50]) {
    select("page-size", size); const seen = [];
    while (true) {
      assert(tableRows().every(row => row.querySelector(".review-model").textContent === "a_fast"));
      seen.push(...tableRows().map(row => row.dataset.inputId));
      if (document.getElementById("page-next").disabled) break;
      document.getElementById("page-next").click();
    }
    assert.equal(seen.length, 92); assert.equal(new Set(seen).size, 92);
  }
  tab("b_expert").click(); assert.equal(document.getElementById("problem-detail").dataset.view, "unfinished");
  assert.deepEqual([...document.querySelectorAll("#coverage b")].slice(0, 3).map(node => Number(node.textContent)), [100, 0, 100]);
  assert.equal(tableRows().length, 50); assert(tableRows().every(row => row.querySelector(".review-model").textContent === "b_expert"));
  document.getElementById("all-samples").click(); assert.equal(tableRows().length, 0, "unfinished inputs cannot become clean accepted answers");
  assert.equal(document.querySelectorAll("nav,a,[download]").length, 0); assert.deepEqual(errors, []);
});

test("multi-responsibility observations keep branch responsibility scoped and global and pending counts unique", t => {
  const data = fixture(), tree = data.attributionTree, first = tree.nodes[0], same = first.observations[0];
  const extra = { ...first, id: groupId("a_fast", 3), category: "工具接入与协议/返回解析", label: "独立工具责任", samples: [same.sampleId], sampleCount: 1, problemCount: 1,
    observations: [{ ...same, components: ["工具接入与协议/返回解析"], libraryStatus: "classified", findingLibraryStatus: "mixed" }] };
  first.observations[0] = { ...same, components: ["模型推断与生成/事实关系推导"], libraryStatus: "classified", findingLibraryStatus: "mixed" };
  tree.nodes.push(extra);
  const pending = tree.pending.observations[0];
  tree.pending.observations.push({ ...pending, components: ["工具接入与协议/返回解析"] });
  const { document, group, select, tableRows, errors } = view(t, data);
  group(extra.id).click();
  assert.equal(tableRows().length, 1); assert.equal(tableRows()[0].querySelector(".review-responsibility").textContent, "工具接入与协议/返回解析");
  select("focus", "mixed"); assert.equal(tableRows().length, 1);
  document.getElementById("reset").click(); document.getElementById("all-samples").click();
  assert.equal(tableRows().filter(row => row.dataset.sampleId === same.sampleId).length, 1);
  assert.equal(tableRows().find(row => row.dataset.sampleId === same.sampleId).querySelector(".review-responsibility").textContent, "模型推断与生成/事实关系推导、工具接入与协议/返回解析");
  assert.equal(Number(document.querySelectorAll("#coverage b")[5].textContent), 2);
  document.getElementById("pending-pool").click(); assert.equal(tableRows().length, 2);
  assert.match(document.querySelector(".review-stats").textContent, /2 归因问题/u);
  assert.deepEqual(errors, []);
});

test("node, pool, model and filter changes reset pagination and retain scoped observations", t => {
  const { document, select, tab, group, tableRows, errors } = view(t, paginationFixture());
  document.getElementById("all-samples").click(); document.getElementById("page-next").click();
  group(groupId("a_fast", 2)).click(); assert.equal(document.getElementById("page-status").textContent, "1 / 1 页");
  assert(tableRows().every(row => row.querySelector(".review-problem-summary").textContent.startsWith("a_fast 的补充核验缺口")));
  document.getElementById("pending-pool").click(); assert.equal(tableRows().length, 2);
  assert(tableRows().every(row => row.querySelector(".review-problem-summary").textContent.startsWith("池内问题")));
  select("focus", "unlocated"); assert.equal(tableRows().length, 1); assert.equal(tableRows()[0].querySelector(".review-responsibility").textContent, "责任未定位");
  document.getElementById("reset").click(); document.getElementById("all-samples").click(); document.getElementById("page-next").click();
  select("date", "2026-10-01"); assert.equal(document.getElementById("page-status").textContent, "1 / 1 页"); assert.equal(tableRows().length, 10);
  select("standard", "yes"); assert.equal(tableRows().length, 5);
  document.getElementById("reset").click(); document.getElementById("page-next").click(); tab("b_fast").click();
  assert.equal(document.getElementById("page-status").textContent, "1 / 1 页"); assert.equal(tableRows().length, 3);
  assert(tableRows().every(row => row.querySelector(".review-model").textContent === "b_fast"));
  assert.deepEqual(errors, []);
});

test("unlocated focus leaves formal nodes for each model's pending pool and falls back to its own samples", t => {
  const data = fixture(), tree = data.attributionTree;
  tree.pending.observations = tree.pending.observations.filter(item => tree.samples.find(sample => sample.id === item.sampleId).model !== "b_fast");
  tree.pending.samples = tree.pending.samples.filter(id => tree.samples.find(sample => sample.id === id).model !== "b_fast");
  const { document, select, tab, tableRows, errors } = view(t, data);
  assert.equal(document.getElementById("problem-detail").dataset.view, "node");
  select("focus", "unlocated");
  for (const model of ["a_fast", "a_expert", "b_expert"]) {
    tab(model).click();
    const unknown = tree.pending.observations.find(item => item.libraryStatus === "unlocated" && tree.samples.find(sample => sample.id === item.sampleId).model === model);
    assert.equal(document.getElementById("problem-detail").dataset.view, "pending");
    assert.deepEqual(tableRows().map(row => row.dataset.sampleId), [unknown.sampleId]);
    assert.equal(tableRows()[0].querySelector(".review-responsibility").textContent, "责任未定位");
    assert.equal(document.getElementById("page-status").textContent, "1 / 1 页");
  }
  tab("b_fast").click(); assert.equal(document.getElementById("problem-detail").dataset.view, "all");
  assert.equal(tableRows().length, 0, "an empty model pool cannot borrow another model's unknown findings");
  document.getElementById("reset").click(); tab("a_fast").click(); select("focus", "deferred");
  assert.equal(document.getElementById("problem-detail").dataset.view, "node");
  assert.equal(tableRows().length, 3, "other status filters retain the selected node's scope");
  assert.deepEqual(errors, []);
});

test("curated search and directional keyboard navigation preserve exact model and group membership", t => {
  const { document, dom, select, tableRows, errors } = view(t);
  select("problem-search", "同组额外问题一"); assert.equal(tableRows().length, 1);
  document.getElementById("all-samples").click(); assert.equal(tableRows().length, 1); assert.equal(tableRows()[0].dataset.sampleId, "sample-1");
  select("problem-search", "引用格式失效"); assert.equal(document.getElementById("sample-count").textContent, "3 份回答");
  document.getElementById("reset").click();
  const key = (node, value) => node.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true }));
  document.querySelector('[data-node-kind="root"]').focus();
  key(document.activeElement, "ArrowDown"); assert.equal(document.activeElement.dataset.nodeKind, "category");
  key(document.activeElement, "ArrowRight"); assert.equal(document.activeElement.dataset.nodeKind, "node");
  key(document.activeElement, "Enter"); assert.equal(document.getElementById("problem-detail").dataset.nodeId, groupId("a_fast"));
  assert.equal(document.activeElement.dataset.nodeKey, groupId("a_fast"));
  key(document.activeElement, "ArrowLeft"); assert.equal(document.activeElement.dataset.nodeKind, "category");
  key(document.activeElement, "ArrowLeft"); assert.equal(document.activeElement.getAttribute("aria-expanded"), "false");
  key(document.activeElement, "ArrowRight"); assert.equal(document.activeElement.getAttribute("aria-expanded"), "true");
  key(document.querySelector('[role=tab][aria-selected=true]'), "ArrowRight"); assert.equal(document.activeElement.dataset.model, "a_expert");
  assert.equal(document.getElementById("problem-detail").dataset.nodeId, groupId("a_expert"));
  select("problem-search", "引用格式失效"); assert.equal(document.querySelectorAll('[data-node-kind="node"]').length, 0); assert.equal(tableRows().length, 0);
  assert.deepEqual(errors, []);
});

test("node search excludes other summaries, mixed responsibility stays visible, and clean recall stays within each model", t => {
  const data = fixture(), node = data.attributionTree.nodes[0], sample = data.attributionTree.samples[0];
  sample.summary = "只有另一节点讨论的内容";
  node.observations.push({ sampleId: sample.id, findingId: "unlocated-extra", summary: "本组责任未定位的缺陷", components: [], evidenceStatus: "已确认", importance: "high", libraryStatus: "unlocated" });
  sample.problemCount++; node.problemCount++; data.attributionTree.totals.problems++;
  const { document, select, tab, tableRows, group, errors } = view(t, data);
  assert.equal(tableRows()[0].querySelector(".review-responsibility").textContent, "模型推断与生成/事实关系推导、责任未定位");
  select("problem-search", sample.summary); assert.equal(tableRows().length, 0);
  document.getElementById("all-samples").click(); assert.equal(tableRows().length, 1);
  assert.equal(tableRows()[0].querySelector(".review-responsibility").textContent, "模型推断与生成/事实关系推导、责任未定位");
  document.getElementById("reset").click(); group(groupId("a_fast")).click();
  select("focus", "no_problem"); assert.equal(document.getElementById("problem-detail").dataset.view, "all");
  assert.deepEqual(tableRows().map(row => row.dataset.sampleId), ["sample-8"]);
  assert.equal(tableRows()[0].querySelector(".review-responsibility").textContent, "—");
  tab("a_expert").click(); assert.deepEqual(tableRows().map(row => row.dataset.sampleId), ["sample-16"]);
  tab("b_fast").click(); assert.equal(tableRows().length, 0);
  assert.deepEqual(errors, []);
});

test("models with no nodes use their own pending pool or their own samples", t => {
  const data = fixture(), tree = data.attributionTree, removed = tree.nodes.filter(node => node.model === "b_expert");
  tree.pending.observations.push(...removed.flatMap(node => node.observations));
  tree.pending.samples = [...new Set([...tree.pending.samples, ...removed.flatMap(node => node.samples)])];
  tree.nodes = tree.nodes.filter(node => node.model !== "b_expert" && node.model !== "a_expert");
  tree.pending.observations = tree.pending.observations.filter(item => tree.samples.find(sample => sample.id === item.sampleId).model !== "a_expert");
  tree.pending.samples = tree.pending.samples.filter(id => tree.samples.find(sample => sample.id === id).model !== "a_expert");
  for (const sample of tree.samples.filter(sample => sample.model === "a_expert")) { sample.problemCount = 0; sample.summary = "无已确认问题"; sample.components = []; sample.importance = null; sample.evidenceStatus = null; }
  const { document, tab, tableRows, treeNodes, errors } = view(t, data);
  tab("b_expert").click(); assert.equal(treeNodes().length, 0); assert.equal(document.getElementById("problem-detail").dataset.view, "pending");
  assert.equal(tableRows().length, 7); assert(tableRows().every(row => row.querySelector(".review-model").textContent === "b_expert"));
  tab("a_expert").click(); assert.equal(treeNodes().length, 0); assert.equal(document.getElementById("problem-detail").dataset.view, "all");
  assert.equal(tableRows().length, 8); assert(tableRows().every(row => row.querySelector(".review-model").textContent === "a_expert"));
  assert.deepEqual(errors, []);
});

test("untrusted summaries stay text, stored references create no links, and the page is offline", t => {
  const data = fixture(), injection = '</script><img src="https://invalid.test/x" onerror="globalThis.attacked=true">';
  data.attributionTree.nodes[0].label = injection; data.attributionTree.nodes[0].definition = injection;
  data.attributionTree.nodes[0].observations[0].summary = injection; data.attributionTree.samples[0].taskSummary = injection;
  data.attributionTree.samples[0].resultLink = "javascript:globalThis.attacked=true"; data.attributionTree.samples[0].source.href = "https://invalid.test/source";
  const { document, dom, errors } = view(t, data);
  assert(document.getElementById("problem-detail").textContent.includes(injection));
  assert.equal(document.querySelectorAll("img,script[src],link[rel=stylesheet]").length, 0);
  assert.equal(document.querySelectorAll("a,nav,[download]").length, 0);
  assert.equal(dom.window.attacked, undefined);
  assert.deepEqual(errors, []);
});
