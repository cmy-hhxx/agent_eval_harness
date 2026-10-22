import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { ROOT } from "../../fixtures/services.js";

const { JSDOM } = createRequire(import.meta.url)("jsdom");

test("Tabler workbench switches modules in place, preserves state and isolates unavailable services", async () => {
  const directory = path.join(ROOT, "apps/host/dashboard");
  const dom = new JSDOM(await readFile(path.join(directory, "workbench.html"), "utf8"), { url:"http://fixture/", runScripts:"outside-only" });
  const stylesheet = dom.window.document.createElement("style");
  stylesheet.textContent = await readFile(path.join(directory, "workbench.css"), "utf8");
  dom.window.document.head.append(stylesheet);
  const compiled = await build({ entryPoints:[path.join(directory, "workbench.js")], bundle:true, write:false, format:"esm", platform:"browser" });
  const requests: string[] = [], faults: unknown[] = [];
  let failProblems = true;
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  dom.window.setInterval = dom.window.setTimeout = () => 0;
  dom.window.scrollTo = ({ top }: { top: number }) => { dom.window.scrollY = top; };
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const waitFor = async (condition: () => boolean) => {
    for (let i=0; i<100; i++) { if (condition()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.fail("module did not finish loading");
  };
  const select = async (id: string) => {
    dom.window.document.getElementById(`nav-${id}`).click();
    await waitFor(() => dom.window.document.getElementById(id).getAttribute("aria-busy") === "false");
    await new Promise(setImmediate);
    assert.equal(dom.window.document.querySelectorAll('[role=tabpanel]:not([hidden])').length, 1);
    assert.equal(dom.window.document.getElementById(id).hidden, false);
    assert.equal(dom.window.document.getElementById(`nav-${id}`).getAttribute("aria-selected"), "true");
  };
  dom.window.addEventListener("error", (event: ErrorEvent) => faults.push(event.error));
  dom.window.fetch = async (url: string) => {
    requests.push(url);
    if (url.startsWith("/workbench-assets/")) {
      const file = url.split("/").at(-1)!;
      if (file === "problems.html" && failProblems) { failProblems = false; return new Response("Unavailable", { status:503 }); }
      if (file === "tabler.css") return new Response(await readFile(path.join(ROOT, "node_modules/@tabler/core/dist/css/tabler.min.css"), "utf8"));
      const dataFiles: Record<string,string> = { "data.html":"dashboard.html", "data.css":"dashboard.css", "records.html":"records.html" };
      return new Response(await readFile(Object.hasOwn(dataFiles,file) ? path.join(ROOT,"server_dashboard_ths",dataFiles[file]) : path.join(directory,file),"utf8"));
    }
    if (url.startsWith("/data/workbench/catalog")) return json({ tasks:[
      { id:"daily", name:"问财日常评测", source:"wencai", category:"daily", dataset:"/data/wencai", profile:"wencai" },
      { id:"post", name:"后训练评测", source:"wencai", category:"task", dataset:"/data/post_training_model", profile:"post_training_model" },
    ], batches:[], total:0, page:1, page_size:50 });
    if (url === "/health") return json({ ok:true });
    if (url.startsWith("/runtime/api/status")) return json({ id:"fixture", sourceName:"普通四路", sources:[{ id:"fixture", name:"普通四路", status:"stopped", dateCount:0 }], status:"stopped", sampledAt:Date.now(), llm:{ sources:[],active:[] }, jobs:[], publishMongo:true, publishStatisticsLog:false });
    if (url.startsWith("/runtime/api/errors")) return json({ sourceId:"fixture",sourceName:"普通四路",page:1,pageSize:10,total:0,dates:[],records:[],sampledAt:Date.now() });
    if (url.endsWith("/analysis")) return json({ jobs:[] });
    if (url.endsWith("/batch-runs")) return json({ runs:[] });
    if (url.endsWith("/runs")) return json({ runs:[],errors:[] });
    if (url.endsWith("/inputs")) return json({ status:"ready",dates:[],issues:0 });
    if (url.endsWith("/library")) return json([]);
    if (url.endsWith("/config") || url.endsWith("/reference")) return json({ error:"配置不可用" },503);
    if (url.endsWith("/dashboard-data")) return json({ dates:[],evaluation:{ status:"stopped",dates:[] } });
    if (url.endsWith("/processing-status")) return json({ pending:0,failed:[],archive:null });
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    await dom.window.eval(`(async () => { ${compiled.outputFiles[0].text}\n })()`);
    await new Promise(setImmediate);
    assert.deepEqual(faults, []);
    assert.equal(dom.window.location.href,"http://fixture/");
    assert.equal(dom.window.document.querySelector("iframe"),null);
    assert.equal(dom.window.document.querySelectorAll('[role=tabpanel]:not([hidden])').length, 1);
    assert.equal(dom.window.document.getElementById("runs-content").shadowRoot, null);
    assert.equal(dom.window.document.getElementById("runs-content").hidden, true);
    assert.equal(dom.window.document.getElementById("samples-content").hidden, true);
    assert.notEqual(dom.window.getComputedStyle(dom.window.document.getElementById("data-content")).display, "none", "mounted shadow content must remain visible");
    assert.equal(requests.some(url => url.endsWith("/runs")), false);
    assert.equal(requests.some(url => url.includes("dashboard-data")), false);
    for (const module of ["monitor", "runs", "errors", "problems"]) await select(module);
    const failedModule = dom.window.document.getElementById("problems-content");
    assert.match(failedModule.textContent, /503/);
    assert.notEqual(dom.window.getComputedStyle(failedModule).display, "none", "load errors must remain visible");
    assert.equal(dom.window.document.getElementById("monitor-content").shadowRoot.querySelector(".mount-error"), null);
    failedModule.querySelector("button").click();
    await waitFor(() => Boolean(failedModule.shadowRoot?.getElementById("problem-tree")));
    await select("reference");
    for (const id of ["monitor","data","runs","errors","problems","definitions"]) {
      const root = dom.window.document.getElementById(`${id}-content`).shadowRoot;
      assert(root, id);
      assert.equal(dom.window.document.getElementById(`${id}-content`).hidden, false, id);
      assert.notEqual(dom.window.getComputedStyle(dom.window.document.getElementById(`${id}-content`)).display, "none", id);
      assert.equal(root.querySelector("iframe, details, .workspace-nav, .page-tabs"),null,id);
      assert.equal(root.querySelector(".mount-error"),null,id);
    }
    assert(requests.includes("/runtime/api/dashboard/runs"));
    await select("data");
    const dataHost = dom.window.document.getElementById("data-content");
    const intake = dataHost.shadowRoot;
    const category = intake.getElementById("intake-category");
    category.value = "task"; category.dispatchEvent(new dom.window.Event("change"));
    await waitFor(() => requests.some(url => url.includes("catalog?") && url.includes("category=task")));
    await new Promise(setImmediate);
    const task = intake.getElementById("intake-task");
    task.value = "post"; task.dispatchEvent(new dom.window.Event("change"));
    await waitFor(() => !intake.getElementById("intake-browse").disabled);
    intake.getElementById("intake-browse").click();
    await waitFor(() => requests.includes("/data/post_training_model/dashboard-data"));
    const catalog = dom.window.document.getElementById("catalog-content").shadowRoot;
    assert.equal(catalog.querySelector(".dataset-range-models").textContent, "2 个模型");
    assert.match(catalog.querySelector("thead").textContent, /AA-fast.*AA-post_train_fast_V1/);
    assert.equal(catalog.querySelectorAll("thead th").length, 2);
    assert.equal(dataHost.shadowRoot, intake, "filters must preserve the task workspace");
    const monitor = dom.window.document.getElementById("monitor-content").shadowRoot;
    for (const id of ["dates","activity","mongo-deliveries","deliveries"]) assert.equal(monitor.getElementById(id).hidden,false);
    assert.match(dom.window.document.getElementById("definitions-content").shadowRoot.textContent,/配置不可用/);
    await select("runs");
    const runsRoot = dom.window.document.getElementById("runs-content").shadowRoot;
    runsRoot.getElementById("sample-seed").value = "73";
    dom.window.scrollY = 640;
    const requestCount = requests.filter(url => url.endsWith("/runs")).length;
    await select("data");
    await select("runs");
    assert.equal(dom.window.document.getElementById("runs-content").shadowRoot, runsRoot);
    assert.equal(runsRoot.getElementById("sample-seed").value, "73");
    assert.equal(dom.window.scrollY, 640);
    assert.equal(requests.filter(url => url.endsWith("/runs")).length, requestCount);
    assert.equal(dom.window.location.pathname, "/");
    assert.equal(dom.window.location.hash, "#runs");
    assert.equal(dom.window.sessionStorage.getItem("workbench-module"), "runs");
    assert.equal(runsRoot.getElementById("sample-seed").classList.contains("form-control"), true);
    assert.equal(monitor.querySelector("table").classList.contains("table"), true);
    dom.window.document.getElementById("nav-runs").dispatchEvent(new dom.window.KeyboardEvent("keydown", { key:"ArrowDown", bubbles:true }));
    assert.equal(dom.window.document.getElementById("errors").hidden, false);
    dom.window.location.hash = "data";
    dom.window.dispatchEvent(new dom.window.HashChangeEvent("hashchange"));
    assert.equal(dom.window.document.getElementById("data").hidden, false);
    assert.equal(dom.window.document.querySelectorAll('[role=tabpanel]:not([hidden])').length, 1);
    assert.deepEqual(faults, []);
  } finally { dom.window.close(); }
});
