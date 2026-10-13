import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { JSDOM, requestInterceptor, VirtualConsole } from 'jsdom';
import { buildReport } from '../scripts/build.mjs';
const directory=dirname(dirname(fileURLToPath(import.meta.url)));
const html=await readFile(join(directory,'src/template.html'),'utf8');
const typographyTokens=await readFile(join(directory,'src/shared/tokens.css'),'utf8');
function environment(t,markup=html,inline=false,hash='flow') {
  const errors=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));
  const requests=[];
  const resources=inline?{interceptors:[requestInterceptor(request=>{requests.push(request.url);return new Response('',{status:503});})]}:undefined;
  const dom=new JSDOM(markup,{url:`https://offline-report.invalid/report.html#${hash}`,runScripts:inline?'dangerously':'outside-only',resources,pretendToBeVisual:true,virtualConsole:vc,beforeParse(w){w.scrollTo=()=>{};w.matchMedia=()=>({matches:true,addEventListener(){},removeEventListener(){}});w.fetch=url=>{requests.push(url);throw new Error('离线报告不能请求外部资源');};}});
  if(!inline){const style=dom.window.document.createElement('style');style.textContent=typographyTokens;dom.window.document.head.append(style);}
  t.after(()=>{dom.window.close();assert.deepEqual(errors,[]);assert.deepEqual(requests,[],'离线报告不能依赖其他文件或网络请求');});
  return {window:dom.window,document:dom.window.document,async load(){if(!inline)for(const script of dom.window.document.querySelectorAll('script[src]'))dom.window.eval(await readFile(join(directory,'src',script.getAttribute('src')),'utf8'));},click(selector){const node=typeof selector==='string'?dom.window.document.querySelector(selector):selector;assert.ok(node,`Missing ${selector}`);node.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true}));},change(selector,value){const el=dom.window.document.querySelector(selector);el.value=String(value);el.dispatchEvent(new dom.window.Event('change',{bubbles:true}));},key(selector,key){dom.window.document.querySelector(selector).dispatchEvent(new dom.window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));}};
}
const markers=page=>[...page.document.querySelectorAll('.matrix-row')].map(row=>({row:row.dataset.matrixRow,cells:[...row.querySelectorAll('.matrix-cell')].map(c=>({candidate:c.dataset.cellCandidate,symbol:c.querySelector('[data-symbol]').dataset.symbol,text:c.querySelector('.matrix-basis').textContent}))}));
const expectedWinner=(pair,labels)=>pair.status==='needs_review'?'待核':pair.winnerIndex===null?(pair.outcome==='both_good'?'都好':'都差'):`${labels[pair.winnerIndex]} 胜`;
const valueText=value=>typeof value==='string'?value:JSON.stringify(value);
const dimensions=node=>['width','height'].map(name=>Number(node.getAttribute(name)));
// Compare all prose characters while allowing only candidate identity substitutions.
// Mapping and source ownership are checked separately, including every matrix column.
function withoutIdentities(value,pair){
 let result=String(value??'');
 const names=[...new Set(pair.candidates.flatMap(candidate=>[candidate.displayName,candidate.versionName,candidate.version,candidate.source]).filter(Boolean))].sort((a,b)=>b.length-a.length);
 for(const name of names)result=result.replaceAll(name,'');
 return result.replace(/[AB]/g,'');
}
function assertProse(actual,source,pair){assert.equal(withoutIdentities(actual,pair),withoutIdentities(source,pair),'全文除匿名身份外不能截断或改写');}
function assertPreview(node,source){
 const full=String(source).replaceAll('\n','');
 if(node.dataset.truncated==='true'){assert.ok(node.textContent.endsWith('…'));assert.ok(full.startsWith(node.textContent.slice(0,-1)));}
 else assert.equal(node.textContent,full);
}
function assertFixedCards(page){
 assert.deepEqual(dimensions(page.document.querySelector('[data-input-control] > rect')),[224,148]);
 assert.deepEqual(dimensions(page.document.querySelector('[data-checklist-control] > rect')),[318,148]);
 assert.equal(page.document.querySelector('.verdict-sheet').getAttribute('height'),'196');
 for(const [attribute,width] of [['data-answer-card',224],['data-check-card',318],['data-anonymous-candidate',146]]){
  const cards=[...page.document.querySelectorAll(`[${attribute}] > rect`)];
  assert.equal(cards.length,2);cards.forEach(card=>assert.deepEqual(dimensions(card),[width,112]));
 }
 assert.equal(page.document.querySelector('[data-reveal-control]').contains(page.document.querySelector('[data-verdict-control]')),false,'身份揭示和点评详情必须是独立操作');
}
function assertOwnership(page,pair,swapped){
 const order=swapped?[1,0]:[0,1],labels=Array.from(pair.candidates,c=>c.label);if(swapped)labels.reverse();
 const summary=page.window.ReportCaseSummaries[pair.id];
 for(const attribute of ['data-answer-card','data-check-card','data-anonymous-candidate','data-problem-group'])assert.deepEqual([...page.document.querySelectorAll(`[${attribute}]`)].map(node=>Number(node.getAttribute(attribute))),order,attribute+'应按展示顺序整组交换，属性保留原来源');
 const columns=[...page.document.querySelectorAll('#comparison-grid .matrix-header[data-candidate-identity]')];
 assert.deepEqual(columns.map(node=>Number(node.dataset.candidateIdentity)),order);
 assert.deepEqual(columns.map(node=>node.textContent),order.map(index=>labels[index]));
 for(const index of order){
  const candidate=pair.candidates[index],card=page.document.querySelector(`[data-answer-card="${index}"]`),check=page.document.querySelector(`[data-check-card="${index}"]`),packet=page.document.querySelector(`[data-anonymous-candidate="${index}"]`);
  assert.equal(card.querySelector('.answer-long').textContent,candidate.source);
  assert.equal(card.querySelector('rect').getAttribute('y'),check.querySelector('rect').getAttribute('y'));
  assert.equal(card.querySelector('rect').getAttribute('y'),packet.querySelector('rect').getAttribute('y'));
  assertProse(check.querySelector('.check-text').textContent,summary.checks[index],pair);
  assert.equal(packet.querySelector('[data-candidate-identity]').textContent,labels[index]);
  const group=page.document.querySelector(`[data-problem-group="${index}"]`);
  assert.equal(group.querySelector('[data-candidate-identity]').textContent,labels[index]);
  assert.deepEqual([...group.querySelectorAll('[data-problem-finding]')].map(node=>node.dataset.problemFinding),Array.from(candidate.findings.filter(f=>f.type==='problem'),f=>f.finding_id));
  for(const node of group.querySelectorAll('[data-problem-candidate]'))assert.equal(node.dataset.problemCandidate,String(index));
 }
 for(const row of page.document.querySelectorAll('.matrix-row')){
  const rowIndex=Number(row.dataset.matrixRow),original=pair.comparisons[rowIndex],cells=[...row.querySelectorAll('[data-cell-candidate]')];
  assert.deepEqual(cells.map(node=>Number(node.dataset.cellCandidate)),order);
  cells.forEach(cell=>{
   const source=Number(cell.dataset.cellCandidate);
   assertProse(cell.querySelector('.matrix-basis').textContent,summary.rows[rowIndex].values[source],pair);
   const expected=original.statuses[source]==='not_applicable'?'∅':original.statuses[source]==='unknown'||original.evidenceStatuses[source]==='uncertain'?'?':original.betterIndices.length===1?(original.betterIndices[0]===source?'✓':'×'):'—';
   assert.equal(cell.querySelector('[data-symbol]').dataset.symbol,expected,'优势只来自该原比较，不能根据整场赢家反推');
  });
 }
 assert.equal(page.document.querySelector('#winnerLabel').textContent,expectedWinner(pair,labels));
 if(pair.status==='decided'&&pair.winnerIndex!==null){
  const winner=page.document.querySelector(`[data-anonymous-candidate="${pair.winnerIndex}"]`);
  assert.equal(winner.querySelector('[data-candidate-identity]').textContent,labels[pair.winnerIndex]);
  const model=winner.querySelector('[data-revealed-model]');if(model)assert.ok(model.textContent.includes(pair.candidates[pair.winnerIndex].model||pair.candidates[pair.winnerIndex].version));
 }
}

test('30题42场保持固定卡片，长输入与点评可读全文，84份回答不截断',async t=>{
 const page=environment(t);await page.load();const cases=page.window.EvaluationReportData.cases;
 assert.equal(cases.length,30);assert.equal(cases.flatMap(c=>c.pairs).length,42);
 let answers=0,pending=0,longInputs=0,longVerdicts=0;
 for(const [i,group] of cases.entries()){
  page.change('[data-case-select]',i);
  for(const [p,pair] of group.pairs.entries()){
   page.change('[data-pair-select]',p);
   assertFixedCards(page);assertOwnership(page,pair,false);
   const inputPreview=page.document.querySelector('[data-overview-question]');assertPreview(inputPreview,group.question);
   longInputs+=Number(inputPreview.dataset.truncated==='true');
   assert.equal(page.document.querySelector('.case-kind').textContent,pair.hasStandardAnswer?'客观题':'主观题');
   assert.equal(Boolean(page.document.querySelector('[data-standard-answer]')),pair.hasStandardAnswer);
   if(pair.hasStandardAnswer)assertPreview(page.document.querySelector('[data-standard-answer-value]'),valueText(pair.groundTruth.value));
   page.key('[data-input-control]','Enter');
   assert.equal(page.document.querySelector('[data-full-question]').textContent,group.question);
   if(pair.hasStandardAnswer)assert.equal(page.document.querySelector('[data-full-standard]').textContent,valueText(pair.groundTruth.value));
   assert.equal(page.document.querySelector('[data-revealed-model]'),null);page.key('dialog','Escape');
   assert.equal(page.document.activeElement,page.document.querySelector('[data-input-control]'));
   const verdictPreview=page.document.querySelector('[data-verdict-reason]');longVerdicts+=Number(verdictPreview.dataset.truncated==='true');
   page.click('[data-verdict-control]');
   assertProse(page.document.querySelector('[data-full-verdict]').textContent,pair.rewrittenReason||pair.tradeoff||pair.reason,pair);
   assertProse(page.document.querySelector('[data-original-tradeoff]').textContent,pair.tradeoff,pair);
   assertPreview(verdictPreview,page.document.querySelector('[data-full-verdict]').textContent);
   assert.equal(page.document.querySelector('[data-revealed-model]'),null,'查看点评不得同时揭示身份');page.key('dialog','Escape');
   assert.equal(page.document.activeElement,page.document.querySelector('[data-verdict-control]'));
   assert.equal(page.document.querySelector('#winnerLabel').textContent,expectedWinner(pair,pair.candidates.map(c=>c.label)));
   if(pair.status==='needs_review'){pending++;assert.equal(page.document.querySelectorAll('.matrix-row').length,0);}
   for(const [index,candidate] of pair.candidates.entries()){
    page.click(`[data-answer-card="${index}"]`);
    assert.equal(page.document.querySelector('dialog').open,true);
    assert.equal(page.document.querySelector('[data-full-answer]').textContent,candidate.finalAnswer);
    assert.equal(page.document.querySelector('[data-full-answer]').hidden,true);
    assert.equal(page.document.querySelector('[data-answer-reading] script,img,iframe,audio,video'),null,'阅读排版不执行HTML或加载外链');
    page.click('[data-answer-format]');assert.equal(page.document.querySelector('[data-full-answer]').hidden,false);
    page.click('[data-answer-format]');assert.equal(page.document.querySelector('[data-answer-reading]').hidden,false);
    assert.equal(page.document.querySelector('[data-full-answer] script,img,iframe,audio,video'),null,'回答中的HTML和链接不执行、不联网');
    page.key('dialog','Escape');assert.equal(page.document.querySelector('dialog').open,false);answers++;
    assert.equal(page.document.querySelectorAll(`[data-problem-candidate="${index}"]`).length,candidate.findings.filter(f=>f.type==='problem').length,'包括责任待定位的全部问题');
   }
  }
 }
 assert.equal(answers,84);assert.equal(pending,5);assert.ok(longInputs>0);assert.ok(longVerdicts>0);
});

test('交换重排回答、归因、匿名包、矩阵与问题，详情归属和原获胜模型不变',async t=>{
 const page=environment(t);await page.load();const cases=page.window.EvaluationReportData.cases;
 const snapshot=JSON.stringify(page.window.EvaluationReportData);
 for(const [i,group] of cases.entries()){
  page.change('[data-case-select]',i);
  for(const [p,pair] of group.pairs.entries()){
   page.change('[data-pair-select]',p);assert.equal(page.document.querySelector('[data-revealed-model]'),null);
   const before=markers(page),winner=page.document.querySelector('#winnerLabel').textContent;assertOwnership(page,pair,false);
   page.key('[data-reveal-control]','Enter');assert.equal(page.document.querySelectorAll('[data-revealed-model]').length,2);
   assert.equal(page.document.querySelector('dialog').open,false,'揭示身份不应打开点评详情');
   pair.candidates.forEach((c,index)=>{const node=page.document.querySelector(`[data-revealed-model="${index}"]`);assert.ok(node.textContent.includes(c.displayName));assert.ok(node.textContent.includes(c.model||c.version));});
   assert.equal(page.document.querySelector('#winnerLabel').textContent,winner);
   page.click('[data-swap-control]');const labels=pair.candidates.map(c=>c.label).reverse();
   assert.equal(page.document.querySelector('#winnerLabel').textContent,expectedWinner(pair,labels));
   assertOwnership(page,pair,true);assertFixedCards(page);
   markers(page).forEach((row,index)=>{
    assert.equal(row.row,before[index].row);
    assert.deepEqual(row.cells.map(cell=>[cell.candidate,cell.symbol]),before[index].cells.toReversed().map(cell=>[cell.candidate,cell.symbol]));
    row.cells.forEach(cell=>assertProse(cell.text,before[index].cells.find(previous=>previous.candidate===cell.candidate).text,pair));
   });
   for(const index of [1,0]){
    page.click(`[data-answer-card="${index}"]`);
    assert.deepEqual([...page.document.querySelectorAll('[data-answer-switch]')].map(node=>Number(node.dataset.answerSwitch)),[1,0]);
    assert.equal(page.document.querySelector('[data-full-answer]').textContent,pair.candidates[index].finalAnswer);
    page.click(`[data-answer-switch="${1-index}"]`);assert.equal(page.document.querySelector('[data-full-answer]').textContent,pair.candidates[1-index].finalAnswer);
    page.click('[data-detail-close]');
    page.click(`[data-check-card="${index}"]`);assert.equal(page.document.querySelector('[data-check-output]').dataset.checkOutput,pair.candidates[index].inputId);page.click('[data-detail-close]');
   }
   page.click('[data-comparison-control]');
   const detailRows=[...page.document.querySelectorAll('[data-detail-body] > .detail-assessment')];assert.equal(detailRows.length,pair.comparisons.length);
   detailRows.forEach((row,index)=>{
    const cells=[...row.querySelectorAll('[data-comparison-detail-candidate]')];assert.deepEqual(cells.map(cell=>Number(cell.dataset.comparisonDetailCandidate)),[1,0]);
    cells.forEach(cell=>{const source=Number(cell.dataset.comparisonDetailCandidate);assert.equal(cell.querySelector('h4').textContent,labels[source]);assertProse(cell.querySelector('p').textContent,pair.comparisons[index].cells[source],pair);});
   });
   page.click('[data-detail-close]');
   page.click('[data-reveal-control]');assert.equal(page.document.querySelector('[data-revealed-model]'),null);
   assertOwnership(page,pair,true);page.key('[data-swap-control]',' ');assertOwnership(page,pair,false);
  }
 }
 assert.equal(JSON.stringify(page.window.EvaluationReportData),snapshot);
});

test('逐项对照覆盖所有比较，归因卡计数与完整核验输出保持对应',async t=>{
 const page=environment(t);await page.load();const cases=page.window.EvaluationReportData.cases;
 for(const [i,group] of cases.entries()){
  page.change('[data-case-select]',i);
  for(const [p,pair] of group.pairs.entries()){
   page.change('[data-pair-select]',p);page.click('[data-swap-control]');const seen=new Set();
   do {assertOwnership(page,pair,true);for(const row of page.document.querySelectorAll('.matrix-row'))seen.add(Number(row.dataset.matrixRow));const next=page.document.querySelector('[data-matrix-next]');if(!next)break;page.click(next);} while(!seen.has(Number(page.document.querySelector('.matrix-row').dataset.matrixRow)));
   assert.deepEqual([...seen].sort((a,b)=>a-b),Array.from(pair.comparisons,(_,i)=>i));
   assertFixedCards(page);
   const checklist=page.document.querySelector('[data-checklist-control]');
   assert.ok(checklist.textContent.includes(`${checklist.querySelectorAll('[data-checklist-item]').length}/${pair.presentation.checklist.length} 项`),'预览数与完整清单总数均可见');
   page.click('[data-checklist-control]');assert.deepEqual([...page.document.querySelectorAll('.criteria-original li')].map(n=>n.textContent),Array.from(pair.presentation.checklist));page.click('[data-detail-close]');
   for(let c=0;c<2;c++){
    const candidate=pair.candidates[c],card=page.document.querySelector(`[data-check-card="${c}"]`);
    const strengths=candidate.findings.filter(f=>f.type==='strength'),problems=candidate.findings.filter(f=>f.type==='problem'),uncertain=problems.filter(f=>f.assessment.evidence_status==='uncertain');
    assert.ok(card.textContent.includes(`优点 ${strengths.length} · 问题 ${problems.length}${uncertain.length?'（'+uncertain.length+' 待核）':''}`));
    const shared=new Set(pair.criteria.filter(rule=>rule.scope==='shared'&&rule.group==='requirements').map(rule=>rule.id));
    const assessments=candidate.criteriaAssessments.filter(a=>shared.has(a.criterion_id));
    const counts=[
     [assessments.filter(a=>a.status==='met'&&a.evidence_status!=='uncertain').length,'满足'],
     [assessments.filter(a=>a.status==='partial'&&a.evidence_status!=='uncertain').length,'部分'],
     [assessments.filter(a=>a.status==='unmet'&&a.evidence_status!=='uncertain').length,'未满足'],
     [assessments.filter(a=>a.status==='unknown'||a.evidence_status==='uncertain').length,'待核'],
    ];
    assert.equal(card.querySelector('.agent-output-count').textContent,'验收 '+counts.filter(([count])=>count).map(([count,label])=>`${count}${label}`).join(' · '));
    page.click(card);
    assert.equal(page.document.querySelector('[data-check-output]').dataset.checkOutput,candidate.inputId);
    assertProse(page.document.querySelector('[data-check-core-reason]').textContent,candidate.core.reason,pair);
    assert.deepEqual([...page.document.querySelectorAll('[data-check-assessment]')].map(node=>node.dataset.checkAssessment),Array.from(candidate.criteriaAssessments,a=>a.criterion_id));
    assert.deepEqual([...page.document.querySelectorAll('[data-check-finding]')].map(node=>node.dataset.checkFinding).sort(),Array.from(candidate.findings,f=>f.finding_id).sort());
    assert.equal(page.document.querySelectorAll('[data-numeric-index]').length,pair.hasStandardAnswer?candidate.numericChecks.length:0);
    assert.equal(page.document.querySelectorAll('[data-check-evidence="correctness"]').length,pair.hasStandardAnswer?candidate.correctnessEvidence.length:0);
    assert.equal(page.document.querySelector('[data-detail-body] script,img,iframe,audio,video'),null);
    page.click('[data-detail-close]');
   }
   const roles=[...page.document.querySelectorAll('#flowBody [data-agent-role]')];assert.deepEqual(roles.map(node=>node.dataset.agentRole),['criteria','attribution','attribution','comparison']);
   roles.forEach(node=>assert.ok(node.querySelector('.agent-title,.agent-card-title'),'每个Agent保留文字标识'));
  }
 }
});

test('宽窄布局全部分页的比较表与判决共用中线，双路证据只汇合一次',async t=>{
 const page=environment(t);await page.load();
 const box=node=>{
  const [x,y,width,height]=['x','y','width','height'].map(name=>Number(node.getAttribute(name)));
  return {x,y,width,height,right:x+width,bottom:y+height,cx:x+width/2,cy:y+height/2};
 };
 const route=node=>{
  const d=node.getAttribute('d'),steps=[...d.matchAll(/([MHVQ])([^MHVQ]+)/g)].map(([,command,values])=>({command,values:values.trim().split(/[\s,]+/).map(Number)}));
  assert.ok(steps.length>1&&steps[0].command==='M');
  assert.equal(d.replace(/[MHVQ\d.\s,+-]/g,''),'','连线仅包含可核验的绝对直线与圆角命令');
  let x=steps[0].values[0],y=steps[0].values[1];
  const start=[x,y];
  for(const step of steps.slice(1)){
   if(step.command==='H')x=step.values[0];
   else if(step.command==='V')y=step.values[0];
   else if(step.command==='Q')[x,y]=step.values.slice(2);
   else assert.fail('一条流向不能用新的M断开');
   step.end=[x,y];
  }
  assert.ok([...start,x,y].every(Number.isFinite));
  return {start,end:[x,y],steps};
 };
 const checkGeometry=compact=>{
  const table=box(page.document.querySelector('.comparison-matrix')),verdict=box(page.document.querySelector('.verdict-sheet'));
  const cards=[...page.document.querySelectorAll('.anonymous-sheet')].map(box).sort((a,b)=>a.cy-b.cy);
  assert.equal(cards.length,2);assert.equal(verdict.height,196);
  assert.equal(table.cy,verdict.cy,'比较表与判决始终在同一水平中线上');
  const flowBottom=Math.max(...cards.map(card=>card.bottom));
  if(compact)assert.equal(Math.min(table.y,verdict.y)-flowBottom,54,'窄屏整组比较区留在上游卡片下方，按较高框确定间隔');
  else assert.equal(table.cy,(cards[0].cy+cards[1].cy)/2,'桌面对照表围绕两匿名卡的中心均值居中');
  if(!page.document.querySelector('.matrix-row'))assert.equal(table.height,120,'空表也使用实际外框高度参与对齐');

  const merge=page.document.querySelector('[data-flow-merge]');
  assert.equal(page.document.querySelectorAll('[data-flow-merge]').length,1);
  assert.equal(merge.querySelectorAll('circle.flow-junction').length,1);
  const circle=merge.querySelector('circle.flow-junction'),junction=['cx','cy'].map(name=>Number(circle.getAttribute(name)));
  const inputs=[...merge.querySelectorAll('[data-merge-input]')];
  assert.deepEqual(inputs.map(node=>node.dataset.mergeInput),['0','1']);
  inputs.forEach((node,lane)=>{
   const input=route(node);
   assert.equal(input.start[1],cards[lane].cy,'输入线从对应显示通道的卡片中点引出');
   assert.ok(input.start[0]>cards[lane].right&&input.start[0]<junction[0]);
   assert.deepEqual(input.end,junction,'两路输入必须落到同一个汇合点');
   assert.equal(node.hasAttribute('marker-end'),false,'汇合前不叠加箭头');
  });
  if(compact){assert.equal(junction[1],cards[1].cy);assert.ok(junction[0]>cards[1].right);}
  else{assert.equal(junction[1],table.cy);assert.equal(junction[0],(cards[0].right+table.x)/2);}

  const entryNode=merge.querySelector('[data-comparison-entry]'),entry=route(entryNode);
  assert.equal(merge.querySelectorAll('[data-comparison-entry]').length,1);assert.deepEqual(entry.start,junction);
  if(compact){
   assert.deepEqual(entry.end,[table.cx,table.y-8]);
   assert.equal(entry.steps.at(-1).command,'V');
   assert.ok(entry.steps.at(-2).end[1]<entry.end[1],'窄屏从上方顺向进入表格');
   entry.steps.filter(step=>step.command==='H').forEach(step=>assert.ok(step.end[1]>flowBottom,'跨越到表格的横线不能穿过上游卡片'));
  }else{
   assert.deepEqual(entry.steps.map(step=>step.command),['M','H'],'桌面汇合后直接水平入表');
   assert.deepEqual(entry.end,[table.x-8,table.cy]);assert.ok(entry.end[0]>entry.start[0]);
  }
  const verdictNode=page.document.querySelector('[data-verdict-entry]'),output=route(verdictNode);
  assert.equal(page.document.querySelectorAll('[data-verdict-entry]').length,1);
  assert.deepEqual(output.steps.map(step=>step.command),['M','H'],'表格到判决始终直接水平连接');
  assert.deepEqual(output.start,[table.right+8,table.cy]);assert.deepEqual(output.end,[verdict.x-8,verdict.cy]);
  assert.ok(output.end[0]>output.start[0],'判决箭头不能反向');
  for(const node of [entryNode,verdictNode]){
   assert.equal(node.hasAttribute('marker-start'),false);
   const marker=node.getAttribute('marker-end').match(/^url\(#([\w-]+)\)$/)?.[1];
   const head=page.document.getElementById(marker)?.querySelector('path');assert.ok(head);assert.doesNotMatch(head.getAttribute('d'),/[Zz]/,'箭头使用开放尖角');
  }
 };
 let pages=0,emptyPages=0;
 for(const width of [1400,716]){
  Object.defineProperty(page.window,'innerWidth',{value:width,configurable:true});page.window.dispatchEvent(new page.window.Event('resize'));
  for(const [index,group] of page.window.EvaluationReportData.cases.entries()){
   page.change('[data-case-select]',index);
   for(const [pairIndex,pair] of group.pairs.entries()){
    page.change('[data-pair-select]',pairIndex);
    const seen=new Set();
    while(true){
     const signature=page.document.querySelector('.matrix-row')?.dataset.matrixRow??'empty';
     if(seen.has(signature))break;
     seen.add(signature);checkGeometry(width<=1080);pages++;if(signature==='empty')emptyPages++;
     const next=page.document.querySelector('[data-matrix-next]');if(!next)break;page.click(next);
    }
    assert.equal(seen.size,Math.max(1,Math.ceil(pair.comparisons.length/5)),'每个矩阵分页均执行几何校验');
   }
  }
 }
 assert.equal(pages,116);assert.equal(emptyPages,10);
});

test('翻页键盘、断点重排与重新挂载保持正确状态，无重复监听',async t=>{
 const page=environment(t);await page.load();page.key('[data-case-next]','End');assert.equal(page.document.querySelector('[data-case-select]').value,'29');page.click('[data-case-next]');assert.equal(page.document.querySelector('[data-case-select]').value,'0');
 page.click('[data-reveal-control]');page.click('[data-swap-control]');const winner=page.document.querySelector('#winnerLabel').textContent;
 const pair=page.window.EvaluationReportData.cases[0].pairs[0];
 for(const width of [1400,1080,716,1660]){
  Object.defineProperty(page.window,'innerWidth',{value:width,configurable:true});page.window.dispatchEvent(new page.window.Event('resize'));
  assert.equal(page.document.querySelector('#winnerLabel').textContent,winner);assert.equal(page.document.querySelectorAll('[data-revealed-model]').length,2);
  assertFixedCards(page);assertOwnership(page,pair,true);
  assert.equal(page.document.querySelectorAll('#evaluationMechanism,dialog,[data-swap-control]').length,3);
 }
 const root=page.document.querySelector('#flowBody'),oldControl=page.document.querySelector('[data-swap-control]'),oldScene=page.document.querySelector('#mechanismScene');
 const controller=page.window.ReportFlow.render(root,page.window.EvaluationReportData);page.click(oldControl);assert.equal(oldScene.querySelector('[data-swap-control]').getAttribute('aria-pressed'),'true');
 page.click('[data-case-next]');assert.equal(page.document.querySelector('[data-case-select]').value,'1');
 page.click('[data-input-control]');page.click('[data-page="rules"]');assert.equal(page.document.querySelector('dialog').open,false,'离开主题关闭详情');page.click('[data-page="flow"]');
 controller.destroy();const before=root.innerHTML;page.click('[data-swap-control]');page.click('[data-case-next]');page.key('[data-input-control]','Enter');page.window.dispatchEvent(new page.window.Event('resize'));assert.equal(root.innerHTML,before);
});

test('离线单文件可重开六个主题，来源HTML不会执行',async t=>{
 const temporary=await mkdtemp(join(tmpdir(),'report-current-'));t.after(()=>rm(temporary,{recursive:true,force:true}));
 const output=await buildReport({output:join(temporary,'report.html')});const page=environment(t,await readFile(output,'utf8'),true);
 assert.equal(page.document.querySelectorAll('[data-case-select] option').length,30);
 for(const name of ['research','architecture','rules','prompts','experiments','flow']){page.click(`[data-page="${name}"]`);assert.equal(page.document.querySelectorAll('.page:not([hidden])').length,1);assert.equal(page.document.querySelector(`#page-${name}`).hidden,false);}
 assert.equal(page.document.querySelector('[src^="http"],link[rel="stylesheet"],script[src]'),null);
 assert.equal(page.document.querySelectorAll('#architectureBody [data-agent-role]').length,6);
 assert.doesNotMatch(page.document.querySelector('#architectureBody').textContent,/关键问题没查齐|分开检查，也可能一起看错/);
 assertFixedCards(page);page.click('[data-swap-control]');assertOwnership(page,page.window.EvaluationReportData.cases[0].pairs[0],true);
 page.click('[data-input-control]');assert.equal(page.document.querySelector('[data-full-question]').textContent,page.window.EvaluationReportData.cases[0].question);
});

test('默认进入行业对标，章节支持键盘切换且完整研究与来源可离线阅读',async t=>{
 const page=environment(t,html,false,'');await page.load();
 assert.equal(page.document.querySelector('#page-research').hidden,false);
 assert.equal(page.document.querySelectorAll('.page:not([hidden])').length,1);
 const tabs=[...page.document.querySelectorAll('[data-research-tab]')];
 for(const tab of tabs){
  page.click(tab);
  assert.equal(page.document.querySelectorAll('.research-panel:not([hidden])').length,1);
  assert.equal(page.document.querySelector('#'+tab.getAttribute('aria-controls')).hidden,false);
 }
 page.key('#'+tabs.at(-1).id,'ArrowRight');
 assert.equal(page.document.activeElement,tabs[0]);
 assert.equal(tabs[0].getAttribute('aria-selected'),'true');
 page.key('#'+tabs[0].id,'End');
 assert.equal(page.document.activeElement,tabs.at(-1));
 assert.equal(page.document.querySelector('.research-document').querySelectorAll('h2').length,5);
 const sources=page.window.EvaluationResearchData.sources;
 assert.equal(new Set(sources.map(source=>source.id)).size,sources.length);
 assert.ok(sources.some(source=>source.url.includes('tech.meituan.com')));
 assert.ok(sources.some(source=>source.url.includes('developer.volcengine.com')));
 for(const link of page.document.querySelectorAll('.research-cite')) assert.ok(sources.some(source=>source.url===link.href));
 assert.match(page.document.querySelector('#research-panel-overview').textContent,/固定六题/);
 assert.match(page.document.querySelector('.research-document').textContent,/这不是人工准确率/);
});
