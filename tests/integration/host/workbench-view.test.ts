import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { ROOT } from '../../fixtures/services.js';
const { JSDOM } = createRequire(import.meta.url)('jsdom');
function enableDialogs(dom:any) {
  dom.window.HTMLDialogElement.prototype.showModal = function(this:HTMLDialogElement) { this.setAttribute('open',''); };
  dom.window.HTMLDialogElement.prototype.close = function(this:HTMLDialogElement) { this.removeAttribute('open'); this.dispatchEvent(new dom.window.Event('close')); };
}


test('three-module workbench defaults to both daily sources and keeps results and lower-frequency work in place', async () => {
  const directory = path.join(ROOT,'apps/host/dashboard');
  const dom = new JSDOM(await readFile(path.join(directory,'workbench.html'),'utf8'),{url:'http://fixture/',runScripts:'outside-only'}); enableDialogs(dom);
  const stylesheet = dom.window.document.createElement('style'); stylesheet.textContent = await readFile(path.join(directory,'workbench.css'),'utf8'); dom.window.document.head.append(stylesheet);
  const compiled = await build({entryPoints:[path.join(directory,'workbench.js')],bundle:true,write:false,format:'esm',platform:'browser'});
  const requests:string[] = [], faults:unknown[] = []; let failProblems = true;
  dom.window.setInterval = dom.window.setTimeout = () => 0;
  dom.window.scrollTo = ({top}:{top:number}) => {dom.window.scrollY=top;}; dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const wait = async (condition:()=>boolean) => {for(let n=0;n<100;n++){if(condition())return;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('module did not load');};
  dom.window.addEventListener('error',(event:ErrorEvent)=>faults.push(event.error));
  const json = (value:unknown,status=200) => new Response(JSON.stringify(value),{status});
  dom.window.fetch = async (url:string) => {
    requests.push(url);
    if(url.startsWith('/workbench-assets/')) {
      const file=url.split('/').at(-1)!;
      if(file==='problems.html'&&failProblems){failProblems=false;return new Response('Unavailable',{status:503});}
      if(file==='tabler.css')return new Response(await readFile(path.join(ROOT,'node_modules/@tabler/core/dist/css/tabler.min.css'),'utf8'));
      const dataFiles:Record<string,string>={'data.html':'dashboard.html','data.css':'dashboard.css','records.html':'records.html'};
      return new Response(await readFile(Object.hasOwn(dataFiles,file)?path.join(ROOT,'server_dashboard_ths',dataFiles[file]):path.join(directory,file),'utf8'));
    }
    if(url==='/health')return json({ok:true});
    if(url==='/session')return json({authenticated:false});
    if(/^\/runtime\/api\/daily\/(wencai|aime)\/analytics$/.test(url))return json({source:url.split('/').at(-2),intake:{totals:{answers:0,questions:0,excluded:0},dates:[],models:[],exclusions:[],reportsComplete:true},evaluation:{unit:url.includes('/aime/')?'answers':'comparisons',totals:{total:0,completed:0,partial:0,running:0,pending:0,failed:0},dates:[]}});
    if(url==='/runtime/api/daily?page_size=10')return json({sources:['wencai','aime'].map(id=>({id,name:id,status:'idle',concurrency:id==='aime'?64:32,activeRequests:0,waitingRequests:0,settings:{engine:'pi',execution:{timeoutSeconds:600,maxToolCalls:8,retries:1},bindings:{},rewrite:{}},modelCatalog:[],packages:{items:[{id:id+'-package',name:id+'.7z',status:'cleaned',accepted:1,excluded:1}],total:1,page:1,pageSize:40},stages:{},runs:[]})),requests:[]});
    if(url.includes('/packages/')&&url.includes('/report?'))return json({batch_id:'package',status:'cleaned',summary:{read:2,accepted:1,excluded:1,questions:1},section:'exclusions',page:1,page_size:50,total:1,items:[{model:'model',case_id:'isolated',original_file:'archive.7z/member.jsonl',original_line:2,reason:'invalid_input'}]});
    if(url==='/runtime/api/daily/aime/runs')return json({runs:[]});
    if(url.startsWith('/data/workbench/catalog'))return json({tasks:[{id:'daily',name:'问财日常评测',source:'wencai',category:'daily',dataset:'/data/wencai',profile:'wencai'}],batches:[],total:0,page:1,page_size:50});
    if(url.endsWith('/runs'))return json({runs:[],errors:[]});
    if(url.endsWith('/batch-runs'))return json({runs:[]});
    if(url.endsWith('/analysis'))return json({jobs:[]});
    if(url.endsWith('/inputs'))return json({status:'ready',dates:[],issues:0});
    if(url.endsWith('/config'))return json({error:'配置不可用'},503);
    if(url.endsWith('/library'))return json([]);
    throw new Error('Unexpected request: '+url);
  };
  const select = async(id:string)=>{dom.window.document.getElementById('nav-'+id).click();await wait(()=>dom.window.document.getElementById(id).getAttribute('aria-busy')==='false');await new Promise(setImmediate);assert.equal(dom.window.document.querySelectorAll('[role=tabpanel]:not([hidden])').length,1);};
  try {
    await dom.window.eval(`(async()=>{${compiled.outputFiles[0].text}\n})()`); await new Promise(setImmediate);
    assert.deepEqual([...dom.window.document.querySelectorAll('[data-module]')].map((item:any)=>item.textContent),['评测','结果','更多']);
    const daily=dom.window.document.getElementById('daily-content'); assert.equal(daily.hidden,false); assert.notEqual(dom.window.getComputedStyle(daily).display,'none');
    assert.match(daily.shadowRoot.textContent,/问财日常四路.*AIME 日常全量/s); assert.equal(dom.window.document.querySelector('iframe'),null);
    assert.equal(requests.some(url=>url.includes('/dashboard/')),false); assert.equal(requests.some(url=>url.includes('reference')),false);
    await select('results'); const wencai=dom.window.document.getElementById('wencai-results-content'); assert.equal(wencai.hidden,false); assert.equal(wencai.shadowRoot.getElementById('config').hidden,true);
    assert.equal(requests.includes('/runtime/api/dashboard/config'),false); assert.equal(requests.includes('/runtime/api/dashboard/inputs'),false);
    dom.window.document.querySelector('[data-results-source=aime]').click(); await wait(()=>Boolean(dom.window.document.getElementById('aime-results-content').shadowRoot)); assert.equal(wencai.hidden,true);
    const aime=dom.window.document.getElementById('aime-results-content').shadowRoot; aime.getElementById('aime-query').value='我的草稿';
    dom.window.document.querySelector('[data-results-source=wencai]').click(); dom.window.document.querySelector('[data-results-source=aime]').click(); assert.equal(aime.getElementById('aime-query').value,'我的草稿');
    dom.window.document.getElementById('results-quarantine').click(); await wait(()=>requests.some(url=>url.includes('/aime/packages/aime-package/report?section=exclusions')));
    await wait(()=>daily.shadowRoot.getElementById('daily-report-section').value==='exclusions'); assert.equal(dom.window.document.getElementById('evaluate').hidden,false); assert.equal(daily.shadowRoot.getElementById('daily-title').textContent,'AIME 日常全量');
    await select('results'); assert.equal(aime.getElementById('aime-query').value,'我的草稿'); dom.window.document.querySelector('[data-results-source=wencai]').click(); dom.window.document.getElementById('results-quarantine').click();
    await wait(()=>requests.some(url=>url.includes('/wencai/packages/wencai-package/report?section=exclusions'))); assert.equal(daily.shadowRoot.getElementById('daily-title').textContent,'问财日常四路');
    await select('more'); const intake=dom.window.document.getElementById('data-content').shadowRoot; intake.getElementById('intake-category').value='task';
    const more=dom.window.document.getElementById('more-section'); more.value='problems'; more.dispatchEvent(new dom.window.Event('change'));
    const problemHost=dom.window.document.getElementById('problems-content'); await wait(()=>Boolean(problemHost.querySelector('button'))); assert.match(problemHost.textContent,/503/); assert.equal(problemHost.hidden,false);
    problemHost.querySelector('button').click(); await wait(()=>Boolean(problemHost.shadowRoot?.getElementById('problem-tree')));
    more.value='data'; more.dispatchEvent(new dom.window.Event('change')); assert.equal(dom.window.document.getElementById('data-content').shadowRoot,intake); assert.equal(intake.getElementById('intake-category').value,'task');
    dom.window.scrollY=640; await select('evaluate'); await select('more'); assert.equal(dom.window.scrollY,640); assert.equal(dom.window.location.hash,'#more'); assert.equal(dom.window.sessionStorage.getItem('workbench-module'),'more');
    assert.equal(requests.some(url=>url.includes('reference')),false); assert.deepEqual(faults,[]);
  } finally {dom.window.close();}
});
