import { cleaningReason } from './cleaning-labels.js';

const chartUrl = '/workbench-assets/daily-charts.bundle.js';
const number = value => typeof value === 'number' && Number.isFinite(value);
const format = value => number(value) ? value.toLocaleString('zh-CN') : '—';
const axisNumber = new Intl.NumberFormat('zh-CN',{notation:'compact',maximumFractionDigits:1}).format;
const modelNames = {a_fast:'A · Fast',b_fast:'AA · Fast',a_expert:'A · Expert',b_expert:'AA · Expert',aime_fast:'Fast',aime_expert:'Expert'};
const statusNames = {completed:'完整完成',partial:'部分完成',running:'进行中',pending:'待评',failed:'失败'};
const blue = '#496b91', dark = '#525964', gray = '#b0b5bd';
const base = {
  animation:false,backgroundColor:'transparent',color:[blue,dark,gray],
  textStyle:{fontFamily:'-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif',fontSize:12,color:'#414852'},
  tooltip:{trigger:'axis',renderMode:'richText',confine:true,axisPointer:{type:'shadow'}},
  grid:{left:8,right:32,top:6,bottom:8,containLabel:true},
};
function bar(labels,values,unit) {
  const valueSpace=Math.max(32,...values.map(value=>format(value).length*7+16));
  return {...base,grid:{...base.grid,right:valueSpace},xAxis:{type:'value',min:0,minInterval:1,splitNumber:3,splitLine:{lineStyle:{color:'#eceef0'}},axisLabel:{color:'#707782',hideOverlap:true,formatter:axisNumber}},
    yAxis:{type:'category',inverse:true,data:labels,axisTick:{show:false},axisLine:{show:false},axisLabel:{width:110,overflow:'truncate',margin:10,lineHeight:14,color:'#414852'}},
    series:[{name:unit,type:'bar',data:values,barMaxWidth:20,label:{show:true,position:'right',distance:6,color:'#414852',formatter:params=>format(params.value)}}]};
}

/** Business dates describe present coverage, never a fabricated completion history. */
export function analyticsView(value,range='30') {
  const intake=value.intake,evaluation=value.evaluation,unit=evaluation.unit==='comparisons'?'对局':'回答';
  const intakeDates=new Map((intake.dates||[]).filter(row=>row.date).map(row=>[row.date,row]));
  const evaluationDates=new Map((evaluation.dates||[]).filter(row=>row.date).map(row=>[row.date,row]));
  const dates=[...new Set([...intakeDates.keys(),...evaluationDates.keys()])].sort();
  let selected=[];
  if(dates.length) {
    const end=new Date(`${dates.at(-1)}T00:00:00Z`),start=range==='all'?new Date(`${dates[0]}T00:00:00Z`):new Date(end);if(range!=='all')start.setUTCDate(start.getUTCDate()-Number(range)+1);
    selected=[];for(const date=new Date(start);date<=end;date.setUTCDate(date.getUTCDate()+1))selected.push(date.toISOString().slice(0,10));
  }
  const trendRows=selected.map(date=>[date,intakeDates.get(date)?.answers??0,evaluationDates.get(date)?.completed??0]);
  const unknownDates=(evaluation.dates||[]).filter(row=>!row.date).reduce((total,row)=>total+row.total,0);
  const trendScope=`按数据日期 · 当前完成覆盖${unknownDates?` · 未知日期 ${format(unknownDates)} ${unit}`:''}`;
  const modelRows=(intake.models||[]).map(row=>[modelNames[row.model]||row.model,row.answers]);
  const stateRows=Object.entries(statusNames).map(([key,label])=>[label,evaluation.totals?.[key]]).filter(([,count])=>number(count));
  const exclusionRows=(intake.exclusions||[]).map(row=>[cleaningReason(row.reason),row.count]).sort((a,b)=>b[1]-a[1]);
  const exclusionBars=exclusionRows.length>8?[...exclusionRows.slice(0,7),[`其他（${exclusionRows.length-7} 种）`,exclusionRows.slice(7).reduce((total,row)=>total+row[1],0)]]:exclusionRows;
  const total=evaluation.totals?.total,completed=evaluation.totals?.completed;
  const multiYear=selected.length>1&&selected[0].slice(0,4)!==selected.at(-1).slice(0,4);
  const valueAxis={type:'value',min:0,minInterval:1,splitNumber:3,nameLocation:'end',nameGap:10,nameTextStyle:{fontSize:12,color:'#707782'},axisLabel:{color:'#707782',hideOverlap:true,formatter:axisNumber}};
  const trend={...base,legend:{bottom:0,left:'center',itemWidth:16,itemHeight:8,itemGap:18,textStyle:{fontSize:12,color:'#525964'}},
    grid:{left:8,right:8,top:26,bottom:44,containLabel:true},
    xAxis:{type:'category',data:selected,axisTick:{show:false},axisLine:{lineStyle:{color:'#d8dce1'}},axisLabel:{hideOverlap:true,margin:10,formatter:date=>multiYear?date:date.slice(5),color:'#707782'}},
    yAxis:[{...valueAxis,name:'回答',nameTextStyle:{...valueAxis.nameTextStyle,align:'left'},splitLine:{lineStyle:{color:'#eceef0'}}},
      ...(evaluation.unit==='comparisons'?[{...valueAxis,name:'对局',nameTextStyle:{...valueAxis.nameTextStyle,align:'right'},splitLine:{show:false}}]:[])],
    series:[{name:'有效回答',type:'bar',data:trendRows.map(row=>row[1]),barMaxWidth:24,itemStyle:{color:gray}},
      {name:`完整完成${unit}`,type:'line',yAxisIndex:evaluation.unit==='comparisons'?1:0,data:trendRows.map(row=>row[2]),symbol:'circle',symbolSize:5,lineStyle:{width:2,color:blue},itemStyle:{color:blue},connectNulls:false}]};
  return {
    scope:`全量数据 · ${format(intake.totals?.questions)} 问句${dates.length?` · ${dates[0]} — ${dates.at(-1)}`:''}`,
    metrics:[{label:'有效回答',value:format(intake.totals?.answers),unit:'条'},{label:`完整完成${unit}`,value:format(completed),unit:`${evaluation.unit==='comparisons'?'场':'条'} · 纳入 ${format(total)} ${unit}`},
      {label:'已纳入评测完成率',value:number(total)&&total>0&&number(completed)?`${(completed/total*100).toFixed(1)}%`:'—',unit:number(total)?`${format(completed)} / ${format(total)}`:''},
      {label:'清洗排除',value:format(intake.totals?.excluded),unit:intake.reportsComplete===false?'清洗报告未覆盖全量':'条'}],
    charts:[
      {id:'trend',title:'每日数据与评测覆盖',scope:trendScope,columns:['数据日期','有效回答',`完整完成${unit}`],rows:trendRows,empty:dates.length?'':'暂无日期数据',option:trend},
      {id:'models',title:'回答模式分布',scope:'全部有效回答',columns:['回答模式','有效回答'],rows:modelRows,empty:modelRows.length?'':'暂无有效回答',option:bar(modelRows.map(row=>row[0]),modelRows.map(row=>row[1]),'回答')},
      {id:'statuses',title:'评测状态分布',scope:`已纳入评测 · ${format(total)} ${unit}`,columns:['评测状态',unit],rows:stateRows,empty:number(total)&&total>0?'':'暂无已纳入评测数据',option:bar(stateRows.map(row=>row[0]),stateRows.map(row=>row[1]),unit)},
      {id:'exclusions',title:'清洗排除原因',scope:(intake.reportsComplete===false?'已有清洗报告':'全部清洗报告')+(exclusionRows.length>8?' · 前 7 项与其他':''),columns:['排除原因','记录'],rows:exclusionRows,empty:exclusionRows.length?'':intake.reportsComplete===false?'暂无可用排除记录':'无排除记录',option:bar(exclusionBars.map(row=>row[0]),exclusionBars.map(row=>row[1]),'记录')},
    ],
  };
}

export function mountAnalytics(root,options) {
  const $=id=>root.querySelector('#'+id),doc=root.ownerDocument||root,values=new Map(),views=new Map();
  let source,active=false,disposed=false,controller,generation=0,renderer,loading=false,rendererPromise;
  const view=()=>{if(!views.has(source))views.set(source,{range:'30',table:false});return views.get(source);};
  const node=(tag,text)=>{const el=doc.createElement(tag);el.textContent=text??'';return el;};
  function status(id,text){$(id).textContent=text;$(id).hidden=!text;}
  function clearCharts(){renderer?.destroy();renderer=undefined;}
  async function draw(charts) {
    if(view().table)return;
    if(charts.every(chart=>chart.empty)){clearCharts();return;}
    const current=generation;
    try {
      rendererPromise??=(options.loadCharts||(()=>import(chartUrl)))().catch(error=>{rendererPromise=undefined;throw error;});
      const module=await rendererPromise;
      if(disposed||!active||current!==generation||view().table)return;
      renderer??=module.mountCharts(root);renderer.render(charts);
    }catch(error){if(!disposed&&active&&current===generation)status('daily-analytics-error',`图表读取失败：${error.message}`);}
  }
  function render() {
    if(!active||disposed)return;
    const current=view(),value=values.get(source);$('daily-trend-range').value=current.range;
    $('daily-analytics-charts').hidden=current.table;$('daily-analytics-tables').hidden=!current.table;
    for(const [id,table]of [['daily-analytics-chart-view',false],['daily-analytics-table-view',true]]){$(id).classList.toggle('active',current.table===table);$(id).setAttribute('aria-pressed',String(current.table===table));}
    $('daily-panel-overview').setAttribute('aria-busy',String(loading));status('daily-analytics-loading',loading?'统计读取中':'');
    if(!value){$('daily-metrics').replaceChildren();$('daily-analytics-scope').textContent='';$('daily-analytics-tables').replaceChildren();for(const id of ['trend','models','statuses','exclusions']){$(`daily-chart-${id}`).hidden=true;$(`daily-chart-${id}-empty`).hidden=true;$(`daily-${id}-scope`).textContent='';}return;}
    const model=analyticsView(value,current.range);$('daily-analytics-scope').textContent=model.scope;
    $('daily-metrics').replaceChildren(...model.metrics.map(metric=>{const col=node('div');col.className='col';const card=node('div');card.className='card card-sm';const body=node('div');body.className='card-body';const label=node('dt',metric.label);label.className='subheader';const amount=node('dd',metric.value);amount.className='h2 mb-0';const unit=node('span',metric.unit);unit.className='daily-metric-unit';amount.append(unit);body.append(label,amount);card.append(body);col.append(card);return col;}));
    $('daily-analytics-tables').replaceChildren(...model.charts.map(chart=>{const section=node('section'),heading=node('h3',chart.title),scope=node('p',chart.scope),table=node('table'),head=node('thead'),titles=node('tr'),body=node('tbody');table.className='table table-sm';titles.append(...chart.columns.map(label=>node('th',label)));head.append(titles);body.append(...chart.rows.map(row=>{const item=node('tr');item.append(...row.map(value=>node('td',number(value)?format(value):value)));return item;}));table.append(head,body);section.append(heading,scope,table);if(chart.empty)section.append(node('p',chart.empty));return section;}));
    for(const chart of model.charts){$(`daily-${chart.id}-scope`).textContent=chart.scope;$(`daily-chart-${chart.id}`).hidden=!!chart.empty;status(`daily-chart-${chart.id}-empty`,chart.empty);$(`daily-chart-${chart.id}`).setAttribute('aria-label',`${chart.title}，${chart.scope}。精确数值见数据视图。`);}
    if(!current.table)void draw(model.charts);
  }
  async function refresh() {
    if(disposed||!active||loading)return;
    controller?.abort();controller=new AbortController();const signal=controller.signal,current=++generation,id=source;loading=true;status('daily-analytics-error','');render();
    try {const value=await options.api(`/${encodeURIComponent(id)}/analytics`,undefined,AbortSignal.any([signal,AbortSignal.timeout(30000)]));if(disposed||signal.aborted||current!==generation||source!==id)return;if(value.source!==id||!value.intake?.totals||!value.evaluation?.totals)throw new Error('统计响应不完整');values.set(id,value);}
    catch(error){if(!disposed&&!signal.aborted&&current===generation)status('daily-analytics-error',`统计读取失败：${error.message}${values.has(id)?' · 保留上次数据':''}`);}
    finally {if(!disposed&&current===generation){loading=false;render();}}
  }
  $('daily-trend-range').onchange=event=>{view().range=event.target.value;render();};
  for(const [id,table]of [['daily-analytics-chart-view',false],['daily-analytics-table-view',true]])$(id).onclick=()=>{view().table=table;if(table)clearCharts();render();};
  return {activate(id){if(disposed||active&&source===id)return;controller?.abort();generation++;clearCharts();source=id;active=true;loading=false;status('daily-analytics-error','');render();void refresh();},
    hide(){if(!active)return;active=false;loading=false;controller?.abort();generation++;clearCharts();},refresh,
    destroy(){disposed=true;controller?.abort();generation++;clearCharts();}};
}
