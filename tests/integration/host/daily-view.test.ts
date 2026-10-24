import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { ROOT } from '../../fixtures/services.js';
const { JSDOM } = createRequire(import.meta.url)('jsdom');

test('daily sources control independently and preserve configuration drafts, package pages and last data on failure', async () => {
  const directory = path.join(ROOT,'apps/host/dashboard');
  const dom = new JSDOM(await readFile(path.join(directory,'daily.html'),'utf8'),{url:'http://fixture/',runScripts:'outside-only'});
  const compiled = await build({entryPoints:[path.join(directory,'daily.js')],bundle:true,write:false,format:'iife',globalName:'Daily',platform:'browser'});
  dom.window.setTimeout = () => 0;
  const settings = {engine:'pi',bindings:{attribution:{channel:'judge',model:'judge-model',thinking:'medium'}},execution:{timeoutSeconds:600,maxToolCalls:8,retries:1,repairAttempts:2,maxTaskAttempts:4,retryDelaySeconds:10},rewrite:{attribution:false},debug:false};
  const sources = ['wencai','aime'].map(id => ({id,name:id,workflow:id === 'aime' ? 'answer-review' : 'comparison',status:'idle',archiveDirectory:`/${id}/input`,outputDirectory:`/${id}/output`,concurrency:id === 'aime' ? 64 : 32,activeRequests:id === 'aime' ? 2 : 3,waitingRequests:1,settings:structuredClone(settings),activeSettings:structuredClone(settings),modelCatalog:[{id:'judge-model',channel:'judge',name:'Judge'}],packages:{items:[{id:'p',name:`${id}.7z`,status:'pending',accepted:2,excluded:1}],total:41,page:1,pageSize:40},stages:{attribution:{total:10,completed:5,running:2,pending:3,failed:0}},runs:[],...(id === 'wencai' ? {mongo:{status:'completed',inputs:2,outputs:1}} : {questions:7,answers:10,completedAnswers:5,models:{aime_fast:{answers:6,completed:3,failed:1,pending:2},aime_expert:{answers:4,completed:2,failed:0,pending:2}}})}));
  const calls:{url:string;body:any}[] = []; let offline = false;
  const fetcher = async (url:string,init:RequestInit = {}) => {
    if (offline) return new Response(JSON.stringify({error:'离线'}),{status:503});
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (body) calls.push({url,body});
    const source = sources.find(item => url.includes('/' + item.id + '/'));
    if (url.endsWith('/control')) { source!.status = ({run:'running',pause:'paused',resume:'running',stop:'idle'} as Record<string,string>)[body.action]; return Response.json({}); }
    if (url.endsWith('/concurrency')) { source!.concurrency = body.concurrency; return Response.json({}); }
    if (url.endsWith('/settings')) return Response.json({});
    if (url.includes('/packages?')) return Response.json({items:[{id:'last',name:'last.7z',status:'pending',accepted:0,excluded:0}],total:41,page:2,pageSize:40});
    return Response.json({sources,requests:[],sampledAt:Date.now()});
  };
  const wait = async (condition:()=>boolean) => { for (let n=0;n<100;n++) { if(condition()) return; await new Promise(resolve=>setTimeout(resolve,5)); } assert.fail('daily UI did not update'); };
  dom.window.eval(compiled.outputFiles[0].text+'\nglobalThis.Daily=Daily;');
  const controller = dom.window.Daily.mountDaily(dom.window.document,{fetch:fetcher});
  const el = (id:string) => dom.window.document.getElementById(id), row = (id:string) => el('daily-source-rows').querySelector(`[data-source="${id}"]`);
  const click = (id:string,label:string) => [...row(id).querySelectorAll('button')].find((item:any)=>item.textContent===label).click();
  try {
    await controller.ready; assert.match(el('daily-requests-total').textContent,/请求 5.*等待 2/);
    assert.equal(el('daily-aime-coverage').hidden,true);
    assert.equal(row('wencai').querySelector('[data-cell=pending]').textContent,'3'); assert.equal(row('wencai').querySelector('[data-cell=completed]').textContent,'5');
    assert.equal(el('daily-settings-heading').textContent,'下次执行配置'); assert.match(el('daily-active-values').textContent,/judge-model.*600/s);
    click('wencai','评测'); await wait(()=>row('wencai').textContent.includes('运行中'));
    assert.equal(sources[1].status,'idle'); click('aime','评测'); await wait(()=>sources[1].status==='running');
    click('wencai','暂停'); await wait(()=>row('wencai').textContent.includes('已暂停')); assert.equal(sources[1].status,'running');
    click('wencai','继续'); await wait(()=>sources[0].status==='running');
    click('aime','立即停止'); await wait(()=>sources[1].status==='idle' && !row('aime').querySelector('input').disabled); assert.equal(sources[0].status,'running');
    el('daily-timeout').value='901'; el('daily-timeout').dispatchEvent(new dom.window.Event('input',{bubbles:true}));
    controller.select('aime'); assert.equal(el('daily-timeout').value,'600'); assert.equal(el('daily-mongo').hidden,true);
    assert.equal(el('daily-aime-coverage').hidden,false); assert.match(el('daily-aime-counts').textContent,/问句 7.*回答 10.*完整回答 5.*阶段任务 5 \/ 10/);
    assert.deepEqual([...el('daily-aime-model-rows').querySelectorAll('tr')].map((row:any)=>[...row.children].map((cell:any)=>cell.textContent)),[['Fast','6','3','1','2'],['Expert','4','2','0','2']]);
    const aimeSource = sources[1] as Record<string,any>; delete aimeSource.models; delete aimeSource.questions; delete aimeSource.answers; delete aimeSource.completedAnswers;
    await controller.refresh(); assert.equal(el('daily-aime-model-table').hidden,true); assert.equal(el('daily-aime-counts').textContent,'阶段任务 5 / 10');
    el('daily-settings-form').dispatchEvent(new dom.window.Event('submit',{cancelable:true})); await wait(()=>el('daily-settings-status').textContent.includes('已保存'));
    assert.equal(Object.hasOwn(calls.find(call=>call.url.endsWith('/aime/settings'))!.body,'rewrite'),false);
    controller.select('wencai'); assert.equal(el('daily-timeout').value,'901'); assert.equal(el('daily-mongo').hidden,false);
    el('daily-package-next').click(); await wait(()=>el('daily-package-rows').textContent.includes('last.7z')); await controller.refresh(); assert.match(el('daily-package-page').textContent,/2 \/ 2/);
    el('daily-settings-form').dispatchEvent(new dom.window.Event('submit',{cancelable:true})); await wait(()=>el('daily-settings-status').textContent.includes('已保存'));
    assert.equal(calls.find(call=>call.url.endsWith('/wencai/settings'))!.body.execution.timeoutSeconds,901);
    assert.equal(calls.find(call=>call.url.endsWith('/wencai/settings'))!.body.execution.maxTaskAttempts,4);
    offline = true; await controller.refresh(); assert.match(el('daily-error').textContent,/离线/); assert.match(row('wencai').textContent,/问财日常四路/); assert([...row('wencai').querySelectorAll('button')].every((item:any)=>item.disabled));
  } finally { controller.destroy(); dom.window.close(); }
});

test('package reports show exact exclusions and per-answer evaluation coverage with pagination and result recall', async () => {
  const directory = path.join(ROOT,'apps/host/dashboard');
  const dom = new JSDOM(await readFile(path.join(directory,'daily.html'),'utf8'),{url:'http://fixture/',runScripts:'outside-only'});
  const compiled = await build({entryPoints:[path.join(directory,'daily.js')],bundle:true,write:false,format:'iife',globalName:'Daily',platform:'browser'});
  dom.window.setTimeout = () => 0;
  const calls:string[] = [], recalls:string[][] = [];
  const summary = {read:52,accepted:50,excluded:2,questions:25,metadata_issue_count:1,file_errors:[]};
  const fetcher = async (url:string) => {
    calls.push(url);
    if(url.includes('/packages/package-1/report')) {
      const query = new URL(url,'http://fixture').searchParams, section = query.get('section'), page = Number(query.get('page'));
      const items = section === 'records' ? [{model:'aime_fast',case_id:'case-1',original_file:'online.7z/member.jsonl',original_line:18,original_item:0,coverage:{runIds:['1024'],stages:{score:{total:1,completed:1,failed:0,pending:0,running:0},attribution:{total:1,completed:0,failed:1,pending:0,running:0}}}}] : section === 'exclusions' ? [{model:'aime_expert',case_id:'bad-case',original_file:'online.7z/bad.jsonl',original_line:19,original_item:2,reason:'missing_trace_id'}] : [{model:'aime_fast',case_id:'case-1',original_file:'online.7z/member.jsonl',original_line:18,field:'difficulty',error:'conflicting_labels'}];
      return Response.json({batch_id:'package-1',status:'cleaned',summary,section,page,page_size:50,total:section === 'records' ? 51 : 1,items});
    }
    return Response.json({sources:[{id:'wencai',name:'问财',workflow:'comparison',status:'idle',concurrency:32,settings:{bindings:{},execution:{}},packages:{items:[{id:'package-1',name:'online.7z',status:'cleaned',accepted:50,excluded:2}],total:1,page:1,pageSize:50},runs:[],stages:{}}],requests:[]});
  };
  const wait = async (condition:()=>boolean) => {for(let n=0;n<100;n++){if(condition())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('package report did not update');};
  dom.window.eval(compiled.outputFiles[0].text+'\nglobalThis.Daily=Daily;'); const controller = dom.window.Daily.mountDaily(dom.window.document,{fetch:fetcher,onResults:(...args:string[])=>recalls.push(args)});
  const el = (id:string) => dom.window.document.getElementById(id);
  try {
    await controller.ready; el('daily-package-rows').querySelector('button').click(); await wait(()=>el('daily-report-rows').textContent.includes('case-1'));
    assert.equal(el('daily-package-report').hidden,false); assert.match(el('daily-report-summary').textContent,/读入 52.*纳入 50.*排除 2/);
    assert.match(el('daily-report-rows').textContent,/online.7z\/member.jsonl.*18 \/ 0.*独立评分 1 \/ 1.*回答归因 0 \/ 1 · 失败 1/s);
    el('daily-report-rows').querySelector('button').click(); assert.deepEqual(recalls,[['wencai','1024']]);
    el('daily-report-next').click(); await wait(()=>calls.some(url=>url.includes('section=records&page=2'))); await wait(()=>el('daily-report-page').textContent.startsWith('2 / 2'));
    el('daily-report-section').value='exclusions'; el('daily-report-section').dispatchEvent(new dom.window.Event('change')); await wait(()=>el('daily-report-rows').textContent.includes('missing_trace_id'));
    assert.match(el('daily-report-rows').textContent,/bad.jsonl.*19 \/ 2/s); assert.match(el('daily-report-page').textContent,/1 \/ 1/);
    el('daily-report-section').value='metadata_issues'; el('daily-report-section').dispatchEvent(new dom.window.Event('change')); await wait(()=>el('daily-report-rows').textContent.includes('difficulty · conflicting_labels'));
    await controller.refresh(); assert.equal(el('daily-report-section').value,'metadata_issues'); assert.match(el('daily-report-rows').textContent,/conflicting_labels/);
  } finally {controller.destroy();dom.window.close();}
});

test('a delayed configuration failure stays with its source and preserves its draft and actual settings', async () => {
  const directory = path.join(ROOT,'apps/host/dashboard');
  const dom = new JSDOM(await readFile(path.join(directory,'daily.html'),'utf8'),{url:'http://fixture/',runScripts:'outside-only'});
  const compiled = await build({entryPoints:[path.join(directory,'daily.js')],bundle:true,write:false,format:'iife',globalName:'Daily',platform:'browser'});
  dom.window.setTimeout = () => 0;
  let release!:()=>void, started = false;
  const held = new Promise<void>(resolve=>{release=resolve;});
  const settings = {engine:'pi',execution:{timeoutSeconds:600,maxToolCalls:8,retries:1},bindings:{},rewrite:{}};
  const fetcher = async (url:string) => {
    if(url.endsWith('/wencai/settings')) {started=true;await held;return Response.json({error:'问财预算无效'},{status:400});}
    return Response.json({sources:['wencai','aime'].map(id=>({id,name:id,status:'idle',concurrency:32,settings,activeSettings:settings,stages:{},packages:{items:[],total:0,page:1,pageSize:50},runs:[]})),requests:[]});
  };
  const wait = async (condition:()=>boolean) => {for(let n=0;n<100;n++){if(condition())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('configuration request did not settle');};
  dom.window.eval(compiled.outputFiles[0].text+'\nglobalThis.Daily=Daily;');const controller=dom.window.Daily.mountDaily(dom.window.document,{fetch:fetcher});const el=(id:string)=>dom.window.document.getElementById(id);
  try {
    await controller.ready;el('daily-timeout').value='777';el('daily-timeout').dispatchEvent(new dom.window.Event('input',{bubbles:true}));
    el('daily-settings-form').dispatchEvent(new dom.window.Event('submit',{cancelable:true}));await wait(()=>started);controller.select('aime');
    assert.equal(el('daily-timeout').value,'600');assert.equal(el('daily-settings-status').textContent,'');
    const aime=el('daily-source-rows').querySelector('[data-source=aime]');assert.equal([...aime.querySelectorAll('button')].find((button:any)=>button.textContent==='评测').disabled,false);
    release();await wait(()=>!el('daily-timeout').disabled);assert.equal(el('daily-settings-status').textContent,'');
    controller.select('wencai');assert.equal(el('daily-timeout').value,'777');assert.equal(el('daily-settings-status').textContent,'问财预算无效');assert.match(el('daily-active-values').textContent,/超时 600 秒/);
  } finally {release();controller.destroy();dom.window.close();}
});
