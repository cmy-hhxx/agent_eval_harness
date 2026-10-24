import { cleaningReason as reason } from './cleaning-labels.js';
const states = { uploading:'上传中', ready:'待清洗', queued:'清洗排队中', cleaning:'清洗中', cleaned:'清洗完成', partial:'部分文件失败', empty:'无新增有效回答', failed:'清洗失败', interrupted:'清洗中断' };

export function mountIntake(root, options = {}) {
  const el = id => root.querySelector(`#${id}`);
  const doc = root.ownerDocument || root;
  const request = options.fetch || fetch;
  let catalog, page = 1, selected = new Set(), loading = false, reload = false, mutating = false, online = false, disposed = false;
  let reportId, reportPage = 1, reportRevision = 0, sampleRevision = 0;
  const text = (tag, value) => { const node = doc.createElement(tag); node.textContent = value ?? '—'; return node; };
  const button = (label, action) => { const node = text('button', label); node.type = 'button'; node.className = 'button'; node.addEventListener('click', action); return node; };
  const error = value => { el('intake-error').hidden = !value; el('intake-error').textContent = value || ''; };
  async function api(path, body) {
    const response = await request(`/data/workbench/${path}`, body === undefined ? { cache:'no-store' } : {
      method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(body),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
    return value;
  }
  function choices(id, tasks, first) {
    const node = el(id), previous = node.value;
    node.replaceChildren(new Option(first, ''), ...tasks.map(task => new Option(`${task.name} · ${task.source} · ${task.category === 'daily' ? '日常' : '专项'}`, task.id)));
    if ([...node.options].some(option => option.value === previous)) node.value = previous;
  }
  function controls() {
    const rows = (catalog?.batches || []).filter(batch => selected.has(batch.id));
    el('intake-selected').textContent = `已选 ${rows.length} 个批次`;
    el('intake-assign').disabled = !online || mutating || !rows.length || !el('intake-assign-task').value || rows.some(row => row.summary || !['uploading','ready','failed','interrupted'].includes(row.status));
    el('intake-clean').disabled = !online || mutating || !rows.length || rows.some(row => !row.task_id || !['ready','failed','interrupted'].includes(row.status));
    el('intake-evaluate').disabled = !online || mutating || !rows.length || new Set(rows.map(row => row.task_id)).size !== 1 || rows.some(row => !row.task_id || !['cleaned','partial'].includes(row.status) || !row.summary?.accepted);
    el('intake-browse').disabled = !online || !el('intake-task').value;
    el('intake-all').checked = Boolean(catalog?.batches.length) && rows.length === catalog.batches.length;
    el('intake-all').indeterminate = rows.length > 0 && rows.length < catalog.batches.length;
  }
  function render() {
    const source = el('intake-source').value, category = el('intake-category').value;
    const tasks = catalog.tasks.filter(task => (!source || task.source === source) && (!category || task.category === category));
    choices('intake-task', tasks, '全部任务');
    choices('intake-assign-task', catalog.tasks.filter(task => !source || task.source === source), '选择任务');
    selected = new Set([...selected].filter(id => catalog.batches.some(row => row.id === id)));
    el('intake-rows').replaceChildren(...catalog.batches.map(batch => {
      const row = doc.createElement('tr'), checkCell = doc.createElement('td'), check = doc.createElement('input');
      check.type = 'checkbox'; check.checked = selected.has(batch.id); check.setAttribute('aria-label', `选择 ${batch.name}`);
      check.addEventListener('change', () => { if (check.checked) selected.add(batch.id); else selected.delete(batch.id); controls(); });
      checkCell.append(check);
      const name = text('td', batch.name); name.append(text('div', `${(batch.size / 1024).toFixed(1)} KB · ${batch.id}`)); name.lastChild.className = 'intake-path'; name.title = batch.archive_path;
      if (batch.revises) name.append(text('div', `修订自 ${batch.revises}`));
      const status = text('td', batch.task_id ? states[batch.status] || batch.status : `待归属 · ${states[batch.status] || batch.status}`);
      if (batch.error) status.append(text('div', batch.error));
      const task = text('td', batch.task_name || '未归属');
      if (batch.source) task.append(text('div', `${batch.source} · ${batch.category === 'daily' ? '日常' : '专项'}`));
      row.append(checkCell, name, task, status);
      for (const key of ['read','accepted','excluded']) { const cell = text('td', batch.summary?.[key]); cell.className = 'intake-number'; row.append(cell); }
      const actions = doc.createElement('td');
      if (batch.summary) actions.append(button('清洗报告', () => { reportId = batch.id; reportPage = 1; void showReport(); }));
      row.append(actions); return row;
    }));
    if (!catalog.batches.length) { const row = doc.createElement('tr'), cell = text('td', '暂无批次'); cell.colSpan = 8; row.append(cell); el('intake-rows').append(row); }
    el('intake-page').textContent = `${page} / ${Math.max(1, Math.ceil(catalog.total / catalog.page_size))} 页 · ${catalog.total} 个批次`;
    el('intake-prev').disabled = page === 1;
    el('intake-next').disabled = page * catalog.page_size >= catalog.total;
    const activeTask = catalog.tasks.find(task => task.id === el('intake-task').value);
    el('intake-task-path').hidden = !activeTask;
    el('intake-task-path').textContent = activeTask ? `收包目录：${activeTask.archive_dir || '—'}` : '';
    controls();
  }
  async function load() {
    if (disposed) return;
    if (loading) { reload = true; return; }
    loading = true;
    el('intake-refresh').disabled = true;
    try {
      const query = new URLSearchParams({ page:String(page) });
      if (el('intake-unassigned').checked) query.set('unassigned', 'true');
      else for (const key of ['source','category','task']) if (el(`intake-${key}`).value) query.set(key, el(`intake-${key}`).value);
      const result = await api(`catalog?${query}`);
      if (disposed || reload) return;
      catalog = result; online = true; error(''); render();
    } catch (failure) { if (!disposed) { online = false; error(`数据读取失败：${failure.message}`); controls(); } }
    finally { loading = false; if (!disposed) el('intake-refresh').disabled = false; if (reload) { reload = false; void load(); } }
  }
  async function mutate(action, body, message) {
    if (mutating) return;
    mutating = true; controls(); error('');
    try {
      const result = await api(action, body);
      if (disposed) return;
      el('intake-status').textContent = action === 'tasks' ? `${message} · 收包目录：${result.archive_dir}` : message;
      if (action === 'tasks') { el('intake-create').hidden = true; el('task-name').value = ''; }
      selected.clear(); await load();
      if (action === 'tasks' && catalog) { choices('intake-assign-task', catalog.tasks, '选择任务'); el('intake-assign-task').value = result.id; }
    } catch (failure) { if (!disposed) error(failure.message); }
    finally { mutating = false; if (!disposed) controls(); }
  }
  async function showReport() {
    const revision = ++reportRevision; sampleRevision++; el('intake-sample').hidden = true;
    try {
      const section = el('report-section').value;
      const report = await api(`batches/${reportId}/report?page=${reportPage}&section=${section}`);
      if (disposed || revision !== reportRevision) return;
      const counts = report.summary;
      el('intake-report').hidden = false;
      el('report-title').textContent = `清洗报告 · ${states[report.status] || report.status}`;
      el('report-path').textContent = report.archive_path;
      const pairs = Object.values(counts.pairs).reduce((total, value) => total + value, 0);
      el('report-counts').textContent = `读入 ${counts.read} 条 · 纳入 ${counts.accepted} 个回答 · 排除 ${counts.excluded} 条 · ${counts.questions} 个问题 · ${pairs} 个有效模型对 · 标签与效率异常 ${counts.metadata_issue_count} 项`;
      el('report-reasons').replaceChildren(...counts.reasons.map(item => text('p', `${item.model} · ${reason(item.reason)} · ${item.count} 条`)),
        ...counts.file_errors.map(item => text('p', `${item.original_file} · ${reason(item.reason)}`)));
      el('report-failure').hidden = !counts.error; el('report-failure').textContent = counts.error || '';
      el('report-rows').replaceChildren(...report.items.map((item, index) => {
        const row = doc.createElement('tr');
        for (const value of [item.model, item.case_id, item.original_file, `${item.original_line ?? '—'} / ${item.original_item ?? '—'}`]) row.append(text('td', value));
        const action = doc.createElement('td');
        if (section === 'records') action.append(button('查看样本', () => void showSample(report.batch_id, (report.page - 1) * report.page_size + index)));
        else action.textContent = section === 'metadata_issues' ? `${item.field} · ${item.error}` : reason(item.reason);
        row.append(action); return row;
      }));
      if (!report.items.length) { const row = doc.createElement('tr'), cell = text('td', '无记录'); cell.colSpan = 5; row.append(cell); el('report-rows').append(row); }
      el('report-page').textContent = `${report.page} / ${Math.max(1, Math.ceil(report.total / report.page_size))} 页 · ${report.total} 条`;
      el('report-prev').disabled = reportPage === 1; el('report-next').disabled = reportPage * report.page_size >= report.total;
      el('intake-report').scrollIntoView({ block:'start' });
    } catch (failure) { if (!disposed && revision === reportRevision) error(`报告读取失败：${failure.message}`); }
  }
  async function showSample(id, index) {
    const revision = ++sampleRevision;
    try {
      const sample = await api(`batches/${id}/sample?index=${index}`);
      if (disposed || revision !== sampleRevision) return;
      el('intake-sample').hidden = false; el('sample-title').textContent = `样本 ${sample.location.case_id}`;
      el('sample-location').textContent = `${sample.location.original_file} · 第 ${sample.location.original_line} 行`;
      el('sample-question').textContent = sample.record.question || '—';
      el('sample-answer').textContent = sample.record.answer || '—';
      el('intake-sample').scrollIntoView({ block:'start' });
    } catch (failure) { if (!disposed && revision === sampleRevision) error(`样本读取失败：${failure.message}`); }
  }
  for (const key of ['source','category','task','unassigned']) el(`intake-${key}`).addEventListener('change', () => {
    if (key === 'source' || key === 'category') el('intake-task').value = '';
    page = 1; selected.clear(); void load();
  });
  el('intake-all').addEventListener('change', () => { selected = new Set(el('intake-all').checked ? (catalog?.batches || []).map(row => row.id) : []); if (catalog) render(); });
  el('intake-assign-task').addEventListener('change', controls);
  el('intake-refresh').addEventListener('click', () => void load());
  el('intake-new').addEventListener('click', () => { el('intake-create').hidden = false; el('task-name').focus(); });
  el('task-cancel').addEventListener('click', () => { el('intake-create').hidden = true; });
  el('task-source').addEventListener('change', () => {
    const source = el('task-source').value;
    el('task-profile').replaceChildren(...(source === 'wencai' ? [['wencai','问财四模型'],['post_training_model','后训练双模型']] : [[source,source]]).map(([id,label]) => new Option(label,id)));
  });
  el('intake-create').addEventListener('submit', event => { event.preventDefault(); void mutate('tasks', { name:el('task-name').value, source:el('task-source').value, category:el('task-category').value, profile:el('task-profile').value }, '任务已创建'); });
  el('intake-assign').addEventListener('click', () => void mutate('assign', { batch_ids:[...selected], task_id:el('intake-assign-task').value }, '批次已归入任务'));
  el('intake-clean').addEventListener('click', () => void mutate('clean', { batch_ids:[...selected] }, '清洗已提交'));
  el('intake-evaluate').addEventListener('click', () => options.onEvaluate?.([...selected]));
  el('intake-browse').addEventListener('click', () => { const task = catalog?.tasks.find(task => task.id === el('intake-task').value); if (task) options.onBrowse?.(task); });
  for (const [id, delta] of [['intake-prev',-1],['intake-next',1]]) el(id).addEventListener('click', () => { page += delta; selected.clear(); void load(); });
  el('report-section').addEventListener('change', () => { reportPage = 1; void showReport(); });
  for (const [id, delta] of [['report-prev',-1],['report-next',1]]) el(id).addEventListener('click', () => { reportPage += delta; void showReport(); });
  const timer = setInterval(() => { if (doc.visibilityState !== 'hidden' && !mutating) void load(); }, 5000);
  const ready = load();
  return { ready, destroy() { disposed = true; clearInterval(timer); reportRevision++; sampleRevision++; } };
}
