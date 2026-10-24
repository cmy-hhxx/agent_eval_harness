import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { ROOT } from '../../fixtures/services.js';
const { JSDOM } = createRequire(import.meta.url)('jsdom');
function enableDialogs(dom:any) {
  dom.window.HTMLDialogElement.prototype.showModal = function(this:HTMLDialogElement) { this.setAttribute('open',''); };
  dom.window.HTMLDialogElement.prototype.close = function(this:HTMLDialogElement) { this.removeAttribute('open'); this.dispatchEvent(new dom.window.Event('close')); };
}


test('AIME results show score and direct attribution with independent statuses, filters, source coordinates and scoped retry', async () => {
  const directory = path.join(ROOT,'apps/host/dashboard');
  const dom = new JSDOM(await readFile(path.join(directory,'aime-results.html'),'utf8'),{url:'http://fixture/',runScripts:'outside-only'}); enableDialogs(dom);
  const compiled = await build({entryPoints:[path.join(directory,'aime-results.js')],bundle:true,write:false,format:'iife',globalName:'Aime',platform:'browser'});
  dom.window.setTimeout = () => 0;
  const calls:{url:string;body:any}[] = [], sample = {inputId:'input-1',batchId:'b',caseId:'case-1',traceId:'trace-1',question:'完整问句 <script>',model:'aime_fast',status:'partial',stages:{score:{status:'succeeded',taskId:'score-1'},attribution:{status:'failed',taskId:'attr-1',error:'证据错误',attempts:2}}};
  let failed = false, empty = false, sampleTotal = 26, attributionPrepared = false;
  const fetcher = async (url:string,init:RequestInit={}) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined; calls.push({url,body});
    if (failed) return Response.json({error:'服务断开'},{status:503});
    if (url.endsWith('/runs')) return Response.json({runs:empty ? [] : [{runId:'1024',date:'2026-10-24',status:'interrupted',questions:13,answers:26,total:26,succeeded:25,partial:1,failed:1,pending:0,taskCompleted:51,taskTotal:52,stages:{score:{total:26,succeeded:26,failed:0},attribution:{total:26,succeeded:25,failed:1}},artifacts:[{name:'results/score.jsonl',path:'/out/results/score.jsonl'}]}]});
    const currentSample = {...sample,stages:{...sample.stages,attribution:{...sample.stages.attribution,status:attributionPrepared ? 'pending' : 'failed'}}};
    if (url.endsWith('/samples/input-1')) return Response.json({...currentSample,answer:'**最终回答**',input:{messages:['trace']},source:{archive:'input.7z',member:'inside.jsonl',line:8,item:0},tasks:[{id:'attr-1',stage:'attribution',status:currentSample.stages.attribution.status,reason:'证据错误',attempts:2,errors:[{path:'/evidence',message:'缺失'}]},{id:'rewrite-1',stage:'rewrite',status:'failed',reason:'改写校验失败',attempts:1,errors:[]}],results:{score:{evaluation:{final_answer_score:{score:8,status:'met'}}},attribution:{summary:'中文归因总结',findings:[{type:'problem',component:['检索'],label:'证据缺失',definition:'缺少来源',text:'事实未证实',reason:'缺少出处'}],evidence:[{quote:'真实证据'}]}}});
    if (url.includes('/samples?')) {
      const status = new URL(url,'http://fixture').searchParams.get('status');
      const item = status === 'succeeded' ? {...currentSample,status:'succeeded',stages:{score:{status:'succeeded',taskId:'score-1'},attribution:{status:'succeeded',taskId:'attr-1'}}} : currentSample;
      return Response.json({runId:'1024',items:[item],total:status ? 1 : sampleTotal,offset:0,limit:25});
    }
    if (url.endsWith('/retry')) { attributionPrepared = true; return Response.json({retried:['attr-1']}); }
    throw new Error(url);
  };
  const wait = async (condition:()=>boolean) => {for(let n=0;n<100;n++){if(condition())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('AIME UI did not update');};
  dom.window.eval(compiled.outputFiles[0].text+'\nglobalThis.Aime=Aime;'); const controller = dom.window.Aime.mountAimeResults(dom.window.document,{fetch:fetcher});
  const el = (id:string) => dom.window.document.getElementById(id);
  try {
    await controller.ready; assert.match(el('aime-sample-rows').textContent,/完整问句.*case-1.*trace-1/s); assert.match(el('aime-sample-rows').textContent,/已完成.*失败/s);
    assert.match(el('aime-run').selectedOptions[0].textContent,/2026-10-24.*26 回答.*1 失败/);
    assert.match(el('aime-run-status').textContent,/问句 13.*回答 26.*完整回答 25 \/ 26.*部分完成 1.*阶段任务 51 \/ 52/);
    assert.equal(el('aime-sample-rows').querySelector('[data-cell=answer-status]').textContent,'部分完成');
    const opener=el('aime-sample-rows').querySelector('button'); opener.focus(); opener.click(); await wait(()=>el('aime-detail-loading').hidden); assert.equal(el('aime-detail').open,true);
    assert.equal(el('aime-detail-title').textContent,'回答详情'); assert.equal(el('aime-question').textContent,sample.question);
    assert.equal(el('aime-detail-panel-attribution').hidden,false); assert.equal(el('aime-detail-panel-answer').hidden,true);
    assert.match(el('aime-score-result').textContent,/最终回答得分.*8/s); assert.match(el('aime-attribution-result').textContent,/中文归因总结.*证据缺失.*真实证据/s);assert.match(el('aime-attribution-errors').textContent,/改写 · 失败 · 1 次.*改写校验失败/s);assert.equal(el('aime-attribution-errors').querySelectorAll('button').length,1,'unsupported rewrite preparation is not offered as a no-op');
    assert.equal(el('aime-detail').querySelector('script'),null); assert.match(el('aime-location').textContent,/input.7z.*inside.jsonl:8 \[0\]/s); assert(el('aime-answer').querySelector('strong'));
    el('aime-attribution-errors').querySelector('button').click(); await wait(()=>calls.some(call=>call.body?.taskIds)); assert.deepEqual(calls.find(call=>call.body?.taskIds)!.body,{taskIds:['attr-1']});
    await wait(()=>el('aime-detail-operation-status').textContent==='已准备 1 项重试');
    assert.match(el('aime-attribution-errors').textContent,/待处理 · 2 次.*证据错误.*缺失/s);assert.equal(el('aime-attribution-errors').querySelector('button'),null,'a prepared pending task retains its error without offering preparation again');assert.equal(el('aime-sample-rows').querySelector('[data-aime-retry]'),null);
    el('aime-detail-tab-answer').click(); assert.equal(el('aime-detail-panel-answer').hidden,false); el('aime-detail-close').click(); assert.equal(dom.window.document.activeElement,el('aime-sample-rows').querySelector('button'));
    el('aime-status').value='partial'; el('aime-filters').dispatchEvent(new dom.window.Event('submit',{cancelable:true})); await wait(()=>calls.some(call=>call.url.includes('status=partial'))); await wait(()=>el('aime-page').textContent.includes('1 个回答'));
    assert.equal(el('aime-sample-rows').querySelector('[data-cell=answer-status]').textContent,'部分完成');
    el('aime-status').value='succeeded'; el('aime-filters').dispatchEvent(new dom.window.Event('submit',{cancelable:true})); await wait(()=>el('aime-sample-rows').querySelector('[data-cell=answer-status]').textContent==='已完成');
    assert.equal([...el('aime-sample-rows').querySelector('tr').children].slice(3,5).map((cell:any)=>cell.textContent).join(' / '),'已完成 / 已完成');
    el('aime-status').value='';
    el('aime-query').value='trace-1'; el('aime-model').value='aime_fast'; el('aime-filters').dispatchEvent(new dom.window.Event('submit',{cancelable:true})); await wait(()=>calls.some(call=>call.url.includes('query=trace-1')&&call.url.includes('model=aime_fast')));
    el('aime-filter-reset').click(); await wait(()=>!calls.at(-1)!.url.includes('query=')); assert.equal(el('aime-query').value,''); assert.equal(el('aime-model').value,''); assert.equal(el('aime-status').value,'');
    el('aime-query').value='trace-1'; el('aime-filters').dispatchEvent(new dom.window.Event('submit',{cancelable:true}));
    el('aime-page-size').value='20'; el('aime-page-size').dispatchEvent(new dom.window.Event('change')); await wait(()=>calls.some(call=>call.url.includes('limit=20'))); await wait(()=>!el('aime-next').disabled);
    el('aime-next').click(); await wait(()=>calls.some(call=>call.url.includes('offset=20')));
    sampleTotal=5;el('aime-refresh').click();await wait(()=>el('aime-page').textContent.includes('1 / 1 · 5 个回答'));assert(calls.at(-1)!.url.includes('offset=0'));
    assert.match(el('aime-artifacts').querySelector('a').href,/file=results%2Fscore.jsonl/);
    failed = true; el('aime-refresh').click(); await wait(()=>!el('aime-error').hidden); assert.match(el('aime-sample-rows').textContent,/trace-1/); assert.equal(el('aime-retry-failed').disabled,true);
    failed = false; empty = true; el('aime-refresh').click(); await wait(()=>el('aime-run-status').textContent === '暂无运行');
    assert.equal(el('aime-detail').hidden,true); assert.equal(el('aime-sample-rows').children.length,0); assert.equal(el('aime-query').value,'trace-1');
  } finally { controller.destroy(); dom.window.close(); }
});

test('AIME ignores older refreshes and keeps one polling timer', async () => {
  const directory=path.join(ROOT,'apps/host/dashboard');
  const dom=new JSDOM(await readFile(path.join(directory,'aime-results.html'),'utf8'),{url:'http://fixture/',runScripts:'outside-only'});enableDialogs(dom);
  const compiled=await build({entryPoints:[path.join(directory,'aime-results.js')],bundle:true,write:false,format:'iife',globalName:'Aime',platform:'browser'});
  const timers=new Set<number>();let nextTimer=0,hold=false;const pending:((value:Response)=>void)[]=[];
  dom.window.setTimeout=(_callback:unknown,ms:number)=>{const id=++nextTimer;if(ms===5000)timers.add(id);return id;};dom.window.clearTimeout=(id:number)=>timers.delete(id);
  const overview=(answers:number)=>({runs:[{runId:'day',date:'2026-10-24',status:'running',answers,total:answers,succeeded:0,taskTotal:answers*2,taskCompleted:0,stages:{},artifacts:[]}]});
  const fetcher=async(url:string)=>url.endsWith('/runs') ? hold ? new Promise<Response>(resolve=>pending.push(resolve)) : Response.json(overview(1)) : Response.json({items:[],total:0,offset:0,limit:10});
  dom.window.eval(compiled.outputFiles[0].text+'\nglobalThis.Aime=Aime;');const controller=dom.window.Aime.mountAimeResults(dom.window.document,{fetch:fetcher});const el=(id:string)=>dom.window.document.getElementById(id);
  const settle=async()=>{for(let n=0;n<5;n++)await new Promise(setImmediate);};
  try{
    await controller.ready;assert.equal(timers.size,1);hold=true;el('aime-refresh').click();el('aime-refresh').click();assert.equal(pending.length,2);
    pending[1](Response.json(overview(2)));await settle();pending[0](Response.json(overview(1)));await settle();
    assert.equal(timers.size,1);assert.match(el('aime-run-status').textContent,/回答 2/);
  }finally{controller.destroy();dom.window.close();}
});

test('AIME filters and preparation actions stay scoped, and closing a loading detail cancels it', async () => {
  const directory=path.join(ROOT,'apps/host/dashboard');
  const dom=new JSDOM(await readFile(path.join(directory,'aime-results.html'),'utf8'),{url:'http://fixture/',runScripts:'outside-only'});enableDialogs(dom);
  const compiled=await build({entryPoints:[path.join(directory,'aime-results.js')],bundle:true,write:false,format:'iife',globalName:'Aime',platform:'browser'});
  dom.window.setTimeout=()=>0;
  const question='很长的实际问句。'.repeat(250),sample={inputId:'one',caseId:'case-one',traceId:'true-trace',question,model:'aime_fast',status:'failed',stages:{score:{taskId:'score-one',status:'failed'},attribution:{taskId:'attribution-one',status:'succeeded'}}};
  const calls:{url:string;body:any;signal:AbortSignal}[]=[];let navigation=0,hold=true,detailFailure=false,detailSignal:AbortSignal|undefined;
  const fetcher=async(url:string,init:RequestInit={})=>{
    calls.push({url,body:init.body?JSON.parse(String(init.body)):undefined,signal:init.signal as AbortSignal});
    if(url.endsWith('/runs'))return Response.json({runs:[{runId:'day',date:'2026-10-24',answers:1,total:1,failed:1,status:'interrupted',stages:{},artifacts:[]}]});
    if(url.endsWith('/retry'))return Response.json({retried:['score-one']});
    if(url.includes('/samples?')){const empty=new URL(url,'http://fixture').searchParams.get('query')==='nothing';return Response.json({items:empty?[]:[sample],total:empty?0:1,offset:0,limit:10});}
    if(url.endsWith('/samples/one')){
      detailSignal=init.signal as AbortSignal;
      if(hold)return new Promise<Response>((_resolve,reject)=>detailSignal!.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));
      if(detailFailure)return Response.json({error:'材料读取失败'},{status:503});
      return Response.json({...sample,answer:'原始完整回答'.repeat(300),input:{messages:[]},source:{archive:'a.7z',member:'member.jsonl',line:9},tasks:[{id:'score-one',stage:'score',status:'failed',attempts:1,reason:'真实错误'}],results:{}});
    }
    throw Error(url);
  };
  const wait=async(check:()=>boolean)=>{for(let n=0;n<100;n++){if(check())return;await new Promise(setImmediate);}assert.fail('results did not settle');};
  dom.window.eval(compiled.outputFiles[0].text+'\nglobalThis.Aime=Aime;');const controller=dom.window.Aime.mountAimeResults(dom.window.document,{fetch:fetcher,onEvaluate:()=>navigation++}),el=(id:string)=>dom.window.document.getElementById(id);
  try{
    await controller.ready;
    el('aime-sample-rows').querySelector('[data-aime-retry]').click();assert.equal(el('aime-operation-status').textContent,'准备中…');assert.equal(el('aime-go-evaluate').disabled,true);await wait(()=>el('aime-operation-status').textContent==='已准备 1 项重试');
    assert.deepEqual(calls.find(call=>call.body?.taskIds)!.body,{taskIds:['score-one']});assert.equal(el('aime-detail').open,false);
    el('aime-go-evaluate').click();assert.equal(navigation,1);assert.equal(calls.some(call=>call.url.includes('/control')),false);
    el('aime-model').value='aime_fast';el('aime-model').dispatchEvent(new dom.window.Event('change'));await wait(()=>calls.some(call=>call.url.includes('model=aime_fast')));
    el('aime-status').value='failed';el('aime-status').dispatchEvent(new dom.window.Event('change'));await wait(()=>calls.some(call=>call.url.includes('status=failed')));
    el('aime-query').value='nothing';el('aime-filters').dispatchEvent(new dom.window.Event('submit',{cancelable:true}));await wait(()=>el('aime-sample-rows').textContent==='无匹配回答');
    el('aime-filter-reset').click();await wait(()=>Boolean(el('aime-sample-rows').querySelector('button')));assert.equal(el('aime-status').value,'');assert.equal(el('aime-model').value,'');assert.equal(el('aime-query').value,'');
    el('aime-sample-rows').querySelector('button').focus();el('aime-sample-rows').querySelector('button').click();assert.equal(el('aime-detail').open,true);assert.equal(el('aime-detail-loading').hidden,false);
    el('aime-detail-close').click();assert.equal(detailSignal!.aborted,true);await new Promise(setImmediate);assert.equal(el('aime-detail').hidden,true);assert.equal(el('aime-retry-failed').disabled,false);
    hold=false;el('aime-sample-rows').querySelector('button').click();await wait(()=>el('aime-detail-loading').hidden);assert.equal(el('aime-detail-title').textContent,'回答详情');assert.equal(el('aime-question').textContent,question);assert.equal(el('aime-answer').textContent,'原始完整回答'.repeat(300));
    el('aime-detail-tab-score').dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowRight',cancelable:true}));assert.equal(el('aime-detail-panel-attribution').hidden,false);assert.equal(dom.window.document.activeElement,el('aime-detail-tab-attribution'));
    el('aime-detail-tab-source').click();assert.equal(el('aime-detail-panel-source').hidden,false);assert.match(el('aime-location').textContent,/true-trace.*a.7z.*member.jsonl:9/s);
    el('aime-detail-tab-score').click();el('aime-score-errors').querySelector('button').click();await wait(()=>!el('aime-detail-go-evaluate').hidden);el('aime-detail-go-evaluate').click();assert.equal(navigation,2);assert.equal(el('aime-detail').open,false);assert.equal(calls.some(call=>call.url.includes('/control')),false);
    detailFailure=true;el('aime-sample-rows').querySelector('button').click();await wait(()=>el('aime-detail-error').textContent.includes('材料读取失败'));
    el('aime-refresh').click();await wait(()=>el('aime-error').hidden);assert.match(el('aime-detail-error').textContent,/材料读取失败/,'an unrelated successful poll cannot erase the open detail failure');
  }finally{controller.destroy();dom.window.close();}
});
