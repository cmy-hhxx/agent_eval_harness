import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { caseResultView } from "@eval/workflows/comparison";
import type { JsonObject } from "@eval/contracts";
import { attributionResult, comparisonResult } from "../../fixtures/comparison.js";
import { ROOT } from "../../fixtures/services.js";

const { JSDOM } = createRequire(import.meta.url)("jsdom");
const { createDashboardViews } = await import(pathToFileURL(path.join(ROOT, "apps/host/dashboard/dashboard-view.js")).href);

function render(stage: string, result: JsonObject, id = "task-one") {
  const dom = new JSDOM('<div id="case-detail"></div><div id="clustering-tasks"></div>');
  const { document } = dom.window;
  const task = { id, stage, status: "succeeded", versions: ["model"], attempts: 1 };
  const state = {
    caseDetail: { question: "问题", batch_id: "batch", case_id: "case", candidates: [], tasks: [task] },
    clusteringTasks: [task], openTasks: new Set([id]), openFindings: new Set<string>(), expandedTexts: new Set(),
    taskResults: { [id]: { result } },
  };
  const views = createDashboardViews({
    state, document, $: (selector: string) => document.querySelector(selector),
    loading: () => "加载中", label: (value: string) => value, stageLabel: (value: string) => value,
    dateText: String,
    escapeHtml: (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[char]!),
  });
  if (stage === "clustering") views.renderClustering(); else views.renderDetail();
  return { dom, document, views, state };
}

test("dashboard pairs attribution rewrites by slot and indexes strengths and problems without renumbering", () => {
  const evaluation = attributionResult();
  const finding = evaluation.findings[0]!;
  evaluation.findings = [
    { ...finding, type: "problem", text: "缺点原文" },
    { ...finding, type: "strength", text: "优点原文" },
  ];
  const row = { evaluation: { ...evaluation, rewritten: { evaluator_version: "fixture", rewrites: [
    { id: "findings.1.text", text: "优点改写" },
    { id: "summary", text: "总结改写" },
    { id: "findings.0.assessment.impact", text: "影响改写" },
  ] } } };
  const original = structuredClone(row);
  const result = caseResultView("attribution", row)!;
  const { dom, document, views, state } = render("attribution", result, "task/<one>");
  try {
    assert.deepEqual(row, original, "presentation must not mutate accepted results");
    const groups = document.querySelectorAll(".findings-nav-group");
    assert.match(groups[0].textContent, /优点\s+1/);
    assert.match(groups[1].textContent, /缺点\s+1/);
    assert.equal(groups[0].querySelector(".finding-index").textContent, "1");
    assert.equal(groups[1].querySelector(".finding-index").textContent, "0");
    const link = groups[0].querySelector("a");
    const target = document.getElementById(decodeURIComponent(link.hash.slice(1)));
    assert.equal(target.tagName, "DETAILS");
    assert.equal(target.open, false);
    assert.equal(link.dataset.findingTarget, target.id);
    assert.equal(target.querySelector(".rewrite-original .text-content").textContent, "优点原文");
    assert.equal(target.querySelector(".rewrite-polished .text-content").textContent, "优点改写");
    assert.equal(document.querySelectorAll(".rewrite-pair").length, 3);
    assert.equal(document.querySelectorAll(".finding .evidence-list").length, 2);
    const back = target.querySelector(".findings-return");
    assert.equal(document.getElementById(decodeURIComponent(back.hash.slice(1))).getAttribute("aria-label"), "发现目录");
    state.openFindings.add(target.dataset.finding);
    views.renderDetail();
    assert.equal(document.getElementById(target.id).open, true, "expanded findings survive a result render");
  } finally { dom.window.close(); }
});

test("comparison shows each model's attribution with its own rewrites, directory and isolated finding IDs", () => {
  const evaluation = attributionResult();
  const result = caseResultView("comparison", {
    ...comparisonResult(["left", "right"]),
    models: { left: { version: "左模型" }, right: { version: "右模型" } },
    evaluations: {
      left: { ...evaluation, rewritten: { evaluator_version: "fixture", rewrites: [{ id: "findings.0.text", text: "左模型改写" }] } },
      right: { ...evaluation, rewritten: { evaluator_version: "fixture", rewrites: [{ id: "findings.0.text", text: "右模型改写" }] } },
    },
  })!;
  const { dom, document } = render("comparison", result);
  try {
    const models = document.querySelectorAll(".model-evaluation");
    assert.equal(models.length, 2);
    assert.equal(models[0].querySelector("h6").textContent, "左模型");
    assert.equal(models[0].querySelector(".finding .rewrite-polished .text-content").textContent, "左模型改写");
    assert.equal(models[1].querySelector(".finding .rewrite-polished .text-content").textContent, "右模型改写");
    assert.equal(document.querySelectorAll(".finding[open]").length, 0);
    for (const model of models) {
      const target = document.getElementById(model.querySelector("[data-finding-target]").dataset.findingTarget);
      assert(model.contains(target));
    }
    const ids = [...document.querySelectorAll("[id]")].map((node: any) => node.id);
    assert.equal(new Set(ids).size, ids.length);
  } finally { dom.window.close(); }
});

test("dashboard maps blind comparison slots to model fields and actual verdict pair order", () => {
  const row = {
    ...comparisonResult(["left", "right"]),
    assessments: { left: { summary: "左原文", meets_core: false }, right: { summary: "右原文", meets_core: true } },
    decision_basis: { ...comparisonResult(["left", "right"]).decision_basis, tradeoff: "权衡原文", decisive_findings: [] },
    evaluations: {},
    verdicts: { left__vs__right: { reason: "判决原文", result: "win", winner_name: "右模型" } },
    rewritten: { evaluator_version: "fixture", rewrites: [
      { id: "assessment.A.summary", text: "右改写" },
      { id: "verdict.A__vs__B.reason", text: "判决改写" },
      { id: "assessment.B.summary", text: "左改写" },
      { id: "tradeoff", text: "权衡改写" },
    ] },
  };
  const result = caseResultView("comparison", row, { A: "right", B: "left" })!;
  const { dom, document } = render("comparison", result);
  try {
    const pairs = [...document.querySelectorAll(".rewrite-pair")].map((pair: any) => [
      pair.querySelector(".rewrite-original .text-content").textContent,
      pair.querySelector(".rewrite-polished .text-content").textContent,
    ]);
    assert.deepEqual(pairs, [["左原文", "左改写"], ["右原文", "右改写"], ["判决原文", "判决改写"]]);
    assert.equal(document.querySelector(".comparison-decision .comparison-copy > .expandable-text").textContent.trim(), "权衡改写");
    assert.equal(document.querySelector(".comparison-decision .comparison-original .text-content").textContent, "权衡原文");
    assert.throws(() => caseResultView("comparison", row), /改写槽位缺少字段映射/);
  } finally { dom.window.close(); }
});

test("dashboard aligns models by version, prioritizes impact, and keeps rewrites and finding links attached to their row", () => {
  const row = {
    ...comparisonResult(["left", "right"]),
    models: { left: { version: "A组Fast" }, right: { version: "AA组Fast" } },
    verdicts: { left__vs__right: { result: "win", winner_name: "A组Fast", winner_version: "left", reason: "完成核心要求" } },
    evaluations: { left: attributionResult(), right: attributionResult() },
    decision_basis: { tradeoff: "A组Fast更好，方案比较更具体。", decisive_findings: [], comparisons: [
      { aspect: "脚注", importance: "low", better_candidates: ["right"], assessments: {
        left: { summary: "脚注编号错位。", finding_indices: [] }, right: { summary: "编号准确。", finding_indices: [] },
      } },
      { aspect: "对冲方案", importance: "high", better_candidates: ["left"], assessments: {
        left: { summary: "比较了多种对冲工具。", finding_indices: [0] }, right: { summary: "只提到人民币融资。", finding_indices: [0] },
      } },
    ] },
    rewritten: { evaluator_version: "fixture", rewrites: [
      { id: "comparison.1.B.summary", text: "比较远期与期权。" },
      { id: "comparison.1.A.summary", text: "未比较对冲方案。<img src=x>" },
    ] },
  };
  const { dom, document } = render("comparison", caseResultView("comparison", row, { A: "right", B: "left" })!);
  try {
    const rows = document.querySelectorAll(".comparison-table tbody tr");
    assert.equal(rows[0].dataset.comparisonIndex, "1", "high-impact rows precede minor footnotes");
    assert.equal(rows[1].dataset.comparisonIndex, "0");
    const left = rows[0].querySelector('[data-candidate="left"]');
    const right = rows[0].querySelector('[data-candidate="right"]');
    assert.match(left.textContent, /本项更好.*比较远期与期权/s);
    assert.match(right.textContent, /未比较对冲方案/);
    assert.equal(right.querySelector("img"), null);
    assert.equal(left.querySelector(".comparison-original").open, false);
    assert.match(left.querySelector(".comparison-original").textContent, /比较了多种对冲工具/);
    const target = document.getElementById(left.querySelector("a").dataset.findingTarget);
    assert.match(target.id, /evaluations.left.findings.0$/);
    assert.equal(document.querySelector(".comparison-attributions").open, false);
    assert.match(document.querySelector(".comparison-decision").textContent, /A组Fast更好/);
    assert.equal(document.querySelectorAll(".comparison-decision .findings-nav").length, 0);
  } finally { dom.window.close(); }
});

test("dashboard pairs clustering rewrites inside arrays and escapes text", () => {
  const result = caseResultView("clustering", { result: {
    new_classes: [{ label: "问题类", definition: "定义原文", novelty: "理由原文" }], merges: [{ reason: "合并原文" }],
    rewritten: { evaluator_version: "fixture", rewrites: [
      { id: "merges.0.reason", text: "合并改写" },
      { id: "new_classes.0.definition", text: '<img src=x onerror="alert(1)">' },
    ] },
  } })!;
  const { dom, document } = render("clustering", result);
  try {
    assert.equal(document.querySelectorAll(".rewrite-pair").length, 2);
    assert.equal(document.querySelector(".rewrite-polished .text-content").textContent, '<img src=x onerror="alert(1)">');
    assert.equal(document.querySelectorAll("img").length, 0);
  } finally { dom.window.close(); }
});

test("dashboard shows empty finding groups and no rewrite columns when no rewrites exist", () => {
  const evaluation = attributionResult();
  evaluation.findings = [];
  const { dom, document } = render("attribution", caseResultView("attribution", { evaluation })!);
  try {
    assert.equal(document.querySelectorAll(".rewrite-pair").length, 0);
    assert.equal(document.querySelectorAll(".findings-nav-group .muted").length, 2);
    assert.equal(document.querySelectorAll(".findings-nav a").length, 0);
  } finally { dom.window.close(); }
});
