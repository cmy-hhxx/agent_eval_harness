(() => {
  'use strict';
  const safe = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const text = (x,y,value,cls,anchor='start',attrs='') => `<text x="${x}" y="${y}" class="${cls}" text-anchor="${anchor}" ${attrs}>${safe(value)}</text>`;
  const rect = (x,y,w,h,cls='material-sheet',r=6) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" class="${cls}"/>`;
  const edge = (d,kind='material',arrow=true,attributes='') => `<path d="${d}" class="diagram-edge ${kind}-edge" ${attributes}${kind==='material'?' pathLength="1"':''}${arrow?` marker-end="url(#${kind}-arrow)"`:''}/>`;
  // Chinese glyphs are full width; the conservative Latin allowance prevents labels touching box edges.
  function wrap(value,width,size) {
    const lines=[]; let line='',used=0;
    const pieces=(String(value??'').match(/[A-Za-z0-9＋−+–\-.,/:%≥≤]+|[^\n]|\n/gu)||[]).flatMap(token=>[...token].reduce((sum,glyph)=>sum+(/[\x20-\x7e]/.test(glyph)?size*.61:size),0)>width?[...token]:[token]);
    for(const char of pieces) {
      const unit=[...char].reduce((sum,glyph)=>sum+(/[\x20-\x7e]/.test(glyph)?size*.61:size),0);
      if(char==='\n'||(line&&used+unit>width)) {lines.push(line);line='';used=0;}
      if(char!=='\n'){line+=char;used+=unit;}
    }
    if(line)lines.push(line);
    return lines.length?lines:[''];
  }
  const lines = (x,y,values,cls,step=24,anchor='start',attrs='') => `<text x="${x}" y="${y}" class="${cls}" text-anchor="${anchor}" ${attrs}>${values.map((value,index)=>`<tspan x="${x}" dy="${index?step:0}">${safe(value)}</tspan>`).join('')}</text>`;
  const textWidth=(value,size)=>[...value].reduce((sum,char)=>sum+(/[\x20-\x7e]/.test(char)?size*.61:size),0);
  function typography() {
    const style=window.getComputedStyle(document.documentElement);
    return Object.fromEntries(['section','body','copy','meta'].map(name=>{
      const size=Number.parseFloat(style.getPropertyValue(`--type-${name}`));
      if(!Number.isFinite(size)||size<=0)throw new Error(`缺少有效字号：--type-${name}`);
      return [name,size];
    }));
  }
  function preview(value,width,size,maxLines) {
    const all=wrap(value,width,size),visible=all.slice(0,maxLines);
    if(all.length>maxLines)visible[maxLines-1]=[...visible[maxLines-1]].slice(0,-1).join('')+'…';
    return {lines:visible,truncated:all.length>maxLines};
  }
  // Keep a solid, readable label beneath the narrow moving highlight.
  const agentTitle=(x,y,label,cls='agent-title')=>text(x,y,label,cls)+text(x,y,label,`agent-glint ${cls}-light`,'start','aria-hidden="true"');
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

  const mounted=new WeakMap();
  const coreName=candidate=>candidate.core.meets_core===true?'核心可用':candidate.core.meets_core===false?'核心不可用':'核心待核';
  const sourceText=ref=>ref?`${ref.file}${ref.line?` · 第 ${ref.line} 行`:''}`:'';
  window.ReportFlow={
    render(container,report) {
      mounted.get(container)?.destroy();
      const cases=report.cases;
      let current=0,pairIndex=0,matrixPage=0,swapped=false,revealed=false,destroyed=false,dialogReturn=null;
      let compact=window.innerWidth<=1080;
      const item=()=>cases[current].pairs[pairIndex];
      const displayOrder=()=>swapped?[1,0]:[0,1];
      const mapping=()=>swapped?[...item().candidates.map(c=>c.label)].reverse():item().candidates.map(c=>c.label);
      function anonymous(value) {
        let result=String(value??'');
        const token=index=>`\uE000${index}\uE001`;
        item().candidates.forEach((candidate,index)=>{
          for(const name of [...new Set([candidate.displayName,candidate.versionName,candidate.version])].filter(Boolean).sort((a,b)=>b.length-a.length))result=result.replaceAll(name,token(index));
          result=result.replaceAll(candidate.source,token(index));
        });
        // Keep financial terms such as A股 intact; bind explicit candidate references to their source label.
        result=result.replace(/\b([AB])(?=方|回答|正文|更|较|在|均|都|给出|存在|未|有|无|的|胜|负|[，。；：、\s]|$)/g,(letter)=>token(item().candidates.findIndex(candidate=>candidate.label===letter)));
        item().candidates.forEach((_,index)=>{result=result.replaceAll(token(index),mapping()[index]);});
        return result;
      }
      const control=(x,y,w,h,body,attributes)=>`<g class="diagram-control" tabindex="0" role="button" ${attributes}>${rect(x,y,w,h)}${body}</g>`;
      function closeDetail() {
        const dialog=container.querySelector('dialog');
        if(!dialog?.open)return;
        if(typeof dialog.close==='function')dialog.close();else dialog.removeAttribute('open');
        dialogReturn?.focus({preventScroll:true});
      }
      function openDetail(kind,index,trigger) {
        dialogReturn=trigger||dialogReturn;
        const pair=item(), candidate=pair.candidates[index],dialog=container.querySelector('dialog');
        const title=kind==='answer'?`${candidate.source} · 完整回答`:kind==='check'?`${candidate.source} · 归因完整输出`:kind==='comparison'?'对比 Agent · 逐项对照':kind==='input'?'完整用户输入':kind==='verdict'?'对比 Agent · 裁决与取舍':'共同验收清单';
        dialog.querySelector('[data-detail-title]').textContent=title;
        const body=dialog.querySelector('[data-detail-body]');
        if(kind==='answer') {
          body.innerHTML=`<div class="detail-tabs">${displayOrder().map(i=>`<button type="button" data-answer-switch="${i}" aria-pressed="${i===index}">${safe(pair.candidates[i].source)}${revealed?' · '+safe(pair.candidates[i].displayName):''}</button>`).join('')}<button type="button" data-answer-format aria-pressed="false">原文</button></div><div class="answer-reading" data-answer-reading></div><div class="answer-original" data-full-answer hidden></div><div class="source-reference"></div>`;
          body.querySelector('[data-full-answer]').textContent=candidate.finalAnswer;
          window.ReportAnswer.render(body.querySelector('[data-answer-reading]'),candidate.finalAnswer);
          body.querySelector('.source-reference').textContent=sourceText(candidate.provenance.source);
          body.dataset.answerIndex=String(index);
        } else if(kind==='check') {
          window.ReportDetails.renderCheck(body,{pair,candidate,anonymous});
        } else if(kind==='input') {
          body.innerHTML=`<p class="full-input" data-full-question></p>${pair.hasStandardAnswer?'<h3>标准答案</h3><p class="full-standard" data-full-standard></p>':''}`;
          body.querySelector('[data-full-question]').textContent=cases[current].question;
          if(pair.hasStandardAnswer)body.querySelector('[data-full-standard]').textContent=typeof pair.groundTruth.value==='string'?pair.groundTruth.value:JSON.stringify(pair.groundTruth.value);
        } else if(kind==='verdict') {
          body.innerHTML=`<h3>${safe(pair.status==='needs_review'?'待核':pair.winnerIndex===null?(pair.outcome==='both_good'?'都好':'都差'):mapping()[pair.winnerIndex]+' 胜')}</h3><p data-full-verdict></p><h3>原始取舍</h3><p data-original-tradeoff></p>${pair.presentation.decision.caveat?`<h3>记录限制</h3><p>${safe(anonymous(pair.presentation.decision.caveat))}</p>`:''}<p class="source-reference">${safe(sourceText(pair.provenance.result))}</p>`;
          body.querySelector('[data-full-verdict]').textContent=anonymous(pair.rewrittenReason||pair.tradeoff||pair.reason);
          body.querySelector('[data-original-tradeoff]').textContent=anonymous(pair.tradeoff);
        } else if(kind==='comparison') {
          body.innerHTML=pair.comparisons.map(entry=>`<section class="detail-assessment"><h3>${safe(anonymous(entry.topic))}</h3>${displayOrder().map(i=>`<section data-comparison-detail-candidate="${i}"><h4>${mapping()[i]}</h4><p>${safe(anonymous(entry.cells[i]))}</p></section>`).join('')}</section>`).join('');
        } else body.innerHTML=`<ol class="criteria-original">${pair.criteria.filter(c=>c.scope==='shared'&&c.group==='requirements').map(c=>`<li>${safe(c.text)}</li>`).join('')}</ol>`;
        dialog.dataset.detailKind=kind;
        if(!dialog.open){if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');}
        dialog.querySelector('[data-detail-close]').focus();
        body.scrollTop=0;
      }
      function drawCase() {
        compact=window.innerWidth<=1080;
        const fonts=typography();
        const group=cases[current],pair=item(),labels=mapping(),W=compact?820:1660;
        const presentation=(window.ReportCaseSummaries[pair.id]||window.ReportCaseSummariesB[pair.id]);
        if(!presentation)throw new Error('缺少案例展示摘要：'+pair.id);
        const xInput=10,xStandard=280,xAnonymous=650,inputWidth=224,standardWidth=318,anonymousWidth=146;
        const order=displayOrder(),top=42,topHeight=148,nodeHeight=112;
        const questionPreview=preview(group.question,inputWidth-28,fonts.body,pair.hasStandardAnswer?3:5);
        const gold=pair.hasStandardAnswer?String(typeof pair.groundTruth.value==='string'?pair.groundTruth.value:JSON.stringify(pair.groundTruth.value)):'';
        const goldPreview=pair.hasStandardAnswer?preview(gold,inputWidth-28,fonts.body,2):{lines:[],truncated:false};
        const allChecks=pair.presentation.checklist,checks=[];
        let checklistBudget=topHeight-40;
        for(const value of allChecks.slice(0,4)){
          const check=preview(value,standardWidth-58,fonts.body,2).lines,cost=check.length*18+4;
          if(cost>checklistBudget)break;
          checks.push(check);checklistBudget-=cost;
        }
        const rowY=[top+topHeight+24,top+topHeight+24+nodeHeight+16],flowBottom=rowY[1]+nodeHeight;
        const pageSize=5,totalPages=Math.max(1,Math.ceil(pair.comparisons.length/pageSize));
        matrixPage=Math.min(matrixPage,totalPages-1);
        const start=matrixPage*pageSize;
        const rows=presentation.rows.slice(start,start+pageSize);
        const mx=compact?10:852,mw=compact?624:590,topicWidth=112,cellWidth=(mw-topicWidth)/2;
        const rowLayout=rows.map(row=>({row,topics:wrap(anonymous(row.label),topicWidth-16,fonts.copy),cells:row.values.map(value=>wrap(anonymous(value),cellWidth-38,fonts.copy)),judgments:[0,1].map(i=>cellJudgment(pair,row,i))}));
        const rowHeights=rowLayout.map(row=>Math.max(48,row.topics.length*17+12,...row.cells.map(cell=>cell.length*17+12)));
        const matrixHeight=Math.max(30+rowHeights.reduce((h,v)=>h+v,0),120);
        const verdictHeight=196;
        const comparisonCenterY=compact?flowBottom+54+Math.max(matrixHeight,verdictHeight)/2:(rowY[0]+rowY[1]+nodeHeight)/2;
        const my=comparisonCenterY-matrixHeight/2,matrixBottom=my+matrixHeight;
        const vx=compact?666:1476,vw=compact?144:174;
        const reason=anonymous(pair.rewrittenReason||pair.tradeoff||pair.reason);
        const reasonPreview=preview(reason,vw-24,fonts.copy,5),reasonLines=reasonPreview.lines;
        const vy=comparisonCenterY-verdictHeight/2;
        const verdictBottom=vy+verdictHeight;
        const postY=Math.max(matrixBottom,verdictBottom,flowBottom)+66;
        const problems=pair.candidates.map(c=>c.findings.filter(f=>f.type==='problem'));
        const problemLines=problems.map((list,index)=>list.map(f=>({finding:f,wrapped:wrap(anonymous(`${f.problem?.component?.length?f.problem.component.join(' / '):'责任待定位'}｜${f.problem?.label||f.text}${f.assessment?.evidence_status==='uncertain'?'（待核实）':''}`),W-66,fonts.copy)})));
        const problemHeight=problemLines.reduce((h,groups)=>h+24+Math.max(22,groups.reduce((sum,g)=>sum+g.wrapped.length*18+5,0)),0);
        const fullHeight=postY+problemHeight+34;
        const pageCount=String(current+1).padStart(2,'0');
        const prevIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6M8 12h12"/></svg>';
        const nextIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 6 6 6-6 6M4 12h12"/></svg>';
        container.innerHTML=`<div class="case-navigation" aria-label="真实案例"><span class="case-position">${pageCount}<span> / ${cases.length}</span></span><select aria-label="选择真实案例" data-case-select>${cases.map((entry,index)=>`<option value="${index}" ${index===current?'selected':''}>${safe(entry.title)}</option>`).join('')}</select><select class="pair-select" aria-label="选择模型组" data-pair-select>${group.pairs.map((entry,index)=>`<option value="${index}" ${index===pairIndex?'selected':''}>${safe(entry.tier)}${entry.status==='needs_review'?' · 待核':''}</option>`).join('')}</select><span class="case-kind">${pair.hasStandardAnswer?'客观题':'主观题'}</span><div class="case-pager"><button type="button" data-case-prev aria-label="上一个案例">${prevIcon}</button><button type="button" data-case-next aria-label="下一个案例">${nextIcon}</button></div></div>
          <article id="active-case" aria-label="${safe(group.title)}"><figure class="research-figure ${compact?'compact-figure':''}"><svg id="evaluationMechanism" viewBox="0 0 ${W} ${fullHeight}" role="group" aria-label="${safe(group.title)}的multi-agent评测机制" xmlns="http://www.w3.org/2000/svg"><defs>${['criteria','attribution','comparison'].map(role=>`<linearGradient id="agent-${role}-sheen" gradientUnits="objectBoundingBox" x1="0" y1="0" x2="1" y2="0"><stop offset="0" class="agent-sheen-base"/><stop offset=".3" class="agent-sheen-base"/><stop offset=".44" class="agent-sheen-light"/><stop offset=".485" class="agent-sheen-glint"/><stop offset=".515" class="agent-sheen-glint"/><stop offset=".56" class="agent-sheen-light"/><stop offset=".7" class="agent-sheen-base"/><stop offset="1" class="agent-sheen-base"/><animateTransform attributeName="gradientTransform" type="translate" values="-.65 0;.65 0" dur="3.2s" repeatCount="indefinite"/></linearGradient>`).join('')}${window.ReportIcons.symbols()}${['material','reference','review'].map(kind=>`<marker id="${kind}-arrow" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="11" markerHeight="11" orient="auto" markerUnits="userSpaceOnUse"><path d="M3 2L10 6L3 10" class="arrow-head ${kind}-arrow-head"/></marker>`).join('')}</defs><g id="mechanismScene"></g></svg></figure></article>
          <dialog class="case-detail" aria-labelledby="caseDetailTitle"><header><h2 id="caseDetailTitle" data-detail-title></h2><button type="button" data-detail-close aria-label="关闭详情">×</button></header><div class="case-detail-body" data-detail-body></div></dialog>`;
        const scene=container.querySelector('#mechanismScene');
        let checklist=rect(xStandard,top,standardWidth,topHeight,'criteria-sheet')+agentTitle(xStandard+14,top+24,'标准 Agent','agent-card-title');
        checklist+=text(xStandard+standardWidth-15,top+24,`${checks.length}/${allChecks.length} 项 ↗`,'sheet-caption','end');
        let checkY=top+48;
        checks.forEach((check,index)=>{checklist+=rect(xStandard+17,checkY-11,10,10,'checklist-box',2)+lines(xStandard+40,checkY,check,'criterion-text',18,'start',`data-checklist-item="${index}"`);checkY+=check.length*18+4;});
        const question=control(xInput,top,inputWidth,topHeight,text(xInput+14,top+22,'用户输入','sheet-caption')+text(xInput+inputWidth-14,top+22,'↗','sheet-caption','end')+lines(xInput+14,top+43,questionPreview.lines,'diagram-question',18,'start',`data-overview-question data-truncated="${questionPreview.truncated}"`)+(goldPreview.lines.length?`<g data-standard-answer>${text(xInput+14,top+99,pair.candidates.some(candidate=>candidate.standardConflict)?'标准答案（冲突标记）':'标准答案','standard-answer-label')}${lines(xInput+14,top+121,goldPreview.lines,'standard-answer-value',18,'start',`data-standard-answer-value data-truncated="${goldPreview.truncated}"`)}</g>`:''),'data-input-control aria-label="查看完整用户输入"');
        const answers=order.map((index,slot)=>{
          const candidate=pair.candidates[index],y=rowY[slot];
          return control(xInput,y,inputWidth,nodeHeight,text(xInput+14,y+27,candidate.source,'answer-long')+text(xInput+inputWidth-14,y+25,'↗','sheet-caption','end')+text(xInput+14,y+58,`${[...candidate.finalAnswer].length.toLocaleString('zh-CN')} 字 · 完整回答`,'answer-formula')+text(xInput+14,y+90,pair.hasStandardAnswer?(candidate.isCorrect===true?'匹配标准':candidate.isCorrect===false?'未匹配标准':'标准核对待定'):'主观题 · 核查实际交付','sheet-caption'),`data-answer-card="${index}" aria-label="查看${candidate.source}完整回答"`);
        }).join('');
        const attribution=order.map((index,slot)=>{
          const candidate=pair.candidates[index],y=rowY[slot],sharedIds=new Set(pair.criteria.filter(c=>c.scope==='shared'&&c.group==='requirements').map(c=>c.id));
          const shared=candidate.criteriaAssessments.filter(a=>sharedIds.has(a.criterion_id));
          const count={met:0,partial:0,unmet:0,unknown:0};
          for(const a of shared){const state=a.evidence_status==='uncertain'?'unknown':a.status;if(Object.hasOwn(count,state))count[state]++;}
          const counts=Object.entries(count).filter(([,value])=>value).map(([key,value])=>`${value}${{met:'满足',partial:'部分',unmet:'未满足',unknown:'待核'}[key]}`).join(' · ');
          const strengths=candidate.findings.filter(f=>f.type==='strength').length;
          const uncertainProblems=problems[index].filter(f=>f.assessment?.evidence_status==='uncertain').length;
          return `<g data-agent-role="attribution" data-agent-candidate="${index}">${control(xStandard,y,standardWidth,nodeHeight,agentTitle(xStandard+14,y+24,`归因 Agent ${index===0?'①':'②'}`,'agent-card-title')+text(xStandard+standardWidth-15,y+23,coreName(candidate),candidate.core.meets_core===true?'usable-caption':'issue-caption','end')+lines(xStandard+15,y+47,preview(presentation.checks[index],standardWidth-30,fonts.body,2).lines,'check-text',18)+text(xStandard+15,y+86,`验收 ${counts}`,'agent-output-count')+text(xStandard+15,y+106,`优点 ${strengths} · 问题 ${problems[index].length}${uncertainProblems?'（'+uncertainProblems+' 待核）':''}`,'agent-output-count')+text(xStandard+standardWidth-15,y+106,'输出 ↗','agent-output-count','end'),`data-check-card="${index}" aria-label="查看${candidate.source}核验依据"`)}</g>`;
        }).join('');
        const attributionFrame=rect(xStandard,rowY[0],standardWidth,flowBottom-rowY[0],'attribution-frame')+`<path class="matrix-rule" d="M${xStandard} ${rowY[0]+nodeHeight+8}H${xStandard+standardWidth}"/>`;
        const anon=order.map((index,slot)=>{
          const candidate=pair.candidates[index],y=rowY[slot];
          return `<g data-anonymous-candidate="${index}">`+rect(xAnonymous,y,anonymousWidth,nodeHeight,'anonymous-sheet')+text(xAnonymous+14,y+25,labels[index],'identity-label','start',`data-candidate-identity="${index}"`)+text(xAnonymous+anonymousWidth-12,y+24,`证据${index===0?'①':'②'}`,'packet-source','end')+(revealed?lines(xAnonymous+12,y+55,wrap(`${candidate.displayName}\n${candidate.model||candidate.version}`,anonymousWidth-24,fonts.meta),'identity-model',17,'start',`data-revealed-model="${index}"`):text(xAnonymous+anonymousWidth/2,y+72,coreName(candidate),'packet-long','middle'))+'</g>';
        }).join('');
        const swap=`<g data-swap-control role="button" tabindex="0" aria-label="交换匿名 A/B 映射" aria-pressed="${swapped}" class="swap-target">${rect(xAnonymous+66,4,80,31,'swap-control',4)}${window.ReportIcons.draw('shuffle',xAnonymous+73,9,20,20,'swap-icon')}${text(xAnonymous+121,26,'换位','swap-label','middle')}</g>`;
        let matrix=rect(mx,my,mw,matrixHeight,'comparison-matrix');
        matrix+=`<path class="matrix-rule" d="M${mx} ${my+30}H${mx+mw}M${mx+topicWidth} ${my}V${matrixBottom}M${mx+topicWidth+cellWidth} ${my}V${matrixBottom}"/>`;
        matrix+=text(mx+topicWidth/2,my+21,'对照项','matrix-header','middle');
        order.forEach((index,slot)=>{matrix+=text(mx+topicWidth+cellWidth*(slot+.5),my+21,labels[index],'matrix-header','middle',`data-candidate-identity="${index}"`);});
        let cy=my+30;
        rowLayout.forEach(({row,topics,cells,judgments},i)=>{
          const h=rowHeights[i];
          matrix+=`<g class="matrix-row" data-matrix-row="${start+i}">${lines(mx+topicWidth/2,cy+h/2-(topics.length-1)*8.5+5,topics,'matrix-topic',17,'middle')}${order.map((index,slot)=>{const cell=cells[index],x=mx+topicWidth+cellWidth*slot;return `<g class="matrix-cell" data-cell-candidate="${index}">${cellMarker(x+12,cy+h/2,judgments[index])}${lines(x+cellWidth/2+12,cy+h/2-(cell.length-1)*8.5+5,cell,'matrix-basis',17,'middle')}</g>`;}).join('')}</g>`;
          cy+=h;if(i<rows.length-1)matrix+=`<path class="matrix-rule" d="M${mx} ${cy}H${mx+mw}"/>`;
        });
        if(!rows.length)matrix+=lines(mx+18,my+65,['来源核验尚有未决问题','没有正式逐项对比'], 'evidence-text',24);
        const judgments=rowLayout.flatMap(r=>r.judgments);
        const legend=['✓较优','×较弱','—未判',judgments.some(j=>j.state==='not-applicable')?'∅不适用':'',judgments.some(j=>j.state==='uncertain')?'?待核实':''].filter(Boolean).join('  ');
        const comparisonHeadingX=mx+Math.ceil(textWidth('对比 Agent',fonts.section))+12;
        const originalLinkX=comparisonHeadingX+Math.ceil(textWidth('逐项对照',fonts.section))+12;
        matrix+=text(mx+mw,my-13,legend,'matrix-legend','end','data-matrix-legend');
        if(totalPages>1)matrix+=`<g class="matrix-pagination">${text(mx+mw/2,matrixBottom+24,`${start+1}–${start+rows.length} / ${pair.comparisons.length} 项`,'sheet-caption','middle')}<g role="button" tabindex="0" class="diagram-control" data-matrix-prev aria-label="上一组对照项">${rect(mx+mw/2-108,matrixBottom+7,32,25)}${text(mx+mw/2-92,matrixBottom+25,'←','sheet-caption','middle')}</g><g role="button" tabindex="0" class="diagram-control" data-matrix-next aria-label="下一组对照项">${rect(mx+mw/2+76,matrixBottom+7,32,25)}${text(mx+mw/2+92,matrixBottom+25,'→','sheet-caption','middle')}</g></g>`;
        const winner=pair.status==='needs_review'?'待核':pair.winnerIndex===null?(pair.outcome==='both_good'?'都好':'都差'):`${labels[pair.winnerIndex]} 胜`;
        const verdict=`${rect(vx,vy,vw,verdictHeight,'verdict-sheet')}<g data-reveal-control class="diagram-control" role="button" tabindex="0" aria-label="${revealed?'隐藏':'揭示'} A/B 模型身份" aria-pressed="${revealed}"><rect class="detail-hit" x="${vx+1}" y="${vy+1}" width="${vw-2}" height="68" rx="5"/>${text(vx+vw/2,vy+33,winner,'winner-label','middle','id="winnerLabel"')}${text(vx+vw/2,vy+59,revealed?'隐藏模型身份':'揭示模型身份','sheet-caption','middle')}</g><path class="matrix-rule" d="M${vx+12} ${vy+70}H${vx+vw-12}"/><g data-verdict-control class="diagram-control" role="button" tabindex="0" aria-label="查看完整裁决与取舍"><rect class="detail-hit" x="${vx+1}" y="${vy+72}" width="${vw-2}" height="${verdictHeight-73}" rx="5"/>${lines(vx+12,vy+93,reasonLines,'verdict-reason',17,'start',`data-verdict-reason data-truncated="${reasonPreview.truncated}"`)}${text(vx+vw-12,vy+verdictHeight-12,'完整点评 ↗','sheet-caption','end')}</g>`;
        const sourceX=xInput+inputWidth,laneMid=nodeHeight/2;
        const sourcePortX=xAnonymous+anonymousWidth+6,firstPortY=rowY[0]+laneMid,secondPortY=rowY[1]+laneMid;
        const mergeX=compact?W-7:(xAnonymous+anonymousWidth+mx)/2;
        const joinY=compact?secondPortY:comparisonCenterY;
        // Join both evidence lanes once, then enter the centred comparison block.
        const mergeInputs=compact?
          edge(`M${sourcePortX} ${firstPortY}H${mergeX-6}Q${mergeX} ${firstPortY} ${mergeX} ${firstPortY+6}V${joinY}`,'material',false,'data-merge-input="0"')+edge(`M${sourcePortX} ${secondPortY}H${mergeX}`,'material',false,'data-merge-input="1"'):
          edge(`M${sourcePortX} ${firstPortY}H${mergeX-6}Q${mergeX} ${firstPortY} ${mergeX} ${firstPortY+6}V${joinY}`,'material',false,'data-merge-input="0"')+edge(`M${sourcePortX} ${secondPortY}H${mergeX-6}Q${mergeX} ${secondPortY} ${mergeX} ${secondPortY-6}V${joinY}`,'material',false,'data-merge-input="1"');
        const turnY=flowBottom+14,tablePortX=mx+mw/2;
        const comparisonEntry=compact?
          `M${mergeX} ${joinY}V${turnY-6}Q${mergeX} ${turnY} ${mergeX-6} ${turnY}H${tablePortX+6}Q${tablePortX} ${turnY} ${tablePortX} ${turnY+6}V${my-8}`:
          `M${mergeX} ${comparisonCenterY}H${mx-8}`;
        const paths=`<g class="connections">${edge(`M${sourceX+7} ${top+topHeight/2}H${xStandard-8}`)}${edge(`M${xStandard+standardWidth/2} ${top+topHeight+5}V${rowY[0]-7}`,'reference')}${rowY.map(y=>edge(`M${sourceX+7} ${y+laneMid}H${xStandard-8}`)+edge(`M${xStandard+standardWidth+8} ${y+laneMid}H${xAnonymous-8}`)).join('')}<g data-flow-merge>${mergeInputs}<circle class="flow-junction" cx="${mergeX}" cy="${joinY}" r="2.25"/>${edge(comparisonEntry,'material',true,'data-comparison-entry')}</g>${edge(`M${mx+mw+8} ${comparisonCenterY}H${vx-8}`,'material',true,'data-verdict-entry')}</g>`;
        let problemsContent=text(10,postY,'问题归因','attribution-heading');
        let py=postY+27;
        order.forEach(index=>{
          const list=problemLines[index];
          problemsContent+=`<g data-problem-group="${index}">`;
          problemsContent+=text(10,py,labels[index],'attribution-identity','start',`data-candidate-identity="${index}"`);
          if(revealed)problemsContent+=text(39,py,`${pair.candidates[index].displayName} · ${pair.candidates[index].model||pair.candidates[index].version}`,'attribution-component');
          else problemsContent+=text(39,py,`${problems[index].length} 项问题`,'sheet-caption');
          py+=22;
          if(!list.length){problemsContent+=text(39,py,'未记录问题','attribution-empty');py+=22;}
          for(const {finding,wrapped} of list){problemsContent+=lines(39,py,wrapped,'attribution-text',18,'start',`data-problem-finding="${safe(finding.finding_id)}" data-problem-candidate="${index}"`);py+=wrapped.length*18+5;}
          py+=7;problemsContent+='</g>';
        });
        scene.innerHTML=`<g class="stage-headings">${text(xInput,28,'输入与回答','diagram-heading')}${text(xStandard,28,'独立查证','diagram-heading')}${text(xAnonymous,28,revealed?'模型':'匿名','diagram-heading')}</g>${paths}<g id="source-materials">${question}${answers}</g><g id="shared-rubric-and-attribution"><g class="diagram-control" role="button" tabindex="0" data-agent-role="criteria" data-checklist-control aria-label="查看完整验收清单">${checklist}</g>${attributionFrame}${attribution}</g><g id="identity-mapping">${swap}${anon}</g><g data-agent-role="comparison">${agentTitle(mx,my-13,'对比 Agent')}${text(comparisonHeadingX,my-13,'逐项对照','diagram-heading')}<g class="diagram-control" role="button" tabindex="0" data-comparison-control aria-label="查看逐项对照原文">${text(originalLinkX,my-13,'原文 ↗','sheet-caption')}</g>${text(vx,vy-14,'裁决与取舍','verdict-heading')}<g id="comparison-grid">${matrix}</g><g id="formal-outcomes">${verdict}</g></g><path d="M10 ${postY-19}H${W-10}" class="panel-rule"/><g id="problem-attribution">${problemsContent}</g>`;
      }
      function selectCase(index,focus=false){
        if(destroyed||!Number.isInteger(index)||index<0||index>=cases.length)return;
        current=index;pairIndex=0;matrixPage=0;swapped=false;revealed=false;drawCase();
        if(focus)container.querySelector('[data-case-select]').focus({preventScroll:true});
        window.ReportMotion.reveal(container.querySelector('#active-case'),{distance:2,duration:150});
      }
      function click(event){
        const target=event.target.closest('[data-input-control],[data-verdict-control],[data-answer-format],[data-comparison-control],[data-answer-card],[data-check-card],[data-checklist-control],[data-swap-control],[data-reveal-control],[data-case-prev],[data-case-next],[data-matrix-prev],[data-matrix-next],[data-detail-close],[data-answer-switch]');
        if(!target)return;
        if(target.hasAttribute('data-input-control'))return openDetail('input',0,target);
        if(target.hasAttribute('data-verdict-control'))return openDetail('verdict',0,target);
        if(target.hasAttribute('data-answer-format')){const raw=container.querySelector('[data-full-answer]');raw.hidden=!raw.hidden;container.querySelector('[data-answer-reading]').hidden=!raw.hidden;target.setAttribute('aria-pressed',String(!raw.hidden));return;}
        if(target.hasAttribute('data-detail-close'))return closeDetail();
        if(target.hasAttribute('data-comparison-control'))return openDetail('comparison',0,target);
        if(target.hasAttribute('data-answer-switch'))return openDetail('answer',Number(target.dataset.answerSwitch));
        if(target.hasAttribute('data-answer-card'))return openDetail('answer',Number(target.dataset.answerCard),target);
        if(target.hasAttribute('data-check-card'))return openDetail('check',Number(target.dataset.checkCard),target);
        if(target.hasAttribute('data-checklist-control'))return openDetail('criteria',0,target);
        if(target.hasAttribute('data-case-prev')||target.hasAttribute('data-case-next'))return selectCase((current+(target.hasAttribute('data-case-prev')?-1:1)+cases.length)%cases.length,true);
        if(target.hasAttribute('data-swap-control'))swapped=!swapped;
        if(target.hasAttribute('data-reveal-control'))revealed=!revealed;
        if(target.hasAttribute('data-matrix-prev')||target.hasAttribute('data-matrix-next')){const pages=Math.max(1,Math.ceil(item().comparisons.length/5));matrixPage=(matrixPage+(target.hasAttribute('data-matrix-prev')?-1:1)+pages)%pages;}
        const selector=target.hasAttribute('data-swap-control')?'[data-swap-control]':target.hasAttribute('data-reveal-control')?'[data-reveal-control]':target.hasAttribute('data-matrix-next')?'[data-matrix-next]':'[data-matrix-prev]';
        drawCase();container.querySelector(selector)?.focus({preventScroll:true});
      }
      function change(event){if(event.target.matches('[data-case-select]'))selectCase(Number(event.target.value),true);if(event.target.matches('[data-pair-select]')){pairIndex=Number(event.target.value);matrixPage=0;swapped=false;revealed=false;drawCase();container.querySelector('[data-pair-select]').focus();}}
      function keydown(event){
        if(event.key==='Escape'){closeDetail();return;}
        if(event.target.matches('[role="button"]')&&['Enter',' '].includes(event.key)){event.preventDefault();click(event);return;}
        if(!event.target.closest('.case-navigation')||event.target.matches('select'))return;
        if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
        event.preventDefault();selectCase(event.key==='Home'?0:event.key==='End'?cases.length-1:(current+(event.key==='ArrowRight'?1:-1)+cases.length)%cases.length,true);
      }
      function resize(){if(!destroyed&&(window.innerWidth<=1080)!==compact)drawCase();}
      container.addEventListener('click',click);container.addEventListener('change',change);container.addEventListener('keydown',keydown);window.addEventListener('resize',resize);window.addEventListener('report-page-change',closeDetail);
      drawCase();
      const controller={selectCase,destroy(){if(destroyed)return;destroyed=true;container.removeEventListener('click',click);container.removeEventListener('change',change);container.removeEventListener('keydown',keydown);window.removeEventListener('resize',resize);window.removeEventListener('report-page-change',closeDetail);if(mounted.get(container)===controller)mounted.delete(container);}};
      mounted.set(container,controller);return controller;
    },
  };
})();
