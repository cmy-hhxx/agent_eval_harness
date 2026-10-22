import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
import {ROOT} from '../../fixtures/services.js';
const {JSDOM}=createRequire(import.meta.url)('jsdom');
test('analysis UI selects task, package and run, previews once, shows coverage and recalls results',async()=>{
  const directory=path.join(ROOT,'apps/host/dashboard'),dom=new JSDOM(await readFile(path.join(directory,'analysis.html'),'utf8'),{url:'http://fixture/',runScripts:'outside-only'});
  dom.window.setInterval=()=>0;
  const compiled=await build({entryPoints:[path.join(directory,'analysis.js')],bundle:true,write:false,format:'iife',globalName:'Analysis',platform:'browser'});
  const calls:{path:string;body:any}[]=[],recalls:unknown[]=[];let started=false,offline=false;
  const runs=[{run_id:'new',task:{id:'task',name:'AIME任务',source:'aime',category:'task'},batch_ids:['pkg'],status:'finished'},{run_id:'old',task:{id:'task',name:'AIME任务',source:'aime',category:'task'},batch_ids:['pkg'],status:'finished'}];
  const fetcher=async(url:string,init:RequestInit={})=>{
    if(offline)return new Response(JSON.stringify({error:'离线'}),{status:503});
    const endpoint=url.replace('/runtime/api/dashboard/',''),body=init.body?JSON.parse(String(init.body)):undefined;calls.push({path:endpoint,body});let value:any;
    if(endpoint==='batch-runs')value={runs};
    else if(endpoint==='analysis')value={jobs:started?[{id:'job',scope:{task_id:'task',run_ids:['new']},status:'interrupted',accepted:0,total:1,errors:[],paused_stages:[],output_dir:'/out/job'}]:[]};
    else if(endpoint==='analysis/scope')value={rows:[{run_id:'new',case_id:'case',model:'model',batch_id:'b1',package_name:'p.7z',original_file:'p.7z/member.jsonl',original_line:7,status:started?'reserved':'available',evaluation_status:'succeeded',job_id:started?'job':undefined}],counts:{available:started?0:1,reserved:started?1:0,included:0,unfinished:2,superseded:0},total:1,page_size:40};
    else if(endpoint==='analysis/preview')value={job_id:'job',summary:{attribution_answers:1,clustering_tasks:1,recalled_problems:0},output_dir:'/out/job'};
    else if(endpoint==='analysis/job/start'){started=true;value={job_id:'job'};}
    else if(endpoint==='analysis/job/sources')value={sources:[{kind:'selected',source:{model:'model',case_id:'case',batch_id:'b1',run_id:'new',task_id:'attribution'}}],selected_count:1,recalled_count:0,total:1,page_size:40};
    else if(endpoint==='analysis/job/artifacts')value=[{name:'report.md',bytes:12}];
    else if(endpoint==='analysis/job/errors?history=true')value={tasks:[],records:[{record:{message:'fixture failure'}}],total:1,page_size:40};
    else if(endpoint==='batch-runs/new/artifacts')value={directory:'/out/new',files:[{name:'report.md',bytes:12,modified_at:1}]};
    else throw new Error(endpoint);
    return new Response(JSON.stringify(value));
  };
  dom.window.eval(compiled.outputFiles[0].text+'\nglobalThis.Analysis=Analysis;');
  const controller=dom.window.Analysis.mountAnalysis(dom.window.document,{fetch:fetcher,onResults:(...args:unknown[])=>recalls.push(args)});
  const el=(id:string)=>dom.window.document.getElementById(id),wait=async(check:()=>boolean)=>{for(let i=0;i<100;i++){if(check())return;await new Promise(r=>setTimeout(r,5));}assert.fail('UI update timed out');};
  try {
    await controller.ready;assert.deepEqual([...controller.state.selected],['new']);
    el('analysis-batch').value='pkg';el('analysis-batch').dispatchEvent(new dom.window.Event('change'));
    el('analysis-scope').click();await wait(()=>!el('analysis-preview').disabled);
    assert.deepEqual(calls.find(call=>call.path==='analysis/scope')!.body,{task_id:'task',batch_ids:['pkg'],run_ids:['new'],page:1,status:''});
    assert.match(el('analysis-counts').textContent,/评测未完成 2/);assert.match(el('analysis-rows').textContent,/member.jsonl:7/);
    el('analysis-preview').click();await wait(()=>!el('analysis-start').disabled);
    // Changing a selected run invalidates the pending preview.
    const checkbox=el('analysis-runs').querySelectorAll('input')[1];checkbox.click();assert.equal(el('analysis-start').disabled,true);
    await controller.selectRun('new');el('analysis-preview').click();await wait(()=>!el('analysis-start').disabled);
    el('analysis-start').click();el('analysis-start').click();await wait(()=>/已占用/.test(el('analysis-rows').textContent));
    assert.equal(calls.filter(call=>call.path==='analysis/job/start').length,1);
    assert.equal(el('analysis-preview').disabled,true);assert.match(el('analysis-jobs').textContent,/继续未完成/);
    el('analysis-rows').querySelector('button').click();await wait(()=>recalls.length===1);assert.equal((recalls[0] as any[])[0],'new');
    el('analysis-jobs').querySelector('button').click();await wait(()=>!el('analysis-job-detail').hidden);
    assert.match(el('analysis-job-body').textContent,/fixture failure/);assert.match(el('analysis-job-body').textContent,/本次归因 1/);
    assert.match(el('analysis-job-body').querySelector('a').href,/file=report.md/);
    offline=true;el('analysis-refresh').click();await wait(()=>!el('analysis-error').hidden);assert.match(el('analysis-runs').textContent,/new/);assert.match(el('analysis-rows').textContent,/已占用/);
  }finally{controller.destroy();dom.window.close();}
});
