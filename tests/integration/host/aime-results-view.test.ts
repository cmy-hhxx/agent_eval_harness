import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { ROOT } from '../../fixtures/services.js';
const { JSDOM } = createRequire(import.meta.url)('jsdom');

test('AIME results show score and direct attribution with independent statuses, filters, source coordinates and scoped retry', async () => {
  const directory = path.join(ROOT,'apps/host/dashboard');
  const dom = new JSDOM(await readFile(path.join(directory,'aime-results.html'),'utf8'),{url:'http://fixture/',runScripts:'outside-only'});
  const compiled = await build({entryPoints:[path.join(directory,'aime-results.js')],bundle:true,write:false,format:'iife',globalName:'Aime',platform:'browser'});
  dom.window.setTimeout = () => 0;
  const calls:{url:string;body:any}[] = [], sample = {inputId:'input-1',batchId:'b',caseId:'case-1',traceId:'trace-1',question:'完整问句 <script>',model:'aime_fast',status:'partial',stages:{score:{status:'succeeded',taskId:'score-1'},attribution:{status:'failed',taskId:'attr-1',error:'证据错误',attempts:2}}};
  let failed = false, empty = false;
  const fetcher = async (url:string,init:RequestInit={}) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined; calls.push({url,body});
    if (failed) return Response.json({error:'服务断开'},{status:503});
    if (url.endsWith('/runs')) return Response.json({runs:empty ? [] : [{runId:'1024',date:'2026-10-24',status:'interrupted',questions:13,answers:26,total:26,succeeded:25,partial:1,failed:1,pending:0,taskCompleted:51,taskTotal:52,stages:{score:{total:26,succeeded:26,failed:0},attribution:{total:26,succeeded:25,failed:1}},artifacts:[{name:'results/score.jsonl',path:'/out/results/score.jsonl'}]}]});
    if (url.endsWith('/samples/input-1')) return Response.json({...sample,answer:'**最终回答**',input:{messages:['trace']},source:{archive:'input.7z',member:'inside.jsonl',line:8,item:0},tasks:[{id:'attr-1',stage:'attribution',status:'failed',reason:'证据错误',attempts:2,errors:[{path:'/evidence',message:'缺失'}]}],results:{score:{evaluation:{final_answer_score:{score:8,status:'met'}}},attribution:{summary:'中文归因总结',findings:[{type:'problem',component:['检索'],label:'证据缺失',definition:'缺少来源',text:'事实未证实',reason:'缺少出处'}],evidence:[{quote:'真实证据'}]}}});
    if (url.includes('/samples?')) {
      const status = new URL(url,'http://fixture').searchParams.get('status');
      const item = status === 'succeeded' ? {...sample,status:'succeeded',stages:{score:{status:'succeeded',taskId:'score-1'},attribution:{status:'succeeded',taskId:'attr-1'}}} : sample;
      return Response.json({runId:'1024',items:[item],total:status ? 1 : 26,offset:0,limit:25});
    }
    if (url.endsWith('/retry')) return Response.json({});
    throw new Error(url);
  };
  const wait = async (condition:()=>boolean) => {for(let n=0;n<100;n++){if(condition())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('AIME UI did not update');};
  dom.window.eval(compiled.outputFiles[0].text+'\nglobalThis.Aime=Aime;'); const controller = dom.window.Aime.mountAimeResults(dom.window.document,{fetch:fetcher});
  const el = (id:string) => dom.window.document.getElementById(id);
  try {
    await controller.ready; assert.match(el('aime-sample-rows').textContent,/完整问句.*case-1.*trace-1/s); assert.match(el('aime-sample-rows').textContent,/已完成.*失败/s);
    assert.match(el('aime-run-status').textContent,/问句 13.*回答 26.*完整回答 25 \/ 26.*部分完成 1.*阶段任务 51 \/ 52/);
    assert.equal(el('aime-sample-rows').querySelector('[data-cell=answer-status]').textContent,'部分完成');
    el('aime-sample-rows').querySelector('button').click(); await wait(()=>!el('aime-detail').hidden);
    assert.match(el('aime-results').textContent,/独立评分.*最终回答得分.*8.*回答归因.*中文归因总结.*证据缺失.*真实证据/s);
    assert.equal(el('aime-detail').querySelector('script'),null); assert.match(el('aime-location').textContent,/input.7z.*inside.jsonl:8 \[0\]/s); assert(el('aime-answer').querySelector('strong'));
    el('aime-task-errors').querySelector('button').click(); await wait(()=>calls.some(call=>call.body?.taskIds)); assert.deepEqual(calls.find(call=>call.body?.taskIds)!.body,{taskIds:['attr-1']});
    el('aime-status').value='partial'; el('aime-filters').dispatchEvent(new dom.window.Event('submit',{cancelable:true})); await wait(()=>calls.some(call=>call.url.includes('status=partial'))); await wait(()=>el('aime-page').textContent.includes('1 个回答'));
    assert.equal(el('aime-sample-rows').querySelector('[data-cell=answer-status]').textContent,'部分完成');
    el('aime-status').value='succeeded'; el('aime-filters').dispatchEvent(new dom.window.Event('submit',{cancelable:true})); await wait(()=>el('aime-sample-rows').querySelector('[data-cell=answer-status]').textContent==='已完成');
    assert.equal([...el('aime-sample-rows').querySelector('tr').children].slice(3,5).map((cell:any)=>cell.textContent).join(' / '),'已完成 / 已完成');
    el('aime-status').value='';
    el('aime-query').value='trace-1'; el('aime-model').value='aime_fast'; el('aime-filters').dispatchEvent(new dom.window.Event('submit',{cancelable:true})); await wait(()=>calls.some(call=>call.url.includes('query=trace-1')&&call.url.includes('model=aime_fast')));
    await wait(()=>!el('aime-next').disabled);
    el('aime-next').click(); await wait(()=>calls.some(call=>call.url.includes('offset=25')));
    assert.match(el('aime-artifacts').querySelector('a').href,/file=results%2Fscore.jsonl/);
    failed = true; el('aime-refresh').click(); await wait(()=>!el('aime-error').hidden); assert.match(el('aime-sample-rows').textContent,/trace-1/); assert.equal(el('aime-retry-failed').disabled,true);
    failed = false; empty = true; el('aime-refresh').click(); await wait(()=>el('aime-run-status').textContent === '暂无运行');
    assert.equal(el('aime-detail').hidden,true); assert.equal(el('aime-sample-rows').children.length,0); assert.equal(el('aime-query').value,'trace-1');
  } finally { controller.destroy(); dom.window.close(); }
});
