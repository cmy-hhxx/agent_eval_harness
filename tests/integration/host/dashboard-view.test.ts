import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { caseResultView } from "@eval/workflows/comparison";
import type { JsonObject } from "@eval/contracts";
import { attributionResult } from "../../fixtures/comparison.js";
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
    assessments: { left: { summary: "左原文", meets_core: false }, right: { summary: "右原文", meets_core: true } },
    decision_basis: { tradeoff: "权衡原文", decisive_findings: [] },
    verdicts: { left__vs__right: { reason: "判决原文", result: "win" } },
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
    assert.deepEqual(pairs, [["左原文", "左改写"], ["右原文", "右改写"], ["权衡原文", "权衡改写"], ["判决原文", "判决改写"]]);
    assert.throws(() => caseResultView("comparison", row), /改写槽位缺少字段映射/);
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
