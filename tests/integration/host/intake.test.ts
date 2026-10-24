import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { ROOT } from "../../fixtures/services.js";
const { JSDOM } = createRequire(import.meta.url)("jsdom");

test("intake creates a task, assigns batches, cleans and locates report samples; outages preserve results", async () => {
  const directory = path.join(ROOT, "apps/host/dashboard");
  const dom = new JSDOM(await readFile(path.join(directory, "intake.html"), "utf8"), { url:"http://fixture/", runScripts:"outside-only" });
  const compiled = await build({ entryPoints:[path.join(directory, "intake.js")], bundle:true, write:false, format:"iife", globalName:"Intake", platform:"browser" });
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  dom.window.setInterval = () => 0;
  const tasks = [{ id:"initial",name:"原任务",source:"wencai",category:"task",profile:"post_training_model",dataset:"/data/post_training_model" }];
  const batch = { id:"batch",name:"sample.7z",size:100,task_id:"initial",task_name:"原任务",source:"wencai",category:"task", status:"ready", summary:null as unknown, archive_path:"/data/sample.7z" };
  const calls: { path:string; body:any }[] = [];
  let outage = false;
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  const summary = { metadata_issue_count:1,read:3,accepted:2,excluded:1,questions:1,pairs:{ fast:1 }, reasons:[{ model:"b_fast",reason:"answer_empty",count:1 }],file_errors:[],error:null };
  const fetcher = async (url: string, init: RequestInit = {}) => {
    if (outage) return json({ error:"服务不可用" },503);
    const pathname = url.replace("/data/workbench/", "");
    if (init.method === "POST") {
      const body = JSON.parse(String(init.body)); calls.push({ path:pathname,body });
      if (pathname === "tasks") { const task = { ...body,id:"new",dataset:"/data/task-new" }; tasks.push(task); return json(task,201); }
      if (pathname === "assign") { batch.task_id = body.task_id; batch.task_name = "新专项"; return json({ assigned:1 }); }
      if (pathname === "clean") { batch.status = "cleaned"; batch.summary = summary; return json({ status:"queued" },202); }
    }
    if (pathname.startsWith("catalog")) return json({ tasks,batches:[batch],page:1,page_size:50,total:1 });
    if (pathname.includes("/report")) {
      const section = new URL(url,"http://fixture").searchParams.get("section");
      return json({ batch_id:"batch",archive_path:batch.archive_path,status:"cleaned",summary,section,page:1,page_size:50,total:1,
        items:[{ model:"b_fast",case_id:"case-1",original_file:"sample.7z/AA-fast.jsonl",original_line:12,reason:"answer_empty",field:"meta.rued",error:"R 必须是整数" }] });
    }
    if (pathname.includes("/sample")) return json({ record:{ question:"测试问题",answer:"测试回答" },location:{ case_id:"case-1",original_file:"sample.7z/AA-fast.jsonl",original_line:12 } });
    throw new Error(url);
  };
  const waitFor = async (check: () => boolean) => {
    for (let i=0;i<100;i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve,5)); }
    assert.fail("intake did not update");
  };
  const el = (id:string) => dom.window.document.getElementById(id);
  const change = (id:string,value:string) => { el(id).value = value; el(id).dispatchEvent(new dom.window.Event("change")); };
  const selectBatch = () => { const check = el("intake-rows").querySelector("input"); check.checked = true; check.dispatchEvent(new dom.window.Event("change")); };
  let controller: any;
  try {
    dom.window.eval(compiled.outputFiles[0].text + "\nglobalThis.Intake = Intake;");
    controller = dom.window.Intake.mountIntake(dom.window.document, { fetch:fetcher });
    await controller.ready;
    assert.match(el("intake-rows").textContent,/sample.7z/);
    el("intake-new").click(); el("task-name").value = "新专项";
    el("intake-create").dispatchEvent(new dom.window.Event("submit",{ cancelable:true }));
    await waitFor(() => el("intake-assign-task").value === "new");
    selectBatch(); el("intake-assign").click();
    await waitFor(() => /新专项/.test(el("intake-rows").textContent));
    selectBatch(); el("intake-clean").click();
    await waitFor(() => /清洗完成/.test(el("intake-rows").textContent));
    assert.deepEqual(calls.map(call => call.path), ["tasks","assign","clean"]);
    assert.deepEqual(calls[2].body,{ batch_ids:["batch"] });
    el("intake-rows").querySelector("button").click();
    await waitFor(() => !el("intake-report").hidden);
    assert.match(el("report-counts").textContent,/读入 3 条.*纳入 2 个回答.*排除 1 条/);
    assert.match(el("report-rows").textContent,/空回答/);
    change("report-section","metadata_issues");
    await waitFor(() => /meta.rued.*R 必须是整数/.test(el("report-rows").textContent));
    assert.match(el("report-counts").textContent,/标签与效率异常 1 项/);
    change("report-section","records");
    await waitFor(() => Boolean(el("report-rows").querySelector("button")));
    el("report-rows").querySelector("button").click();
    await waitFor(() => !el("intake-sample").hidden);
    assert.equal(el("sample-title").textContent,"样本 case-1");
    assert.equal(el("sample-answer").textContent,"测试回答");
    assert.match(el("sample-location").textContent,/第 12 行/);
    outage = true; el("intake-refresh").click();
    await waitFor(() => !el("intake-error").hidden);
    assert.match(el("intake-rows").textContent,/清洗完成/);
    assert.equal(el("intake-clean").disabled,true);
  } finally { controller?.destroy(); dom.window.close(); }
});
