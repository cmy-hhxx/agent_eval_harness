(() => {
  'use strict';
  const escape = value => String(value).replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
  const {workflows, repositories} = window.ReportResearchFlows;
  const nodeWidth = 224, nodeHeight = 88, columnStep = 288, rowStep = 144;

  function geometry(graph) {
    const nodes = graph.nodes.map(node => ({...node, x:32 + node.column * columnStep, y:20 + node.row * rowStep}));
    const leftChannel = Math.min(...nodes.map(node => node.x)) - 24;
    const rightChannel = Math.max(...nodes.map(node => node.x + nodeWidth)) + 24;
    const gapCenter = 20 + nodeHeight + (rowStep - nodeHeight) / 2;
    const edges = graph.edges.map(edge => {
      const from = nodes.find(node => node.id === edge.from), to = nodes.find(node => node.id === edge.to);
      const fx = from.x + nodeWidth / 2, fy = from.y + nodeHeight / 2, tx = to.x + nodeWidth / 2, ty = to.y + nodeHeight / 2;
      let points, labelPosition, alternatives = [];
      if (['left','right','center-left'].includes(edge.route)) {
        const right = edge.route === 'right', channel = right ? rightChannel : edge.route === 'center-left' ? columnStep : leftChannel;
        const start = right ? from.x + nodeWidth : from.x, end = right ? to.x + nodeWidth : to.x;
        points = [[start,fy],[channel,fy],[channel,ty],[end,ty]];
        const labelY = Math.round(((fy + ty) / 2 - gapCenter) / rowStep) * rowStep + gapCenter + 5;
        const labelOnLeft = right || edge.route === 'center-left';
        labelPosition = [channel + (labelOnLeft ? -12 : 12),labelY,labelOnLeft ? 'end' : 'start'];
        for (let row = Math.min(from.row,to.row) + 1; row <= Math.max(from.row,to.row); row++) {
          alternatives.push([labelPosition[0],(row - 1) * rowStep + gapCenter + 5,labelPosition[2]]);
        }
        if (edge.route === 'left') alternatives.push(...[labelPosition,...alternatives].map(position => [channel - 12,position[1],'end']));
      } else if (fy === ty) {
        const right = tx > fx, y = fy + edge.offset;
        const start = right ? from.x + nodeWidth : from.x, end = right ? to.x : to.x + nodeWidth;
        points = [[start,y],[end,y]];
        labelPosition = [(start + end) / 2,y + (edge.offset > 0 ? 20 : -10),'middle'];
      } else if (fx === tx) {
        points = [[fx,from.y + nodeHeight],[tx,to.y]];
        labelPosition = [fx + 12,(from.y + nodeHeight + to.y) / 2 + 5,'start'];
        alternatives = [[fx - 12,labelPosition[1],'end']];
      } else {
        const right = tx > fx, start = fx + (right ? 40 : -40), end = tx + (right ? -40 : 40);
        const middle = (from.y + nodeHeight + to.y) / 2;
        points = [[start,from.y + nodeHeight],[start,middle],[end,middle],[end,to.y]];
        labelPosition = [(start + end) / 2,middle - 10,'middle'];
        alternatives = [0.75,0.25].map(ratio => [start + (end - start) * ratio,middle - 10,'middle']);
      }
      return {...edge, points, labelPosition, alternatives};
    });
    const occupied = nodes.map(node => ({x:node.x,y:node.y,w:nodeWidth,h:nodeHeight}));
    for (const edge of edges.filter(edge => edge.label)) {
      // 留出文字边距，优先原位置；分支密集时移到同一条连线的空白处。
      const textWidth = [...edge.label].reduce((sum, character) => sum + (character.charCodeAt(0) < 128 ? 0.6 : 1) * 14,0);
      for (const position of [edge.labelPosition,...edge.alternatives]) {
        const [x,y,anchor] = position;
        const box = {x:x - (anchor === 'middle' ? textWidth / 2 : anchor === 'end' ? textWidth : 0) - 4,y:y - 16,w:textWidth + 8,h:22};
        const overlap = occupied.some(r => box.x < r.x + r.w && box.x + box.w > r.x && box.y < r.y + r.h && box.y + box.h > r.y);
        const crosses = edges.some(other => other.points.slice(1).some((b,index) => {
          const a = other.points[index];
          return a[0] === b[0]
            ? a[0] > box.x && a[0] < box.x + box.w && Math.max(a[1],b[1]) > box.y && Math.min(a[1],b[1]) < box.y + box.h
            : a[1] > box.y && a[1] < box.y + box.h && Math.max(a[0],b[0]) > box.x && Math.min(a[0],b[0]) < box.x + box.w;
        }));
        if (overlap || crosses) continue;
        edge.labelPosition = position;
        occupied.push(box);
        break;
      }
    }
    const bounds = [...occupied,...edges.flatMap(edge => edge.points.map(([x,y]) => ({x,y,w:0,h:0})))];
    const minX = Math.min(...bounds.map(box => box.x)), minY = Math.min(...bounds.map(box => box.y));
    const width = Math.ceil(Math.max(...bounds.map(box => box.x + box.w)) - minX + 24);
    const height = Math.ceil(Math.max(...bounds.map(box => box.y + box.h)) - minY + 24);
    for (const node of nodes) { node.x += 12 - minX; node.y += 12 - minY; }
    for (const edge of edges) {
      edge.points = edge.points.map(([x,y]) => [x + 12 - minX,y + 12 - minY]);
      edge.labelPosition[0] += 12 - minX;
      edge.labelPosition[1] += 12 - minY;
    }
    return {nodes,edges,width,height};
  }

  window.ReportResearch = {
    render(container, data) {
      const resolveSource = source => source.article ? data.sources.find(item => item.id === source.article) : source;
      const link = source => `<a href="${escape(source.url)}" target="_blank" rel="noopener noreferrer">${escape(source.title)}</a>`;
      const dateFormat = new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'});
      const timeFormat = new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'});
      const dateCell = value => `<time datetime="${escape(value)}" title="${timeFormat.format(new Date(value))} · 北京时间">${dateFormat.format(new Date(value))}</time>`;
      const diagram = graph => {
        const {nodes,edges,width,height} = geometry(graph);
        const description = edges.map(edge => `${nodes.find(node => node.id === edge.from).title} → ${nodes.find(node => node.id === edge.to).title}${edge.label ? '（' + edge.label + '）' : ''}`).join('；');
        return `<figure class="research-flow" data-flow-id="${graph.id}">
          <h3 id="${graph.id}-title">${escape(graph.title)}</h3>
          <div class="research-diagram-scroll" tabindex="0" role="region" aria-label="${escape(graph.title)}">
            <svg class="research-diagram" viewBox="0 0 ${width} ${height}" style="--diagram-width:${Math.round(width * 0.95)}px" role="img" aria-labelledby="${graph.id}-title ${graph.id}-description">
              <desc id="${graph.id}-description">${escape(description)}</desc>
              <defs><marker id="${graph.id}-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 1 1 L 9 5 L 1 9" fill="none" stroke="currentColor" stroke-width="1.5"/></marker></defs>
              ${edges.map(edge => `<g class="research-edge"><path data-from="${edge.from}" data-to="${edge.to}" d="${edge.points.map(([x,y],index) => `${index ? 'L' : 'M'} ${x} ${y}`).join(' ')}" marker-end="url(#${graph.id}-arrow)"/>${edge.label ? `<text x="${edge.labelPosition[0]}" y="${edge.labelPosition[1]}" text-anchor="${edge.labelPosition[2]}">${escape(edge.label)}</text>` : ''}</g>`).join('')}
              ${nodes.map(node => `<g class="research-node${node.kind === 'decision' ? ' is-decision' : ''}" data-node-id="${node.id}">
                <rect x="${node.x}" y="${node.y}" width="${nodeWidth}" height="${nodeHeight}" rx="${node.kind === 'decision' ? 20 : 5}"/>
                <text class="research-node-title" x="${node.x + nodeWidth / 2}" y="${node.y + 25}" text-anchor="middle">${escape(node.title)}</text>
                ${node.detail.map((line,index) => `<text class="research-node-detail" x="${node.x + nodeWidth / 2}" y="${node.y + 49 + index * 21}" text-anchor="middle">${escape(line)}</text>`).join('')}
              </g>`).join('')}
            </svg>
          </div>
          <figcaption class="research-references"><span>来源</span>${graph.sources.map(resolveSource).map(link).join('')}</figcaption>
        </figure>`;
      };
      const panels = workflows.map(flow => {
        const repository = repositories[flow.repository];
        return {id:flow.id,title:flow.tab || flow.title,html:`
          <div class="research-heading"><h2>${escape(flow.title)}</h2><span>${escape(flow.kind)}</span></div>
          ${repository ? `<div class="research-repository">${link({title:repository.name,url:repository.url})}<span>★ ${repository.stars.toLocaleString('en-US')}</span><span>${repository.date}</span></div>` : ''}
          <dl class="research-facts">${[['评测对象',flow.object],['输入',flow.input],['判分方式',flow.grading],['产出',flow.output]].map(([key,value]) => `<div><dt>${key}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl>
          ${flow.graphs.map(diagram).join('')}
        `};
      });
      const repositoryFlows = workflows.filter(flow => flow.repository).sort((a,b) => repositories[b.repository].stars - repositories[a.repository].stars);
      const repositoryPanel = `<section class="research-panel research-catalog" id="research-panel-repositories" role="region" aria-labelledby="research-repositories-title" hidden>
        <div class="research-heading"><h2 id="research-repositories-title">GitHub 仓库</h2><span>数据截至 ${data.date}</span></div>
        <div class="research-table-scroll" tabindex="0" role="region" aria-label="GitHub 仓库对照"><table class="research-repository-table"><colgroup><col class="repo-name"><col class="repo-stars"><col class="repo-date"><col class="repo-date"><col class="repo-scope"><col class="repo-license"><col class="repo-flow"></colgroup><thead><tr><th scope="col">仓库</th><th scope="col" aria-sort="descending"><button type="button" data-repository-sort="stars" aria-label="Stars 当前从高到低，点击从低到高">Stars <span data-sort-indicator aria-hidden="true">↓</span></button></th><th scope="col" title="GitHub 仓库创建时间，按北京时间显示"><button type="button" data-repository-sort="createdAt" aria-label="创建时间，点击最新在前">创建时间 <span data-sort-indicator aria-hidden="true">↕</span></button></th><th scope="col" title="GitHub 最近代码推送时间，按北京时间显示"><button type="button" data-repository-sort="pushedAt" aria-label="最近代码更新，点击最新在前">最近代码更新 <span data-sort-indicator aria-hidden="true">↕</span></button></th><th scope="col">评测范围</th><th scope="col">许可 / 范围</th><th scope="col">流程</th></tr></thead><tbody>
          ${repositoryFlows.map(flow => { const repo = repositories[flow.repository]; return `<tr data-repository="${flow.repository}"><td data-label="仓库"><a href="${escape(repo.url)}" target="_blank" rel="noopener noreferrer">${escape(repo.name).replace('/','/<wbr>')}</a></td><td data-label="Stars">${repo.stars.toLocaleString('en-US')}</td><td data-label="创建时间">${dateCell(repo.createdAt)}</td><td data-label="最近代码更新">${dateCell(repo.pushedAt)}</td><td data-label="评测范围">${escape(flow.object)}</td><td data-label="许可 / 范围">${escape(repo.license)}</td><td data-label="流程"><button type="button" data-research-open="${flow.id}">查看流程</button></td></tr>`; }).join('')}
        </tbody></table></div>
      </section>`;
      const sources = [...new Map([...data.sources,...workflows.flatMap(flow => flow.graphs.flatMap(graph => graph.sources.map(resolveSource)))].map(source => [source.url,source])).values()];
      panels.push({id:'sources',title:'来源',html:`
        <div class="research-heading"><h2>来源</h2><span>${escape(data.date)}</span></div>
        <details class="research-document"><summary>流程与来源说明</summary><article>${data.reportHtml}</article></details>
        <ol class="research-sources">${sources.map(source => `<li>${link(source)}${source.date ? `<p>${escape(source.date)} · ${escape(source.note)}</p>` : ''}</li>`).join('')}</ol>
      `});
      container.innerHTML = `<div class="research-hero"><h1><button type="button" class="research-home" data-research-home>行业评测流程</button></h1><button type="button" class="research-catalog-toggle" data-research-catalog aria-expanded="false" aria-controls="research-panel-repositories">GitHub 仓库</button></div>
        <div class="research-nav" role="tablist" aria-label="评测方案">${panels.map((panel,index) => `<button type="button" role="tab" id="research-tab-${panel.id}" data-research-tab="${panel.id}" aria-controls="research-panel-${panel.id}" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}">${panel.title}</button>`).join('')}</div>
        ${panels.map((panel,index) => `<section class="research-panel" id="research-panel-${panel.id}" role="tabpanel" tabindex="0" aria-labelledby="research-tab-${panel.id}"${index ? ' hidden' : ''}>${panel.html}</section>`).join('')}${repositoryPanel}`;
      const tabs = [...container.querySelectorAll('[data-research-tab]')];
      const catalogToggle = container.querySelector('[data-research-catalog]');
      function showCatalog(open) {
        catalogToggle.setAttribute('aria-expanded',String(open));
        catalogToggle.textContent = open ? '← 返回流程' : 'GitHub 仓库';
        container.querySelector('.research-nav').hidden = open;
        const selected = tabs.find(tab => tab.getAttribute('aria-selected') === 'true').getAttribute('aria-controls');
        for (const panel of container.querySelectorAll('.research-panel')) panel.hidden = panel.id === 'research-panel-repositories' ? !open : open || panel.id !== selected;
      }
      catalogToggle.addEventListener('click',() => showCatalog(catalogToggle.getAttribute('aria-expanded') !== 'true'));
      container.querySelector('[data-research-home]').addEventListener('click',() => showCatalog(false));
      function select(tab) {
        for (const item of tabs) { item.setAttribute('aria-selected',String(item === tab)); item.tabIndex = item === tab ? 0 : -1; }
        showCatalog(false);
      }
      for (const [index,tab] of tabs.entries()) {
        tab.addEventListener('click',() => select(tab));
        tab.addEventListener('keydown',event => {
          const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
          if (next === null) return;
          event.preventDefault(); select(tabs[next]); tabs[next].focus();
        });
      }
      for (const button of container.querySelectorAll('[data-research-open]')) button.addEventListener('click',() => {
        const tab = tabs.find(tab => tab.dataset.researchTab === button.dataset.researchOpen);
        select(tab); tab.focus();
      });
      const sortButtons = [...container.querySelectorAll('[data-repository-sort]')];
      for (const sortButton of sortButtons) sortButton.addEventListener('click',() => {
        const field = sortButton.dataset.repositorySort;
        const ascending = sortButton.closest('th').getAttribute('aria-sort') === 'descending';
        for (const button of sortButtons) {
          const active = button === sortButton;
          const [low,high] = button.dataset.repositorySort === 'stars' ? ['从低到高','从高到低'] : ['最早在前','最新在前'];
          const name = button.firstChild.textContent.trim();
          if (active) button.closest('th').setAttribute('aria-sort',ascending ? 'ascending' : 'descending');
          else button.closest('th').removeAttribute('aria-sort');
          button.setAttribute('aria-label',active ? `${name}，当前${ascending ? low : high}，点击${ascending ? high : low}` : `${name}，点击${high}`);
          button.querySelector('[data-sort-indicator]').textContent = active ? ascending ? '↑' : '↓' : '↕';
        }
        const body = container.querySelector('.research-repository-table tbody');
        const value = row => field === 'stars' ? repositories[row.dataset.repository].stars : Date.parse(repositories[row.dataset.repository][field]);
        const rows = [...body.rows].sort((a,b) => (value(a) - value(b)) * (ascending ? 1 : -1));
        body.append(...rows);
      });
    }
  };
})();
