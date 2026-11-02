const $ = id => document.getElementById(id);
const state = { presets: [], source: 'wencai', selected: null, preview: null, cursor: null, tasks: [], polling: false };
const names = { draft: '待启动', starting: '启动中', running: '运行中', pausing: '暂停中', paused: '已暂停', finished: '已完成', partial: '部分完成', failed: '失败' };
function node(tag, text, className) { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; if (className) value.className = className; return value; }
async function api(url, value) {
  const response = await fetch(url, value === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-console-request': '1' }, body: JSON.stringify(value) });
  const result = await response.json();
  if (!response.ok) { if (response.status === 401) showLogin(); throw new Error(result.error || '请求失败'); }
  return result;
}
function showLogin() { $('login').hidden = false; $('app').hidden = true; $('logout').hidden = true; $('refresh').hidden = true; }
async function busy(button, target, action) {
  button.disabled = true; $(target).textContent = '';
  try { await action(); } catch (error) { $(target).textContent = error.message; }
  finally { button.disabled = false; }
}
function fillPreset() {
  const preset = state.presets.find(item => item.id === $('preset').value);
  if (!preset) return;
  $('inputs').replaceChildren();
  for (const [index, input] of preset.inputs.entries()) {
    const field = node('div', undefined, 'field'), label = node('label', undefined, 'input-label'); label.append(node('span', input.name), node('small', '输入'));
    label.htmlFor = 'input-' + index; field.append(label);
    const element = node('textarea'); element.id = 'input-' + index; element.value = input.paths.join('\n'); element.dataset.version = input.id;
    element.rows = Math.min(3, input.paths.length); element.required = true; element.spellcheck = false;
    element.setAttribute('aria-label', input.name + ' 输入路径，每行一个'); field.append(element);
    $('inputs').append(field);
  }
  $('output').value = preset.output; $('concurrency').value = preset.concurrency;
  $('log-paths').replaceChildren(...preset.logs.map(file => node('div', file)));
  $('config-error').textContent = '';
}
function source(value) {
  state.source = value;
  document.querySelectorAll('[data-source]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.source === value)));
  $('preset').replaceChildren(...state.presets.filter(preset => preset.source === value).map(preset => { const option = node('option', preset.name); option.value = preset.id; return option; }));
  fillPreset(); renderTasks();
}
function summary(task) {
  $('preview-summary').replaceChildren();
  for (const [label, text] of [['评测输入', task.inputs.map(input => input.name + '\n' + input.paths.join('\n')).join('\n\n')], ['评测输出', task.output], ['并发', String(task.concurrency)], ['日志位置', task.logs.join('\n')]]) {
    const row = node('div', undefined, 'summary-row'); row.append(node('span', label), node('p', text)); $('preview-summary').append(row);
  }
  for (const warning of task.warnings || []) $('preview-summary').append(node('p', warning, 'path-warning'));
}
function renderTasks() {
  const tasks = state.tasks.filter(task => task.source === state.source);
  $('task-count').textContent = tasks.length ? String(tasks.length) + ' 个' : '';
  // Preserve an in-progress concurrency edit across polling refreshes.
  if ($('task-list').contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
  $('task-list').replaceChildren();
  if (!tasks.length) { $('task-list').append(node('p', '暂无评测', 'empty')); return; }
  for (const task of tasks) {
    const row = node('div', undefined, 'task' + (task.id === state.selected ? ' selected' : ''));
    const head = node('div', undefined, 'task-head'), name = node('button', task.name, 'task-name');
    name.onclick = () => { state.selected = task.id; renderTasks(); void loadLogs(); };
    head.append(name, node('span', names[task.status], 'status ' + task.status + (['failed', 'partial'].includes(task.status) ? ' error' : '')));
    const time = new Date(task.createdAt).toLocaleString('zh-CN', { hour12: false });
    row.append(head, node('p', time + (task.requests ? ' · 在途 ' + task.requests.active + ' / ' + task.concurrency : ' · 并发 ' + task.concurrency), 'task-meta'));
    const actions = node('div', undefined, 'task-actions');
    if (['starting', 'running', 'pausing'].includes(task.status)) {
      const pause = node('button', task.status === 'pausing' ? '等待在途完成' : '暂停'); pause.disabled = task.status === 'pausing';
      pause.onclick = () => busy(pause, 'task-error', async () => { await api('/api/tasks/' + task.id + '/pause', {}); await refresh(); }); actions.append(pause);
    } else if (['paused', 'failed', 'partial'].includes(task.status)) {
      const resume = node('button', '继续'); resume.onclick = () => busy(resume, 'task-error', async () => { await api('/api/tasks/' + task.id + '/resume', {}); await refresh(); }); actions.append(resume);
    }
    if (!['finished'].includes(task.status)) {
      const input = node('input'); input.type = 'number'; input.min = '1'; input.step = '1'; input.value = task.concurrency; input.setAttribute('aria-label', task.name + ' 并发');
      const set = node('button', '调整并发'); set.onclick = () => busy(set, 'task-error', async () => { if (!input.reportValidity()) return; await api('/api/tasks/' + task.id + '/concurrency', { concurrency: Number(input.value) }); input.blur(); await refresh(); });
      actions.append(input, set);
    }
    const logs = node('button', '日志'); logs.onclick = name.onclick; actions.append(logs);
    row.append(actions, node('p', task.output, 'output-path'));
    if (task.error) { const error = node('p', task.error); error.setAttribute('role', 'alert'); row.append(error); }
    $('task-list').append(row);
  }
}
async function loadLogs(older = false) {
  if (!state.selected) return;
  const id = state.selected, kind = $('log-kind').value, errors = $('errors-only').checked;
  $('log-error').textContent = '';
  try {
    const result = await api('/api/tasks/' + id + '/logs?kind=' + kind + '&errors=' + (errors ? 1 : 0) + (older && state.cursor !== null ? '&cursor=' + state.cursor : ''));
    if (state.selected !== id || $('log-kind').value !== kind || $('errors-only').checked !== errors) return;
    state.cursor = result.cursor; $('older').hidden = result.cursor === null;
    $('log-task').textContent = state.tasks.find(task => task.id === id)?.name || id;
    $('log-output').replaceChildren();
    if (!result.rows.length) $('log-output').append(node('p', result.cursor === null ? '暂无日志' : '暂无记录', 'empty'));
    for (const record of result.rows.reverse()) {
      const entry = node('details', undefined, 'log-entry');
      entry.append(node('summary', [record.time ? new Date(record.time).toLocaleTimeString('zh-CN', { hour12: false }) : '', record.stage || record.component, record.message || record.event || record.task_id].filter(Boolean).join(' · '), record.level === 'error' ? 'error' : undefined), node('pre', JSON.stringify(record, null, 2)));
      $('log-output').append(entry);
    }
  } catch (error) { $('log-error').textContent = error.message; }
}
async function refresh() {
  state.tasks = await api('/api/tasks'); renderTasks();
  $('freshness').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false }) + ' 更新';
}
async function initialize() {
  try {
    state.presets = await api('/api/presets'); $('login').hidden = true; $('app').hidden = false; $('logout').hidden = false; $('refresh').hidden = false;
    source(state.source); await refresh();
  } catch (error) { if ($('app').hidden) $('login-error').textContent = error.message === '请先登录' ? '' : error.message; else $('config-error').textContent = error.message; }
}
$('login').onsubmit = event => { event.preventDefault(); void busy($('login').querySelector('button'), 'login-error', async () => { await api('/api/login', { password: $('password').value }); $('password').value = ''; await initialize(); }); };
$('logout').onclick = () => busy($('logout'), 'task-error', async () => { await api('/api/logout', {}); showLogin(); });
document.querySelectorAll('[data-source]').forEach(button => button.onclick = () => source(button.dataset.source));
$('preset').onchange = fillPreset;
$('configuration').onsubmit = event => {
  event.preventDefault(); void busy($('preview-button'), 'config-error', async () => {
    const inputs = {}; $('inputs').querySelectorAll('textarea').forEach(input => { inputs[input.dataset.version] = input.value.split('\n').map(line => line.trim()).filter(Boolean); });
    state.preview = await api('/api/previews', { preset: $('preset').value, inputs, output: $('output').value.trim(), concurrency: Number($('concurrency').value) });
    summary(state.preview); $('download').href = '/api/tasks/' + state.preview.id + '/configuration'; $('start-error').textContent = ''; $('preview').showModal();
  });
};
$('start').onclick = () => busy($('start'), 'start-error', async () => { const task = await api('/api/tasks', { previewId: state.preview.id }); state.selected = task.id; $('preview').close(); await refresh(); await loadLogs(); });
$('refresh').onclick = () => busy($('refresh'), 'task-error', async () => { await refresh(); await loadLogs(); });
$('log-kind').onchange = () => { $('errors-only').disabled = $('log-kind').value === 'evaluation'; if ($('errors-only').disabled) $('errors-only').checked = false; void loadLogs(); };
$('errors-only').onchange = () => void loadLogs(); $('older').onclick = () => void loadLogs(true);
setInterval(async () => {
  if ($('app').hidden || document.hidden || state.polling) return;
  state.polling = true;
  try { await refresh(); } catch (error) { $('task-error').textContent = '刷新失败：' + error.message; }
  finally { state.polling = false; }
}, 4000);
void initialize();
