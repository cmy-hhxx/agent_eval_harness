import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
import {ROOT} from '../../fixtures/services.js';
const {JSDOM}=createRequire(import.meta.url)('jsdom');
const directory=path.join(ROOT,'apps/host/dashboard');
const fixture=(source='aime')=>({source,intake:{totals:{answers:12,questions:7,excluded:3},reportsComplete:true,
  dates:[{date:'2026-10-20',answers:4,questions:2},{date:'2026-10-24',answers:8,questions:5}],
  models:[{model:'aime_fast',answers:8},{model:'aime_expert',answers:4}],exclusions:[{reason:'duplicate_trace',count:2},{reason:'single_trace_required',count:1}]},
  evaluation:{unit:source==='aime'?'answers':'comparisons',totals:{total:4,completed:1,partial:2,pending:1,failed:0,running:0},
    dates:[{date:'2026-10-24',total:3,completed:1},{date:null,total:1,completed:0}],models:[],stages:[]}});
async function environment(){
  const dom=new JSDOM(await readFile(path.join(directory,'daily.html'),'utf8'),{url:'http://fixture/',runScripts:'outside-only'});
  const compiled=await build({entryPoints:[path.join(directory,'daily-analytics.js')],bundle:true,write:false,format:'iife',globalName:'Analytics',platform:'browser'});
  dom.window.eval(compiled.outputFiles[0].text+'\nglobalThis.Analytics=Analytics;');return dom;
}
const wait=async(predicate:()=>boolean)=>{for(let n=0;n<100;n++){if(predicate())return;await new Promise(setImmediate);}assert.fail('analytics did not settle');};

test('analytics counts full scope, preserves answer and comparison units and uses continuous business dates',async()=>{
  const dom=await environment();
  try{
    const value=fixture(),view=dom.window.Analytics.analyticsView(value,'all');
    assert.equal(view.metrics[0].value,'12');assert.equal(view.metrics[1].value,'1');assert.equal(view.metrics[1].unit,'条 · 纳入 4 回答');assert.equal(view.metrics[2].label,'已纳入评测完成率');assert.equal(view.metrics[2].value,'25.0%');
    assert.equal(view.charts[2].scope,'已纳入评测 · 4 回答');
    assert.equal(view.charts[0].rows.length,5);assert.deepEqual(Array.from(view.charts[0].rows[1]),['2026-10-21',0,0]);
    assert.match(view.charts[0].scope,/按数据日期 · 当前完成覆盖.*未知日期 1 回答/);
    assert.deepEqual(Array.from(view.charts[1].rows,(row:any)=>Array.from(row)),[['Fast',8],['Expert',4]]);
    assert.deepEqual(Array.from(view.charts[3].rows,(row:any)=>Array.from(row)),[['重复 Trace',2],['单轮 Trace 数量无效',1]]);
    const week=dom.window.Analytics.analyticsView(value,'7');assert.equal(week.charts[0].rows.length,7);assert.equal(week.charts[0].rows[0][0],'2026-10-18');
    assert.equal(week.charts[0].option.yAxis.length,1);
    const pairs=dom.window.Analytics.analyticsView(fixture('wencai'),'7');assert.equal(pairs.charts[0].option.yAxis.length,2);assert.equal(pairs.charts[0].option.yAxis[1].name,'对局');
    assert.equal(pairs.charts[0].option.series[1].yAxisIndex,1);assert.equal(pairs.metrics[1].label,'完整完成对局');assert.equal(pairs.metrics[1].unit,'场 · 纳入 4 对局');assert.equal(pairs.charts[2].scope,'已纳入评测 · 4 对局');
  }finally{dom.window.close();}
});

test('analytics keeps unknown intake totals distinct from zero and includes the exclusion tail in chart totals',async()=>{
  const dom=await environment();
  try{
    const value=fixture();value.intake.reportsComplete=false;value.intake.totals.excluded=null as any;
    value.intake.exclusions=Array.from({length:11},(_,i)=>({reason:`reason-${i}`,count:i+1}));
    const view=dom.window.Analytics.analyticsView(value,'30');
    assert.equal(view.metrics[3].value,'—');assert.equal(view.metrics[3].unit,'清洗报告未覆盖全量');
    const reasons=view.charts[3];assert.match(reasons.scope,/已有清洗报告.*前 7 项与其他/);assert.equal(reasons.rows.length,11);
    assert.equal(reasons.option.series[0].data.length,8);assert.equal(reasons.option.series[0].data.reduce((a:number,b:number)=>a+b,0),66);
    const empty=fixture();empty.intake.dates=[];empty.evaluation.dates=[];empty.intake.models=[];empty.intake.exclusions=[];empty.evaluation.totals.total=0;
    const noData=dom.window.Analytics.analyticsView(empty,'all');assert.equal(noData.charts[0].empty,'暂无日期数据');assert.equal(noData.charts[1].empty,'暂无有效回答');assert.equal(noData.metrics[2].value,'—');
  }finally{dom.window.close();}
});

test('chart captions and exact bar values have separate space from axes and the trend legend',async()=>{
  const dom=await environment();
  try{
    const value=fixture('wencai');value.intake.models=[{model:'a_fast',answers:123456789}];
    const charts=dom.window.Analytics.analyticsView(value,'7').charts,trend=charts[0].option,distribution=charts[1].option;
    assert.equal(trend.legend.top,undefined);assert.equal(trend.legend.bottom,0);assert(trend.grid.bottom>=44);
    assert.equal(trend.yAxis[0].nameTextStyle.align,'left');assert.equal(trend.yAxis[1].nameTextStyle.align,'right');
    assert.equal(trend.yAxis[0].splitNumber,3);assert.equal(trend.yAxis[1].axisLabel.hideOverlap,true);
    assert(distribution.grid.right>='123,456,789'.length*7+16);assert.equal(distribution.xAxis.axisLabel.hideOverlap,true);
    assert.equal(distribution.xAxis.axisLabel.formatter(10000),'1万');assert.equal(distribution.series[0].label.formatter({value:123456789}),'123,456,789');
    value.intake.dates=[{date:'2025-12-31',answers:1,questions:1},{date:'2026-01-01',answers:1,questions:1}];value.evaluation.dates=[];
    const year=dom.window.Analytics.analyticsView(value,'all').charts[0].option;assert.equal(year.xAxis.axisLabel.formatter('2026-01-01'),'2026-01-01');
  }finally{dom.window.close();}
});

test('overview cancels switched requests, lazy loads charts once, preserves per-source range and offers exact data',async()=>{
  const dom=await environment(),doc=dom.window.document,pending:{id:string;signal:AbortSignal;resolve:(value:unknown)=>void}[]=[],renders:any[]=[];
  let loaded=0,mounted=0,destroyed=0;
  const controller=dom.window.Analytics.mountAnalytics(doc,{api:(url:string,_body:unknown,signal:AbortSignal)=>new Promise(resolve=>pending.push({id:url.split('/')[1],signal,resolve})),loadCharts:async()=>{loaded++;return {mountCharts:()=>{mounted++;return {render:(specs:any)=>renders.push(specs),destroy:()=>destroyed++};}};}});
  const el=(id:string)=>doc.getElementById(id);
  try{
    controller.activate('wencai');assert.equal(loaded,0);assert.equal(el('daily-analytics-loading').hidden,false);
    controller.activate('aime');assert.equal(pending[0].signal.aborted,true);pending[1].resolve(fixture());await wait(()=>el('daily-metrics').textContent.includes('12'));
    assert.equal(loaded,1);assert.equal(mounted,1);pending[0].resolve(fixture('wencai'));await new Promise(setImmediate);assert.match(el('daily-metrics').textContent,/完整完成回答/);
    el('daily-trend-range').value='7';el('daily-trend-range').dispatchEvent(new dom.window.Event('change'));await wait(()=>renders.at(-1)[0].rows.length===7);
    el('daily-analytics-table-view').click();assert.equal(el('daily-analytics-charts').hidden,true);assert.equal(el('daily-analytics-tables').hidden,false);assert.match(el('daily-analytics-tables').textContent,/2026-10-18.*0.*0/s);assert.equal(destroyed,1);
    el('daily-analytics-chart-view').click();await wait(()=>mounted===2);assert.equal(loaded,1);
    controller.activate('wencai');pending[2].resolve(fixture('wencai'));await wait(()=>el('daily-metrics').textContent.includes('完整完成对局'));assert.equal(el('daily-trend-range').value,'30');
    controller.activate('aime');assert.equal(el('daily-trend-range').value,'7');await wait(()=>el('daily-metrics').textContent.includes('完整完成回答'));
    controller.hide();assert.equal(pending.at(-1)!.signal.aborted,true);assert.equal(el('daily-metrics').textContent.includes('完整完成回答'),true);
  }finally{controller.destroy();dom.window.close();}
});

test('overview read failure retains last aggregate and does not turn missing totals into zero',async()=>{
  const dom=await environment(),doc=dom.window.document;let failed=false;
  const controller=dom.window.Analytics.mountAnalytics(doc,{api:async()=>{if(failed)throw new Error('读取中断');return fixture();},loadCharts:async()=>({mountCharts:()=>({render(){},destroy(){}})})});
  const el=(id:string)=>doc.getElementById(id);
  try{
    controller.activate('aime');await wait(()=>el('daily-metrics').textContent.includes('12'));failed=true;await controller.refresh();
    assert.match(el('daily-analytics-error').textContent,/读取中断.*保留上次数据/);assert.equal(el('daily-analytics-loading').hidden,true);assert.match(el('daily-metrics').textContent,/12/);
  }finally{controller.destroy();dom.window.close();}
});
