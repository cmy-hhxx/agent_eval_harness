import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "../../fixtures/services.js";
import { editableDashboardSettings, readConfigSources } from "@eval/host-app/config";

const { JSDOM } = createRequire(import.meta.url)("jsdom");
const { createDashboardViews, groupCaseCandidates } = await import(pathToFileURL(path.join(ROOT, "apps/host/dashboard/dashboard-view.js")).href);

async function controller(respond: (url: string, options?: RequestInit) => unknown) {
  const dom = new JSDOM(await readFile(path.join(ROOT, "apps/host/dashboard/index.html"), "utf8"));
  const source = await readFile(path.join(ROOT, "apps/host/dashboard/dashboard.js"), "utf8");
  const timers = new Map<number, number>();
  let nextTimer = 0;
  // Exercise the real controller with an in-memory DOM and network; no browser or boot requests.
  const load = new Function("document", "createDashboardViews", "groupCaseCandidates", "fetch", "setTimeout", "clearTimeout",
    source.slice(source.indexOf("\n") + 1, source.lastIndexOf("\n(async () => {")) +
    "\nreturn { state, loadConfig, loadInputs, refresh, loadCase, loadInput, loadCaseInputs, resetInputs, pickSample, launchPayload, deleteRun, restoreRecall };",
  );
  const api = load(dom.window.document, createDashboardViews, groupCaseCandidates,
    async (url: string, options: RequestInit) => {
      const value = await respond(url, options);
      return value instanceof Response ? value : new Response(JSON.stringify(value));
    },
    (_callback: unknown, delay: number) => { timers.set(++nextTimer, delay); return nextTimer; },
    (id: number) => timers.delete(id),
  );
  return { ...api, dom, document: dom.window.document, timers };
}

test("dashboard renders gateway models with eight-way concurrency, high thinking and all rewrites", async () => {
  const source = await readConfigSources(path.join(ROOT, "configs/host.json"));
  assert.equal(editableDashboardSettings({}).execution.concurrency, 8);
  const page = await controller(() => ({
    paths: ["configs/host.json"], environment: {},
    model_catalog: [{ id: "claude-4", name: "Claude 4" }, { id: "gpt-5.6", name: "GPT 5.6" }],
    settings: editableDashboardSettings({
      ...source,
      models: { judge: { model: "claude-4" } },
      bindings: Object.fromEntries(["criteria", "attribution", "comparison", "rewrite", "clustering"]
        .map((stage) => [stage, { profile: "judge" }])),
    }),
  }));
  try {
    await page.loadConfig();
    assert.equal(page.document.querySelector("#setting-concurrency").value, "8");
    const selects = [...page.document.querySelectorAll("[data-model-stage]")];
    assert.equal(selects.length, 5);
    for (const select of selects) {
      assert.deepEqual([...select.options].map((option) => option.value), ["", "claude-4", "gpt-5.6"]);
      assert.equal(select.value, "claude-4");
    }
    for (const select of page.document.querySelectorAll("[data-thinking-stage]"))
      assert.equal(select.value, "high");
    for (const stage of ["attribution", "comparison", "clustering"])
      assert.equal(page.document.querySelector(`#rewrite-${stage}`).checked, true);
  } finally { page.dom.window.close(); }
});

test("comparison finding links reveal collapsed attribution details and preserve the opened finding", async () => {
  const page = await controller(() => ({}));
  try {
    page.document.querySelector("#case-detail").innerHTML = '<a href="#target" data-finding-target="target">归因 #0</a><details class="comparison-attributions"><summary>归因明细</summary><details class="finding" id="target" data-finding="task.evaluations.left.findings.0"><summary>发现</summary></details></details>';
    page.document.querySelector("[data-finding-target]").click();
    assert.equal(page.document.querySelector(".comparison-attributions").open, true);
    assert.equal(page.document.querySelector("#target").open, true);
    assert(page.state.openFindings.has("task.evaluations.left.findings.0"));
  } finally { page.dom.window.close(); }
});

test("sample recall opens the requested run, model and persistent finding even outside the visible case page", async () => {
  const task = { id: "attr-a", stage: "attribution", status: "succeeded", versions: ["a_expert"], attempts: 1 };
  const run = { run_id: "recall-run", status: "finished", progress: {}, stages: {} };
  const page = await controller((url) => {
    if (url.endsWith("/runs")) return { runs: [run], errors: [] };
    if (url.endsWith("/recall-run")) return run;
    if (url.includes("/cases?")) return { cases: [], total: 80, page: 1, page_size: 40 };
    if (url.includes("/cases/detail")) return { batch_id: "batch", case_id: "q80", question: "召回问题", tasks: [task], candidates: [
      { version: "a_fast", name: "A组Fast", input_id: "af" }, { version: "a_expert", name: "A组Expert", input_id: "ae" },
    ] };
    if (url.includes("/tasks/attr-a/result")) return { result: { evaluation: { summary: "总结", findings: [
      { finding_id: "f8", type: "problem", text: "目标问题", problem: { label: "问题" } },
    ] } } };
    throw new Error(`Unexpected request ${url}`);
  });
  try {
    await page.refresh();
    await page.restoreRecall(new URLSearchParams({ run: "recall-run", batch: "batch", case: "q80", model: "a_expert", task: "attr-a", finding: "f8" }));
    assert.equal(page.state.selectedRun, "recall-run");
    assert.equal(page.state.selectedCase.caseId, "q80");
    assert.equal(page.document.querySelector('[data-input="ae"]').getAttribute("aria-pressed"), "true");
    assert.equal(page.document.querySelector('[data-task="attr-a"]').open, true);
    const finding = page.document.getElementById("finding-attr-a.findings.0");
    assert.equal(finding.open, true);
    assert.equal(page.document.activeElement, finding);
  } finally { page.dom.window.close(); }
});

test("sample recall reports unavailable runs and never requests a stale result", async () => {
  const calls: string[] = [];
  const page = await controller((url) => { calls.push(url); return {}; });
  try {
    await page.restoreRecall(new URLSearchParams({ run: "deleted-run", batch: "batch", case: "q1", task: "attr-a" }));
    assert.match(page.document.querySelector("#error-banner").textContent, /运行不可用/);
    assert.equal(calls.length, 0);
  } finally { page.dom.window.close(); }
});

test("date discovery renders before counts and preserves selections as scanning finishes", async () => {
  let ready = false, failure = false;
  const page = await controller(() => {
    if (failure) throw new Error("源不可用");
    return { status: ready ? "ready" : "loading", issues: ready ? 0 : null,
      dates: [{ date: "2026-09-25", versions: ["a", "b"], batches: ready ? ["batch"] : [],
        cases: ready ? [{ id: "q1", versions: ["a", "b"], batches: ["batch"] }] : null }],
    };
  });
  try {
    await page.loadInputs();
    assert.match(page.document.querySelector("#date-options").textContent, /2026-09-25.*扫描中/);
    assert.equal(page.document.querySelector("#preview-button").disabled, true);
    page.state.selectedDates.clear();
    ready = true;
    await page.loadInputs();
    assert.equal(page.document.querySelector("#preview-button").disabled, false);
    assert.equal(page.state.selectedDates.size, 0);
    assert.equal(page.timers.size, 0, "finished inventory stops polling");
    failure = true;
    await page.loadInputs();
    assert(page.document.querySelector("#date-options .inline-error"));
    failure = false;
    await page.loadInputs();
    assert.equal(page.document.querySelector("#date-options .inline-error"), null);
    assert.match(page.document.querySelector("#date-options").textContent, /2026-09-25/);
  } finally { page.dom.window.close(); }
});

test("a launched process keeps refreshing until its checkpoint appears, then selects the run", async () => {
  let visible = false;
  const run = { run_id: "new-run", status: "finished", progress: {}, stages: {} };
  const page = await controller((url) => url.includes("/cases?") ? { cases: [], total: 0, page_size: 20 } :
    url.endsWith("/new-run") ? run : { runs: visible ? [run] : [], errors: [] });
  try {
    page.state.startingRun = { id: "new-run", deadline: Date.now() + 120000 };
    await page.refresh();
    assert.deepEqual([...page.timers.values()], [1000], "a process without state.json still needs polling");
    visible = true;
    await page.refresh();
    assert.equal(page.state.startingRun, null);
    assert.equal(page.state.selectedRun, "new-run");
    assert.equal(page.timers.size, 0, "a finished run stops polling");
  } finally { page.dom.window.close(); }
});

test("startup wait ends visibly if no checkpoint appears", async () => {
  const page = await controller(() => ({ runs: [], errors: [] }));
  try {
    page.state.startingRun = { id: "failed-start", deadline: Date.now() - 1 };
    await page.refresh();
    assert.equal(page.state.startingRun, null);
    assert.match(page.document.querySelector("#error-banner").textContent, /启动等待超时/);
    assert.equal(page.timers.size, 0);
  } finally { page.dom.window.close(); }
});

test("new evaluations sample ten viable cases by default and still allow all cases", async () => {
  const page = await controller(() => ({}));
  try {
    page.state.config = { settings: { comparisons: [["a_fast", "b_fast"]] } };
    page.state.selectedModels = new Set(["a_fast", "b_fast"]);
    page.state.selectedDates = new Set(["2026-10-01"]);
    page.state.inputs = { dates: [{ date: "2026-10-01", batches: ["batch"],
      cases: Array.from({ length: 12 }, (_, index) => ({ id: `q${index}`, versions: ["a_fast", "b_fast"] })) }] };
    const sampled = page.pickSample();
    assert.equal(sampled.size, 10);
    assert.equal(sampled.cases.length, 10);
    assert.equal(new Set(sampled.cases).size, 10);
    assert.equal(page.document.querySelector("#sample-all").getAttribute("aria-pressed"), "false");
    page.document.querySelector("#sample-all").click();
    assert.equal(page.pickSample().size, null);
    assert.equal(page.document.querySelector("#sample-all").getAttribute("aria-pressed"), "true");
  } finally { page.dom.window.close(); }
});

test("case inputs load both sides only when opened, switch independently and discard stale responses", async () => {
  const calls: string[] = [];
  let finishOld: ((value: unknown) => void) | undefined;
  const page = await controller((url) => {
    calls.push(url);
    if (url.includes("/cases/detail")) return { batch_id: "batch", case_id: "q1", question: "问题", tasks: [], candidates: [
      { version: "b_fast", name: "B组Fast", input_id: "bf" },
      { version: "a_expert", name: "A组Expert", input_id: "ae" },
      { version: "a_fast", name: "A组Fast", input_id: "af" },
    ] };
    if (url.endsWith("/ae")) return new Promise((resolve) => { finishOld = resolve; });
    return { answer: url.endsWith("/bf") ? "B回答" : "A回答" };
  });
  try {
    page.state.selectedRun = "run-one";
    await page.loadCase("batch", "q1");
    assert.equal(calls.filter((url) => url.includes("/inputs/")).length, 0);
    page.state.inputOpen = true;
    await page.loadCaseInputs();
    assert.deepEqual(page.state.selectedInputs, { a: "af", b: "bf" });
    assert.equal(page.document.querySelector('[data-version-group="a"] .answer-block').textContent, "A回答");
    assert.equal(page.document.querySelector('[data-version-group="b"] .answer-block').textContent, "B回答");
    const oldRequest = page.loadInput("ae", "a");
    assert.equal(page.state.selectedInputs.b, "bf");
    page.resetInputs();
    page.state.caseDetail = null;
    finishOld!({ answer: "旧样本回答" });
    await oldRequest;
    assert.deepEqual(page.state.inputViews, {});
  } finally { page.dom.window.close(); }
});

test("input disclosure toggles do not redraw cached or already loading selections", async () => {
  let finishInput!: (value: unknown) => void;
  let inputRequests = 0;
  const page = await controller((url) => url.includes("/cases/detail")
    ? { batch_id: "batch", case_id: "q1", question: "问题", tasks: [], candidates: [
      { version: "a_fast", name: "A组Fast", input_id: "af" },
    ] }
    : new Promise((resolve) => { inputRequests++; finishInput = resolve; }));
  try {
    page.state.selectedRun = "run-one";
    await page.loadCase("batch", "q1");
    page.state.inputOpen = true;
    const loading = page.loadCaseInputs();
    const disclosure = page.document.querySelector(".input-disclosure");
    disclosure.dispatchEvent(new page.dom.window.Event("toggle"));
    assert.equal(page.document.querySelector(".input-disclosure"), disclosure, "a pending request must not redraw and trigger another toggle");
    finishInput({ answer: "A回答" });
    await loading;
    const cached = page.document.querySelector(".input-disclosure");
    cached.dispatchEvent(new page.dom.window.Event("toggle"));
    assert.equal(page.document.querySelector(".input-disclosure"), cached, "a cached selection must settle without another toggle");
    assert.equal(inputRequests, 1);
  } finally { page.dom.window.close(); }
});

test("run deletion requires the dialog, removes the selected view, and blocks active runs", async () => {
  let deleted = false;
  const mutations: { url: string; method: string }[] = [];
  const stopped = { run_id: "stopped", status: "finished", progress: {}, stages: {} };
  const active = { run_id: "active", status: "running", progress: {}, stages: {} };
  const page = await controller((url, options) => {
    if (options?.method === "DELETE") { mutations.push({ url, method: options.method }); deleted = true; return { deleted: true }; }
    if (url === "/api/dashboard/runs") return { runs: deleted ? [active] : [stopped, active], errors: [] };
    if (url.includes("/cases?")) return { cases: [], total: 0, page_size: 20 };
    return stopped;
  });
  try {
    const dialog = page.document.querySelector("#delete-dialog");
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => { dialog.open = false; dialog.dispatchEvent(new page.dom.window.Event("close")); };
    page.state.selectedRun = "stopped";
    await page.refresh();
    assert.equal(page.document.querySelector('[data-delete="active"]').disabled, true);
    page.document.querySelector('#run-list [data-delete="stopped"]').click();
    assert.equal(dialog.open, true);
    assert.equal(mutations.length, 0);
    page.document.querySelector("#delete-cancel").click();
    assert.equal(page.state.pendingDelete, null);
    assert.equal(mutations.length, 0);
    page.document.querySelector('#run-list [data-delete="stopped"]').click();
    await page.deleteRun();
    assert.deepEqual(mutations, [{ url: "/api/dashboard/runs/stopped", method: "DELETE" }]);
    assert.equal(page.state.selectedRun, null);
    assert.equal(page.document.querySelector("#run-overview").hidden, true);
    assert.equal(page.document.querySelector('[data-run="stopped"]'), null);
    assert.equal(dialog.open, false);
  } finally { page.dom.window.close(); }
});

test("a deletion conflict keeps the run and shows the error in its confirmation dialog", async () => {
  const run = { run_id: "stopped", status: "finished", progress: {}, stages: {} };
  const page = await controller((url, options) => options?.method === "DELETE"
    ? new Response(JSON.stringify({ error: "运行进程尚未退出" }), { status: 409 })
    : url === "/api/dashboard/runs" ? { runs: [run], errors: [] }
    : url.includes("/cases?") ? { cases: [], total: 0, page_size: 20 } : run);
  try {
    const dialog = page.document.querySelector("#delete-dialog");
    dialog.showModal = () => { dialog.open = true; };
    await page.refresh();
    page.document.querySelector('[data-delete="stopped"]').click();
    await page.deleteRun();
    assert.equal(dialog.open, true);
    assert.equal(page.document.querySelector("#delete-error").hidden, false);
    assert.match(page.document.querySelector("#delete-error").textContent, /运行进程尚未退出/);
    assert.equal(page.document.querySelector("#delete-confirm").disabled, false);
    assert(page.document.querySelector('[data-run="stopped"]'));
  } finally { page.dom.window.close(); }
});
