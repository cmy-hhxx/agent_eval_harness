import { renderMarkdown } from '../../../server_dashboard_ths/records-markdown.js';

const labels = { succeeded:'已完成', partial:'部分完成', pending:'待处理', running:'运行中', failed:'失败', timed_out:'超时', cancelled:'已中断', blocked:'依赖阻塞', finished:'已结束', interrupted:'已中断', unknown:'未知', attribution:'回答归因', summary:'总结', findings:'发现', evidence:'证据', final_answer_score:'最终回答得分', evaluations:'评估', explicit_probability:'明确概率', probability_evidence_ids:'概率证据', score:'得分', score_range:'得分区间', status:'状态', reason:'依据', text:'表现', component:'责任组件', label:'问题名称', definition:'定义', type:'类型', strength:'优点', problem:'问题', met:'满足', violated:'未满足', unverified:'待核', not_applicable:'不适用', case_id:'Case', evidence_ids:'证据引用', quote:'原文', source:'来源', evidence_id:'证据坐标' };
const stageName = stage => stage === 'score' ? '独立评分' : stage === 'attribution' ? '回答归因' : stage;

export function mountAimeResults(root, options = {}) {
  const $ = id => root.querySelector('#' + id), doc = root.ownerDocument || root, fetcher = options.fetch || globalThis.fetch;
  const state = { runs:[], runId:'', offset:0, limit:25, total:0, items:[], selected:'', revision:0, detailRevision:0, busy:false };
  let timer, disposed = false, connected = false;
  const node = (tag,value) => { const item = doc.createElement(tag); item.textContent = value ?? ''; return item; };
  const button = (label,action,disabled = false) => { const item = node('button',label); item.type = 'button'; item.className = 'button'; item.disabled = disabled; item.onclick = () => void action(); return item; };
  const url = (suffix = '') => `/runtime/api/daily/aime/runs${state.runId ? '/' + encodeURIComponent(state.runId) : ''}${suffix}`;
  function error(message) { $('aime-error').textContent = message || ''; $('aime-error').hidden = !message; }
  async function request(endpoint,body) {
    try {
      const response = await fetcher(endpoint,{cache:'no-store',signal:AbortSignal.timeout(30000),...(body === undefined ? {} : {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})});
      connected = response.status < 500;
      const value = await response.json(); if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`); return value;
    } catch (cause) { connected = false; throw cause; }
  }
  function valueView(value) {
    if (Array.isArray(value)) { const list = doc.createElement('ol'); value.forEach(item => { const row = doc.createElement('li'); row.append(valueView(item)); list.append(row); }); return list; }
    if (value && typeof value === 'object') { const list = doc.createElement('dl'); list.className = 'aime-fields'; Object.entries(value).forEach(([key,item]) => { const field = doc.createElement('div'), content = doc.createElement('dd'); field.className = item && typeof item === 'object' ? 'aime-object' : 'aime-scalar'; content.append(valueView(item)); field.append(node('dt',labels[key] || key),content); list.append(field); }); return list; }
    return node('span',value === null ? '无' : typeof value === 'boolean' ? value ? '是' : '否' : labels[value] || value);
  }
  function renderRuns() {
    const selected = state.runId; $('aime-run').replaceChildren(...state.runs.map(run => new Option(`${run.date || run.runId} · ${labels[run.status] || run.status}`,run.runId))); $('aime-run').value = selected;
    const run = state.runs.find(item => item.runId === selected);
    const numeric = value => typeof value === 'number' && Number.isFinite(value);
    const metrics = run ? [['问句',run.questions],['回答',run.answers]].filter(([,value]) => numeric(value)).map(([label,value]) => `${label} ${value}`) : [];
    if (run && numeric(run.succeeded) && numeric(run.total)) metrics.push(`完整回答 ${run.succeeded} / ${run.total}`);
    if (run && numeric(run.partial)) metrics.push(`部分完成 ${run.partial}`);
    if (run && numeric(run.taskCompleted) && numeric(run.taskTotal)) metrics.push(`阶段任务 ${run.taskCompleted} / ${run.taskTotal}`);
    if (run && numeric(run.failed)) metrics.push(`失败 ${run.failed}`);
    $('aime-run-status').textContent = run ? metrics.join(' · ') : '暂无运行';
    $('aime-stage-counts').replaceChildren(...Object.entries(run?.stages || {}).map(([stage,counts]) => { const item = doc.createElement('div'); item.append(node('strong',stageName(stage)),node('span',`${counts.succeeded || 0} / ${counts.total || 0}`),node('span',`进行中 ${counts.running || 0} · 待处理 ${counts.pending || 0} · 失败 ${counts.failed || 0}`)); return item; }));
    $('aime-artifacts').replaceChildren(...(run?.artifacts || []).map(file => { const link = node('a',file.name); link.href = url('/artifacts') + '?file=' + encodeURIComponent(file.name); link.setAttribute('download',''); return link; }));
    $('aime-retry-failed').disabled = !connected || state.busy || !run || run.status === 'running' || !run.failed;
    $('aime-task-errors').querySelectorAll('button').forEach(item => { item.disabled = !connected || state.busy || run?.status === 'running'; });
  }
  function renderSamples() {
    $('aime-sample-rows').replaceChildren(...state.items.map(sample => {
      const row = doc.createElement('tr'), identity = node('td',sample.question); identity.append(node('div',sample.caseId),node('code',sample.traceId));
      const actions = doc.createElement('td'); actions.append(button('查看',() => detail(sample.inputId))); row.append(identity,node('td',sample.model === 'aime_fast' ? 'Fast' : sample.model === 'aime_expert' ? 'Expert' : sample.model));
      const overall = node('td',labels[sample.status] || sample.status); overall.dataset.cell = 'answer-status'; row.append(overall);
      for (const stage of ['score','attribution']) { const status = sample.stages?.[stage]; const cell = node('td',labels[status?.status] || status?.status || '未执行'); if (status?.error) cell.append(node('div',status.error)); row.append(cell); }
      row.append(actions); row.classList.toggle('selected',sample.inputId === state.selected); return row;
    }));
    $('aime-page').textContent = `${Math.floor(state.offset / state.limit) + 1} / ${Math.max(1,Math.ceil(state.total / state.limit))} · ${state.total} 个回答`;
    $('aime-prev').disabled = state.offset === 0; $('aime-next').disabled = state.offset + state.limit >= state.total;
  }
  async function samples() {
    if (!state.runId) { state.items = []; state.total = 0; renderSamples(); return; }
    const revision = ++state.revision, runId = state.runId;
    const query = new URLSearchParams({offset:String(state.offset),limit:String(state.limit)});
    for (const key of ['model','status','query']) if ($(`aime-${key}`).value) query.set(key,$(`aime-${key}`).value);
    try { const value = await request(url('/samples') + '?' + query); if (disposed || revision !== state.revision || runId !== state.runId) return; state.items = value.items; state.total = value.total; error(''); renderSamples(); }
    catch (cause) { if (revision === state.revision) { error(`样本读取失败：${cause.message}`); renderRuns(); } }
  }
  async function retry(body) {
    if (state.busy || !connected) return; state.busy = true; renderRuns();
    try { await request(url('/retry'),body); error(''); await refresh(); if (state.selected) await detail(state.selected); }
    catch (cause) { error(`重试失败：${cause.message}`); }
    finally { state.busy = false; renderRuns(); }
  }
  async function detail(inputId) {
    const revision = ++state.detailRevision, runId = state.runId; state.selected = inputId; renderSamples();
    try {
      const value = await request(url('/samples/') + encodeURIComponent(inputId)); if (disposed || revision !== state.detailRevision || runId !== state.runId) return;
      $('aime-detail').hidden = false; $('aime-question').textContent = value.question;
      const source = value.source || {};
      $('aime-location').replaceChildren(...[['Case',value.caseId],['Trace',value.traceId],['模式',value.model],['原包',source.archive],['原始位置',`${source.member || ''}:${source.line || ''}${source.item == null ? '' : ` [${source.item}]`}`]].map(([label,text]) => { const item = doc.createElement('div'); item.append(node('dt',label),node('dd',text)); return item; }));
      $('aime-answer').replaceChildren(renderMarkdown(typeof value.answer === 'string' ? value.answer : JSON.stringify(value.answer,null,2))); $('aime-input').textContent = JSON.stringify(value.input,null,2);
      const run = state.runs.find(item => item.runId === runId);
      $('aime-task-errors').replaceChildren(...value.tasks.filter(task => task.reason || task.errors?.length || ['failed','timed_out','blocked','cancelled'].includes(task.status)).map(task => { const item = doc.createElement('section'); item.append(node('h3',`${stageName(task.stage)} · ${labels[task.status] || task.status} · ${task.attempts} 次`),node('pre',task.reason || ''),valueView(task.errors || []),button('重试此项',() => retry({taskIds:[task.id]}),state.busy || run?.status === 'running')); return item; }));
      $('aime-results').replaceChildren(...['score','attribution'].flatMap(stage => { const result = value.results?.[stage]; if (!result) return []; const section = doc.createElement('section'); section.dataset.stage = stage; section.append(node('h3',stageName(stage)));
        const content = stage === 'score' ? result.evaluation : {summary:result.summary,findings:result.findings.map(finding => finding.type === 'strength' ? Object.fromEntries(Object.entries(finding).filter(([key]) => !['component','label','definition'].includes(key))) : finding),evidence:result.evidence,...(result.rewritten ? {rewritten:result.rewritten} : {})};
        section.append(valueView(content)); return [section]; }));
      error('');
    } catch (cause) { if (revision === state.detailRevision) { error(`详情读取失败：${cause.message}`); renderRuns(); } }
  }
  async function selectRun(id) { if (state.runId !== id) { state.runId = id; state.offset = 0; state.selected = ''; state.detailRevision++; $('aime-detail').hidden = true; } renderRuns(); await samples(); }
  async function refresh() {
    clearTimeout(timer);
    try {
      const value = await request('/runtime/api/daily/aime/runs'); if (disposed) return; state.runs = value.runs;
      if (!state.runs.some(run => run.runId === state.runId)) {
        state.runId = state.runs[0]?.runId || ''; state.offset = 0; state.selected = ''; state.detailRevision++; $('aime-detail').hidden = true;
      }
      renderRuns(); error(''); await samples();
    }
    catch (cause) { if (!disposed) { error(`运行读取失败：${cause.message}`); renderRuns(); } }
    finally { if (!disposed && state.runs.some(run => run.status === 'running')) timer = setTimeout(() => void refresh(),5000); }
  }
  $('aime-run').onchange = event => void selectRun(event.target.value); $('aime-refresh').onclick = () => void refresh(); $('aime-filters').onsubmit = event => { event.preventDefault(); state.offset = 0; void samples(); };
  $('aime-prev').onclick = () => { state.offset = Math.max(0,state.offset-state.limit); void samples(); }; $('aime-next').onclick = () => { state.offset += state.limit; void samples(); };
  $('aime-retry-failed').onclick = () => void retry({});
  return {ready:refresh(),selectRun,destroy() { disposed = true; clearTimeout(timer); }};
}
