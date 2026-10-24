import { renderMarkdown } from '../../../server_dashboard_ths/records-markdown.js';
import { stageProgress } from './stage-progress.js';

const labels = { succeeded:'已完成', partial:'部分完成', pending:'待处理', running:'运行中', failed:'失败', timed_out:'超时', cancelled:'已中断', blocked:'依赖阻塞', finished:'已结束', interrupted:'已中断', unknown:'未知', attribution:'回答归因', summary:'总结', findings:'发现', evidence:'证据', final_answer_score:'最终回答得分', evaluations:'评估', explicit_probability:'明确概率', probability_evidence_ids:'概率证据', score:'得分', score_range:'得分区间', status:'状态', reason:'依据', text:'表现', component:'责任组件', label:'问题名称', definition:'定义', type:'类型', strength:'优点', problem:'问题', met:'满足', violated:'未满足', unverified:'待核', not_applicable:'不适用', case_id:'Case', evidence_ids:'证据引用', quote:'原文', source:'来源', evidence_id:'证据坐标' };
const stageName = stage => stage === 'score' ? '独立评分' : stage === 'attribution' ? '回答归因' : stage === 'rewrite' ? '改写' : stage;

export function mountAimeResults(root, options = {}) {
  const $ = id => root.querySelector('#' + id), doc = root.ownerDocument || root, fetcher = options.fetch || globalThis.fetch;
  const state = { runs:[], runId:'', offset:0, limit:10, total:0, items:[], selected:'', revision:0, detailRevision:0, detailTab:'answer', busy:false };
  let timer, disposed = false, connected = false, detailFocus, detailController, refreshRevision = 0;
  const node = (tag,value) => { const item = doc.createElement(tag); item.textContent = value ?? ''; return item; };
  const button = (label,action,disabled = false) => { const item = node('button',label); item.type = 'button'; item.className = 'button'; item.disabled = disabled; item.onclick = () => void action(); return item; };
  const url = (suffix = '') => `/runtime/api/daily/aime/runs${state.runId ? '/' + encodeURIComponent(state.runId) : ''}${suffix}`;
  function error(message,detail = false) { for (const id of detail ? ['aime-error','aime-detail-error'] : ['aime-error']) { $(id).textContent = message || ''; $(id).hidden = !message; } }
  function notice(message) { for (const id of ['aime-operation-status','aime-detail-operation-status']) { $(id).textContent = message || ''; $(id).hidden = !message; } $('aime-detail-go-evaluate').hidden = !message?.startsWith('已准备') || typeof options.onEvaluate !== 'function'; }
  async function request(endpoint,body,signal = AbortSignal.timeout(30000)) {
    try {
      const response = await fetcher(endpoint,{cache:'no-store',signal,...(body === undefined ? {} : {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})});
      connected = response.status < 500;
      const value = await response.json(); if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`); return value;
    } catch (cause) { if (cause.name !== 'AbortError') connected = false; throw cause; }
  }
  function valueView(value) {
    if (Array.isArray(value)) { const list = doc.createElement('ol'); value.forEach(item => { const row = doc.createElement('li'); row.append(valueView(item)); list.append(row); }); return list; }
    if (value && typeof value === 'object') { const list = doc.createElement('dl'); list.className = 'aime-fields'; Object.entries(value).forEach(([key,item]) => { const field = doc.createElement('div'), content = doc.createElement('dd'); field.className = item && typeof item === 'object' ? 'aime-object' : 'aime-scalar'; content.append(valueView(item)); field.append(node('dt',labels[key] || key),content); list.append(field); }); return list; }
    return node('span',value === null ? '无' : typeof value === 'boolean' ? value ? '是' : '否' : labels[value] || value);
  }
  function renderRuns() {
    const selected = state.runId; $('aime-run').replaceChildren(...state.runs.map(run => new Option(`${run.date || run.runId} · ${run.answers ?? run.total ?? 0} 回答${run.failed ? ` · ${run.failed} 失败` : ''} · ${labels[run.status] || run.status}`,run.runId))); $('aime-run').value = selected;
    $('aime-run').title = $('aime-run').selectedOptions[0]?.textContent || '';
    const run = state.runs.find(item => item.runId === selected);
    const numeric = value => typeof value === 'number' && Number.isFinite(value);
    const metrics = run ? [['问句',run.questions],['回答',run.answers]].filter(([,value]) => numeric(value)).map(([label,value]) => `${label} ${value}`) : [];
    if (run && numeric(run.succeeded) && numeric(run.total)) metrics.push(`完整回答 ${run.succeeded} / ${run.total}`);
    if (run && numeric(run.partial)) metrics.push(`部分完成 ${run.partial}`);
    if (run && numeric(run.taskCompleted) && numeric(run.taskTotal)) metrics.push(`阶段任务 ${run.taskCompleted} / ${run.taskTotal}`);
    if (run && numeric(run.failed)) metrics.push(`失败 ${run.failed}`);
    $('aime-run-status').replaceChildren(...(run ? metrics.map(text => node('span',text)) : [node('span','暂无运行')]));
    $('aime-stage-counts').replaceChildren(...Object.entries(run?.stages || {}).map(([stage,counts]) => stageProgress(doc,stageName(stage),{...counts,completed:counts.succeeded})));
    $('aime-artifacts').replaceChildren(...(run?.artifacts || []).map(file => { const link = node('a',file.name); link.href = url('/artifacts') + '?file=' + encodeURIComponent(file.name); link.setAttribute('download',''); link.onclick = () => { $('aime-artifact-menu').open = false; }; return link; }));
    $('aime-artifact-menu').hidden = !run?.artifacts?.length;
    $('aime-retry-failed').disabled = !connected || state.busy || !run || run.status === 'running' || !run.failed;
    $('aime-go-evaluate').disabled = $('aime-detail-go-evaluate').disabled = state.busy;
    root.querySelectorAll('[data-task-errors] button,[data-aime-retry]').forEach(item => { item.disabled = !connected || state.busy || run?.status === 'running'; });
  }
  function renderSamples() {
    $('aime-sample-rows').replaceChildren(...state.items.map(sample => {
      const row = doc.createElement('tr'), identity = doc.createElement('td'), question = node('span',sample.question), caseId = node('div',sample.caseId), trace = node('code',sample.traceId); row.dataset.inputId = sample.inputId;
      question.className = 'aime-question-preview'; question.title = sample.question; caseId.className = 'aime-case-preview'; caseId.title = sample.caseId; trace.className = 'aime-trace-preview'; trace.title = sample.traceId;
      const identifiers = doc.createElement('div'); identifiers.className = 'aime-identity-preview'; identifiers.append(caseId,trace); identity.append(question,identifiers);
      const failedStages = ['score','attribution'].filter(stage => ['failed','timed_out','blocked','cancelled'].includes(sample.stages?.[stage]?.status));
      const actions = doc.createElement('td'); actions.className = 'aime-row-actions'; actions.append(button('查看',() => detail(sample.inputId,failedStages[0] || 'answer')));
      const retryIds = failedStages.flatMap(stage => sample.stages[stage].taskId ? [sample.stages[stage].taskId] : []);
      if (retryIds.length) { const retryButton = button('准备重试',() => retry({taskIds:retryIds}),!connected || state.busy || state.runs.find(run => run.runId === state.runId)?.status === 'running'); retryButton.dataset.aimeRetry = ''; actions.append(retryButton); }
      row.append(identity,node('td',sample.model === 'aime_fast' ? 'Fast' : sample.model === 'aime_expert' ? 'Expert' : sample.model));
      const overall = node('td',labels[sample.status] || sample.status); overall.dataset.cell = 'answer-status'; row.append(overall);
      for (const stage of ['score','attribution']) { const status = sample.stages?.[stage]; const cell = node('td',labels[status?.status] || status?.status || '未执行'); if (status?.error) { const reason = node('div',status.error); reason.className = 'aime-error-preview'; reason.title = status.error; cell.append(reason); } row.append(cell); }
      row.append(actions); row.classList.toggle('selected',sample.inputId === state.selected); return row;
    }));
    if (!state.items.length && state.runId) { const row = doc.createElement('tr'), cell = node('td',['model','status','query'].some(key => $(`aime-${key}`).value) ? '无匹配回答' : '暂无回答'); cell.colSpan = 6; cell.className = 'empty'; row.append(cell); $('aime-sample-rows').append(row); }
    $('aime-page').textContent = `${Math.floor(state.offset / state.limit) + 1} / ${Math.max(1,Math.ceil(state.total / state.limit))} · ${state.total} 个回答`;
    $('aime-prev').disabled = state.offset === 0; $('aime-next').disabled = state.offset + state.limit >= state.total;
  }
  async function samples() {
    if (!state.runId) { state.items = []; state.total = 0; renderSamples(); return; }
    const revision = ++state.revision, runId = state.runId;
    $('aime-sample-rows').closest('.table-scroll').setAttribute('aria-busy','true');
    const query = new URLSearchParams({offset:String(state.offset),limit:String(state.limit)});
    for (const key of ['model','status','query']) if ($(`aime-${key}`).value) query.set(key,$(`aime-${key}`).value);
    try {
      const value = await request(url('/samples') + '?' + query); if (disposed || revision !== state.revision || runId !== state.runId) return;
      const offset = Math.max(0,Math.floor((value.total-1)/state.limit)*state.limit);
      if (state.offset > offset) { state.offset = offset; await samples(); return; }
      state.items = value.items; state.total = value.total; error(''); renderSamples();
    }
    catch (cause) { if (revision === state.revision) { error(`样本读取失败：${cause.message}`); renderRuns(); } }
    finally { if (!disposed && revision === state.revision) $('aime-sample-rows').closest('.table-scroll').setAttribute('aria-busy','false'); }
  }
  async function retry(body) {
    if (state.busy || !connected) return;
    const runId = state.runId, detailInput = $('aime-detail').open ? state.selected : '', tab = state.detailTab;
    state.busy = true; notice('准备中…'); renderRuns();
    try {
      const value = await request(url('/retry'),body); if (disposed) return;
      await refresh();
      if (state.runId === runId) {
        if (detailInput && state.selected === detailInput && $('aime-detail').open) await detail(detailInput,tab);
        notice(Array.isArray(value.retried) ? value.retried.length ? `已准备 ${value.retried.length} 项重试` : '没有可重试任务' : '已准备重试');
      }
    }
    catch (cause) { if (!disposed && state.runId === runId) { notice(''); error(`准备重试失败：${cause.message}`,$('aime-detail').open); } }
    finally { state.busy = false; renderRuns(); }
  }
  function detailTab(tab) {
    state.detailTab = tab;
    root.querySelectorAll('[data-aime-detail-tab]').forEach(item => {
      const active = item.dataset.aimeDetailTab === tab; item.classList.toggle('active',active); item.setAttribute('aria-selected',String(active)); item.tabIndex = active ? 0 : -1;
      $(`aime-detail-panel-${item.dataset.aimeDetailTab}`).hidden = !active;
    });
    $('aime-results').scrollTop = 0;
  }
  async function detail(inputId,tab = 'answer') {
    const opener = root.activeElement || doc.activeElement;
    detailController?.abort(); const controller = new AbortController(); detailController = controller;
    const revision = ++state.detailRevision, runId = state.runId; state.selected = inputId; renderSamples();
    $('aime-detail').hidden = false; $('aime-detail').setAttribute('aria-busy','true'); $('aime-detail-loading').hidden = false;
    $('aime-detail-operation-status').textContent = ''; $('aime-detail-operation-status').hidden = true; $('aime-detail-go-evaluate').hidden = true;
    $('aime-question').textContent = ''; $('aime-detail-identity').textContent = ''; $('aime-answer').replaceChildren(); $('aime-location').replaceChildren(); $('aime-input').textContent = '';
    for (const stage of ['score','attribution']) { $(`aime-${stage}-errors`).replaceChildren(); $(`aime-${stage}-result`).replaceChildren(); $(`aime-detail-tab-${stage}`).textContent = stageName(stage); }
    detailTab(tab); error('',true);
    if (!$('aime-detail').open) { detailFocus = opener; $('aime-detail').showModal(); }
    try {
      const value = await request(url('/samples/') + encodeURIComponent(inputId),undefined,AbortSignal.any([controller.signal,AbortSignal.timeout(30000)])); if (disposed || revision !== state.detailRevision || runId !== state.runId) return;
      $('aime-question').textContent = value.question;
      $('aime-detail-identity').textContent = `${value.model === 'aime_fast' ? 'Fast' : value.model === 'aime_expert' ? 'Expert' : value.model} · ${value.caseId}`; $('aime-detail-identity').title = $('aime-detail-identity').textContent;
      const source = value.source || {};
      $('aime-location').replaceChildren(...[['Case',value.caseId],['Trace',value.traceId],['模式',value.model],['原包',source.archive],['原始位置',`${source.member || ''}:${source.line || ''}${source.item == null ? '' : ` [${source.item}]`}`]].map(([label,text]) => { const item = doc.createElement('div'); item.append(node('dt',label),node('dd',text)); return item; }));
      $('aime-answer').replaceChildren(renderMarkdown(typeof value.answer === 'string' ? value.answer : JSON.stringify(value.answer,null,2))); $('aime-input').textContent = JSON.stringify(value.input,null,2);
      const run = state.runs.find(item => item.runId === runId);
      for (const stage of ['score','attribution']) {
        const tasks = value.tasks.filter(task => task.stage === stage || stage === 'attribution' && task.stage === 'rewrite'), status = tasks.find(task => task.stage === stage)?.status || value.stages?.[stage]?.status;
        $(`aime-detail-tab-${stage}`).textContent = `${stageName(stage)}${status ? ` · ${labels[status] || status}` : ''}`;
        $(`aime-${stage}-errors`).replaceChildren(...tasks.filter(task => task.reason || task.errors?.length || ['failed','timed_out','blocked','cancelled'].includes(task.status)).map(task => { const item = doc.createElement('section'); item.append(node('h3',`${task.stage === stage ? '' : stageName(task.stage) + ' · '}${labels[task.status] || task.status} · ${task.attempts} 次`),node('pre',task.reason || ''),valueView(task.errors || [])); if (task.stage === stage && ['failed','timed_out','blocked','cancelled'].includes(task.status)) item.append(button('准备重试此项',() => retry({taskIds:[task.id]}),state.busy || run?.status === 'running')); return item; }));
        const result = value.results?.[stage]; if (!result) { $(`aime-${stage}-result`).replaceChildren(node('p',labels[status] || status || '未执行')); continue; }
        const content = stage === 'score' ? result.evaluation : {summary:result.summary,findings:result.findings.map(finding => finding.type === 'strength' ? Object.fromEntries(Object.entries(finding).filter(([key]) => !['component','label','definition'].includes(key))) : finding),evidence:result.evidence,...(result.rewritten ? {rewritten:result.rewritten} : {})};
        $(`aime-${stage}-result`).replaceChildren(valueView(content));
      }
      error('',true);
    } catch (cause) { if (!controller.signal.aborted && revision === state.detailRevision) { error(`详情读取失败：${cause.message}`,true); renderRuns(); } }
    finally { if (!disposed && revision === state.detailRevision) { $('aime-detail').setAttribute('aria-busy','false'); $('aime-detail-loading').hidden = true; } }
  }
  async function selectRun(id) { if (state.runId !== id) { state.runId = id; state.offset = 0; state.selected = ''; state.detailRevision++; detailController?.abort(); notice(''); $('aime-artifact-menu').open = false; if ($('aime-detail').open) $('aime-detail').close(); $('aime-detail').hidden = true; } renderRuns(); await samples(); }
  async function refresh() {
    const revision = ++refreshRevision;
    clearTimeout(timer);
    try {
      const value = await request('/runtime/api/daily/aime/runs'); if (disposed || revision !== refreshRevision) return; state.runs = value.runs;
      if (!state.runs.some(run => run.runId === state.runId)) {
        state.runId = state.runs[0]?.runId || ''; state.offset = 0; state.selected = ''; state.detailRevision++; detailController?.abort(); if ($('aime-detail').open) $('aime-detail').close(); $('aime-detail').hidden = true;
      }
      renderRuns(); error(''); await samples();
    }
    catch (cause) { if (!disposed && revision === refreshRevision) { error(`运行读取失败：${cause.message}`); renderRuns(); } }
    finally { if (!disposed && revision === refreshRevision && state.runs.some(run => run.status === 'running')) timer = setTimeout(() => void refresh(),5000); }
  }
  const filter = () => { state.offset = 0; notice(''); void samples(); };
  $('aime-run').onchange = event => void selectRun(event.target.value); $('aime-refresh').onclick = () => void refresh(); $('aime-filters').onsubmit = event => { event.preventDefault(); filter(); };
  for (const id of ['aime-model','aime-status']) $(id).onchange = filter;
  $('aime-filter-reset').onclick = () => { for (const key of ['model','status','query']) $(`aime-${key}`).value = ''; filter(); };
  $('aime-prev').onclick = () => { state.offset = Math.max(0,state.offset-state.limit); void samples(); }; $('aime-next').onclick = () => { state.offset += state.limit; void samples(); };
  $('aime-retry-failed').onclick = () => void retry({});
  const evaluate = () => { if ($('aime-detail').open) $('aime-detail').close(); options.onEvaluate?.(); };
  $('aime-go-evaluate').hidden = typeof options.onEvaluate !== 'function'; $('aime-go-evaluate').onclick = $('aime-detail-go-evaluate').onclick = evaluate;
  $('aime-page-size').onchange = event => { state.limit = Number(event.target.value); state.offset = 0; void samples(); };
  $('aime-detail-close').onclick = () => $('aime-detail').close();
  const tabs = [...root.querySelectorAll('[data-aime-detail-tab]')];
  tabs.forEach((item,index) => { item.onclick = () => detailTab(item.dataset.aimeDetailTab); item.onkeydown = event => {
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length-1 : event.key === 'ArrowRight' ? (index+1)%tabs.length : event.key === 'ArrowLeft' ? (index+tabs.length-1)%tabs.length : undefined;
    if (next === undefined) return; event.preventDefault(); detailTab(tabs[next].dataset.aimeDetailTab); tabs[next].focus();
  }; });
  $('aime-detail').addEventListener('close',() => { detailController?.abort(); state.detailRevision++; $('aime-detail').hidden = true; const sample = [...$('aime-sample-rows').children].find(row => row.dataset.inputId === state.selected)?.querySelector('button'); if (detailFocus?.isConnected) detailFocus.focus(); else if (sample) sample.focus(); else $('aime-run').focus(); });
  return {ready:refresh(),selectRun,destroy() { disposed = true; detailController?.abort(); state.detailRevision++; clearTimeout(timer); }};
}
