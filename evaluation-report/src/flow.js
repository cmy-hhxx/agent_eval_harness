(() => {
  'use strict';
  const safe = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const text = (x,y,value,cls,anchor='start',attrs='') => `<text x="${x}" y="${y}" class="${cls}" text-anchor="${anchor}" ${attrs}>${safe(value)}</text>`;
  const rect = (x,y,w,h,cls='material-sheet',r=6) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" class="${cls}"/>`;
  const edge = (d,kind='material',arrow=true) => `<path d="${d}" class="diagram-edge ${kind}-edge"${kind==='material'?' pathLength="1"':''}${arrow?` marker-end="url(#${kind}-arrow)"`:''}/>`;
  // Chinese glyphs are full width; the conservative Latin allowance prevents labels touching box edges.
  function wrap(value,width,size) {
    const lines=[]; let line='',used=0;
    for(const char of (String(value??'').match(/[A-Za-z0-9＋−+–\-.,/:%≥≤]+|[^\n]|\n/gu)||[])) {
      const unit=[...char].reduce((sum,glyph)=>sum+(/[\x20-\x7e]/.test(glyph)?size*.61:size),0);
      if(char==='\n'||(line&&used+unit>width)) {lines.push(line);line='';used=0;}
      if(char!=='\n'){line+=char;used+=unit;}
    }
    if(line)lines.push(line);
    return lines.length?lines:[''];
  }
  const lines = (x,y,values,cls,step=24,anchor='start',attrs='') => `<text x="${x}" y="${y}" class="${cls}" text-anchor="${anchor}" ${attrs}>${values.map((value,index)=>`<tspan x="${x}" dy="${index?step:0}">${safe(value)}</tspan>`).join('')}</text>`;
  const textWidth = (value,size) => [...String(value)].reduce((sum,char)=>sum+(/[\x20-\x7e]/.test(char)?size*.61:size),0);
  // Only the recorded comparison decides an advantage; a failed or inapplicable check is not a vote.
  function cellJudgment(item,row,candidate) {
    const states=row.comparisonIndices.map(index=>{
      const entry=item.comparisons[index];
      if(entry.statuses[candidate]==='not_applicable')return 'not-applicable';
      if(entry.evidenceStatuses[candidate]==='uncertain'||entry.statuses[candidate]==='unknown')return 'uncertain';
      if(entry.betterIndices.length===1)return entry.betterIndices[0]===candidate?'better':'worse';
      return 'neutral';
    });
    let state='neutral';
    if(states.every(value=>value==='not-applicable'))state='not-applicable';
    else if(states.includes('uncertain'))state='uncertain';
    else if(states.includes('better')&&!states.includes('worse'))state='better';
    else if(states.includes('worse')&&!states.includes('better'))state='worse';
    const partial=['better','worse'].includes(state)&&states.some(value=>value!==state);
    const symbol={better:'✓',worse:'×',neutral:'—','not-applicable':'∅',uncertain:'?'}[state]+(partial?'*':'');
    const label={better:'原判相对较优',worse:'原判相对较弱',neutral:'原判未判优劣','not-applicable':'不适用',uncertain:'待核实'}[state]+(partial?'（仅部分比较项）':'');
    return {state,partial,symbol,label};
  }
  function cellMarker(x,y,judgment) {
    const shape={better:'<path d="m-5 0 4 4 7-9"/>',worse:'<path d="m-4-4 8 8m0-8-8 8"/>',neutral:'<path d="M-5 0H5"/>','not-applicable':'<circle r="5"/><path d="m-4 4 8-8"/>',uncertain:'<text y="6" text-anchor="middle" class="marker-question">?</text>'}[judgment.state];
    return `<g transform="translate(${x} ${y})" class="cell-marker marker-${judgment.state}" role="img" aria-label="${safe(judgment.label)}" data-cell-judgment="${judgment.state}" data-symbol="${judgment.symbol}" data-partial="${judgment.partial}">${shape}${judgment.partial?'<text x="8" y="-4" class="marker-partial">*</text>':''}</g>`;
  }
  const region = (id,body) => `<g id="${id}" class="interaction-region" data-region="${id}">${body}</g>`;
  const regionDefinitions = [
    {id:'source-materials',related:['shared-rubric-and-attribution']},
    {id:'shared-rubric-and-attribution',related:['source-materials','identity-mapping','paired-comparison']},
    {id:'identity-mapping',related:['shared-rubric-and-attribution','paired-comparison','formal-outcomes']},
    {id:'paired-comparison',related:['identity-mapping','formal-outcomes']},
    {id:'formal-outcomes',related:['paired-comparison']},
    {id:'bounded-review',related:['paired-comparison','formal-outcomes']},
    {id:'problem-attribution',related:[]},
  ];
  const mounted=new WeakMap();
  window.ReportFlow={
    render(container,report) {
      mounted.get(container)?.destroy();
      const cases=report.cases;
      let current=0,swapped=false,interaction=null,destroyed=false,compact=window.innerWidth<=1080;
      function drawCase() {
        interaction?.destroy();
        compact=window.innerWidth<=1080;
        const item=cases[current],view=item.presentation;
        if(!view)throw new Error(`案例缺少图内内容：${item.id}`);
        const labels=item.candidates.map(candidate=>candidate.label);
        const mapping=swapped?[...labels].reverse():labels;
        const winner=()=>item.winnerIndex===null?(item.outcome==='both_good'?'都好':'都差'):`${(swapped?[...labels].reverse():labels)[item.winnerIndex]} 胜`;
        const sourceWinner=item.winnerIndex===null?'':item.candidates[item.winnerIndex].source;
        const W=compact?820:1660, xInput=10,xStandard=280,xAnonymous=650;
        const inputWidth=224,standardWidth=318,anonymousWidth=146;
        const questionLines=wrap(item.question,inputWidth-28,16);
        const objective=item.hasStandardAnswer;
        const kind=objective?'客观题':'主观题';
        const standardAnswerValue=objective?(typeof item.groundTruth.value==='string'?item.groundTruth.value:JSON.stringify(item.groundTruth.value)):'';
        const standardAnswerLines=objective?wrap(standardAnswerValue,inputWidth-28,16):[];
        const inputHeight=questionLines.length*19+(objective?standardAnswerLines.length*19+42:20);
        const checks=view.checklist.map(check=>wrap(check,standardWidth-62,16));
        const top=42,topHeight=Math.max(92,inputHeight,checks.reduce((sum,check)=>sum+check.length*19+3,0)+40);
        const rowY=[top+topHeight+28,top+topHeight+106],nodeHeight=64;
        const flowBottom=rowY[1]+nodeHeight;
        const mx=compact?10:852,mw=compact?624:590;
        const topicWidth=86,cellWidth=(mw-topicWidth)/2;
        const matrixRows=view.matrixRows.map(row=>({...row,judgments:row.values.map((_,index)=>cellJudgment(item,row,index)),wrapped:row.values.map(value=>wrap(value,cellWidth-42,15))}));
        const cellJudgments=matrixRows.flatMap(row=>row.judgments);
        const matrixLegend=['原判：✓ 较优  × 较弱  — 未判',
          cellJudgments.some(value=>value.state==='not-applicable')?'∅ 不适用':'',
          cellJudgments.some(value=>value.state==='uncertain')?'? 待核实':'',
          cellJudgments.some(value=>value.partial)?'* 部分项':'',
        ].filter(Boolean).join('  ');
        const vx=compact?666:1476,vw=compact?144:174;
        const decision=view.decision;
        const reasonLines=wrap(decision.summary.replace(/回答([①②])/g,'$1'),vw-24,15);
        const cautionLines=decision.caveat?wrap(decision.caveat.replace(/回答([①②])/g,'$1'),vw-24,13):[];
        const verdictHeight=86+reasonLines.length*17+(cautionLines.length?cautionLines.length*15+10:0);
        const heights=matrixRows.map(row=>Math.max(row.caution?42:28,Math.max(...row.wrapped.map(value=>value.length))*17+8));
        const extraHeight=Math.max(0,verdictHeight-30-heights.reduce((sum,h)=>sum+h,0));
        heights.forEach((height,index)=>{heights[index]=height+extraHeight/heights.length;});
        const matrixHeight=30+heights.reduce((sum,h)=>sum+h,0);
        const my=compact?flowBottom+48:Math.max(top,(rowY[0]+rowY[1])/2+32-matrixHeight/2);
        const matrixBottom=my+matrixHeight;
        const vy=matrixBottom-verdictHeight;
        const reviewY=Math.max(matrixBottom,flowBottom)+50;
        const postY=reviewY+70;
        // Match the problem library's component → problem hierarchy, using the original attributions.
        const problemRows=item.candidates.map(candidate=>{
          const groups=new Map();
          for(const finding of candidate.findings){
            if(finding.type!=='problem'||!finding.problem.component.length)continue;
            const component=finding.problem.component.join(' / ');
            if(!groups.has(component))groups.set(component,[]);
            groups.get(component).push(finding);
          }
          return [...groups].map(([component,findings])=>({component,findings,wrapped:wrap(`${component}｜${findings.map(finding=>finding.problem.label+(finding.assessment.evidence_status==='uncertain'?'（待核实）':'')).join('；')}`,W-56,15)}));
        });
        const problemRowHeights=problemRows.map(groups=>groups.length?groups.reduce((height,group)=>height+group.wrapped.length*18+4,0):22);
        const fullHeight=postY+28+problemRowHeights.reduce((height,row)=>height+row,0)+8;
        const middleY=my+matrixHeight/2;
        const count=String(current+1).padStart(2,'0');
        const prevIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6M8 12h12"/></svg>';
        const nextIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 6 6 6-6 6M4 12h12"/></svg>';
        container.innerHTML=`<div class="case-navigation" aria-label="真实案例"><span class="case-position">${count}<span> / ${cases.length}</span></span><select aria-label="选择真实案例" data-case-select>${cases.map((entry,index)=>`<option value="${index}" ${index===current?'selected':''}>${safe(entry.title)}</option>`).join('')}</select><span class="case-kind">${safe(kind)}</span><div class="case-pager"><button type="button" data-case-prev aria-label="上一个案例">${prevIcon}</button><button type="button" data-case-next aria-label="下一个案例">${nextIcon}</button></div></div><article id="active-case" aria-label="${safe(item.title)}"><figure class="research-figure "><p class="visually-hidden" role="status" data-diagram-status></p><svg id="evaluationMechanism" viewBox="0 0 ${W} ${fullHeight}" role="group" aria-labelledby="mechanismTitle mechanismDescription" xmlns="http://www.w3.org/2000/svg"><title id="mechanismTitle">${safe(item.title)}的评测机制</title><desc id="mechanismDescription">真实评测案例。输入、验收清单、独立核验、匿名比较与原判结果。验收清单是原判据及问句的分项摘录；对照表是已接受比较记录的摘要。换位只改变匿名代号。复核为未决时的条件路径。</desc><defs>${window.ReportIcons.symbols()}${['material','reference','review'].map(kind=>`<marker id="${kind}-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto" markerUnits="userSpaceOnUse"><path d="M1 1L9 5L1 9Z" class="${kind}-arrow-fill"/></marker>`).join('')}</defs><g id="mechanismScene"></g></svg></figure></article>`;
        const root=container.querySelector('.research-figure'),scene=root.querySelector('#mechanismScene');
        const standardAnswerY=top+questionLines.length*19+27;
        const standardAnswer=objective?`<g data-standard-answer data-answer-available="true">${text(xInput+14,standardAnswerY,'标准答案','standard-answer-label')}${lines(xInput+14,standardAnswerY+21,standardAnswerLines,'standard-answer-value',19,'start','data-standard-answer-value')}</g>`:'';
        let standardContent=rect(xStandard,top,standardWidth,topHeight,'criteria-sheet')+text(xStandard+16,top+22,'验收清单','sheet-caption');
        let checklistY=top+44;
        checks.forEach((check,index)=>{
          standardContent+=`<g data-checklist-item="${index}">${rect(xStandard+17,checklistY-11,10,10,'checklist-box',2)}${lines(xStandard+40,checklistY,check,'criterion-text',19)}</g>`;
          checklistY+=check.length*19+3;
        });
        let matrixContent=rect(mx,my,mw,matrixHeight,'comparison-matrix')+edge(`M${mx} ${my+30}H${mx+mw}`,'reference',false);
        matrixContent+=`<path class="matrix-rule" d="M${mx+topicWidth} ${my}V${matrixBottom}M${mx+topicWidth+cellWidth} ${my}V${matrixBottom}"/>`;
        matrixContent+=text(mx+topicWidth/2,my+21,'对照项','matrix-header','middle');
        mapping.forEach((label,index)=>{matrixContent+=text(mx+topicWidth+cellWidth*(index+.5),my+21,label,'matrix-header','middle',`data-candidate-identity="${index}"`);});
        matrixContent+=text(mx+mw,my-11,matrixLegend,'matrix-legend','end','data-matrix-legend');
        let cy=my+30;
        matrixRows.forEach((row,index)=>{
          const h=heights[index];
          const topicLines=wrap(row.label,topicWidth-12,15);
          matrixContent+=`<g class="matrix-row" data-matrix-row="${index}" data-comparison-indices="${safe(row.comparisonIndices.join(','))}">${lines(mx+topicWidth/2,cy+h/2-(topicLines.length-1)*8.5+(row.caution?-4:5),topicLines,'matrix-row-label',17,'middle')}${row.caution?text(mx+topicWidth/2,cy+h/2+14,row.caution,'matrix-row-caution','middle','data-row-caution'):''}${row.wrapped.map((cell,column)=>{
            const start=mx+topicWidth+cellWidth*column;
            return `<g class="matrix-cell" data-cell-candidate="${column}">${cellMarker(start+13,cy+h/2,row.judgments[column])}${lines(start+cellWidth/2+13,cy+h/2-(cell.length-1)*8.5+5,cell,'matrix-basis',17,'middle')}</g>`;
          }).join('')}</g>`;
          cy+=h;
          if(index<matrixRows.length-1)matrixContent+=`<path class="matrix-rule" d="M${mx} ${cy}H${mx+mw}"/>`;
        });
        const candidateContent=item.candidates.map((candidate,index)=>{
          const y=rowY[index],result=view.result[index],resultSize=textWidth(result,23)>130?'answer-long':'answer-number';
          return `${rect(xInput,y,inputWidth,nodeHeight)}${text(xInput+14,y+19,candidate.source,'sheet-caption')}${text(xInput+inputWidth-14,y+25,result,resultSize,'end')}${lines(xInput+14,y+51,wrap(view.formula[index],inputWidth-28,16),'answer-formula',19)}`;
        }).join('');
        const attributionFrame=rect(xStandard,rowY[0],standardWidth,flowBottom-rowY[0])+`<path class="matrix-rule" d="M${xStandard} ${rowY[0]+nodeHeight+7}H${xStandard+standardWidth}"/>`;
        const attributionContent=attributionFrame+item.candidates.map((candidate,index)=>{
          const y=rowY[index],issue=!candidate.core.meets_core;
          return `<g class="evidence-sheet" data-source-candidate="${index}">${text(xStandard+15,y+18,`核验${index===0?'①':'②'}`,'sheet-caption')}${text(xStandard+standardWidth-15,y+18,issue?'核心不可用':'核心可用',issue?'issue-caption':'usable-caption','end')}${text(xStandard+15,y+38,view.check[index],issue?'issue-text':'check-text')}${text(xStandard+15,y+56,view.finding[index],issue?'issue-evidence':'evidence-text')}</g>`;
        }).join('');
        const anonContent=item.candidates.map((candidate,index)=>{
          const y=rowY[index];
          return `${rect(xAnonymous,y,anonymousWidth,nodeHeight,'anonymous-sheet')}${rect(xAnonymous+12,y+8,22,22,'identity-badge',4)}${text(xAnonymous+23,y+24,mapping[index],'identity-label','middle',`data-candidate-identity="${index}"`)}${text(xAnonymous+anonymousWidth-12,y+24,`证据${index===0?'①':'②'}`,'packet-source','end')}${text(xAnonymous+anonymousWidth/2,y+53,view.result[index],textWidth(view.result[index],23)>anonymousWidth-20?'packet-long':'packet-number','middle')}`;
        }).join('');
        const sx=xAnonymous+65;
        const swap=`<g data-swap-control role="button" tabindex="0" aria-label="交换匿名 A/B 映射" aria-pressed="${swapped}" class="swap-target">${rect(sx,4,81,31,'swap-control',4)}${window.ReportIcons.draw('shuffle',sx+8,9,20,20,'swap-icon')}${text(sx+56,26,'换位','swap-label','middle')}</g>`;
        const headings=text(xInput,28,'输入','diagram-heading')+text(xStandard,28,'标准与核验','diagram-heading')+text(xAnonymous,28,'匿名','diagram-heading')+text(mx,my-10,'逐项对照','diagram-heading')+text(vx,vy-14,'判决与取舍','diagram-heading');
        // The checklist applies to the shared frame; each answer keeps an independent horizontal lane.
        const sourceX=xInput+inputWidth,checklistPort=xStandard+standardWidth/2;
        const connections=`<g class="connections" data-owner="shared-rubric-and-attribution">${edge(`M${sourceX+7} ${top+topHeight/2}H${xStandard-8}`)}${rowY.map(y=>edge(`M${sourceX+7} ${y+32}H${xStandard-8}`)).join('')}${edge(`M${checklistPort} ${top+topHeight+5}V${rowY[0]-5}`,'reference')}</g><g class="connections" data-owner="identity-mapping">${rowY.map(y=>edge(`M${xStandard+standardWidth+8} ${y+32}H${xAnonymous-8}`)).join('')}</g>`;
        const mergeX=compact?W-7:xAnonymous+anonymousWidth+20;
        const mergeY=compact?flowBottom+10:middleY;
        const comparisonConnection=compact?
          `${edge(`M${xAnonymous+anonymousWidth+6} ${rowY[0]+32}H${mergeX-6}Q${mergeX} ${rowY[0]+32} ${mergeX} ${rowY[0]+38}V${mergeY-6}Q${mergeX} ${mergeY} ${mergeX-6} ${mergeY}H${mx+mw/2+6}Q${mx+mw/2} ${mergeY} ${mx+mw/2} ${mergeY+6}V${my-8}`)}${edge(`M${xAnonymous+anonymousWidth+6} ${rowY[1]+32}H${mergeX}`,'material',false)}`:
          `${edge(`M${xAnonymous+anonymousWidth+6} ${rowY[0]+32}H${mergeX-5}Q${mergeX} ${rowY[0]+32} ${mergeX} ${rowY[0]+37}V${middleY}`,'material',false)}${edge(`M${xAnonymous+anonymousWidth+6} ${rowY[1]+32}H${mergeX-5}Q${mergeX} ${rowY[1]+32} ${mergeX} ${rowY[1]+27}V${middleY}`,'material',false)}${edge(`M${mergeX} ${middleY}H${mx-8}`)}`;
        const verdictPortY=vy+32;
        const verdictPath=`M${mx+mw+8} ${verdictPortY}H${vx-8}`;
        const boundLines=(y,values,cls,step,attrs)=>`<text x="${vx+12}" y="${y}" class="${cls}" ${attrs}>${values.map((line,index)=>`<tspan x="${vx+12}" dy="${index?step:0}">${line.split(/([①②])/).map(part=>['①','②'].includes(part)?`<tspan data-candidate-identity="${part==='①'?0:1}">${mapping[part==='①'?0:1]}</tspan>`:safe(part)).join('')}</tspan>`).join('')}</text>`;
        const verdict=rect(vx,vy,vw,verdictHeight,'verdict-sheet')+text(vx+vw/2,vy+(item.winnerIndex===null?43:32),winner(),'winner-label','middle','id="winnerLabel"')+text(vx+vw/2,vy+55,sourceWinner,'winner-source','middle','id="sourceWinner"')+`<path class="matrix-rule" d="M${vx+12} ${vy+67}H${vx+vw-12}"/>`+boundLines(vy+88,reasonLines,'verdict-reason',17,'data-verdict-reason')+(cautionLines.length?boundLines(vy+88+reasonLines.length*17+10,cautionLines,'verdict-caution',15,'data-verdict-caution'):'');
        // Align the verdict with the matrix bottom so the return stays in the gap below both.
        const rx=compact?178:940,rw=compact?158:170,gap=compact?70:64;
        const reviewX=[rx,rx+rw+gap,rx+2*(rw+gap)];
        const reviewSource=reviewX[0]+rw/2;
        const retryCenter=reviewX[1]+rw/2,verdictCenter=vx+vw/2,returnY=matrixBottom+26;
        const reviewW=Math.min(rw,W-reviewX[2]-8);
        const review=`${text(reviewSource+11,matrixBottom+23,'待复核','review-label')}${rect(reviewX[0],reviewY,rw,38,'review-operation')}${text(reviewX[0]+rw/2,reviewY+25,`复核 ≤${report.limits.reviewRounds} 轮`,'review-text','middle')}${rect(reviewX[1],reviewY,rw,38,'review-operation')}${text(retryCenter,reviewY+25,'再次比较','review-text','middle')}${rect(reviewX[2],reviewY,reviewW,38,'stop-sheet')}${text(reviewX[2]+reviewW/2,reviewY+25,'不交付','review-text','middle')}${text(reviewX[1]+rw+gap/2,reviewY+9,'仍未决','review-label','middle')}${text((retryCenter+verdictCenter)/2,returnY-7,'可裁决','review-label','middle')}`;
        const reviewEdges=`${edge(`M${reviewSource} ${matrixBottom+8}V${reviewY-8}`,'review')}${edge(`M${reviewX[0]+rw+8} ${reviewY+19}H${reviewX[1]-8}`,'review')}${edge(`M${reviewX[1]+rw+8} ${reviewY+19}H${reviewX[2]-8}`,'review')}${edge(`M${retryCenter} ${reviewY-8}V${returnY}H${verdictCenter}V${matrixBottom+8}`,'review')}`;
        let problemY=postY+28;
        const problemContent=problemRows.map((groups,index)=>{
          let body=text(10,problemY,mapping[index],'attribution-identity','start',`data-candidate-identity="${index}"`);
          if(!groups.length)body+=text(46,problemY,'未记录问题','attribution-empty');
          for(const group of groups){
            const wrapped=group.wrapped.map((line,lineIndex)=>`<tspan x="46" dy="${lineIndex?18:0}">${lineIndex===0?`<tspan class="attribution-component">${safe(group.component)}</tspan>${safe(line.slice(group.component.length))}`:safe(line)}</tspan>`).join('');
            body+=`<g data-finding-ids="${safe(group.findings.map(finding=>finding.finding_id).join(' '))}"><text x="46" y="${problemY}" class="attribution-text">${wrapped}</text></g>`;
            problemY+=group.wrapped.length*18+4;
          }
          if(!groups.length)problemY+=22;
          problemY+=8;
          return `<g data-problem-candidate="${index}">${body}</g>`;
        }).join('');
        const post=region('problem-attribution',text(10,postY,'问题归因','attribution-heading')+problemContent);
        scene.innerHTML=`<g class="stage-headings">${headings}</g>${connections}<g class="connections" data-owner="paired-comparison">${comparisonConnection}</g><g class="connections" data-owner="formal-outcomes">${edge(verdictPath)}</g><g class="connections" data-owner="bounded-review">${reviewEdges}</g>${region('source-materials',rect(xInput,top,inputWidth,topHeight)+lines(xInput+14,top+24,questionLines,'diagram-question',19,'start','data-overview-question')+standardAnswer+candidateContent)}${region('shared-rubric-and-attribution',standardContent+attributionContent)}${region('identity-mapping',swap+anonContent)}${region('paired-comparison',`<g id="comparison-grid">${matrixContent}</g>`)}${region('formal-outcomes',verdict)}${region('bounded-review',review)}<path d="M10 ${postY-22}H${W-10}" class="panel-rule"/>${post}`;
        function syncSwap(){
          swapped=!swapped;
          const values=swapped?[...labels].reverse():labels;
          root.querySelectorAll('[data-candidate-identity]').forEach(node=>{node.textContent=values[Number(node.dataset.candidateIdentity)];});
          root.querySelector('#winnerLabel').textContent=winner();
          root.querySelector('[data-swap-control]').setAttribute('aria-pressed',String(swapped));
          root.querySelector('[data-diagram-status]').textContent='匿名代号已交换，原判来源不变';
          root.querySelectorAll('[data-owner="identity-mapping"] .material-edge').forEach(path=>window.ReportMotion.trace(path));
        }
        interaction=window.ReportDiagram.mount(root,{regions:regionDefinitions,onSwap:syncSwap});
      }
      function selectCase(index,focus=false){
        if(destroyed||!Number.isInteger(index)||index<0||index>=cases.length)return;
        current=index;swapped=false;drawCase();
        if(focus)container.querySelector('[data-case-select]').focus({preventScroll:true});
        window.ReportMotion.reveal(container.querySelector('#active-case'),{distance:2,duration:150});
      }
      function click(event){
        const control=event.target.closest('[data-case-prev],[data-case-next]');
        if(!control)return;
        const key=control.hasAttribute('data-case-prev')?'data-case-prev':'data-case-next';
        selectCase((current+(key==='data-case-prev'?-1:1)+cases.length)%cases.length);
        container.querySelector(`[${key}]`).focus({preventScroll:true});
      }
      function change(event){if(event.target.matches('[data-case-select]'))selectCase(Number(event.target.value),true);}
      function keydown(event){
        if(!event.target.closest('.case-navigation')||event.target.matches('select'))return;
        if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
        event.preventDefault();selectCase(event.key==='Home'?0:event.key==='End'?cases.length-1:(current+(event.key==='ArrowRight'?1:-1)+cases.length)%cases.length,true);
      }
      function resize(){if(!destroyed&&(window.innerWidth<=1080)!==compact)drawCase();}
      container.addEventListener('click',click);container.addEventListener('change',change);container.addEventListener('keydown',keydown);window.addEventListener('resize',resize);
      drawCase();
      const controller={selectCase,destroy(){if(destroyed)return;destroyed=true;interaction?.destroy();container.removeEventListener('click',click);container.removeEventListener('change',change);container.removeEventListener('keydown',keydown);window.removeEventListener('resize',resize);if(mounted.get(container)===controller)mounted.delete(container);}};
      mounted.set(container,controller);return controller;
    },
  };
})();
