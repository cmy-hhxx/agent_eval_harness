(() => {
  'use strict';
  const instances = new WeakMap();
  const routes = ['core-win', 'both-bad', 'quality-win', 'both-good'];
  const all = [...routes, 'unresolved'];
  const safe = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const joins = ids => ids.join(' ');

  window.ReportRules = {
    render(container, report) {
      instances.get(container)?.destroy();
      const rounds = report.limits.reviewRounds;
      container.innerHTML = `<div class="rules-tree" role="group" aria-label="从判决依据到正式结果的决策树">
        <svg class="rules-connectors" aria-hidden="true"><defs>
          <marker id="rules-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto" markerUnits="userSpaceOnUse"><path d="M1 1L9 5L1 9Z"/></marker>
          <marker id="rules-review-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto" markerUnits="userSpaceOnUse"><path d="M1 1L9 5L1 9Z"/></marker>
        </defs><g data-rule-lines></g></svg>
        <div class="rules-question rules-evidence" data-rule-node="evidence" data-rule-routes="${joins(all)}">判决依据明确？</div>
        <div class="rules-question rules-review" data-rule-node="review" data-rule-routes="unresolved"><span>独立复核</span><span class="rules-round"><span>≤${safe(rounds)} 轮</span><span>再次比较</span></span></div>
        <div class="rules-question rules-core" data-rule-node="core" data-rule-routes="${joins(routes)}">核心交付是否可用？</div>
        <button class="rules-result rules-unresolved" type="button" data-rule-node="unresolved" data-rule-routes="unresolved" data-rule-result="unresolved" aria-pressed="false">不交付</button>
        <div class="rules-state rules-single" data-rule-node="single" data-rule-routes="core-win">仅一方可用</div>
        <div class="rules-state rules-neither" data-rule-node="neither" data-rule-routes="both-bad">双方不可用</div>
        <div class="rules-question rules-difference" data-rule-node="difference" data-rule-routes="quality-win both-good"><span class="rules-state-title">双方可用</span><span>有实质差距？</span></div>
        <button class="rules-result rules-core-win" type="button" data-rule-node="core-win" data-rule-routes="core-win" data-rule-result="core-win" aria-pressed="false">可用者胜</button>
        <button class="rules-result rules-both-bad" type="button" data-rule-node="both-bad" data-rule-routes="both-bad" data-rule-result="both-bad" aria-pressed="false">都差</button>
        <button class="rules-result rules-quality-win" type="button" data-rule-node="quality-win" data-rule-routes="quality-win" data-rule-result="quality-win" aria-pressed="false">优势者胜</button>
        <button class="rules-result rules-both-good" type="button" data-rule-node="both-good" data-rule-routes="both-good" data-rule-result="both-good" aria-pressed="false">都好</button>
        <p class="visually-hidden" data-rules-status role="status"></p>
      </div>`;
      const root = container.querySelector('.rules-tree');
      const svg = root.querySelector('.rules-connectors');
      const layer = root.querySelector('[data-rule-lines]');
      const status = root.querySelector('[data-rules-status]');
      const nodes = new Map([...root.querySelectorAll('[data-rule-node]')].map(node => [node.dataset.ruleNode, node]));
      const buttons = [...root.querySelectorAll('[data-rule-result]')];
      let selected = null, hovering = null, focused = null, frame = 0, destroyed = false;
      const removers = [];
      function listen(target, name, fn) { target.addEventListener(name, fn); removers.push(() => target.removeEventListener(name, fn)); }
      function highlight() {
        const active = hovering || focused || selected;
        root.classList.toggle('has-rule-path', Boolean(active));
        for (const element of root.querySelectorAll('[data-rule-routes]')) {
          const included = active && element.dataset.ruleRoutes.split(' ').includes(active);
          element.classList.toggle('on-rule-path', Boolean(included));
        }
        buttons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.ruleResult === selected)));
      }
      function draw() {
        frame = 0;
        const box = root.getBoundingClientRect();
        if (!box.width || !box.height) return;
        svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
        const positions = new Map([...nodes].map(([id, node]) => {
          const b = node.getBoundingClientRect();
          return [id, { left:b.left-box.left, right:b.right-box.left, top:b.top-box.top, bottom:b.bottom-box.top, x:b.left-box.left+b.width/2, y:b.top-box.top+b.height/2, width:b.width }];
        }));
        const p = id => positions.get(id);
        const path = (d, ids, review=false) => `<path d="${d}" class="rules-edge${review?' is-review':''}" data-rule-routes="${joins(ids)}" marker-end="url(#rules-${review?'review-':''}arrow)"/>`;
        const label = (x,y,value,ids,review=false,anchor='middle') => `<text x="${x}" y="${y}" text-anchor="${anchor}" class="rules-edge-label${review?' is-review':''}" data-rule-routes="${joins(ids)}">${safe(value)}</text>`;
        const e=p('evidence'), r=p('review'), c=p('core'), u=p('unresolved'), one=p('single'), none=p('neither'), diff=p('difference');
        const lines = [];
        // Aligned main nodes give the direct path one uninterrupted vertical arrow.
        // Review uses a separate return lane and a second top port on the core box.
        lines.push(path(`M${e.right} ${e.y}H${r.left-3}`, ['unresolved'], true));
        lines.push(label((e.right+r.left)/2,e.y-10,'否',['unresolved'],true));
        const rightPort = c.x+c.width*.28;
        const firstBranchY=e.bottom+(c.top-e.bottom)*.46;
        lines.push(path(`M${e.x} ${e.bottom}V${c.top-3}`, routes));
        lines.push(label(e.x-12,(e.bottom+c.top)/2+5,'是',routes,false,'end'));
        const reviewPort = r.left+r.width*.24;
        lines.push(path(`M${reviewPort} ${r.bottom}V${firstBranchY}H${rightPort}V${c.top-3}`,[],true));
        lines.push(label((reviewPort+rightPort)/2,firstBranchY-9,'可判决',[],true));
        lines.push(path(`M${r.x} ${r.bottom}V${u.top-3}`,['unresolved'],true));
        lines.push(label(u.x-10,firstBranchY+(u.top-firstBranchY)/2+5,'仍未决',['unresolved'],true,'end'));
        // Three core states share one explicit branch, without crossing the review path.
        const forkY=c.bottom+(one.top-c.bottom)*.50;
        lines.push(`<path d="M${c.x} ${c.bottom}V${forkY}" class="rules-edge" data-rule-routes="${joins(routes)}"/>`);
        lines.push(`<circle cx="${c.x}" cy="${forkY}" r="2.5" class="rules-junction" data-rule-routes="${joins(routes)}"/>`);
        for (const [target, ids] of [[one,['core-win']],[none,['both-bad']],[diff,['quality-win','both-good']]]) {
          const across=Math.abs(target.x-c.x)<.5?'':`H${target.x}`;
          lines.push(path(`M${c.x} ${forkY}${across}V${target.top-3}`,ids));
        }
        for (const [source, target, ids] of [[one,p('core-win'),['core-win']],[none,p('both-bad'),['both-bad']]]) {
          lines.push(path(`M${source.x} ${source.bottom}V${target.top-3}`,ids));
        }
        const win=p('quality-win'), good=p('both-good'), decisionY=diff.bottom+(win.top-diff.bottom)*.5;
        lines.push(`<path d="M${diff.x} ${diff.bottom}V${decisionY}" class="rules-edge" data-rule-routes="quality-win both-good"/>`);
        lines.push(`<circle cx="${diff.x}" cy="${decisionY}" r="2.5" class="rules-junction" data-rule-routes="quality-win both-good"/>`);
        lines.push(path(`M${diff.x} ${decisionY}H${win.x}V${win.top-3}`,['quality-win']));
        lines.push(path(`M${diff.x} ${decisionY}H${good.x}V${good.top-3}`,['both-good']));
        lines.push(label((diff.x+win.x)/2,decisionY-9,'有',['quality-win']));
        lines.push(label((diff.x+good.x)/2,decisionY-9,'无',['both-good']));
        layer.innerHTML=lines.join('');
        highlight();
      }
      function scheduleDraw() { if (!destroyed && !frame) frame=requestAnimationFrame(draw); }
      for (const button of buttons) {
        listen(button,'mouseenter',()=>{hovering=button.dataset.ruleResult;highlight();});
        listen(button,'mouseleave',()=>{hovering=null;highlight();});
        listen(button,'focus',()=>{focused=button.dataset.ruleResult;highlight();});
        listen(button,'blur',()=>{focused=null;highlight();});
        listen(button,'click',()=>{
          selected=selected===button.dataset.ruleResult?null:button.dataset.ruleResult;
          status.textContent=selected?`已突出“${button.textContent}”的判决路径`:'已恢复全部判决路径';
          highlight();
        });
      }
      listen(root,'keydown',event=>{
        if(event.key==='Escape'){selected=null;hovering=null;focused=null;highlight();status.textContent='已恢复全部判决路径';}
      });
      listen(window,'resize',scheduleDraw);
      listen(window,'report-page-change',scheduleDraw);
      listen(window,'beforeprint',()=>{root.classList.add('is-printing');draw();});
      listen(window,'afterprint',()=>{root.classList.remove('is-printing');scheduleDraw();});
      const observer=typeof ResizeObserver==='function'?new ResizeObserver(scheduleDraw):null;
      observer?.observe(root);
      scheduleDraw();
      const controller={destroy(){if(destroyed)return;destroyed=true;observer?.disconnect();if(frame)cancelAnimationFrame(frame);removers.forEach(remove=>remove());if(instances.get(container)===controller)instances.delete(container);}};
      instances.set(container,controller);
      return controller;
    }
  };
})();
