import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { ROOT } from "../../fixtures/services.js";
const { JSDOM } = createRequire(import.meta.url)("jsdom");

test("batch UI previews, starts, locates failed data, retries a task and keeps recovered history", async () => {
  const directory = path.join(ROOT,'apps/host/dashboard');
  const dom = new JSDOM(await readFile(path.join(directory,'batch-runs.html'),'utf8'),{url:'http://fixture/',runScripts:'outside-only'});
  const compiled = await build({entryPoints:[path.join(directory,'batch-runs.js')],bundle:true,write:false,format:'iife',globalName:'BatchRuns',platform:'browser'});
  dom.window.HTMLElement.prototype.scrollIntoView = () => {}; dom.window.setInterval = () => 0;
  const calls:{path:string;body:any}[] = [];
  let run:any, fail = false;
  const task = { task_id:'attempt-task',stage:'attribution',status:'failed',attempts:2,reason:'请求超时',errors:[{path:'/findings/0',message:'证据坐标无效'}],dependencies:[],locations:[{case_id:'case-7',model:'b_fast',original_file:'p.7z/nested/input.jsonl',original_line:18}] };
  const fetcher = async (url:string, init:RequestInit = {}) => {
    const path = url.replace('/runtime/api/dashboard/','');
    if (fail) return new Response(JSON.stringify({error:'服务离线'}),{status:503});
    let value:any;
    if (init.method === 'POST') {
      const body = JSON.parse(String(init.body)); calls.push({path,body});
      if (path === 'batch-runs/preview') value = {run_id:'run',task:{name:'专项'},summary:{valid_inputs:2,attribution_tasks:2,comparison_tasks:1,issues_count:0},tasks:4,models:['b_fast','b_post_train_fast'],evaluator_models:{attribution:'judge'},output_dir:'/source/eval_output/1_task_eval/task/run'};
      else { run = {run_id:'run',task:{name:'专项',source:'wencai'},batch_ids:['pkg'],status:'finished',progress:{accepted:1,running:0,queued:0,failures:{transport:1},blocked:1}}; value = {run_id:'run'}; }
    } else if (path === 'batch-runs') value = {runs:run?[run]:[]};
    else if (path.startsWith('runs/run/errors')) value = {tasks:[task],unresolved_count:1,total:1,page_size:40,records:[{record:{time:'2026-10-22',stage:'attribution',message:'请求超时'},task,recovery:path.includes('history=true')?'recovered':'unresolved'}]};
    else throw new Error(path);
    return new Response(JSON.stringify(value));
  };
  const el = (id:string) => dom.window.document.getElementById(id);
  const wait = async (check:()=>boolean) => { for(let n=0;n<100;n++){ if(check())return;await new Promise(resolve=>setTimeout(resolve,5)); } assert.fail('UI did not update'); };
  dom.window.eval(compiled.outputFiles[0].text+'\nglobalThis.BatchRuns=BatchRuns;');
  const controller = dom.window.BatchRuns.mountBatchRuns(dom.window.document,{fetch:fetcher});
  try {
    await controller.ready; controller.select(['pkg']);
    el('batch-launch-form').dispatchEvent(new dom.window.Event('submit',{cancelable:true}));
    await wait(()=>!el('batch-start').disabled);
    assert.match(el('batch-preview-summary').textContent,/2 个回答/); assert.match(el('batch-evaluator').textContent,/judge/);
    el('batch-start').click(); await wait(()=>/部分完成/.test(el('batch-run-rows').textContent));
    await controller.showErrors('run');
    assert.match(el('batch-error-rows').textContent,/case-7.*b_fast[\s\S]*nested\/input.jsonl.*18[\s\S]*回答归因[\s\S]*2 次/);
    const retry = [...el('batch-error-rows').querySelectorAll('button')].find((button:any)=>button.textContent==='重试此项') as any;
    retry.click(); await wait(()=>calls.some(call=>call.path==='batch-runs/run/retry'));
    assert.deepEqual(calls.find(call=>call.path==='batch-runs/run/retry')!.body,{task_ids:['attempt-task']});
    el('batch-history').checked = true; el('batch-history').dispatchEvent(new dom.window.Event('change'));
    await wait(()=>/已恢复/.test(el('batch-error-history').textContent));
    fail = true; el('batch-refresh').click(); await wait(()=>!el('batch-error').hidden);
    assert.match(el('batch-run-rows').textContent,/专项/);
  } finally { controller.destroy(); dom.window.close(); }
});
