const $ = id => document.getElementById(id);
const state = { presets: [], source: 'wencai', selected: null, preview: null, cursor: null, tasks: [], polling: false, capacity: null };
const names = { draft: '待启动', starting: '启动中', running: '运行中', pausing: '暂停中', paused: '已暂停', finished: '已完成', partial: '部分完成', failed: '失败' };
function node(tag, text, className) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; }
function button(text, action, className = 'text-button') { const el = node('button', text, className); el.type = 'button'; el.onclick = action; return el; }
const basename = file => file.replace(/\/$/, '').split('/').at(-1);
const shortPath = file => '…/' + file.replace(/\/$/, '').split('/').slice(-2).join('/');
async function api(url, value) {
  const response = await fetch(url, value === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-console-request': '1' }, body: JSON.stringify(value) });
  const result = await response.json();
  if (!response.ok) { if (response.status === 401) showLogin(); throw new Error(result.error || '请求失败'); }
  return result;
}
function showLogin() { document.querySelectorAll('dialog[open]').forEach(el => el.close()); $('login').hidden = false; $('app').hidden = true; $('logout').hidden = true; }
async function busy(el, target, action) {
  el.disabled = true; $(target).textContent = '';
  try { await action(); } catch (error) { $(target).textContent = error.message; }
  finally { el.disabled = false; }
}
function outputEditor(file) {
  const details = node('details', undefined, 'path-editor output-editor');
  const summary = node('summary'), label = node('span', undefined, 'path-label');
  const title = node('span', shortPath(file), 'path-name');
  label.append(title); summary.append(label); summary.title = file;
  const field = node('textarea'); field.id = 'output'; field.value = file; field.rows = 3; field.required = true; field.spellcheck = false;
  field.setAttribute('aria-label', '评测输出路径');
  field.oninput = () => { summary.title = field.value; title.textContent = field.value.trim() ? shortPath(field.value.trim()) : '填写输出路径'; };
  details.append(summary, field); return details;
}
function fillPreset() {
  const preset = state.presets.find(p => p.id === $('preset').value); if (!preset) return;
  $('input-directory').value = preset.inputDirectory;
  $('output-field').replaceChildren(outputEditor(preset.output));
  $('concurrency').value = preset.concurrency; $('config-error').textContent = '';
}
function setSource(value) {
  state.source = value;
  document.querySelectorAll('[data-source]').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.source === value)));
  renderTasks();
}
function editMode() {
  state.preview = null; $('configuration').hidden = false; $('preview-summary').hidden = true;
  $('preview-button').hidden = false; $('start').hidden = true; $('back').hidden = true; $('download-preview').hidden = true;
  $('create-title').textContent = '新建评测'; $('config-error').textContent = '';
}
function openCreate() {
  editMode(); $('preset').replaceChildren(...state.presets.filter(p => p.source === state.source).map(p => { const option = node('option', p.name); option.value = p.id; return option; }));
  fillPreset(); $('create').showModal();
}
function readPath(file, label = basename(file)) {
  const details = node('details', undefined, 'path-read'), summary = node('summary', label);
  summary.title = file; details.append(summary, node('div', file, 'full-path')); return details;
}
function summary(task, target) {
  target.replaceChildren();
  const check = task.dataCheck;
  if (check?.status === 'ready') {
    const counts = node('div', undefined, 'check-counts');
    for (const [label, value, unit] of [['将读入', check.readRecords, '条输入'], ['可评测', check.total, check.unit], ['已有结果跳过', check.skipped, check.unit], ['预计待评', check.pending, check.unit]]) {
      const item = node('div'); item.append(node('span', label), node('strong', value.toLocaleString()), node('small', unit)); counts.append(item);
    }
    target.append(counts, node('p', check.files + ' 个文件 · ' + formatBytes(check.bytes) + ' · 检查 ' + (check.elapsedMs / 1000).toFixed(1) + ' 秒', 'check-meta'));
    if (check.invalidRecords || check.unavailable) {
      const detail = node('details', undefined, 'check-issues');
      detail.append(node('summary', [check.invalidRecords ? '无效输入 ' + check.invalidRecords + ' 条' : '', check.unavailable ? '无法配对 ' + check.unavailable + ' 场' : ''].filter(Boolean).join(' · ')));
      for (const issue of check.issues) detail.append(node('div', issue.file + ':' + (issue.line || '') + ' ' + issue.reason, 'full-path'));
      target.append(detail);
    }
  }
  const inputs = node('div');
  if (task.inputDirectory) inputs.append(readPath(task.inputDirectory, shortPath(task.inputDirectory)));
  for (const input of task.inputs) inputs.append(readPath(input.paths.join('\n'),
    input.paths.length > 1 ? input.name + ' · ' + input.paths.length + ' 个文件' : basename(input.paths[0])));
  const logs = node('div'); for (const file of task.logs) logs.append(readPath(file));
  const output = node('div'); output.append(readPath(task.output, shortPath(task.output)));
  if (check?.destinations.length) output.append(readPath(check.destinations.join('\n'), '主要结果文件 · ' + check.destinations.length));
  for (const [label, content] of [['输入', inputs], ['输出', output], ['并发', node('span', String(task.concurrency))], ['日志', logs]]) {
    const row = node('div', undefined, 'summary-row'), value = node('div', undefined, 'summary-value'); value.append(content); row.append(node('span', label), value); target.append(row);
  }
  for (const warning of task.warnings || []) target.append(node('p', warning, 'path-warning'));
  if (check?.status === 'ready') target.append(node('p', '数量以本次检查为准，启动时按最新结果跳过。', 'check-meta'));
}
function formatBytes(value) { return value >= 1024 ** 3 ? (value / 1024 ** 3).toFixed(2) + ' GB' : (value / 1024 ** 2).toFixed(1) + ' MB'; }
function checking(task) {
  const check = task.dataCheck;
  const text = node('p', '已检查 ' + check.checkedFiles + ' / ' + check.files + ' 个文件 · 已读取 ' + check.readRecords.toLocaleString() + ' 条', 'check-meta');
  const bar = node('progress'); bar.setAttribute('aria-label', '数据检查进度');
  $('preview-summary').replaceChildren(text, bar);
}
function openCapacity(task) { state.capacity = task.id; $('capacity-value').value = task.concurrency; $('capacity-error').textContent = ''; $('capacity').showModal(); $('capacity-value').select(); }
function renderTasks() {
  for (const channel of ['wencai', 'aime']) document.querySelector('[data-count="' + channel + '"]').textContent = state.tasks.filter(t => t.source === channel).length;
  const tasks = state.tasks.filter(t => t.source === state.source); $('task-list').replaceChildren(); $('empty').hidden = tasks.length > 0;
  for (const task of tasks) {
    const row = node('tr'), title = node('td');
    title.append(button(task.name, () => openDetail(task.id, 'config'), 'task-title'), node('span', task.id.slice(8, 16), 'task-id'));
    const status = node('td'); status.append(node('span', task.status === 'running' && !task.progress && !task.requests?.active ? '加载输入' : names[task.status], 'status ' + task.status));
    if (task.error) { const error = node('span', task.error, 'task-error-mark'); error.title = task.error; status.append(error); }
    const progress = node('td'), p = task.progress, finished = task.status === 'finished';
    progress.append(node('span', finished ? (task.result?.skipped_cases ? '跳过 ' + task.result.skipped_cases + ' 项' : '已完成') : p?.total ? p.completed + ' / ' + p.total + ' 步' : '—', 'progress-text'));
    if (p?.total || finished || task.status === 'running') { const bar = node('progress'); bar.setAttribute('aria-label', '评测进度'); if (finished || p?.total) { bar.max = finished ? 1 : p.total; bar.value = finished ? 1 : p.completed; } progress.append(bar); }
    const capacity = node('td', undefined, 'num'); capacity.append(finished ? node('span', String(task.concurrency)) : button(String(task.concurrency), () => openCapacity(task)));
    if (!finished) capacity.querySelector('button').setAttribute('aria-label', task.name + ' 调整并发');
    const date = node('td', new Date(task.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }), 'date-cell');
    const operations = node('td'), actions = node('div', undefined, 'row-actions');
    if (['starting', 'running', 'pausing'].includes(task.status)) {
      const pause = button(task.status === 'pausing' ? '暂停中' : '暂停', () => busy(pause, 'task-error', async () => { await api('/api/tasks/' + task.id + '/pause', {}); await refresh(); })); pause.disabled = task.status === 'pausing'; actions.append(pause);
    } else if (['paused', 'failed', 'partial'].includes(task.status)) {
      const resume = button('继续', () => busy(resume, 'task-error', async () => { await api('/api/tasks/' + task.id + '/resume', {}); await refresh(); })); actions.append(resume);
    }
    actions.append(button('日志', () => openDetail(task.id, 'logs')), button('配置', () => openDetail(task.id, 'config'))); operations.append(actions);
    row.append(title, status, progress, capacity, date, operations); $('task-list').append(row);
  }
}
async function openDetail(id, tab) {
  state.selected = id; state.cursor = null; const task = state.tasks.find(t => t.id === id); if (!task) return;
  $('detail-title').textContent = task.name + ' · ' + id.slice(8, 16); summary(task, $('detail-config'));
  $('download-task').href = '/api/tasks/' + id + '/configuration'; setDetail(tab); if (!$('detail').open) $('detail').showModal();
}
function setDetail(tab) {
  document.querySelectorAll('[data-detail]').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.detail === tab)));
  $('logs-panel').hidden = tab !== 'logs'; $('detail-config').hidden = tab !== 'config'; if (tab === 'logs') void loadLogs();
}
async function loadLogs(older = false) {
  if (!state.selected) return; const id = state.selected, kind = $('log-kind').value, errors = $('errors-only').checked;
  $('log-error').textContent = '';
  try {
    const result = await api('/api/tasks/' + id + '/logs?kind=' + kind + '&errors=' + Number(errors) + (older && state.cursor !== null ? '&cursor=' + state.cursor : ''));
    if (id !== state.selected || kind !== $('log-kind').value || errors !== $('errors-only').checked) return;
    state.cursor = result.cursor; $('older').hidden = result.cursor === null; $('log-output').replaceChildren();
    if (!result.rows.length) $('log-output').append(node('p', errors ? '暂无错误记录' : '暂无日志', 'log-empty'));
    for (const record of result.rows.reverse()) {
      const entry = node('details', undefined, 'log-entry');
      const time = record.time ? new Date(record.time).toLocaleTimeString('zh-CN', { hour12: false }) : '';
      entry.append(node('summary', [time, record.message || record.event || record.task_id].filter(Boolean).join(' · '), record.level === 'error' ? 'error' : undefined), node('pre', JSON.stringify(record, null, 2))); $('log-output').append(entry);
    }
  } catch (error) { $('log-error').textContent = error.message; }
}
async function refresh() { state.tasks = await api('/api/tasks'); renderTasks(); $('freshness').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false }) + ' 更新'; }
async function initialize() {
  try { state.presets = await api('/api/presets'); $('login').hidden = true; $('app').hidden = false; $('logout').hidden = false; setSource(state.source); await refresh(); }
  catch (error) { ($('app').hidden ? $('login-error') : $('task-error')).textContent = error.message === '请先登录' ? '' : error.message; }
}
$('login').onsubmit = event => { event.preventDefault(); void busy($('login').querySelector('button'), 'login-error', async () => { await api('/api/login', { password: $('password').value }); $('password').value = ''; await initialize(); }); };
$('logout').onclick = () => busy($('logout'), 'task-error', async () => { await api('/api/logout', {}); showLogin(); });
document.querySelectorAll('[data-source]').forEach(el => el.onclick = () => setSource(el.dataset.source));
document.querySelectorAll('[data-detail]').forEach(el => el.onclick = () => setDetail(el.dataset.detail));
$('new-task').onclick = openCreate; $('empty-create').onclick = openCreate; $('preset').onchange = fillPreset; $('back').onclick = editMode;
$('close-create').onclick = () => $('create').close(); $('create').onclose = () => { state.preview = null; };
$('close-detail').onclick = $('close-detail-bottom').onclick = () => $('detail').close(); $('close-capacity').onclick = () => $('capacity').close();
$('configuration').addEventListener('invalid', event => { const details = event.target.closest('details'); if (details) details.open = true; }, true);
$('configuration').onsubmit = event => {
  event.preventDefault(); void busy($('preview-button'), 'config-error', async () => {
    state.preview = await api('/api/previews', { preset: $('preset').value, inputDirectory: $('input-directory').value.trim(), output: $('output').value.trim(), concurrency: Number($('concurrency').value) });
    const id = state.preview.id;
    $('configuration').hidden = true; $('preview-summary').hidden = false; $('preview-button').hidden = true; $('back').hidden = false; $('create-title').textContent = 'Check data';
    while (state.preview?.id === id && state.preview.dataCheck.status === 'checking') {
      checking(state.preview);
      await new Promise(resolve => setTimeout(resolve, 700));
      const task = await api('/api/tasks/' + id);
      if (state.preview?.id !== id) return;
      state.preview = task;
    }
    if (state.preview?.id !== id) return;
    $('back').hidden = false;
    if (state.preview.dataCheck.status === 'failed') {
      $('preview-summary').replaceChildren(); throw new Error(state.preview.dataCheck.error);
    }
    summary(state.preview, $('preview-summary')); $('download-preview').href = '/api/tasks/' + state.preview.id + '/configuration';
    $('configuration').hidden = true; $('preview-summary').hidden = false; $('preview-button').hidden = true; $('start').hidden = false; $('back').hidden = false; $('download-preview').hidden = false; $('create-title').textContent = '确认评测';
    $('start').disabled = !state.preview.dataCheck.total;
    $('create').querySelector('.drawer-body').scrollTop = 0; $('start').focus();
  });
};
$('start').onclick = () => busy($('start'), 'config-error', async () => { const task = await api('/api/tasks', { previewId: state.preview.id }); state.selected = task.id; $('create').close(); await refresh(); });
$('capacity-form').onsubmit = event => { event.preventDefault(); void busy($('apply-capacity'), 'capacity-error', async () => { await api('/api/tasks/' + state.capacity + '/concurrency', { concurrency: Number($('capacity-value').value) }); $('capacity').close(); await refresh(); }); };
$('refresh').onclick = () => busy($('refresh'), 'task-error', refresh); $('refresh-logs').onclick = () => loadLogs();
$('log-kind').onchange = () => { $('errors-only').disabled = $('log-kind').value === 'evaluation'; if ($('errors-only').disabled) $('errors-only').checked = false; void loadLogs(); };
$('errors-only').onchange = () => loadLogs(); $('older').onclick = () => loadLogs(true);
setInterval(async () => { if ($('app').hidden || document.hidden || state.polling) return; state.polling = true; try { await refresh(); } catch (error) { $('task-error').textContent = '刷新失败：' + error.message; } finally { state.polling = false; } }, 4000);
void initialize();
