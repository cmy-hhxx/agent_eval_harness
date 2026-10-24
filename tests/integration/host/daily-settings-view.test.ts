import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
import {ROOT} from '../../fixtures/services.js';
const {JSDOM}=createRequire(import.meta.url)('jsdom');
const model='deepseek-v4.1-flash-with-a-complete-current-model-identifier';

async function environment(save?:(id:string,value:any)=>Promise<Response>){
  const directory=path.join(ROOT,'apps/host/dashboard');
  const dom=new JSDOM(await readFile(path.join(directory,'daily.html'),'utf8'),{url:'http://fixture/',runScripts:'outside-only'});
  dom.window.HTMLDialogElement.prototype.showModal=function(this:HTMLDialogElement){this.setAttribute('open','');};
  dom.window.HTMLDialogElement.prototype.close=function(this:HTMLDialogElement){this.removeAttribute('open');this.dispatchEvent(new dom.window.Event('close'));};
  dom.window.setTimeout=()=>0;
  const execution={timeoutSeconds:600,maxToolCalls:8,retries:1,repairAttempts:3,retryDelaySeconds:10,maxTaskAttempts:4};
  const sources=['wencai','aime'].map(id=>({id,name:id,workflow:id==='aime'?'answer-review':'comparison',status:'idle',concurrency:32,
    archiveDirectory:`/mnt/fin_bench/${id}/input`,outputDirectory:`/mnt/fin_bench/${id}/output`,
    settings:{engine:'pi',debug:false,execution:{...execution},bindings:Object.fromEntries((id==='aime'?['score','attribution']:['criteria','attribution','comparison','rewrite']).map(stage=>[stage,{channel:'evaluation-gateway',model:id==='aime'?'saved-model-not-in-current-catalog':model,thinking:'high'}])),rewrite:{attribution:true,comparison:true}},
    activeSettings:{engine:'pi',execution:{...execution},bindings:{score:{model:'current-running-model',thinking:'low'}}},
    modelCatalog:[{id:model,channel:'evaluation-gateway',name:'Short display alias'}],stages:{},packages:{items:[],total:0,page:1,pageSize:10},runs:[]}));
  const calls:{url:string;body:any}[]=[];
  const fetcher=async(url:string,init:RequestInit={})=>{
    if(init.method==='POST'){
      const body=JSON.parse(String(init.body)),id=url.split('/')[4];calls.push({url,body});
      if(save)return save(id,body);
      const source=sources.find(source=>source.id===id)!;source.settings=body;return Response.json(source);
    }
    if(url.endsWith('/analytics'))return Response.json({error:'统计未准备'},{status:409});
    return Response.json({sources,requests:[]});
  };
  const compiled=await build({entryPoints:[path.join(directory,'daily.js')],bundle:true,write:false,format:'iife',globalName:'Daily',platform:'browser'});
  dom.window.eval(compiled.outputFiles[0].text+'\nglobalThis.Daily=Daily;');
  const controller=dom.window.Daily.mountDaily(dom.window.document,{fetch:fetcher});await controller.ready;
  const el=(id:string)=>dom.window.document.getElementById(id);
  return {dom,controller,el,sources,calls,close(){controller.destroy();dom.window.close();}};
}
const wait=async(condition:()=>boolean)=>{for(let n=0;n<100;n++){if(condition())return;await new Promise(setImmediate);}assert.fail('settings did not settle');};

test('source configuration opens on models, keeps full model names and separates execution and directories',async()=>{
  const f=await environment();
  try{
    f.el('daily-settings-open').click();
    assert.equal(f.el('daily-settings-title').textContent,'问财日常四路 · 配置');
    assert.equal(f.el('daily-settings-panel-models').hidden,false);assert.equal(f.el('daily-settings-panel-execution').hidden,true);
    assert.equal(f.el('daily-bindings').tagName,'TBODY');assert.equal(f.el('daily-bindings').children.length,4);
    const selected=f.el('daily-bindings').querySelector('[data-stage=criteria]');
    assert.match(selected.selectedOptions[0].textContent,new RegExp(model));assert.match(selected.title,new RegExp(model));
    assert.equal(selected.closest('tr').children.length,3);assert.equal(f.el('daily-active-settings').open,false);
    f.el('daily-settings-tab-models').dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'ArrowRight',cancelable:true}));
    assert.equal(f.el('daily-settings-panel-execution').hidden,false);assert.equal(f.el('daily-settings-panel-models').hidden,true);
    assert.equal(f.el('daily-settings-advanced').open,false);assert.equal(f.el('daily-timeout').value,'600');
    f.el('daily-settings-tab-directories').click();assert.equal(f.el('daily-settings-panel-directories').hidden,false);
    assert.match(f.el('daily-paths').textContent,/\/mnt\/fin_bench\/wencai\/input.*\/mnt\/fin_bench\/wencai\/output/s);
    assert.equal(f.calls.length,0,'inspecting configuration cannot start or save work');
  }finally{f.close();}
});

test('configuration retains source drafts and current stale model identity, resets locally and saves legal source payloads',async()=>{
  const f=await environment();
  try{
    f.el('daily-settings-tab-execution').click();f.el('daily-timeout').value='777';f.el('daily-timeout').dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));
    f.controller.select('aime');
    assert.equal(f.el('daily-settings-title').textContent,'AIME 日常全量 · 配置');assert.equal(f.el('daily-bindings').children.length,2);
    const selected=f.el('daily-bindings').querySelector('[data-stage=score]');assert.deepEqual(JSON.parse(selected.value),['evaluation-gateway','saved-model-not-in-current-catalog']);assert.match(selected.title,/saved-model-not-in-current-catalog/);
    f.el('daily-engine').value='prime';f.el('daily-engine').dispatchEvent(new f.dom.window.Event('change',{bubbles:true}));f.el('daily-settings-reset').click();
    assert.equal(f.el('daily-engine').value,'pi');assert.equal(f.calls.length,0,'reset does not call the server');
    f.controller.select('wencai');assert.equal(f.el('daily-timeout').value,'777');assert.equal(f.el('daily-settings-panel-execution').hidden,false);
    f.el('daily-settings-form').dispatchEvent(new f.dom.window.Event('submit',{cancelable:true}));await wait(()=>f.el('daily-settings-status').textContent.includes('已保存'));
    assert.equal(f.calls[0].url,'/runtime/api/daily/wencai/settings');assert.equal(f.calls[0].body.execution.timeoutSeconds,777);assert.equal(f.calls[0].body.execution.maxTaskAttempts,4);assert.equal(f.calls[0].body.execution.repairAttempts,3);assert.equal(f.calls[0].body.bindings.criteria.model,model);
    assert.deepEqual(f.calls[0].body.rewrite,{attribution:true,comparison:true});assert.match(f.el('daily-active-values').textContent,/current-running-model.*600/s);
    f.controller.select('aime');f.el('daily-settings-form').dispatchEvent(new f.dom.window.Event('submit',{cancelable:true}));await wait(()=>f.calls.length===2);
    assert.equal(Object.hasOwn(f.calls[1].body,'rewrite'),false);assert.equal(f.calls[1].body.bindings.score.model,'saved-model-not-in-current-catalog');
    await wait(()=>!f.el('daily-settings-save').disabled);f.el('daily-attempts').value='';f.el('daily-attempts').dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));
    f.el('daily-settings-form').dispatchEvent(new f.dom.window.Event('submit',{cancelable:true}));await wait(()=>f.calls.length===3);
    assert.equal(f.calls[2].body.execution.maxTaskAttempts,null,'blank cap sends an explicit clear operation');
    assert.equal(f.calls[2].body.bindings.score.model,'saved-model-not-in-current-catalog');assert.equal(f.calls[2].body.execution.repairAttempts,3);
  }finally{f.close();}
});

test('invalid hidden execution controls reveal their tab and advanced group before focus without posting',async()=>{
  const f=await environment();
  try{
    f.el('daily-tools').value='0';f.el('daily-settings-form').dispatchEvent(new f.dom.window.Event('submit',{cancelable:true}));
    assert.equal(f.el('daily-settings-panel-execution').hidden,false);assert.equal(f.el('daily-settings-advanced').open,true);assert.equal(f.dom.window.document.activeElement,f.el('daily-tools'));assert.equal(f.calls.length,0);
    f.el('daily-tools').value='8';const modelSelect=f.el('daily-bindings').querySelector('[data-stage=criteria]');modelSelect.value='';
    f.el('daily-settings-form').dispatchEvent(new f.dom.window.Event('submit',{cancelable:true}));
    assert.equal(f.el('daily-settings-panel-models').hidden,false);assert.equal(f.dom.window.document.activeElement,modelSelect);assert.equal(f.calls.length,0);
  }finally{f.close();}
});

test('a pending save shows its state and a delayed failure remains with the original source draft',async()=>{
  let release!:(response:Response)=>void;
  const f=await environment(()=>new Promise<Response>(resolve=>{release=resolve;}));
  try{
    f.el('daily-timeout').value='901';f.el('daily-timeout').dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));
    f.el('daily-settings-form').dispatchEvent(new f.dom.window.Event('submit',{cancelable:true}));
    assert.equal(f.el('daily-settings-save').textContent,'保存中…');assert.equal(f.el('daily-settings-save').disabled,true);
    f.controller.select('aime');release(Response.json({error:'任务预算冲突'},{status:400}));await wait(()=>!f.el('daily-settings-save').disabled);
    assert.equal(f.el('daily-settings-status').textContent,'');f.controller.select('wencai');assert.equal(f.el('daily-timeout').value,'901');assert.equal(f.el('daily-settings-status').textContent,'任务预算冲突');
  }finally{f.close();}
});

test('directory copying works on HTTP without the secure clipboard API',async()=>{
  const f=await environment();
  try{
    let copied='';f.dom.window.document.execCommand=(command:string)=>{assert.equal(command,'copy');copied=f.el('daily-settings').querySelector('textarea').value;return true;};
    f.el('daily-settings-open').click();f.el('daily-settings-tab-directories').click();
    const copy=f.el('daily-paths').querySelector('button');copy.click();await wait(()=>copy.textContent==='已复制');
    assert.equal(copied,'/mnt/fin_bench/wencai/input');assert.equal(f.el('daily-settings').querySelector('textarea'),null);assert.equal(f.calls.length,0);
  }finally{f.close();}
});
