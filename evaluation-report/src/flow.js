(() => {
  'use strict';
  const safe = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const text = (x, y, value, cls = 'diagram-text', anchor = 'start', attrs = '') => `<text x="${x}" y="${y}" class="${cls}" text-anchor="${anchor}" ${attrs}>${safe(value)}</text>`;
  const rect = (x, y, width, height, cls = 'material-sheet', radius = 7) => `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" class="${cls}"/>`;
  const edge = (d, kind = 'material', arrow = true) => `<path d="${d}" class="diagram-edge ${kind}-edge"${kind === 'material' ? ' pathLength="1"' : ''}${arrow ? ` marker-end="url(#${kind}-arrow)"` : ''}/>`;
  const heading = (x, title) => text(x, 28, title, 'diagram-heading');
  const identity = (x, y, label) => `${rect(x,y,28,28,'identity-badge',5)}${text(x+14,y+20,label,'identity-label','middle')}`;
  const regions = [
    {id:'source-materials', label:'题目与两份回答', bounds:[12,40,225,373], related:['shared-rubric-and-attribution']},
    {id:'shared-rubric-and-attribution', label:'共同标准与两路查证', bounds:[270,40,289,390], related:['source-materials','identity-mapping','paired-comparison']},
    {id:'identity-mapping', label:'交换匿名 A/B 映射', bounds:[590,180,152,234], related:['shared-rubric-and-attribution','paired-comparison','formal-outcomes'], action:'swap'},
    {id:'paired-comparison', label:'真实案例逐项对照', bounds:[772,188,302,222], related:['identity-mapping','formal-outcomes','shared-rubric-and-attribution']},
    {id:'formal-outcomes', label:'真实案例正式判决', bounds:[1110,216,160,141], related:['paired-comparison','bounded-review','identity-mapping']},
    {id:'bounded-review', label:'未决时的独立复核', bounds:[744,415,526,98], related:['paired-comparison','formal-outcomes']},
    {id:'problem-clustering', label:'问题归类与知识库', bounds:[12,532,604,88], related:[]},
    {id:'text-only-rewrite', label:'评语润色与判决保留', bounds:[654,532,616,88], related:[]},
  ];

  const mounted = new WeakMap();
  window.ReportFlow = {
    render(container, report) {
      mounted.get(container)?.destroy();
      const limit = report.limits;
      const example = report.mechanismCase;
      const candidateRows = [206, 322];
      const compact = window.innerWidth <= 760;
      container.innerHTML = `<figure class="research-figure interactive-figure">
      <div class="diagram-controls"><button class="button" data-reset-diagram type="button" hidden>返回总览</button></div><p class="visually-hidden" data-diagram-status role="status"></p>
      <svg id="evaluationMechanism" viewBox="0 0 1280 620" role="group" aria-labelledby="mechanismTitle mechanismDescription" xmlns="http://www.w3.org/2000/svg">
        <title id="mechanismTitle">${safe(example.title)}的评测机制</title>
        <desc id="mechanismDescription">${safe(example.question)} 标准答案${safe(example.reference)}。真实运行${safe(example.provenance.run_id)}，本条评测器${safe(example.provenance.evaluator_version_for_this_case)}。回答①主结论+1.25，回答②按区间中值近似给出−0.60。原始匿名映射B对应回答①，A对应回答②，正式判决A胜，即回答②胜。页面换位只改变代号，不表示再次调用裁判。复核是通用条件路径；本次未启用聚类和改写。</desc>
        <defs>
          ${window.ReportIcons.symbols()}
          ${['material','reference','review'].map(kind=>`<marker id="${kind}-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="10" markerHeight="10" orient="auto" markerUnits="userSpaceOnUse"><path d="M1 1L9 5L1 9Z" class="${kind}-arrow-fill"/></marker>`).join('')}
        </defs>
        <g id="mechanismScene">
          <g class="stage-headings">${heading(18,'输入')}${heading(278,'标准与核验')}${heading(598,'匿名')}${heading(780,'逐项对照')}${heading(1120,'判决')}</g>

          <g class="connections" data-owner="shared-rubric-and-attribution">
            ${edge('M236 111H270')}
            ${edge('M236 247H270')}${edge('M236 363H270')}
            ${edge('M414 174V180Q414 188 406 188H258Q250 188 250 196V363','reference',false)}<circle cx="250" cy="247" r="3.5" class="reference-arrow-fill"/><circle cx="250" cy="363" r="3.5" class="reference-arrow-fill"/>
          </g>
          <g class="connections" data-owner="identity-mapping">${edge('M558 247H590')}${edge('M558 363H590')}</g>
          <g class="connections" data-owner="paired-comparison">
            ${text(923,173,'共同标准','reference-label','middle')}${edge('M923 181V198','reference')}
            ${edge('M740 247H748Q756 247 756 255V304','material',false)}${edge('M740 363H748Q756 363 756 355V304','material',false)}
            <circle cx="756" cy="304" r="3" class="junction"/>${edge('M756 304H772')}
          </g>
          <g class="connections" data-owner="formal-outcomes">${edge('M1074 304H1112')}</g>

          <g id="source-materials">
            ${rect(18,58,210,108)}${example.questionLines.map((line,i)=>text(34,86+i*30,line,i===0?'case-name':'case-question')).join('')}
            ${example.candidates.map((candidate,i)=>`${rect(18,candidateRows[i],210,82)}${text(34,candidateRows[i]+22,candidate.source,'sheet-caption')}${text(210,candidateRows[i]+30,candidate.result,'answer-number','end')}${text(34,candidateRows[i]+64,candidate.formula,'answer-formula')}`).join('')}
          </g>

          <g id="shared-rubric-and-attribution">
            ${rect(278,58,272,108,'criteria-sheet')}${text(294,82,'共同标准','sheet-caption')}${text(534,82,`${example.sharedCriteriaCount} 条`,'sheet-caption','end')}
            ${example.criteria.map((rule,i)=>`${text(295,115+i*29,String(i+1),'criterion-index')}${text(322,115+i*29,rule,'criterion-text')}`).join('')}
            ${example.candidates.map((candidate,i)=>`<g class="evidence-sheet" data-source-candidate="${i}"><title>${safe(example.provenance.lanes[i].attribution.complete_result.file)}:${example.provenance.lanes[i].attribution.complete_result.jsonl_line_1_based}；回答证据 messages[${candidate.messageIndex}]</title>${rect(278,candidateRows[i],272,82)}${text(294,candidateRows[i]+22,`核验${i===0?'①':'②'}`,'sheet-caption')}${text(534,candidateRows[i]+22,candidate.usable?'核心可用':'核心不可用',candidate.usable?'usable-caption':'issue-caption','end')}${text(294,candidateRows[i]+49,candidate.check,candidate.usable?'check-text':'issue-text')}${text(294,candidateRows[i]+72,candidate.finding,candidate.usable?'evidence-text':'issue-evidence')}</g>`).join('')}
            ${text(414,428,'单位：百分点','diagram-limit','middle')}

          </g>

          <g id="identity-mapping">
            ${rect(658,3,74,31,'swap-control',5)}${window.ReportIcons.draw('shuffle',665,8,20,20,'swap-icon')}${text(710,25,'换位','swap-label','middle')}
            ${example.candidates.map((candidate,i)=>`<g class="anonymous-packet" data-source-candidate="${i}">${rect(598,candidateRows[i],134,82,'anonymous-sheet')}${identity(610,candidateRows[i]+12,example.initialLabels[i])}${text(717,candidateRows[i]+31,`证据${i===0?'①':'②'}`,'packet-source','end')}${text(665,candidateRows[i]+65,candidate.result,'packet-number','middle')}</g>`).join('')}
          </g>

          <g id="paired-comparison">
            <g id="comparison-grid" transform="translate(780 206)">
              ${rect(0,0,286,196,'comparison-matrix')}
              <path d="M0 40H286M0 92H286M0 144H286M64 0V196M175 0V196" class="matrix-rule"/>
              ${text(32,27,'项','matrix-header','middle')}${text(119,27,example.initialLabels[0],'matrix-header','middle')}${text(230,27,example.initialLabels[1],'matrix-header','middle')}
              ${[['口径','basis'],['答案','result'],['核心','usable']].map(([name,key],row)=>`<g class="matrix-row" data-matrix-row="${row}">${rect(1,41+row*52,284,50,'matrix-row-hit',0)}${text(32,74+row*52,name,'matrix-row-label','middle')}${example.candidates.map((candidate,col)=>text(119+col*111,74+row*52,key==='usable'?(candidate.usable?'可用':'不可用'):candidate[key],`${key==='basis'?'matrix-basis':key==='result'?'matrix-value':'matrix-core'}${!candidate.usable && key!=='result'?' is-issue':''}`,'middle')).join('')}</g>`).join('')}
            </g>
          </g>

          <g id="formal-outcomes">
            ${text(1190,210,'原判结果','sheet-caption','middle')}
            ${rect(1120,230,140,120,'verdict-sheet')}
            ${text(1190,282,`${example.initialLabels[example.winnerIndex]} 胜`,'winner-label','middle','id="winnerLabel"')}${text(1190,326,example.candidates[example.winnerIndex].source,'winner-source','middle','id="sourceWinner"')}
            ${text(1190,389,'另有 都好 / 都差','other-outcomes','middle')}
          </g>

          <g class="connections" data-owner="bounded-review">
            ${edge('M820 410V442','review')}
            ${edge('M902 478H928','review')}
            ${edge('M1074 478H1100','review',false)}<circle cx="1100" cy="478" r="3" class="review-junction"/>
            ${edge('M1100 478V373Q1100 365 1108 365H1182Q1190 365 1190 357V350','review')}
            ${edge('M1100 478H1112','review')}
          </g>
          <g id="bounded-review">
            ${text(835,433,'待复核','review-label')}
            ${rect(754,450,140,56,'review-operation')}${text(824,485,`复核 ≤${limit.reviewRounds} 轮`,'review-text','middle')}
            ${rect(936,450,130,56,'review-operation')}${text(1001,485,'再次对照','review-text','middle')}
            ${text(1088,435,'可裁决','review-label','end')}${text(1190,440,'仍未决','review-label','middle')}${rect(1120,450,140,56,'stop-sheet')}${text(1190,485,'不交付','review-text','middle')}
          </g>

          <path d="M18 526H1260M636 543V613" class="panel-rule"/>
          <g class="connections" data-owner="problem-clustering">${edge('M209 586H239')}${edge('M442 586H472')}</g>
          <g id="problem-clustering">
            ${text(18,552,'问题归类','branch-heading')}${text(610,552,'本次未启用','diagram-limit','end')}
            ${rect(18,566,183,47,'finding-slip')}${text(109,596,'归因发现','branch-text','middle')}
            ${rect(247,566,187,47,'class-sheet')}${text(340,579,'同组件','class-component','middle')}${text(340,606,'归类 / 新建类','class-name','middle')}
            ${rect(480,566,130,47,'library-sheet')}${text(545,584,'问题库','class-component','middle')}${text(545,606,`≤${limit.classesPerModel}/模型`,'class-name','middle')}
          </g>
          <g class="connections" data-owner="text-only-rewrite">${edge('M863 589H890')}</g>
          <g id="text-only-rewrite">
            ${text(662,552,'评语润色','branch-heading')}${text(1260,552,'本次未启用','diagram-limit','end')}
            ${rect(662,566,193,47,'finding-slip')}${text(758,596,'已接受文本','branch-text','middle')}
            ${rect(898,566,362,47,'rewrite-sheet')}${text(1079,596,'只改措辞 · 判决不变','branch-text','middle')}
          </g>
        </g>
      </svg></figure>`;
      const root = container.querySelector('.research-figure');
      for (const region of regions) {
        const group = root.querySelector(`#${region.id}`);
        group.dataset.region = region.id;
        group.classList.add('interaction-region');
        if (region.action) group.dataset.action = region.action;
        const [x,y,width,height] = region.bounds;
        group.insertAdjacentHTML('afterbegin', `<rect class="region-hit" role="button" tabindex="0" aria-label="${safe(region.action === 'swap' ? region.label : `放大${region.label}`)}" aria-pressed="false" x="${x}" y="${y}" width="${width}" height="${height}" rx="8"/>`);
      }
      let visibleRegions = regions;
      if (compact) {
        root.classList.add('compact-figure');
        root.querySelector('svg').setAttribute('viewBox', '0 0 960 920');
        const transforms = {
          'source-materials': [90,0,1], 'shared-rubric-and-attribution': [90,0,1], 'identity-mapping': [90,0,1],
          'paired-comparison': [-502,290,1], 'formal-outcomes': [-432,290,1], 'bounded-review': [-422,294,1],
          'problem-clustering': [6,452,.74], 'text-only-rewrite': [6,452,.74],
        };
        visibleRegions = regions.map(region => {
          const [dx,dy,scale] = transforms[region.id];
          root.querySelector(`#${region.id}`).setAttribute('transform', `translate(${dx} ${dy}) scale(${scale})`);
          const [x,y,w,h] = region.bounds;
          return {...region, bounds:[x*scale+dx,y*scale+dy,w*scale,h*scale]};
        });
        const scene = root.querySelector('#mechanismScene');
        root.querySelector('.stage-headings').innerHTML = `${heading(108,'输入')}${heading(368,'标准与核验')}${heading(688,'匿名')}${text(278,478,'逐项对照','diagram-heading')}${text(688,478,'判决','diagram-heading')}`;
        root.querySelector('.other-outcomes').setAttribute('y', '412');
        root.querySelectorAll('.connections').forEach(node=>node.remove());
        root.querySelector('.panel-rule').setAttribute('transform', 'translate(6 452) scale(.74)');
        scene.insertAdjacentHTML('afterbegin', `
          <g class="connections" data-owner="shared-rubric-and-attribution" transform="translate(90 0)">
            ${edge('M236 111H270')}${edge('M236 247H270')}${edge('M236 363H270')}
            ${edge('M414 174V180Q414 188 406 188H258Q250 188 250 196V363','reference',false)}<circle cx="250" cy="247" r="3.5" class="reference-arrow-fill"/><circle cx="250" cy="363" r="3.5" class="reference-arrow-fill"/>
          </g>
          <g class="connections" data-owner="identity-mapping" transform="translate(90 0)">${edge('M558 247H590')}${edge('M558 363H590')}</g>
          <g class="connections" data-owner="paired-comparison">
            ${text(520,471,'共同标准','reference-label','middle')}${edge('M520 481V488','reference')}
            ${edge('M830 247H842Q852 247 852 257V363','material',false)}${edge('M830 363H852','material',false)}
            <circle cx="852" cy="363" r="3" class="junction"/>
            ${edge('M852 363V428Q852 438 842 438H240Q228 438 228 450V582Q228 594 240 594H270')}
          </g>
          <g class="connections" data-owner="formal-outcomes">${edge('M572 594H680')}</g>
          <g class="connections" data-owner="bounded-review">
            ${edge('M402 700V736','review')}${edge('M480 772H506','review')}${edge('M652 772H678','review',false)}
            <circle cx="678" cy="772" r="3" class="review-junction"/>
            ${edge('M678 772V670Q678 662 686 662H750Q758 662 758 654V640','review')}${edge('M678 772H690','review')}
          </g>
          <g class="connections" data-owner="problem-clustering" transform="translate(6 452) scale(.74)">${edge('M209 586H239')}${edge('M442 586H472')}</g>
          <g class="connections" data-owner="text-only-rewrite" transform="translate(6 452) scale(.74)">${edge('M863 589H890')}</g>`);
      }
      let swapped = false;
      const interaction = window.ReportDiagram.mount(root, { regions: visibleRegions, onSwap() {
        swapped = !swapped;
        const mapping = swapped ? [...example.initialLabels].reverse() : example.initialLabels;
        root.querySelectorAll('#identity-mapping .identity-label').forEach((element,index) => { element.textContent = mapping[index]; window.ReportMotion.reveal(element, {distance:2,duration:160}); });
        [...root.querySelectorAll('#comparison-grid .matrix-header')].slice(1).forEach((element,index) => { element.textContent = mapping[index]; });
        root.querySelector('#winnerLabel').textContent = `${mapping[example.winnerIndex]} 胜`;
        root.querySelector('[data-region="identity-mapping"] .region-hit').setAttribute('aria-pressed', String(swapped));
        root.querySelectorAll('[data-owner="identity-mapping"] .material-edge').forEach(path=>window.ReportMotion.trace(path));
      }});
      const resize = () => {
        if ((window.innerWidth <= 760) !== compact) window.ReportFlow.render(container, report);
      };
      window.addEventListener('resize', resize);
      const controller = {...interaction, destroy() {
        window.removeEventListener('resize', resize);
        interaction.destroy();
      }};
      mounted.set(container, controller);
      return controller;
    },
  };
})();
