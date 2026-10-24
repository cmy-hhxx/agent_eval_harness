const sourceLabels = { wencai:'问财日常四路', aime:'AIME 日常全量' };
const statusLabels = { idle:'待运行', running:'运行中', pausing:'暂停中', paused:'已暂停', stopping:'停止中', failed:'失败', finished:'已完成', completed:'已完成', pending:'待处理', queued:'排队', stable:'待处理', uploading:'上传中', cleaning:'清洗中', cleaned:'清洗完成', evaluating:'评测中', interrupted:'已中断', ready:'已就绪', retry:'等待重试', stopped:'已停止', waiting:'等待数据', waiting_inputs:'等待配对', partial:'部分完成', empty:'无有效数据', cancelling:'取消中', cancelled:'已取消', uploaded:'已上传', blocked:'已暂停' };
const stageLabels = { criteria:'共同标准', score:'独立评分', attribution:'回答归因', comparison:'对比', rewrite:'改写', clustering:'聚类' };
const live = status => ['running','pausing','stopping'].includes(status);
const textStatus = status => statusLabels[status] || status || '未知';
const numeric = value => typeof value === 'number' && Number.isFinite(value);

export function mountDaily(root, options = {}) {
  const $ = id => root.querySelector('#' + id), doc = root.ownerDocument || root;
  const fetcher = options.fetch || globalThis.fetch;
  let data, selected = 'wencai', formSource, busy = false, connected = false, timer, disposed = false, revision = 0;
  const sourceBusy = new Set(), drafts = new Map(), settingsMessages = new Map(), packageViews = new Map(), reports = new Map(), reportSections = new Map();
  const node = (tag, text) => { const item = doc.createElement(tag); item.textContent = text ?? ''; return item; };
  function button(label, action, disabled = false) { const item = node('button',label); item.type = 'button'; item.className = 'button'; item.disabled = disabled; item.onclick = () => void action(); return item; }
  function error(message) { if (disposed) return; $('daily-error').textContent = message || ''; $('daily-error').hidden = !message; }
  async function api(path = '', body) {
    const response = await fetcher('/runtime/api/daily' + path, { cache:'no-store', signal:AbortSignal.timeout(30000), ...(body === undefined ? {} : {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}) });
    const value = await response.json(); if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`); return value;
  }
  async function control(id, action) {
    if (!connected || sourceBusy.has(id)) return;
    sourceBusy.add(id); renderSources();
    try { await api(`/${encodeURIComponent(id)}/control`,{action}); await refresh(); }
    catch (cause) { error(`${sourceLabels[id]}：${cause.message}`); }
    finally { sourceBusy.delete(id); renderSources(); }
  }
  async function concurrency(id, input, output) {
    sourceBusy.add(id); renderSources();
    try { await api(`/${encodeURIComponent(id)}/concurrency`,{concurrency:Number(input.value)}); input.dataset.dirty = ''; await refresh(); }
    catch (cause) { output.textContent = cause.message; }
    finally { sourceBusy.delete(id); renderSources(); }
  }
  function renderSources() {
    if (!data || disposed) return;
    for (const source of data.sources) {
      let row = $('daily-source-rows').querySelector(`[data-source="${source.id}"]`);
      if (!row) {
        row = doc.createElement('tr'); row.dataset.source = source.id;
        const name = doc.createElement('td'); name.append(button(sourceLabels[source.id] || source.name, () => { if (selected !== source.id) { selected = source.id; formSource = undefined; render(); } }));
        const state = doc.createElement('td'), pending = doc.createElement('td'), completed = doc.createElement('td'), failed = doc.createElement('td'), requests = doc.createElement('td'), allocation = doc.createElement('td'), actions = doc.createElement('td');
        pending.dataset.cell = 'pending'; completed.dataset.cell = 'completed'; failed.dataset.cell = 'failed'; pending.className = completed.className = failed.className = 'daily-number';
        state.dataset.cell = 'status'; requests.dataset.cell = 'requests'; actions.dataset.cell = 'actions';
        const form = doc.createElement('form'), input = doc.createElement('input'), output = doc.createElement('output');
        form.className = 'daily-concurrency'; input.type = 'number'; input.min = '1'; input.required = true; input.setAttribute('aria-label',`${sourceLabels[source.id] || source.name} LLM 并发`);
        input.oninput = () => { input.dataset.dirty = 'true'; }; const apply = node('button','应用'); apply.className = 'button'; apply.type = 'submit'; form.append(input,apply,output);
        form.onsubmit = event => { event.preventDefault(); void concurrency(source.id,input,output); }; allocation.append(form); row.append(name,state,pending,completed,failed,requests,allocation,actions); $('daily-source-rows').append(row);
      }
      row.classList.toggle('selected',source.id === selected); row.querySelector('td:first-child button').setAttribute('aria-pressed',String(source.id === selected));
      row.querySelector('[data-cell=status]').textContent = textStatus(source.status);
      const stages = Object.values(source.stages || {});
      for (const key of ['pending','completed','failed']) row.querySelector(`[data-cell=${key}]`).textContent = stages.length && stages.every(counts => numeric(counts[key])) ? stages.reduce((sum,counts) => sum + counts[key],0) : '';
      row.querySelector('[data-cell=requests]').textContent = `${source.activeRequests || 0} / ${source.waitingRequests || 0}`;
      const input = row.querySelector('input'); if (!input.dataset.dirty && root.activeElement !== input) input.value = source.concurrency;
      row.querySelectorAll('input,button').forEach(item => { item.disabled = !connected || sourceBusy.has(source.id); });
      const disabled = !connected || sourceBusy.has(source.id), actions = row.querySelector('[data-cell=actions]');
      actions.replaceChildren();
      if (source.status === 'paused') actions.append(button('继续',() => control(source.id,'resume'),disabled));
      else if (!live(source.status)) actions.append(button('评测',() => control(source.id,'run'),disabled));
      if (source.status === 'running') actions.append(button('暂停',() => control(source.id,'pause'),disabled));
      if (live(source.status) || source.status === 'paused') actions.append(button('立即停止',() => control(source.id,'stop'),disabled || source.status === 'stopping'));
    }
    $('daily-requests-total').textContent = `实际 LLM 请求 ${data.sources.reduce((sum,source) => sum + (source.activeRequests || 0),0)} · 等待 ${data.sources.reduce((sum,source) => sum + (source.waitingRequests || 0),0)}`;
  }
  function renderSettings(source) {
    if (formSource === source.id) return;
    formSource = source.id; const settings = drafts.get(source.id) || source.settings || {}, execution = settings.execution || {};
    $('daily-settings-status').textContent = settingsMessages.get(source.id) || (drafts.has(source.id) ? '未保存' : '');
    $('daily-engine').value = settings.engine || 'pi'; $('daily-timeout').value = execution.timeoutSeconds ?? 3600; $('daily-tools').value = execution.maxToolCalls ?? 20; $('daily-retries').value = execution.retries ?? 1; $('daily-debug').checked = settings.debug === true;
    $('daily-repairs').value = execution.repairAttempts ?? 1; $('daily-attempts').value = execution.maxTaskAttempts ?? ''; $('daily-retry-delay').value = execution.retryDelaySeconds ?? 10;
    const catalog = source.modelCatalog || [];
    $('daily-bindings').replaceChildren(...Object.entries(settings.bindings || {}).filter(([stage]) => stage !== 'clustering').map(([stage,binding]) => {
      const field = doc.createElement('div'); field.className = 'daily-binding'; const label = node('label',stageLabels[stage] || stage), select = doc.createElement('select'); select.dataset.stage = stage;
      select.setAttribute('aria-label',`${stageLabels[stage] || stage}评测模型`); select.append(new Option('未选模型',''),...catalog.map(model => new Option(model.name || model.id,JSON.stringify([model.channel,model.id]))));
      select.value = JSON.stringify([binding.channel,binding.model]); label.append(select); const thinkingLabel = node('label','推理档位'), thinking = doc.createElement('select'); thinking.dataset.thinking = stage;
      thinking.append(...['off','minimal','low','medium','high','xhigh','max'].map(value => new Option(value,value))); thinking.value = binding.thinking || 'medium'; thinkingLabel.append(thinking); field.append(label,thinkingLabel); return field;
    }));
    $('daily-rewrites').replaceChildren(...Object.entries(settings.rewrite || {}).filter(([stage]) => ['attribution','comparison'].includes(stage)).map(([stage,enabled]) => {
      const label = doc.createElement('label'), check = doc.createElement('input'); check.type = 'checkbox'; check.dataset.rewrite = stage; check.checked = enabled === true; label.append(check,doc.createTextNode(` 改写${stageLabels[stage] || stage}评语`)); return label;
    }));
  }
  function renderDetail() {
    if (disposed) return;
    const source = data?.sources.find(item => item.id === selected); $('daily-detail').hidden = !source; if (!source) return;
    $('daily-title').textContent = sourceLabels[source.id] || source.name;
    $('daily-paths').replaceChildren(...[['收包目录',source.archiveDirectory],['结果目录',source.outputDirectory]].map(([label,value]) => { const item = doc.createElement('div'); item.append(node('dt',label),node('dd',value)); return item; }));
    const sourceError = [source.error,source.packageError,source.modelCatalogError].filter(Boolean).join('\n');
    $('daily-source-error').textContent = sourceError; $('daily-source-error').hidden = !sourceError; renderSettings(source);
    const stageCounts = Object.values(source.stages || {}), taskTotal = numeric(source.taskTotal) ? source.taskTotal : stageCounts.length && stageCounts.every(counts => numeric(counts.total)) ? stageCounts.reduce((sum,counts) => sum + counts.total,0) : undefined;
    const taskCompleted = numeric(source.taskCompleted) ? source.taskCompleted : stageCounts.length && stageCounts.every(counts => numeric(counts.completed)) ? stageCounts.reduce((sum,counts) => sum + counts.completed,0) : undefined;
    const counts = [['问句',source.questions],['回答',source.answers],['完整回答',source.completedAnswers]].filter(([,value]) => numeric(value)).map(([label,value]) => `${label} ${value}`);
    if (numeric(taskTotal)) counts.push(`阶段任务 ${numeric(taskCompleted) ? taskCompleted + ' / ' : ''}${taskTotal}`);
    const models = Object.entries(source.models || {}).filter(([id]) => ['aime_fast','aime_expert'].includes(id));
    $('daily-aime-coverage').hidden = source.id !== 'aime' || !counts.length && !models.length;
    $('daily-aime-counts').textContent = source.id === 'aime' ? counts.join(' · ') : '';
    $('daily-aime-model-table').hidden = !models.length;
    $('daily-aime-model-rows').replaceChildren(...models.map(([id,model]) => { const row = doc.createElement('tr'); row.append(node('td',id === 'aime_fast' ? 'Fast' : 'Expert'),...['answers','completed','failed','pending'].map(key => node('td',numeric(model[key]) ? model[key] : ''))); return row; }));
    $('daily-settings-heading').textContent = source.activeSettings ? '下次执行配置' : '执行配置';
    $('daily-active-settings').hidden = !source.activeSettings;
    if (source.activeSettings) {
      const current = source.activeSettings, execution = current.execution || {};
      $('daily-active-values').replaceChildren(...[['引擎',current.engine],...Object.entries(current.bindings || {}).filter(([stage]) => stage !== 'clustering').map(([stage,binding]) => [stageLabels[stage] || stage,`${binding.model} · ${binding.thinking}`]),['执行预算',`超时 ${execution.timeoutSeconds} 秒 · 工具 ${execution.maxToolCalls} · 传输重试 ${execution.retries} · 修正 ${execution.repairAttempts} · 尝试 ${execution.maxTaskAttempts ?? '按当前预算'} · 间隔 ${execution.retryDelaySeconds} 秒`],['Debug',current.debug ? '开启' : '关闭']].map(([label,value]) => { const item = doc.createElement('div'); item.append(node('dt',label),node('dd',value)); return item; }));
    }
    $('daily-settings-form').querySelectorAll('input,select,button').forEach(item => { item.disabled = !connected || busy; });
    $('daily-stages').replaceChildren(...Object.entries(source.stages || {}).map(([stage,counts]) => {
      const item = doc.createElement('div'); item.append(node('strong',stageLabels[stage] || stage),node('span',`${counts.completed || 0} / ${counts.total || 0}`),node('span',`进行中 ${counts.running || 0} · 待处理 ${counts.pending || 0} · 失败 ${counts.failed || 0}${counts.blocked ? ` · 阻塞 ${counts.blocked}` : ''}`)); return item;
    }));
    $('daily-mongo').hidden = !source.mongo; $('daily-mongo-status').textContent = source.mongo ? `${textStatus(source.mongo.status)} · 输入 ${source.mongo.inputs || 0} · 结果 ${source.mongo.outputs || 0}${source.mongo.error ? '\n' + source.mongo.error : ''}` : '';
    const packages = packageViews.get(source.id) || source.packages || {items:[],total:0,page:1,pageSize:40}, pages = Math.max(1,Math.ceil(packages.total / packages.pageSize));
    $('daily-package-rows').replaceChildren(...packages.items.map(item => { const row = doc.createElement('tr'), actions = doc.createElement('td'); actions.append(button('查看',() => selectReport(source.id,item))); row.append(node('td',item.name),node('td',textStatus(item.status)),node('td',`${item.accepted || 0} / ${item.excluded || 0}`),node('td',item.error),actions); return row; }));
    $('daily-package-page').textContent = `${packages.page} / ${pages} · ${packages.total} 个包`; $('daily-package-prev').disabled = packages.page <= 1; $('daily-package-next').disabled = packages.page >= pages;
    renderReport();
    $('daily-run-rows').replaceChildren(...(source.runs || []).map(run => { const row = doc.createElement('tr'), name = node('td',run.date); name.append(node('div',run.run_id)); const actions = doc.createElement('td'); actions.append(button('查看结果',() => options.onResults?.(source.id,run.run_id))); row.append(name,node('td',textStatus(run.status)),node('td',`${run.completed || 0} / ${run.total || 0}`),actions); return row; }));
  }
  function render() {
    if (disposed) return;
    renderSources(); renderDetail();
    $('daily-request-rows').replaceChildren(...(data?.requests || []).map(request => { const row = doc.createElement('tr'); row.append(node('td',sourceLabels[request.sourceId] || request.sourceId),node('td',stageLabels[request.stage] || request.stage),node('td',`${request.model}\n${request.channel || ''}`),node('td',request.startedAt ? new Date(request.startedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}) : ''),node('td',request.taskId)); return row; }));
  }
  async function refresh() {
    const current = ++revision;
    clearTimeout(timer);
    try { const value = await api(); if (disposed || current !== revision) return; data = value; connected = true; error(''); render(); const report = reports.get(selected); if (report) await loadReport(selected,report); }
    catch (cause) { if (disposed || current !== revision) return; connected = false; error(`读取失败：${cause.message}`); renderSources(); renderDetail(); }
    finally { if (!disposed && (data?.sources.some(source => live(source.status)) || !connected)) timer = setTimeout(() => void refresh(),5000); }
  }
  async function packagePage(step) {
    const id = selected, source = data?.sources.find(item => item.id === id), current = packageViews.get(id) || source?.packages;
    if (!current) return;
    try { const value = await api(`/${id}/packages?page=${current.page + step}`); packageViews.set(id,value); if (selected === id) renderDetail(); }
    catch (cause) { error(`数据包读取失败：${cause.message}`); }
  }
  function renderReport() {
    const report = reports.get(selected); $('daily-package-report').hidden = !report; if (!report) return;
    $('daily-package-report').setAttribute('aria-busy',String(report.loading === true));
    $('daily-report-title').textContent = report.name; $('daily-report-section').value = report.section;
    $('daily-report-error').textContent = report.error || ''; $('daily-report-error').hidden = !report.error;
    const value = report.value, summary = value?.summary;
    $('daily-report-summary').textContent = summary ? `${textStatus(value.status)} · 读入 ${summary.read || 0} · 纳入 ${summary.accepted || 0} · 排除 ${summary.excluded || 0} · 问句 ${summary.questions || 0} · 元数据异常 ${summary.metadata_issue_count || 0}` : '';
    $('daily-report-file-errors').replaceChildren(...(summary?.file_errors || []).map(item => node('p',`${item.original_file || ''} · ${item.reason || ''}${item.error ? ' · ' + item.error : ''}`)),...(summary?.error ? [node('p',summary.error)] : []));
    $('daily-report-rows').replaceChildren(...(value?.items || []).map(item => {
      const row = doc.createElement('tr'), location = node('td',item.original_file), coverage = doc.createElement('td'), results = doc.createElement('td');
      location.append(node('div',`${item.original_line ?? '—'} / ${item.original_item ?? '—'}`));
      if (report.section === 'records') {
        for (const [stage,counts] of Object.entries(item.coverage?.stages || {})) coverage.append(node('div',`${stageLabels[stage] || stage} ${counts.completed || 0} / ${counts.total || 0} · 失败 ${counts.failed || 0} · 待处理 ${counts.pending || 0} · 进行中 ${counts.running || 0}`));
        if (item.coverage?.mongoStatus) coverage.append(node('div',`MongoDB ${textStatus(item.coverage.mongoStatus)}`));
        const id = selected;
        for (const runId of item.coverage?.runIds || []) results.append(button(runId,() => options.onResults?.(id,runId)));
      } else coverage.textContent = report.section === 'metadata_issues' ? `${item.field || ''} · ${item.error || item.reason || ''}` : item.reason || item.error || '';
      row.append(node('td',`${item.model || ''}\n${item.case_id || ''}`),location,coverage,results); return row;
    }));
    const pages = Math.max(1,Math.ceil((value?.total || 0) / (value?.page_size || 50)));
    $('daily-report-page').textContent = `${value?.page || report.page} / ${pages} · ${value?.total || 0} 条`;
    $('daily-report-prev').disabled = report.loading || report.page <= 1; $('daily-report-next').disabled = report.loading || report.page >= pages;
  }
  async function selectReport(id,item) {
    const report = {id:item.id,name:item.name,section:reportSections.get(id) || 'records',page:1,version:0}; reports.set(id,report); renderReport(); await loadReport(id,report);
  }
  async function loadReport(id,report) {
    const version = ++report.version; report.loading = true;
    if (selected === id) renderReport();
    try {
      const value = await api(`/${encodeURIComponent(id)}/packages/${encodeURIComponent(report.id)}/report?${new URLSearchParams({section:report.section,page:String(report.page)})}`);
      if (disposed || reports.get(id) !== report || version !== report.version) return;
      report.value = value; report.error = '';
    } catch (cause) { if (reports.get(id) === report && version === report.version) report.error = `报告读取失败：${cause.message}`; }
    finally { if (!disposed && reports.get(id) === report && version === report.version) { report.loading = false; if (selected === id) renderReport(); } }
  }
  function reportPage(step) { const report = reports.get(selected); if (!report || report.loading) return; report.page += step; void loadReport(selected,report); }
  $('daily-report-section').onchange = event => { const report = reports.get(selected); if (!report) return; report.section = event.target.value; reportSections.set(selected,report.section); report.page = 1; report.value = undefined; void loadReport(selected,report); };
  $('daily-report-prev').onclick = () => reportPage(-1); $('daily-report-next').onclick = () => reportPage(1);
  $('daily-refresh').onclick = () => void refresh(); $('daily-package-prev').onclick = () => void packagePage(-1); $('daily-package-next').onclick = () => void packagePage(1);
  function settingsValue() {
    const bindings = {}, rewrite = {};
    $('daily-bindings').querySelectorAll('[data-stage]').forEach(input => { const choice = input.value ? JSON.parse(input.value) : []; bindings[input.dataset.stage] = {channel:choice[0] || '',model:choice[1] || '',thinking:$('daily-bindings').querySelector(`[data-thinking="${input.dataset.stage}"]`).value}; });
    $('daily-rewrites').querySelectorAll('input').forEach(input => { rewrite[input.dataset.rewrite] = input.checked; });
    const execution = {timeoutSeconds:Number($('daily-timeout').value),maxToolCalls:Number($('daily-tools').value),retries:Number($('daily-retries').value),repairAttempts:Number($('daily-repairs').value),retryDelaySeconds:Number($('daily-retry-delay').value)};
    if ($('daily-attempts').value) execution.maxTaskAttempts = Number($('daily-attempts').value);
    return {engine:$('daily-engine').value,bindings,execution,...(data?.sources.find(source => source.id === selected)?.workflow === 'answer-review' ? {} : {rewrite}),debug:$('daily-debug').checked};
  }
  $('daily-settings-form').oninput = $('daily-settings-form').onchange = () => { drafts.set(selected,settingsValue()); settingsMessages.set(selected,'未保存'); $('daily-settings-status').textContent = '未保存'; };
  $('daily-settings-form').onsubmit = async event => {
    event.preventDefault(); if (busy || !connected) return; const id = selected, settings = settingsValue(); busy = true; renderDetail();
    try { await api(`/${id}/settings`,settings); drafts.delete(id); settingsMessages.set(id,'已保存 · 下次评测或继续时生效'); await refresh(); if (!disposed && selected === id) $('daily-settings-status').textContent = settingsMessages.get(id); }
    catch (cause) { settingsMessages.set(id,cause.message); if (!disposed && selected === id) $('daily-settings-status').textContent = cause.message; }
    finally { busy = false; renderDetail(); }
  };
  const ready = refresh();
  function select(id) { if (selected !== id) { selected = id; formSource = undefined; render(); } }
  return { ready, refresh, select, async openExclusions(id) {
    select(id); reportSections.set(id,'exclusions');
    const source = data?.sources.find(source => source.id === id), packages = packageViews.get(id) || source?.packages;
    const item = packages?.items.find(item => item.excluded > 0) || packages?.items[0];
    if (item) await selectReport(id,item);
    else { reports.delete(id); renderReport(); $('daily-report-section').value = 'exclusions'; }
    $('daily-package-rows').scrollIntoView({block:'start'});
  }, destroy() { disposed = true; clearTimeout(timer); } };
}
