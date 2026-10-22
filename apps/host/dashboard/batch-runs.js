const statuses = { ready:'待启动', starting:'启动中', running:'运行中', interrupted:'已中断', finished:'已完成', failed:'失败', pending:'待运行', blocked:'依赖阻塞', cancelled:'已取消', timed_out:'超时', succeeded:'已接受' };
const stages = { criteria:'共同基准', attribution:'回答归因', comparison:'对比', rewrite:'改写', clustering:'聚类' };
export function mountBatchRuns(root, options = {}) {
  const $ = id => root.querySelector('#' + id), doc = root.ownerDocument || root;
  const request = options.fetch || fetch;
  let selected = [], prepared, runs = [], current, page = 1, busy = false, disposed = false, revision = 0, errorRevision = 0, selectionRevision = 0;
  const node = (tag, value) => { const el = doc.createElement(tag); el.textContent = value ?? '—'; return el; };
  const button = (label, action, disabled = false) => { const el = node('button', label); el.type = 'button'; el.className = 'button'; el.disabled = busy || disabled; el.onclick = () => void action(); return el; };
  const error = message => { $('batch-error').hidden = !message; $('batch-error').textContent = message || ''; };
  async function api(path, body) {
    const response = await request('/runtime/api/dashboard/' + path, { cache:'no-store', ...(body === undefined ? {} : { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body) }) });
    const value = await response.json(); if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`); return value;
  }
  function render() {
    $('batch-run-rows').replaceChildren(...runs.map(run => {
      const row = doc.createElement('tr'), title = node('td', run.task.name);
      title.append(node('div',run.run_id),node('div',`${run.batch_ids.length} 个批次 · ${run.task.source}`));
      const p = run.progress || {}, failures = Object.values(p.failures || {}).reduce((a,b) => a+b,0);
      let status = statuses[run.status] || run.status;
      if (run.status === 'finished' && (failures || p.blocked || p.queued || p.cancelled)) status = '部分完成';
      const state = node('td',status); if (run.launch_error) state.append(node('p', run.launch_error));
      row.append(title,state,node('td',`${p.accepted || 0} / ${p.running || 0} / ${p.queued || 0}`),node('td',`${failures} / ${p.blocked || 0}`));
      const actions = doc.createElement('td'), live = ['running','starting'].includes(run.status);
      if (options.onAnalysis) actions.append(button('结果与聚类', () => options.onAnalysis(run.run_id), !run.progress));
      actions.append(button('错误与恢复', () => showErrors(run.run_id)), button('样本与结果', () => options.onResults?.(run.run_id), !run.progress));
      if (live) actions.append(button('停止运行', () => control(run.run_id,'stop')));
      else if (run.status === 'ready') actions.append(button('开始评测', () => control(run.run_id,'start')));
      else actions.append(button('继续未完成', () => control(run.run_id,'resume')),button('重试失败', () => control(run.run_id,'retry'), !failures && !p.blocked && !p.cancelled));
      row.append(actions); return row;
    }));
    if (!runs.length) { const row = doc.createElement('tr'), cell = node('td','暂无批次运行'); cell.colSpan = 5; row.append(cell); $('batch-run-rows').append(row); }
  }
  async function refresh() {
    const version = ++revision;
    try { const value = await api('batch-runs'); if (disposed || version !== revision) return; runs = value.runs; render(); error(''); if (current) await showErrors(current,false); }
    catch (failure) { if (!disposed && version === revision) error(failure.message); }
  }
  async function control(id, action, body = {}) {
    if (busy) return; busy = true; render(); error('');
    try { await api(action === 'stop' ? `runs/${id}/stop` : `batch-runs/${id}/${action}`,body); await refresh(); }
    catch (failure) { error(failure.message); }
    finally { busy = false; render(); }
  }
  async function showErrors(id, scroll = true) {
    if (id !== current) { current = id; page = 1; }
    const version = ++errorRevision;
    try {
      const query = new URLSearchParams({ page:String(page),stage:$('batch-stage').value,case:$('batch-case').value,history:String($('batch-history').checked) });
      const value = await api(`runs/${id}/errors?${query}`);
      if (disposed || version !== errorRevision) return;
      $('batch-errors').hidden = false; $('batch-errors-title').textContent = `运行错误 · ${id}`;
      $('batch-error-count').textContent = `${value.unresolved_count} 个未恢复任务 · ${value.total} 条错误日志`;
      const active = ['running','starting'].includes(runs.find(run => run.run_id === id)?.status);
      const pauses = new Map(value.tasks.filter(task => task.paused).map(task => [task.stage,task.paused]));
      $('batch-paused').replaceChildren(...[...pauses].map(([stage,pause]) => {
        const el = node('p',`${stages[stage] || stage} 已暂停 · ${pause.code} · ${pause.path} `);
        el.append(button('修复后解除暂停并续跑', () => control(id,'resume',{ resume_stages:[stage] }),active)); return el;
      }));
      $('batch-error-rows').replaceChildren(...value.tasks.map(task => {
        const row = doc.createElement('tr'), locations = doc.createElement('td');
        for (const loc of task.locations) locations.append(node('p',`${loc.case_id} · ${loc.model}\n${loc.original_file || loc.input_file} · 第 ${loc.original_line ?? loc.input_line} 行${loc.original_item ? ` / 项 ${loc.original_item}` : ''}`));
        if (!task.locations.length) locations.textContent = '运行级任务';
        const stage = node('td',stages[task.stage] || task.stage); stage.append(node('div',task.task_id));
        const status = node('td',`${statuses[task.status] || task.status} · ${task.attempts} 次`);
        if (task.next_retry_at) status.append(node('div',`下次重试 ${new Date(task.next_retry_at).toLocaleString()}`));
        const detail = node('td',task.reason || ''); detail.append(node('pre',JSON.stringify(task.errors,null,2)));
        for (const dep of task.dependencies.filter(dep => dep.status !== 'succeeded')) detail.append(node('div',`依赖 ${dep.task_id} · ${statuses[dep.status] || dep.status}`));
        const actions = doc.createElement('td'); actions.append(button('重试此项', () => control(id,'retry',{ task_ids:[task.task_id] }),active));
        if (task.locations[0]) actions.append(button('查看样本', () => options.onResults?.(id,task.locations[0])));
        row.append(locations,stage,status,detail,actions); return row;
      }));
      $('batch-error-history').replaceChildren(...value.records.map(item => {
        const details = doc.createElement('details'); details.append(node('summary',`${item.record.time || ''} · ${stages[item.record.stage] || item.record.stage || '运行'} · ${item.recovery === 'recovered' ? '已恢复' : item.recovery === 'unknown' ? '恢复状态未知' : '未恢复'} · ${item.record.message || item.record.event}`));
        details.append(node('pre',JSON.stringify(item,null,2))); return details;
      }));
      const total = Math.max(value.total,value.unresolved_count);
      $('batch-error-page').textContent = `${page} / ${Math.max(1,Math.ceil(total/value.page_size))}`;
      $('batch-error-prev').disabled = page === 1; $('batch-error-next').disabled = page * value.page_size >= total;
      if (scroll) $('batch-errors').scrollIntoView({ block:'start' });
    } catch (failure) { if (!disposed && version === errorRevision) error(failure.message); }
  }
  function invalidate() { selectionRevision++; prepared = undefined; $('batch-start').disabled = true; $('batch-preview-summary').textContent = ''; }
  $('batch-launch-form').addEventListener('change',invalidate);
  $('batch-launch-form').addEventListener('input',invalidate);
  $('batch-launch-form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !selected.length || !$('batch-launch-form').reportValidity()) return;
    busy = true; $('batch-preview').disabled = true; error(''); invalidate();
    const selection = selectionRevision;
    try {
      const value = await api('batch-runs/preview',{ batch_ids:selected,engine:$('batch-engine').value,settings:{ execution:{ concurrency:Number($('batch-concurrency').value) } } });
      if (selection !== selectionRevision || disposed) return;
      prepared = value; const s = value.summary;
      $('batch-preview-summary').textContent = `${value.task.name} · ${s.valid_inputs} 个回答 · ${s.attribution_tasks} 个归因 · ${s.comparison_tasks} 个对局 · ${s.issues_count} 个输入异常`;
      $('batch-evaluator').textContent = '被评模型：' + value.models.join(' / ') + '；评测模型：' + Object.entries(value.evaluator_models).map(([stage,model]) => `${stages[stage] || stage} ${model}`).join(' / ');
      $('batch-output').textContent = value.output_dir;
      $('batch-start').disabled = !value.tasks || !!s.issues_count;
      await refresh();
    } catch (failure) { error(failure.message); }
    finally { busy = false; $('batch-preview').disabled = false; }
  });
  $('batch-start').onclick = async () => { if (!prepared) return; $('batch-start').disabled = true; await control(prepared.run_id,'start'); };
  $('batch-refresh').onclick = () => void refresh();
  for (const id of ['batch-stage','batch-case','batch-history']) $(id).onchange = () => { page = 1; if (current) void showErrors(current,false); };
  $('batch-error-prev').onclick = () => { page--; void showErrors(current,false); }; $('batch-error-next').onclick = () => { page++; void showErrors(current,false); };
  const timer = setInterval(() => { if (!busy && doc.visibilityState !== 'hidden') void refresh(); },5000);
  return { ready:refresh(), select(ids) { selected = [...ids]; invalidate(); $('batch-launch').hidden = false; $('batch-selection').textContent = `已选 ${ids.length} 个清洗批次`; $('batch-launch').scrollIntoView({ block:'start' }); },
    showErrors, destroy() { disposed = true; revision++; errorRevision++; clearInterval(timer); } };
}
