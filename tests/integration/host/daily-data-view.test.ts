import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { ROOT } from '../../fixtures/services.js';

test('daily date table shows full-range completion, both AIME stages and independent source filters', async () => {
  const directory = path.join(ROOT,'apps/host/dashboard');
  const dom = new JSDOM(await readFile(path.join(directory,'daily-data.html'),'utf8'),{url:'http://fixture/',runScripts:'outside-only'});
  dom.window.HTMLDialogElement.prototype.showModal = function() { this.setAttribute('open',''); };
  dom.window.HTMLDialogElement.prototype.close = function() { this.removeAttribute('open'); this.dispatchEvent(new dom.window.Event('close')); };
  const bundle = await build({entryPoints:[path.join(directory,'daily-data.js')],bundle:true,write:false,format:'iife',globalName:'Data',platform:'browser'});
  const days = Array.from({length:16},(_,index)=>`2026-10-${String(index+1).padStart(2,'0')}`), requests:string[] = [], results:string[] = [];
  let completed = 300, aimeComplete = false, failure = false;
  const counts = (complete:number,total:number) => ({total,completed:complete,partial:total-complete,pending:0,running:0,failed:0});
  const analytics = (source:string) => ({source,intake:{totals:{answers:source==='aime'?16:16000},dates:days.map(date=>({date,answers:source==='aime'?1:1000})),
    dateModels:days.flatMap(date=>(source==='aime'?['aime_fast']:['a_fast','b_fast']).map(model=>({date,model,answers:source==='aime'?1:500}))),
    datePairs:source==='aime'?[]:days.map(date=>({date,tier:'Fast',paired:500,unpaired:0}))},
    evaluation:{dates:days.map(date=>({date})),groups:days.map(date=>({date,model:source==='aime'?'aime_fast':'Fast',...counts(source==='aime'?(aimeComplete?1:0):completed,source==='aime'?1:500),stages:source==='aime'?[{stage:'score',completed:aimeComplete?1:0,failed:0},{stage:'attribution',completed:1,failed:0}]:[]}))}});
  const fetcher = async (url:string) => { requests.push(url); if (url.includes('/records/')) return Response.json({total:1,items:[{format:'trace',trace_id:'trace-one',question:'完整原始问句',answer:'**完整原始回答**'}]}); if (failure) return Response.json({error:'读取故障'},{status:503}); return Response.json(analytics(url.includes('/aime/')?'aime':'wencai')); };
  dom.window.fetch = fetcher as any;
  dom.window.eval(bundle.outputFiles[0].text+'\nglobalThis.Data=Data;');
  const controller = dom.window.Data.mountDailyData(dom.window.document,{fetch:fetcher,onResults:(source:string)=>results.push(source),recordsTemplate:()=>readFile(path.join(ROOT,'server_dashboard_ths/records.html'),'utf8')});
  const el = (id:string) => dom.window.document.getElementById(id)! as any;
  const wait = async (check:()=>boolean) => {for(let i=0;i<100;i++){if(check())return;await new Promise(setImmediate);}assert.fail('table did not settle');};
  try {
    await controller.ready;assert.equal(el('data-date-rows').children.length,5);assert.match(el('data-date-rows').textContent,/完整完成 300 \/ 500 对/);assert.equal(el('data-date-rows').textContent.includes('✅'),false,'300 is not completion for a full-range source');
    completed=500;el('data-refresh').click();await wait(()=>el('data-date-rows').textContent.includes('✅'));assert.equal(requests.some(url=>url.includes('/records/')),false,'counts never load answer bodies');
    el('data-next').click();assert.match(el('data-page').textContent,/2 \/ 4/);assert.equal(el('data-date-rows').children.length,5);
    el('data-date').value=days[0];el('data-date').dispatchEvent(new dom.window.Event('change'));assert.equal(el('data-date-rows').children.length,1);
    await controller.select('aime');assert.equal(el('data-date').value,'');assert.equal(el('data-date-rows').textContent.includes('✅'),false);assert.match(el('data-date-rows').textContent,/Score 0 \/ 1.*Attribution 1 \/ 1/s);
    aimeComplete=true;el('data-refresh').click();await wait(()=>el('data-date-rows').textContent.includes('✅'));el('data-results').click();assert.deepEqual(results,['aime']);
    await controller.select('wencai');assert.equal(el('data-date').value,days[0]);assert.equal(el('data-date-rows').children.length,1);
    failure=true;el('data-refresh').click();await wait(()=>!el('data-error').hidden);assert.match(el('data-error').textContent,/读取故障.*保留上次数据/);assert.equal(el('data-date-rows').children.length,1);
    el('data-date-rows').querySelector('button').click();assert.equal(el('data-sample-dialog').open,true);await wait(()=>requests.some(url=>url.includes('/records/2026-10-01/a_fast')));await wait(()=>Boolean(el('data-sample-content').querySelector('.compact-records-table')));assert.match(el('data-sample-content').textContent,/完整原始问句/);const answer=el('data-sample-content').querySelector('td:nth-child(2) details');answer.open=true;await wait(()=>Boolean(answer.querySelector('strong')));assert.match(answer.textContent,/完整原始回答/);el('data-sample-close').click();assert.equal(el('data-sample-dialog').open,false);
  } finally {controller.destroy();dom.window.close();}
});
