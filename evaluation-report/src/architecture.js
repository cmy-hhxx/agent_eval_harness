(() => {
  'use strict';
  const agents = [
    { id:'criteria', title:'标准 Agent', input:'只看题目和参考答案', action:'列出这题要完成的要求', output:'验收清单', side:'top' },
    { id:'attribution', title:'归因 Agent × 2', input:'各看一份回答和相关资料', action:'核对回答、找证据、定位问题', output:'核验结果与问题清单', side:'top' },
    { id:'comparison', title:'对比 Agent', input:'匿名回答 + 两份核验结果', action:'说清两边差在哪、结论是什么', output:'逐项点评与裁决理由', side:'top' },
    { id:'verification', title:'独立核验（可选）', input:'按需重查原始资料', action:'先自己查，再对照原评价', output:'另记疑点，保留原判', side:'bottom' },
    { id:'clustering', title:'问题归类 Agent', input:'汇总每个模型的问题', action:'把相同问题归到一类', output:'各模型的问题库', side:'bottom' },
    { id:'rewrite', title:'文案改写 Agent', input:'已有评语', action:'把评语写得简短好懂', output:'事实和结论不变', side:'bottom' },
  ];
  window.ReportArchitecture = {
    render(container,report) {
      const counts=report.cases.flatMap(item=>item.pairs);
      const card=agent=>`<article class="agent-role" data-agent-role="${agent.id}"><h2>${agent.title}</h2><p class="agent-input">${agent.input}</p><p class="agent-action">${agent.action}</p><p class="agent-output">${agent.output}</p></article>`;
      container.innerHTML=`<div class="architecture-counts"><span><b>${report.cases.length}</b> 个案例</span><span><b>${counts.length}</b> 场对局</span><span><b>${counts.filter(item=>item.status==='decided').length}</b> 正式判决</span><span><b>${counts.filter(item=>item.status==='needs_review').length}</b> 待核</span></div>
        <div class="agent-system"><div class="agent-row agent-row-main">${agents.filter(agent=>agent.side==='top').map(card).join('')}</div>
        <div class="host-lane"><div class="host-coordinator"><h2>任务协调</h2><p>分派任务、传递结果，能同时做的就一起做</p><div class="host-artifacts">验收清单 <span>／</span> 核验结果 <span>／</span> 判决与证据</div></div></div>
        <div class="agent-row agent-row-support">${agents.filter(agent=>agent.side==='bottom').map(card).join('')}</div></div>
        <div class="architecture-boundaries"><p><b>关键问题没查齐，就先补查</b>比较前，双方最多各补查一轮。</p><p><b>分开检查，也可能一起看错</b>默认使用同一裁判模型，还要用实验和人工复核。</p></div>`;
    },
  };
})();
