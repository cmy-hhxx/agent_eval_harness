import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { caseResultView } from "@eval/workflows/comparison";
import type { JsonObject } from "@eval/contracts";
import { attributionResult, comparisonResult, criteriaResult } from "../../fixtures/comparison.js";
import { ROOT } from "../../fixtures/services.js";

const { JSDOM } = createRequire(import.meta.url)("jsdom");
const { createDashboardViews } = await import(pathToFileURL(path.join(ROOT, "apps/host/dashboard/dashboard-view.js")).href);

type ViewCandidate = { input_id: string; version: string; name: string };
type ViewTask = {
  id: string; stage: string; status: string; versions: string[]; attempts: number;
  review_of?: { task_id: string; round: number; reasons: string[] };
  result_status?: "decided" | "needs_review";
};

function render(stage: string, result: JsonObject, id = "task-one") {
  const dom = new JSDOM('<div id="case-detail"></div><div id="clustering-tasks"></div>');
  const { document } = dom.window;
  const task: ViewTask = { id, stage, status: "succeeded", versions: ["model"], attempts: 1 };
  const state = {
    caseDetail: { question: "问题", batch_id: "batch", case_id: "case", ground_truth: { available: false, value: null as unknown }, candidates: [] as ViewCandidate[], tasks: [task] },
    clusteringTasks: [task], openTasks: new Set([id]), openFindings: new Set<string>(), expandedTexts: new Set(),
    selectedInputs: {} as Record<string, string>, inputViews: {} as Record<string, { answer?: string; error?: string }>, inputOpen: false,
    taskResults: { [id]: { result } },
  };
  const views = createDashboardViews({
    state, document, $: (selector: string) => document.querySelector(selector),
    loading: () => "加载中", label: (value: string) => value === "needs_review" ? "待复核" : value,
    stageLabel: (value: string) => value === "attribution" ? "归因" : value === "comparison" ? "对比" : value,
    dateText: String,
    escapeHtml: (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[char]!),
  });
  if (stage === "clustering") views.renderClustering(); else views.renderDetail();
  return { dom, document, views, state };
}

test("criteria tasks show readable requirements, candidate scope and visible acceptance rules", () => {
  const criteria = criteriaResult();
  const candidateId = "7c4e3ba8-8f7c-46cc-b8fb-3016e10ea2dd";
  criteria.requirements.push({ id: "private", text: "保留原文的条件与例外。", applies_to: [candidateId, "unknown-input"],
    acceptance_rule: criteria.requirements[0]!.acceptance_rule });
  const result = caseResultView("criteria", { result: criteria })!;
  const original = structuredClone(result);
  const { dom, document, views, state } = render("criteria", result);
  try {
    state.caseDetail.candidates = [{ input_id: candidateId, version: "a_fast", name: "A组Fast" }];
    views.renderDetail();
    const group = document.querySelector('[data-stage="criteria"]');
    assert(group);
    const entries = [...group.querySelectorAll('[data-criterion-kind="requirements"]')];
    assert.equal(entries.length, 6);
    assert.match(entries[0].querySelector(".criterion-identity").textContent, /requirements\[0\].*r1/);
    assert.equal(entries[0].querySelector(".criterion-scope").textContent, "适用候选 · 全部候选");
    assert.equal(entries[5].querySelector(".criterion-scope").textContent, "适用候选 · A组Fast / unknown-input");
    for (const [index, entry] of entries.entries()) {
      assert.equal(entry.querySelector(".criterion-text .text-content").textContent, criteria.requirements[index]!.text);
      const rule = entry.querySelector("section.criterion-rule");
      assert.equal(rule?.tagName, "SECTION", "rules are visible without a disclosure");
      assert.match(rule.querySelector("header").textContent, /核验方法/);
      assert.equal(rule.querySelector(".text-content").textContent, criteria.requirements[index]!.acceptance_rule);
    }
    assert.match(group.querySelector('[data-criteria-group="scoring_points"]').textContent, /得分点.*0 项/);
    assert.match(group.querySelector('[data-criteria-group="red_flags"]').textContent, /红线.*0 项/);
    assert(!group.querySelector('[data-criteria-group="scoring_points"] .schema-list'));
    state.expandedTexts.add(entries[0].querySelector(".criterion-rule").dataset.criterionRule);
    views.renderDetail();
    assert.equal(document.querySelector(".criterion-rule").tagName, "SECTION");
    assert.deepEqual(result, original, "presentation preserves accepted criteria");
    assert(!group.textContent.includes("[object Object]"));
  } finally { dom.window.close(); }
});

test("comparison retains shared criteria groups, private scope and complete text", () => {
  const criteria = criteriaResult();
  const candidateIds = ["7c4e3ba8-8f7c-46cc-b8fb-3016e10ea2dd", "114529b8-de39-4da7-9c4f-d6a1ca4971c3"];
  const rule = criteria.requirements[0]!.acceptance_rule;
  criteria.requirements.push({ id: "r2", text: `保留条件与例外。\n${"长段原文 <img src=x>。".repeat(40)}`, applies_to: [candidateIds[0]!], acceptance_rule: rule });
  criteria.scoring_points.push({ id: "s1", text: "可选项\n保持原文", applies_to: [candidateIds[1]!], acceptance_rule: rule });
  criteria.red_flags.push({ id: "f1", text: "禁止项\n保留否定范围", applies_to: [], acceptance_rule: rule });
  const evaluation = attributionResult();
  for (const stage of ["comparison"] as const) {
    const row = {
      ...comparisonResult(["a_fast", "b_fast"], criteria),
      models: { a_fast: { version: "A组Fast" }, b_fast: { version: "B组Fast" } },
      evaluations: { a_fast: evaluation, b_fast: evaluation },
    };
    const original = structuredClone(row);
    const result = caseResultView(stage, row)!;
    const { dom, document, views, state } = render(stage, result);
    try {
      state.caseDetail.candidates = candidateIds.map((input_id, index) => ({
        input_id, version: index ? "b_fast" : "a_fast", name: index ? "B组Fast" : "A组Fast",
      }));
      views.renderDetail();
      const analyses = [...document.querySelectorAll(".task-analysis")];
      assert.equal(analyses.length, 1, "comparison shows common rules once without adding an attribution scorecard");
      for (const analysis of analyses)
        for (const kind of ["requirements", "scoring_points", "red_flags"] as const) {
          const entries = [...analysis.querySelectorAll(`[data-criterion-kind="${kind}"]`)];
          assert.equal(entries.length, criteria[kind].length);
          for (const [index, entry] of entries.entries()) {
            const criterion = criteria[kind][index]!;
            assert.equal(entry.querySelector(".criterion-identity code").textContent, `${kind}[${index}]`);
            assert.equal(entry.querySelector(".criterion-identity strong").textContent, criterion.id);
            const scope = criterion.applies_to.length ? criterion.applies_to.map(id => id === candidateIds[0] ? "A组Fast" : "B组Fast").join(" / ") : "全部候选";
            assert.equal(entry.querySelector(".criterion-scope").textContent, `适用候选 · ${scope}`);
            assert.equal(entry.querySelector(".criterion-text .text-content").textContent, criterion.text);
            assert.equal(entry.querySelector(".criterion-rule .text-content").textContent, criterion.acceptance_rule);
          }
        }
      assert.equal(document.querySelector(".task-analysis img"), null);
      assert.deepEqual(row, original, "all display paths preserve accepted criteria");
    } finally { dom.window.close(); }
  }
});

test("review projections resolve blind candidates and show uncertain cells without a formal tie", () => {
  const review = comparisonResult(["A", "B"]);
  review.status = "needs_review";
  review.ranking = [];
  review.review_requests = [{ candidate: "A", criterion_ids: [review.task_analysis.requirements[0]!.id], finding_indices: [], reason: "需要独立确认结果。" }];
  review.assessments.A!.meets_core = null;
  review.decision_basis.comparisons[0]!.better_candidates = [];
  review.decision_basis.comparisons[0]!.assessments.A!.status = "unknown";
  review.decision_basis.comparisons[0]!.assessments.A!.evidence_status = "uncertain";
  const row = { evaluation_type: "comparison_review", result: review,
    models: { a_fast: { version: "A组Fast" }, b_fast: { version: "B组Fast" } },
    evaluations: { a_fast: attributionResult(), b_fast: attributionResult() },
  };
  const projected = caseResultView("comparison", row, { A: "a_fast", B: "b_fast" })!;
  assert.deepEqual(projected.verdicts, {});
  assert.equal((projected.review_requests as { candidate: string }[])[0]!.candidate, "a_fast");
  assert.deepEqual(Object.keys(projected.assessments as object), ["a_fast", "b_fast"]);
  assert.equal(review.review_requests[0]!.candidate, "A", "projection leaves the accepted review row unchanged");
  const { dom, document } = render("comparison", projected);
  try {
    const verdicts = document.querySelector(".comparison-verdicts").textContent;
    assert.equal(verdicts, "待复核");
    assert(!/都好|都差/.test(verdicts));
    const cell = document.querySelector('[data-candidate="a_fast"]');
    assert.match(cell.textContent, /证据不足.*不确定/);
    assert(document.querySelector(".comparison-table th").closest("table").textContent.includes(review.task_analysis.requirements[0]!.id));
  } finally { dom.window.close(); }
});

test("case header shows a standard answer row below the question, including zero and structured values, and hides absent answers", () => {
  const { dom, document, views, state } = render("attribution", caseResultView("attribution", attributionResult() as unknown as JsonObject)!);
  try {
    assert.equal(document.querySelector(".standard-answer"), null);
    for (const value of ["21.6256", 0, false, { answer: ["A", "B"] }, '<img src=x onerror="alert(1)">']) {
      state.caseDetail.ground_truth = { available: true, value };
      views.renderDetail();
      assert.equal(document.querySelector(".detail-heading .standard-answer h3").textContent, "标准答案");
      assert.equal(document.querySelector(".question-text").nextElementSibling, document.querySelector(".standard-answer"));
      assert.equal(document.querySelector(".standard-answer").closest("details"), null, "standard answers are visible without opening inputs or tasks");
      assert.equal(document.querySelector(".standard-answer .text-content").textContent,
        typeof value === "string" ? value : JSON.stringify(value, null, 2));
      assert.equal(document.querySelector(".standard-answer img"), null);
    }
    state.caseDetail.ground_truth = { available: false, value: null };
    views.renderDetail();
    assert.equal(document.querySelector(".standard-answer"), null);
  } finally { dom.window.close(); }
});

test("case inputs keep A and B side by side with independent version selection and additional models", () => {
  const { dom, document, views, state } = render("attribution", caseResultView("attribution", attributionResult() as unknown as JsonObject)!);
  try {
    state.caseDetail.candidates = [
      { input_id: "be", version: "b_expert", name: "B组Expert" },
      { input_id: "ae", version: "a_expert", name: "A组Expert" },
      { input_id: "kimi", version: "kimi", name: "Kimi" },
      { input_id: "bf", version: "b_fast", name: "B组Fast" },
      { input_id: "af", version: "a_fast", name: "A组Fast" },
    ];
    state.selectedInputs = { a: "ae", b: "bf" };
    state.inputViews = { ae: { answer: "A专家回答" }, bf: { answer: "B快速回答<img src=x>" }, af: { answer: "A快速回答" } };
    state.inputOpen = true;
    const original = structuredClone(state.caseDetail);
    views.renderDetail();
    const columns = [...document.querySelectorAll(".input-content > .case-column")];
    assert.deepEqual(columns.map((column: any) => column.dataset.versionGroup), ["a", "b", "version:kimi"]);
    assert.deepEqual([...columns[0].querySelectorAll("[data-input]")].map((button: any) => button.dataset.input), ["af", "ae"]);
    assert.deepEqual([...columns[1].querySelectorAll("[data-input]")].map((button: any) => button.dataset.input), ["bf", "be"]);
    assert.equal(columns[0].querySelector('[aria-pressed="true"]').dataset.input, "ae");
    assert.equal(columns[1].querySelector('[aria-pressed="true"]').dataset.input, "bf");
    assert.equal(columns[2].querySelector('[aria-pressed="true"]').dataset.input, "kimi");
    assert.equal(columns[0].querySelector(".input-view").textContent, "A专家回答");
    assert.equal(columns[1].querySelector(".input-view").textContent, "B快速回答<img src=x>");
    assert.equal(columns[1].querySelector("img"), null);
    assert.equal(columns[2].querySelector(".input-view").textContent, "加载中");
    assert.equal(document.querySelector(".input-disclosure").tagName, "SECTION");
    assert.deepEqual(state.caseDetail, original, "grouping leaves source metadata intact");
    state.selectedInputs.a = "af";
    views.renderDetail();
    assert.equal(document.querySelector('[data-version-group="a"] .input-view').textContent, "A快速回答");
    assert.equal(document.querySelector('[data-version-group="b"] .input-view').textContent, "B快速回答<img src=x>");
  } finally { dom.window.close(); }
});

test("attribution tasks follow their model columns in Fast and Expert order while comparison stays across the case", () => {
  const { dom, document, views, state } = render("attribution", caseResultView("attribution", attributionResult() as unknown as JsonObject)!);
  try {
    const versions = ["b_expert", "a_expert", "kimi", "b_fast", "a_fast"];
    state.caseDetail.candidates = versions.map((version) => ({
      input_id: version, version, name: { a_fast: "A组Fast", a_expert: "A组Expert", b_fast: "B组Fast", b_expert: "B组Expert", kimi: "Kimi" }[version]!,
    }));
    state.caseDetail.tasks = versions.map((version, index) => ({ id: version, stage: "attribution", versions: [version], status: index % 2 ? "failed" : "succeeded", attempts: 1 }));
    state.caseDetail.tasks.push({ id: "comparison", stage: "comparison", versions: ["b_fast", "a_fast"], status: "blocked", attempts: 0 });
    state.openTasks.add("a_expert");
    views.renderDetail();
    const columns = [...document.querySelectorAll('[data-stage="attribution"] .case-columns > .case-column')];
    assert.deepEqual(columns.map((column: any) => column.dataset.versionGroup), ["a", "b", "version:kimi"]);
    assert.deepEqual([...columns[0].querySelectorAll("[data-task]")].map((task: any) => task.dataset.task), ["a_fast", "a_expert"]);
    assert.deepEqual([...columns[1].querySelectorAll("[data-task]")].map((task: any) => task.dataset.task), ["b_fast", "b_expert"]);
    assert.equal(columns[0].querySelector(".task-name").textContent, "A组Fast");
    assert.equal(columns[0].querySelector('[data-task="a_expert"]').tagName, "SECTION");
    assert.equal(document.querySelector('[data-stage="comparison"] .case-columns'), null);
    assert.equal(document.querySelector('[data-stage="comparison"] .task-name').textContent, "A组Fast / B组Fast");
    assert.equal(document.querySelectorAll("[data-task]").length, 6, "every task appears once");
  } finally { dom.window.close(); }
});

test("dashboard distinguishes initial receipts from queued reviews and shows pending comparison decisions", () => {
  const { dom, document, views, state } = render("attribution", caseResultView("attribution", attributionResult() as unknown as JsonObject)!);
  try {
    state.caseDetail.candidates = ["a_fast", "b_fast"].map((version) => ({
      input_id: version, version, name: version === "a_fast" ? "A组Fast" : "B组Fast",
    }));
    const reason = "结果与原材料有冲突，需要确认 <img src=x>。";
    state.caseDetail.tasks = [
      ...["a_fast", "b_fast"].flatMap((version) => [
        { id: version, stage: "attribution", versions: [version], status: "succeeded", attempts: 1 },
        { id: `${version}-review`, stage: "attribution", versions: [version], status: "pending", attempts: 0,
          review_of: { task_id: version, round: 1, reasons: [reason] } },
      ]),
      { id: "initial-comparison", stage: "comparison", versions: ["a_fast", "b_fast"], status: "succeeded", attempts: 1,
        result_status: "needs_review" },
      { id: "decided-comparison", stage: "comparison", versions: ["a_fast", "b_fast"], status: "succeeded", attempts: 1,
        result_status: "decided" },
    ];
    const original = structuredClone(state.caseDetail.tasks);
    state.openTasks.add("a_fast-review");
    views.renderDetail();
    for (const version of ["a_fast", "b_fast"]) {
      const initial = document.querySelector(`[data-task="${version}"]`);
      const review = document.querySelector(`[data-task="${version}-review"]`);
      assert.equal(initial.querySelector(".task-phase").textContent, "首次归因");
      assert.equal(review.querySelector(".task-phase").textContent, "归因复核 · 第 1 轮");
      assert.equal(initial.querySelector(".task-name").textContent, review.querySelector(".task-name").textContent);
      assert.equal(review.querySelector(".task-status").textContent, "pending");
      assert.equal(review.querySelector(".task-review-reasons").textContent, reason);
      assert.equal(review.querySelector("img"), null);
    }
    const initial = document.querySelector('[data-task="initial-comparison"]');
    assert.equal(initial.querySelector(".task-phase"), null);
    assert.equal(initial.querySelector(".task-status").textContent, "待复核");
    assert(initial.querySelector(".task-status").classList.contains("needs_review"));
    assert(initial.querySelector(".task-result"), "a submitted review receipt remains readable");
    assert.equal(document.querySelector('[data-task="decided-comparison"] .task-status').textContent, "succeeded");
    assert.equal(document.querySelectorAll("[data-task]").length, original.length, "accepted history and each queued task appear exactly once");
    assert.deepEqual(state.caseDetail.tasks, original, "display status does not mutate host execution status");
    state.caseDetail.tasks.find((task) => task.id === "initial-comparison")!.status = "failed";
    state.caseDetail.tasks.find((task) => task.id === "initial-comparison")!.result_status = "needs_review";
    views.renderDetail();
    assert.equal(document.querySelector('[data-task="initial-comparison"] .task-status').textContent, "failed", "execution failures take priority");
  } finally { dom.window.close(); }
});

test("dashboard pairs minimal attribution rewrites and evidence without changing accepted output", () => {
  const evaluation=attributionResult(false);
  evaluation.Problem[0].text="缺点原文";
  evaluation.meta.rewritten={evaluator_version:"fixture",rewrites:[{id:"Problem.0.text",text:"问题改写"},{id:"summary",text:"总结改写"},{id:"Problem.0.reason",text:"依据改写"}]};
  const before=structuredClone(evaluation),result=caseResultView("attribution",evaluation as unknown as JsonObject)!;
  const {dom,document,views,state}=render("attribution",result,"task/<one>");
  try {
    assert.deepEqual(evaluation,before);
    assert.equal(document.querySelectorAll(".findings-nav a").length,1);
    assert.equal(document.querySelectorAll(".rewrite-pair").length,3);
    const link=document.querySelector(".findings-nav a"),target=document.getElementById(link.dataset.findingTarget);
    assert(target);assert.match(target.textContent,/问题改写/);assert(target.querySelector(".evidence-list"));
    const back=target.querySelector(".findings-return");
    assert.equal(document.getElementById(decodeURIComponent(back.hash.slice(1))).getAttribute("aria-label"),"问题目录");
    state.openFindings.add(target.dataset.finding);views.renderDetail();assert.equal(document.getElementById(target.id).tagName,"SECTION");
  } finally {dom.window.close();}
});

test("checklist rewrite paths follow saved blind identities without changing the raw comparison", () => {
  const result = comparisonResult();
  const row = { ...result, verdicts: {}, rewritten: { evaluator_version: "fixture", rewrites: [
    { id: "comparison.0.A.summary", text: "右模型逐项点评。" },
    { id: "comparison.0.B.summary", text: "左模型逐项点评。" },
  ] } };
  const before = structuredClone(row);
  const view = caseResultView("comparison", row, { A: "right", B: "left" })!;
  assert.deepEqual((view.rewritten as { rewrites: { path: string }[] }).rewrites.map(item => item.path), [
    "decision_basis.comparisons.0.assessments.right.summary", "decision_basis.comparisons.0.assessments.left.summary",
  ]);
  assert.deepEqual(row, before);
});

test("comparison shows each model's attribution with its own rewrites, directory and isolated finding IDs", () => {
  const evaluation = attributionResult(false);
  const result = caseResultView("comparison", {
    ...comparisonResult(["left", "right"]),
    models: { left: { version: "左模型" }, right: { version: "右模型" } },
    evaluations: {
      left: { ...evaluation, meta:{...evaluation.meta, rewritten: { evaluator_version: "fixture", rewrites: [{ id: "Problem.0.text", text: "左模型改写" }] }} },
      right: { ...evaluation, meta:{...evaluation.meta, rewritten: { evaluator_version: "fixture", rewrites: [{ id: "Problem.0.text", text: "右模型改写" }] }} },
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

test("pairwise comparison orders A before B and preserves attribution finding links", () => {
  const versions = ["b_fast", "a_fast"];
  const names = { a_fast: "A组Fast", b_fast: "B组Fast" };
  const row = {
    ...comparisonResult(versions),
    models: Object.fromEntries(versions.map((version) => [version, { version: names[version as keyof typeof names] }])),
    evaluations: Object.fromEntries(versions.map((version) => [version, attributionResult(false)])),
  };
  for (const assessment of Object.values(row.decision_basis.comparisons[0]!.assessments)) assessment.finding_indices = [0];
  const { dom, document } = render("comparison", caseResultView("comparison", row)!);
  try {
    assert.deepEqual([...document.querySelectorAll(".comparison-table thead th")].map((node: any) => node.textContent), ["比较点", "A组Fast", "B组Fast"]);
    const cells = [...document.querySelectorAll(".comparison-table tbody td")];
    assert.deepEqual(cells.map((node: any) => node.dataset.candidate), Array.from({length: 5}, () => ["a_fast", "b_fast"]).flat());
    const columns = [...document.querySelectorAll(".comparison-attributions .case-columns > .case-column")];
    assert.deepEqual(columns.map((node: any) => node.dataset.versionGroup), ["a", "b"]);
    for (const [index, cell] of cells.slice(0, 2).entries()) {
      const target = document.getElementById(cell.querySelector("[data-finding-target]").dataset.findingTarget);
      assert(columns[index].contains(target), "comparison links resolve within the same model column");
    }
  } finally { dom.window.close(); }
});

test("dashboard maps blind comparison slots to model fields and actual verdict pair order", () => {
  const row = {
    ...comparisonResult(["left", "right"]),
    assessments: { left: { summary: "左原文", meets_core: false, core_failure_refs: ["r1"] },
      right: { summary: "右原文", meets_core: true, core_failure_refs: [] } },
    decision_basis: { ...comparisonResult(["left", "right"]).decision_basis, tradeoff: "权衡原文", decisive_findings: [] },
    models: { left: { version: "左模型" }, right: { version: "右模型" } },
    evaluations: { left: attributionResult(false, "2+2=5"), right: attributionResult() },
    verdicts: { left__vs__right: { reason: "判决原文", result: "win", winner_name: "右模型", winner_version: "right" } },
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

test("dashboard aligns models by version, prioritizes impact, and keeps accepted facts and finding links attached to their row", () => {
  const row = {
    ...comparisonResult(["left", "right"]),
    models: { left: { version: "A组Fast" }, right: { version: "B组Fast" } },
    verdicts: { left__vs__right: { result: "win", winner_name: "A组Fast", winner_version: "left", reason: "完成核心要求" } },
    evaluations: { left: attributionResult(false), right: attributionResult(false) },
    decision_basis: { tradeoff: "A组Fast更好，方案比较更具体。", decisive_findings: [], comparisons: [
      { aspect: "脚注", criterion_ids: ["r1"], importance: "low", better_candidates: ["right"], assessments: {
        left: { summary: "脚注编号错位。", finding_indices: [], status: "partial", evidence_status: "established" },
        right: { summary: "编号准确。", finding_indices: [], status: "met", evidence_status: "established" },
      } },
      { aspect: "对冲方案", criterion_ids: ["r1"], importance: "high", better_candidates: ["left"], assessments: {
        left: { summary: "比较了多种对冲工具。", finding_indices: [0], status: "met", evidence_status: "established" },
        right: { summary: "只提到人民币融资。", finding_indices: [0], status: "unmet", evidence_status: "established" },
      } },
    ] },
  };
  const { dom, document } = render("comparison", caseResultView("comparison", row, { A: "right", B: "left" })!);
  try {
    const rows = document.querySelectorAll(".comparison-table tbody tr");
    assert.equal(rows[0].dataset.comparisonIndex, "1", "high-impact rows precede minor footnotes");
    assert.equal(rows[1].dataset.comparisonIndex, "0");
    const left = rows[0].querySelector('[data-candidate="left"]');
    const right = rows[0].querySelector('[data-candidate="right"]');
    assert.match(left.textContent, /更优.*比较了多种对冲工具/s);
    assert.match(right.textContent, /只提到人民币融资/);
    assert.equal(right.querySelector("img"), null);
    assert.equal(left.querySelector(".comparison-original"), null);
    const target = document.getElementById(left.querySelector("a").dataset.findingTarget);
    assert.match(target.id, /evaluations.left.Problem.0$/);
    assert.equal(document.querySelector(".comparison-attributions").tagName, "SECTION");
    assert.match(document.querySelector(".comparison-decision").textContent, /A组Fast更好/);
    assert.equal(document.querySelectorAll(".comparison-decision .findings-nav").length, 0);
  } finally { dom.window.close(); }
});

test("comparison cells retain problem evidence, source identities and escaped prose", () => {
  const evaluations={left:attributionResult(false),right:attributionResult(false)};
  evaluations.left.Problem[0].text="错误数据 <img src=x>";
  evaluations.left.Problem[0].reason="证据支持具体缺陷 <script>内容</script>";
  const comparison=comparisonResult(["left","right"]);
  comparison.decision_basis.comparisons=[{aspect:"引用缺陷",criterion_ids:[],importance:"medium",better_candidates:["right"],assessments:{
    left:{summary:"已确认本方问题。",finding_indices:[0],status:"met",evidence_status:"established"},
    right:{summary:"问题影响更小。",finding_indices:[0],status:"met",evidence_status:"established"}}}];
  const row={...comparison,evaluations,models:{left:{version:"左模型"},right:{version:"右模型"}},verdicts:{}};
  const before=structuredClone(row),projected=caseResultView("comparison",row)!;
  const {dom,document,views}=render("comparison",projected);
  try {
    const table=document.querySelector(".comparison-table"),cells=table.querySelectorAll("td");assert.equal(cells.length,2);
    for(const cell of cells){const problem=evaluations[cell.dataset.candidate as keyof typeof evaluations].Problem[0];
      const shown=cell.querySelector(".comparison-finding");assert(shown);assert(shown.textContent.includes(problem.text));
      assert(shown.textContent.includes(problem.reason));for(const evidence of problem.evidence)assert(shown.textContent.includes(evidence.quote));
      const link=cell.querySelector("[data-finding-target]");assert(document.getElementById(link.dataset.findingTarget));}
    assert.equal(table.querySelector("img,script"),null);assert.equal(table.querySelectorAll(".comparison-advantage").length,1);
    views.renderDetail();assert.deepEqual(row,before);
  } finally {dom.window.close();}
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
  evaluation.Problem = [];
  const { dom, document } = render("attribution", caseResultView("attribution", evaluation as unknown as JsonObject)!);
  try {
    assert.equal(document.querySelectorAll(".rewrite-pair").length, 0);
    assert.equal(document.querySelectorAll(".findings-nav-group").length, 1);
    assert.equal(document.querySelectorAll(".findings-nav a").length, 0);
  } finally { dom.window.close(); }
});
