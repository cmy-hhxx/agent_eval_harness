import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "../../fixtures/services.js";
import { editableDashboardSettings } from "@eval/host-app/config";

const { JSDOM } = createRequire(import.meta.url)("jsdom");
const { createDashboardViews } = await import(pathToFileURL(path.join(ROOT, "apps/host/dashboard/dashboard-view.js")).href);

async function controller(respond: (url: string) => unknown) {
  const dom = new JSDOM(await readFile(path.join(ROOT, "apps/host/dashboard/index.html"), "utf8"));
  const source = await readFile(path.join(ROOT, "apps/host/dashboard/dashboard.js"), "utf8");
  const timers = new Map<number, number>();
  let nextTimer = 0;
  // Exercise the real controller with an in-memory DOM and network; no browser or boot requests.
  const load = new Function("document", "createDashboardViews", "fetch", "setTimeout", "clearTimeout",
    source.slice(source.indexOf("\n") + 1, source.lastIndexOf("\n(async () => {")) +
    "\nreturn { state, loadConfig, loadInputs, refresh };",
  );
  const api = load(dom.window.document, createDashboardViews,
    async (url: string) => new Response(JSON.stringify(respond(url))),
    (_callback: unknown, delay: number) => { timers.set(++nextTimer, delay); return nextTimer; },
    (id: number) => timers.delete(id),
  );
  return { ...api, dom, document: dom.window.document, timers };
}

test("dashboard renders all configured gateway models and high thinking with every rewrite enabled", async () => {
  const page = await controller(() => ({
    paths: ["configs/host.json"], environment: {},
    model_catalog: [{ id: "claude-4", name: "Claude 4" }, { id: "gpt-5.6", name: "GPT 5.6" }],
    settings: editableDashboardSettings({
      models: { judge: { model: "claude-4" } },
      bindings: Object.fromEntries(["attribution", "comparison", "rewrite", "clustering"]
        .map((stage) => [stage, { profile: "judge" }])),
      execution: { concurrency: 4, timeoutSeconds: 900, maxToolCalls: 12, retries: 1 },
      clustering: { enabled: true },
    }),
  }));
  try {
    await page.loadConfig();
    const selects = [...page.document.querySelectorAll("[data-model-stage]")];
    assert.equal(selects.length, 4);
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
