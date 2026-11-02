const $ = id => document.getElementById(id);
const state = { presets: [], source: 'wencai', selected: null, preview: null, cursor: null, tasks: [], polling: false, capacity: null, checked: new Set(), deleting: false, folderKind: null, folderData: null, folderRequest: 0 };
const names = { draft: '待启动', starting: '启动中', running: '运行中', pausing: '暂停中', paused: '已暂停', finished: '已完成', partial: '部分完成', failed: '失败' };
function node(tag, text, className) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; }
function button(text, action, className = 'text-button') { const el = node('button', text, className); el.type = 'button'; el.onclick = action; return el; }
const basename = file => file.replace(/\/$/, '').split('/').at(-1);
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
  const title = node('span', file, 'path-name');
  label.append(title); summary.append(label); summary.title = file;
  const field = node('textarea'); field.id = 'output'; field.value = file; field.rows = 3; field.required = true; field.spellcheck = false;
  field.setAttribute('aria-label', '评测输出路径');
  field.oninput = () => { summary.title = field.value; title.textContent = field.value.trim() || '填写输出路径'; };
  details.append(summary, field); return details;
}
function fillPreset() {
  const preset = state.presets.find(p => p.id === $('preset').value); if (!preset) return;
  $('input-directory').value = preset.inputDirectory;
  $('input-folder-stats').textContent = '';
  $('batch-id').value = '';
  $('output-field').replaceChildren(outputEditor(preset.output));
  $('concurrency').value = preset.concurrency; $('config-error').textContent = '';
}
function setSource(value) {
  if (state.source !== value) state.checked.clear();
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
function pathRoot(label, file) {
  const root = node('div', undefined, 'path-root');
  root.append(node('span', label, 'path-caption'), node('code', file)); return root;
}
function fileGroup(label, files, root) {
  const group = node('details', undefined, 'file-group'), heading = node('summary');
  group.open = files.length <= 3;
  heading.append(node('span', label), node('small', files.length + ' 项'));
  const list = node('ul', undefined, 'file-list');
  for (const file of files) {
    const item = node('li'), relative = root && file.startsWith(root.replace(/\/$/, '') + '/') ? file.slice(root.replace(/\/$/, '').length + 1) : file;
    const name = node('code', relative); name.title = file; item.append(name); list.append(item);
  }
  group.append(heading, list); return group;
}
function folderStats(stats) {
  if (!stats) return '尚未统计';
  return stats.files.toLocaleString() + ' 个文件 · 已统计 ' + stats.records.toLocaleString() + ' 条输入' +
    (stats.pendingFiles ? ' · ' + stats.pendingFiles + ' 项待统计或重试' : '') +
    ' · ' + new Date(stats.checkedAt).toLocaleString('zh-CN', { hour12: false });
}
function useFolder(file, stats) {
  if (state.folderKind === 'input') {
    $('input-directory').value = file;
    $('input-folder-stats').textContent = folderStats(stats) + '。原始记录数，尚未校验有效性。';
  } else {
    $('output').value = file; $('output').oninput();
  }
  $('folder-picker').close();
}
function renderFolders() {
  const data = state.folderData; if (!data) return;
  $('folder-list').replaceChildren();
  const query = $('folder-search').value.trim().toLowerCase();
  const items = data.directories.filter(item => item.name.toLowerCase().includes(query) || item.path.toLowerCase().includes(query));
  for (const item of items) {
    const row = node('div', undefined, 'folder-option'), name = button(item.name, () => loadFolders(item.path), 'folder-name text-button');
    const body = node('div'); body.append(name, node('code', item.path, 'folder-option-path'));
    if (state.folderKind === 'input') body.append(node('small', folderStats(item.stats), 'folder-option-stats'));
    row.append(body, button('选用', () => useFolder(item.path, item.stats))); $('folder-list').append(row);
  }
  if (!items.length) $('folder-list').append(node('p', query ? '没有匹配目录' : '没有子目录，可使用当前目录。', 'check-meta'));
}
async function loadFolders(directory) {
  const request = ++state.folderRequest, kind = state.folderKind;
  $('folder-error').textContent = ''; $('use-folder').disabled = true;
  $('folder-list').replaceChildren(node('p', '读取目录…', 'check-meta'));
  try {
    const data = await api('/api/directories?preset=' + encodeURIComponent($('preset').value) + '&kind=' + kind +
      (directory ? '&path=' + encodeURIComponent(directory) : ''));
    if (request !== state.folderRequest) return;
    state.folderData = data;
    $('folder-current').textContent = data.path || '选择一个已配置的目录范围';
    $('folder-parent').disabled = !data.parent; $('use-folder').disabled = !data.path;
    $('folder-status').textContent = kind === 'input' ?
      (data.path ? folderStats(data.stats) + '。' : '') +
      (data.refreshing ? '后台正在更新统计；已完成的目录会陆续显示数量。' : '每小时增量更新，记录数尚未校验有效性。') : '输出目录可在此选择，也可返回手动填写新路径。';
    $('folder-error').textContent = [data.error, ...(data.unavailable || []).map(item => item.path + '：' + item.reason)].filter(Boolean).join('；');
    renderFolders();
  } catch (error) { if (request === state.folderRequest) { $('folder-error').textContent = error.message; $('folder-list').replaceChildren(); } }
}
function openFolders(kind) {
  state.folderKind = kind; state.folderData = null; $('folder-search').value = '';
  $('folder-title').textContent = kind === 'input' ? '选择评测输入目录' : '选择评测输出目录';
  $('folder-picker').showModal(); void loadFolders();
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
  const inputs = node('div', undefined, 'path-section');
  if (task.inputDirectory) inputs.append(pathRoot('输入父目录', task.inputDirectory));
  for (const input of task.inputs) inputs.append(fileGroup(input.name, input.paths, task.inputDirectory));
  const logs = node('div'); for (const file of task.logs) logs.append(readPath(file));
  const output = node('div', undefined, 'path-section'); output.append(pathRoot('输出根目录', task.output));
  const folders = new Map();
  for (const file of check?.destinations || []) {
    const parent = file.slice(0, file.lastIndexOf('/')), files = folders.get(parent) || [];
    files.push(file); folders.set(parent, files);
  }
  for (const [folder, files] of folders) {
    const root = task.output.replace(/\/$/, '');
    const relative = folder === root ? '' : folder.startsWith(root + '/') ? folder.slice(root.length + 1) : folder;
    const label = relative === 'criteria' ? '共同标准 · criteria' : relative.startsWith('comparison/') ? '对比结果 · ' + relative.slice(11) : relative || '结果文件';
    const group = fileGroup(label, files, folder);
    group.insertBefore(node('code', relative || '.', 'folder-path'), group.lastChild); output.append(group);
  }
  for (const [label, content] of [['输入', inputs], ['输出', output], ['并发', node('span', String(task.concurrency))], ['日志', logs]]) {
    const row = node('div', undefined, 'summary-row'), value = node('div', undefined, 'summary-value'); value.append(content); row.append(node('span', label), value); target.append(row);
  }
  if (task.batchId) target.append(node('p', '缺省批次：' + task.batchId + '（原始输入已有批次时使用原值）', 'check-meta'));
  for (const warning of task.warnings || []) target.append(node('p', warning, 'path-warning'));
  if (check?.status === 'ready') target.append(node('p', '数量以本次检查为准，启动时按最新结果跳过。', 'check-meta'));
}
function formatBytes(value) { return value >= 1024 ** 3 ? (value / 1024 ** 3).toFixed(2) + ' GB' : (value / 1024 ** 2).toFixed(1) + ' MB'; }
function checkText(task) {
  const check = task.dataCheck;
  return check?.status === 'checking' ? '已读取 ' + check.readRecords.toLocaleString() + ' 条 · ' + check.checkedFiles + '/' + check.files + ' 文件' :
    check?.status === 'ready' ? '待评 ' + check.pending.toLocaleString() + ' · 跳过 ' + check.skipped.toLocaleString() : '—';
}
function previewTask(task) {
  state.preview = task;
  $('configuration').hidden = true; $('preview-summary').hidden = false; $('preview-button').hidden = true;
  $('back').hidden = true; $('download-preview').hidden = false; $('download-preview').href = '/api/tasks/' + task.id + '/configuration';
  $('create-title').textContent = task.name + ' · ' + task.id.slice(8, 16);
  $('config-error').textContent = task.dataCheck?.error || '';
  summary(task, $('preview-summary'));
  if (task.dataCheck?.status === 'checking') {
    const bar = node('progress'); bar.setAttribute('aria-label', '数据检查进度');
    $('preview-summary').prepend(node('p', checkText(task), 'check-meta'), bar);
  }
  $('start').hidden = task.dataCheck?.status !== 'ready'; $('start').disabled = !task.dataCheck?.total;
  if (!$('create').open) $('create').showModal();
}
function openCapacity(task) { state.capacity = task.id; $('capacity-value').value = task.concurrency; $('capacity-error').textContent = ''; $('capacity').showModal(); $('capacity-value').select(); }
const canDelete = task => !['starting', 'running', 'pausing'].includes(task.status);
function updateSelection() {
  const available = state.tasks.filter(task => task.source === state.source && canDelete(task));
  const all = $('select-all');
  all.checked = available.length > 0 && available.every(task => state.checked.has(task.id));
  all.indeterminate = state.checked.size > 0 && !all.checked;
  all.disabled = state.deleting || !available.length;
  $('selection-count').textContent = '已选 ' + state.checked.size + ' 项';
  $('delete-selected').disabled = state.deleting || !state.checked.size;
}
function closeDeleted(id) {
  state.checked.delete(id);
  if (state.selected === id) { state.selected = null; $('detail').close(); }
  if (state.preview?.id === id) $('create').close();
}
function renderTasks() {
  for (const channel of ['wencai', 'aime']) document.querySelector('[data-count="' + channel + '"]').textContent = state.tasks.filter(t => t.source === channel).length;
  const tasks = state.tasks.filter(t => t.source === state.source); $('task-list').replaceChildren(); $('empty').hidden = tasks.length > 0;
  for (const id of state.checked) if (!tasks.some(task => task.id === id && canDelete(task))) state.checked.delete(id);
  for (const task of tasks) {
    const row = node('tr'), title = node('td');
    const choice = node('input', undefined, 'task-select'); choice.type = 'checkbox'; choice.checked = state.checked.has(task.id);
    choice.disabled = state.deleting || !canDelete(task); choice.setAttribute('aria-label', '选择 ' + task.name + ' ' + task.id.slice(8, 16));
    choice.title = canDelete(task) ? '选择任务' : '先暂停任务，等待保存完成后再删除';
    choice.onchange = () => { if (choice.checked) state.checked.add(task.id); else state.checked.delete(task.id); updateSelection(); };
    const titleText = node('div'); titleText.append(button(task.name, () => openDetail(task.id, 'config'), 'task-title'), node('span', task.id.slice(8, 16), 'task-id'));
    const heading = node('div', undefined, 'task-heading'); heading.append(choice, titleText); title.append(heading);
    const status = node('td'); status.append(node('span', task.status === 'draft' ? ({checking: '检查中', ready: '待启动', failed: '检查失败'}[task.dataCheck?.status] || '待检查') : task.status === 'running' && !task.progress && !task.requests?.active ? '加载输入' : names[task.status], 'status ' + task.status));
    if (task.error || task.dataCheck?.error) { const error = node('span', task.error || task.dataCheck.error, 'task-error-mark'); error.title = error.textContent; status.append(error); }
    const progress = node('td'), p = task.progress, finished = task.status === 'finished';
    progress.append(node('span', task.status === 'draft' ? checkText(task) : finished ? (task.result?.skipped_cases ? '跳过 ' + task.result.skipped_cases + ' 项' : '已完成') : p?.total ? p.completed + ' / ' + p.total + ' 步' : '—', 'progress-text'));
    if (p?.total || finished || task.status === 'running' || task.dataCheck?.status === 'checking') { const bar = node('progress'); bar.setAttribute('aria-label', '评测进度'); if (finished || p?.total) { bar.max = finished ? 1 : p.total; bar.value = finished ? 1 : p.completed; } progress.append(bar); }
    const capacity = node('td', undefined, 'num'); capacity.append(finished ? node('span', String(task.concurrency)) : button(String(task.concurrency), () => openCapacity(task)));
    if (!finished) capacity.querySelector('button').setAttribute('aria-label', task.name + ' 调整并发');
    const date = node('td', new Date(task.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }), 'date-cell');
    const operations = node('td'), actions = node('div', undefined, 'row-actions');
    if (['starting', 'running', 'pausing'].includes(task.status)) {
      const pause = button(task.status === 'pausing' ? '暂停中' : '暂停', () => busy(pause, 'task-error', async () => { await api('/api/tasks/' + task.id + '/pause', {}); await refresh(); })); pause.disabled = task.status === 'pausing'; actions.append(pause);
    } else if (['paused', 'failed', 'partial'].includes(task.status)) {
      const resume = button('继续', () => busy(resume, 'task-error', async () => { await api('/api/tasks/' + task.id + '/resume', {}); await refresh(); })); actions.append(resume);
    }
    if (task.status === 'draft') {
      actions.append(button('预览', () => previewTask(task)));
      if (!task.dataCheck || task.dataCheck.status === 'failed') { const retry = button(task.dataCheck ? '重新检查' : 'Check data', () => busy(retry, 'task-error', async () => { await api('/api/tasks/' + task.id + '/check', {}); await refresh(); })); actions.append(retry); }
    }
    actions.append(button('日志', () => openDetail(task.id, 'logs')), button('配置', () => openDetail(task.id, 'config')));
    const remove = button('删除', () => {
      if (!confirm(`删除“${task.name} · ${task.id.slice(8, 16)}”？\n仅删除工作台任务记录和配置，保留原始输入、评测结果与日志。`)) return;
      void busy(remove, 'task-error', async () => {
        await api('/api/tasks/' + task.id + '/delete', {});
        closeDeleted(task.id);
        await refresh();
      });
    }, 'text-button delete-task');
    remove.disabled = state.deleting || !canDelete(task);
    remove.title = remove.disabled ? '先暂停任务，等待保存完成后再删除' : '删除任务，保留输入、评测结果与日志';
    remove.setAttribute('aria-label', task.name + ' ' + task.id.slice(8, 16) + ' 删除任务');
    actions.append(remove); operations.append(actions);
    row.append(title, status, progress, capacity, date, operations); $('task-list').append(row);
  }
  updateSelection();
}
async function openDetail(id, tab) {
  const draft = state.tasks.find(t => t.id === id && t.status === 'draft');
  if (draft && tab === 'config') { previewTask(draft); return; }
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
async function refresh() { state.tasks = await api('/api/tasks'); renderTasks(); if ($('create').open && state.preview?.dataCheck?.status === 'checking') { const task = state.tasks.find(t => t.id === state.preview.id); if (task?.status === 'draft') previewTask(task); } $('freshness').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false }) + ' 更新'; }
async function initialize() {
  try { state.presets = await api('/api/presets'); $('login').hidden = true; $('app').hidden = false; $('logout').hidden = false; setSource(state.source); await refresh(); }
  catch (error) { ($('app').hidden ? $('login-error') : $('task-error')).textContent = error.message === '请先登录' ? '' : error.message; }
}
$('login').onsubmit = event => { event.preventDefault(); void busy($('login').querySelector('button'), 'login-error', async () => { await api('/api/login', { password: $('password').value }); $('password').value = ''; await initialize(); }); };
$('logout').onclick = () => busy($('logout'), 'task-error', async () => { await api('/api/logout', {}); showLogin(); });
document.querySelectorAll('[data-source]').forEach(el => el.onclick = () => setSource(el.dataset.source));
document.querySelectorAll('[data-detail]').forEach(el => el.onclick = () => setDetail(el.dataset.detail));
$('new-task').onclick = openCreate; $('empty-create').onclick = openCreate; $('preset').onchange = fillPreset; $('back').onclick = editMode;
$('choose-input').onclick = () => openFolders('input'); $('choose-output').onclick = () => openFolders('output');
$('input-directory').oninput = () => { $('input-folder-stats').textContent = ''; };
$('close-folder-picker').onclick = () => { state.folderRequest++; $('folder-picker').close(); };
$('folder-roots').onclick = () => { $('folder-search').value = ''; void loadFolders(); };
$('folder-parent').onclick = () => { if (state.folderData?.parent) { $('folder-search').value = ''; void loadFolders(state.folderData.parent); } };
$('folder-search').oninput = renderFolders;
$('use-folder').onclick = () => { if (state.folderData?.path) useFolder(state.folderData.path, state.folderData.stats); };
$('close-create').onclick = () => $('create').close(); $('create').onclose = () => { state.preview = null; };
$('close-detail').onclick = $('close-detail-bottom').onclick = () => $('detail').close(); $('close-capacity').onclick = () => $('capacity').close();
$('configuration').addEventListener('invalid', event => { const details = event.target.closest('details'); if (details) details.open = true; }, true);
$('configuration').onsubmit = event => {
  event.preventDefault(); void busy($('preview-button'), 'config-error', async () => {
    await api('/api/previews', { preset: $('preset').value, inputDirectory: $('input-directory').value.trim(), output: $('output').value.trim(), concurrency: Number($('concurrency').value), batchId: $('batch-id').value.trim() });
    $('create').close(); await refresh();
  });
};
$('start').onclick = () => busy($('start'), 'config-error', async () => { const task = await api('/api/tasks', { previewId: state.preview.id }); state.selected = task.id; $('create').close(); await refresh(); });
$('capacity-form').onsubmit = event => { event.preventDefault(); void busy($('apply-capacity'), 'capacity-error', async () => { await api('/api/tasks/' + state.capacity + '/concurrency', { concurrency: Number($('capacity-value').value) }); $('capacity').close(); await refresh(); }); };
$('refresh').onclick = () => busy($('refresh'), 'task-error', refresh); $('refresh-logs').onclick = () => loadLogs();
$('select-all').onchange = () => {
  state.checked.clear();
  if ($('select-all').checked) for (const task of state.tasks) if (task.source === state.source && canDelete(task)) state.checked.add(task.id);
  renderTasks();
};
$('delete-selected').onclick = async () => {
  const selected = state.tasks.filter(task => state.checked.has(task.id) && task.source === state.source && canDelete(task));
  if (!selected.length || state.deleting || !confirm(`删除选中的 ${selected.length} 个任务？\n仅删除工作台任务记录和配置，保留原始输入、评测结果与日志。`)) return;
  state.deleting = true; $('task-error').textContent = ''; renderTasks();
  try {
    const results = await Promise.allSettled(selected.map(task => api('/api/tasks/' + task.id + '/delete', {})));
    const failures = [];
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') closeDeleted(selected[index].id);
      else failures.push(selected[index].name + ' · ' + selected[index].id.slice(8, 16) + '：' + result.reason.message);
    });
    await refresh();
    if (failures.length) $('task-error').textContent = '已删除 ' + (selected.length - failures.length) + ' 项，' + failures.length + ' 项未删除。' + failures.join('；');
  } catch (error) { $('task-error').textContent = error.message; }
  finally { state.deleting = false; renderTasks(); }
};
$('log-kind').onchange = () => { $('errors-only').disabled = $('log-kind').value === 'evaluation'; if ($('errors-only').disabled) $('errors-only').checked = false; void loadLogs(); };
$('errors-only').onchange = () => loadLogs(); $('older').onclick = () => loadLogs(true);
setInterval(async () => { if ($('app').hidden || document.hidden || state.polling) return; state.polling = true; try { await refresh(); } catch (error) { $('task-error').textContent = '刷新失败：' + error.message; } finally { state.polling = false; } }, 4000);
void initialize();
