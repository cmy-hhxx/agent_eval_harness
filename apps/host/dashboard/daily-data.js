import { mountRecords } from '../../../server_dashboard_ths/records.js';

const format = value => Number.isFinite(value) ? value.toLocaleString('zh-CN') : '—';
const names = { a_fast:'A Fast', b_fast:'AA Fast', a_expert:'A Expert', b_expert:'AA Expert', aime_fast:'Fast', aime_expert:'Expert' };

export function mountDailyData(root, options = {}) {
  const $ = id => root.querySelector('#' + id), doc = root.ownerDocument || root, fetcher = options.fetch || globalThis.fetch;
  const cache = new Map(), views = new Map(), buttons = [...root.querySelectorAll('[data-data-source]')];
  let source = 'wencai', request, generation = 0, disposed = false, sampleGeneration = 0, sampleController, sampleFocus;
  const node = (tag, text) => { const item = doc.createElement(tag); item.textContent = text ?? ''; return item; };
  const view = () => { if (!views.has(source)) views.set(source, { date:'', page:1, size:10 }); return views.get(source); };
  function message(text) { $('data-error').textContent = text; $('data-error').hidden = !text; }
  async function showSamples(day, model) {
    const current = ++sampleGeneration, selection = { dataset:source, profile:source, date:day, model };
    sampleFocus = root.activeElement || doc.activeElement; sampleController?.destroy();
    $('data-sample-title').textContent = `${day} · ${names[model]}`; $('data-sample-content').textContent = '读取中'; $('data-sample-dialog').showModal();
    try {
      const html = await options.recordsTemplate(); if (disposed || current !== sampleGeneration || !$('data-sample-dialog').open) return;
      const content = new DOMParser().parseFromString(html, 'text/html').querySelector('main');
      $('data-sample-content').replaceChildren(content); sampleController = mountRecords(content, {...selection,compact:true});
    } catch (error) { if (current === sampleGeneration) $('data-sample-content').textContent = `样本读取失败：${error.message}`; }
  }
  $('data-sample-close').onclick = () => $('data-sample-dialog').close();
  $('data-sample-dialog').addEventListener('close', () => { sampleGeneration++; sampleController?.destroy(); sampleFocus?.isConnected && sampleFocus.focus(); });
  function modelLink(day, model, count) {
    const button = node('button', `${names[model]} ${format(count)} 条`); button.className = 'button date-model-link'; button.type = 'button'; button.disabled = !count;
    button.onclick = () => void showSamples(day, model); return button;
  }
  function cell(value, day, tier) {
    const item = node('td'), intake = value.intake, evaluation = value.evaluation;
    const inputModels = source === 'aime' ? [`aime_${tier.toLowerCase()}`] : tier === 'Fast' ? ['a_fast','b_fast'] : ['a_expert','b_expert'];
    const inputs = node('div'); inputs.className = 'date-model-inputs';
    const count = model => intake.dateModels.find(row => row.date === day && row.model === model)?.answers ?? 0;
    inputs.append(...inputModels.map(model => modelLink(day, model, count(model)))); item.append(inputs);
    const model = source === 'aime' ? inputModels[0] : tier;
    const group = evaluation.groups.find(row => row.date === day && row.model === model);
    const pair = source === 'wencai' ? intake.datePairs.find(row => row.date === day && row.tier === tier) : undefined;
    const total = source === 'aime' ? count(model) : pair?.paired ?? 0, completed = group?.completed ?? 0;
    const done = total > 0 && completed === total && group?.total === total && !group.failed && !group.partial && !group.running && !pair?.unpaired;
    const status = node('div'); status.className = 'date-completion';
    if (done) { const check = node('span', '✅'); check.setAttribute('aria-label', '当前有效数据已完整评测'); check.title = '当前有效数据已完整评测'; status.append(check); }
    const displayedTotal = total || group?.total || 0;
    status.append(node('strong', displayedTotal ? `${total ? '完整完成' : '历史评测'} ${format(completed)} / ${format(displayedTotal)} ${source === 'aime' ? '条' : '对'}` : '暂无可评数据')); item.append(status);
    if (source === 'aime' && total) {
      const stages = node('div'); stages.className = 'date-stage-counts';
      for (const [stage, label] of [['score','Score'],['attribution','Attribution']]) {
        const counts = group?.stages.find(row => row.stage === stage);
        stages.append(node('span', `${label} ${format(counts?.completed ?? 0)} / ${format(total)}${counts?.failed ? ` · 失败 ${format(counts.failed)}` : ''}`));
      }
      item.append(stages);
    }
    const counts = node('div'); counts.className = 'date-pending-counts';
    const outstanding = [['部分完成',group?.partial],['进行中',group?.running],['失败',group?.failed],['待评',Math.max(0,total - completed - (group?.partial ?? 0) - (group?.running ?? 0) - (group?.failed ?? 0))],['待配对',pair?.unpaired]];
    counts.append(...outstanding.filter(([,count]) => count > 0).map(([label,count]) => node('span',`${label} ${format(count)}`))); item.append(counts); return item;
  }
  function render() {
    const current = view(), value = cache.get(source); $('data-table-panel').setAttribute('aria-labelledby', `data-source-${source}`); $('data-date').value = current.date; $('data-page-size').value = current.size;
    buttons.forEach(button => { const active = button.dataset.dataSource === source; button.classList.toggle('active',active); button.setAttribute('aria-selected',String(active)); button.tabIndex = active ? 0 : -1; });
    for (const tier of ['fast','expert']) $(`data-${tier}-heading`).textContent = `${tier === 'fast' ? 'Fast' : 'Expert'}${source === 'wencai' ? ' · A / AA' : ''}`;
    if (!value) { $('data-date-rows').replaceChildren(); $('data-summary').textContent = ''; $('data-page').textContent = ''; $('data-prev').disabled = $('data-next').disabled = true; return; }
    const all = [...new Set([...value.intake.dates.map(row => row.date),...value.evaluation.dates.map(row => row.date).filter(Boolean)])].sort().reverse();
    const dates = all.filter(day => !current.date || day === current.date), pages = Math.max(1,Math.ceil(dates.length/current.size)); current.page = Math.min(current.page,pages);
    $('data-summary').textContent = `${format(all.length)} 个日期 · ${format(value.intake.totals.answers)} 条有效回答`;
    const rows = dates.slice((current.page-1)*current.size,current.page*current.size).map(day => { const row = node('tr'), date = node('th',day); date.scope = 'row'; row.append(date,cell(value,day,'Fast'),cell(value,day,'Expert')); return row; });
    if (!rows.length) { const row = node('tr'), empty = node('td',current.date ? '该日期暂无数据' : '暂无已清洗数据'); empty.colSpan = 3; row.append(empty); rows.push(row); }
    $('data-date-rows').replaceChildren(...rows); $('data-page').textContent = `${current.page} / ${pages} · ${dates.length} 个日期`; $('data-prev').disabled = current.page <= 1; $('data-next').disabled = current.page >= pages;
  }
  async function refresh() {
    request?.abort(); request = new AbortController(); const current = ++generation, id = source; message(''); $('data-loading').hidden = false; $('data-refresh').disabled = true;
    try {
      const response = await fetcher(`/runtime/api/daily/${id}/analytics`, { cache:'no-store', signal:AbortSignal.any([request.signal,AbortSignal.timeout(30000)]) }); const value = await response.json();
      if (!response.ok) throw Error(value.error || `HTTP ${response.status}`); if (!Array.isArray(value.intake?.dateModels) || !Array.isArray(value.intake?.datePairs) || !Array.isArray(value.evaluation?.groups)) throw Error('日期覆盖统计不可用');
      if (disposed || current !== generation) return; cache.set(id,value); render();
    } catch (error) { if (!disposed && current === generation && !request.signal.aborted) message(`读取失败：${error.message}${cache.has(id) ? ' · 保留上次数据' : ''}`); }
    finally { if (!disposed && current === generation) { $('data-loading').hidden = true; $('data-refresh').disabled = false; } }
  }
  async function select(id) { if (!['wencai','aime'].includes(id)) return; source = id; render(); await refresh(); }
  buttons.forEach((button,index) => { button.onclick = () => void select(button.dataset.dataSource); button.onkeydown = event => { const next = event.key === 'ArrowRight' || event.key === 'ArrowLeft' ? 1-index : undefined; if (next === undefined) return; event.preventDefault(); buttons[next].focus(); void select(buttons[next].dataset.dataSource); }; });
  $('data-refresh').onclick = () => void refresh(); $('data-results').onclick = () => options.onResults?.(source);
  $('data-date').onchange = event => { view().date = event.target.value; view().page = 1; render(); }; $('data-date-clear').onclick = () => { view().date = ''; view().page = 1; render(); };
  $('data-page-size').onchange = event => { view().size = Number(event.target.value); view().page = 1; render(); };
  $('data-prev').onclick = () => { view().page--; render(); }; $('data-next').onclick = () => { view().page++; render(); };
  render(); return { ready:refresh(), select, destroy() { disposed = true; request?.abort(); sampleGeneration++; sampleController?.destroy(); } };
}
