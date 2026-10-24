export function stageProgress(document, name, counts) {
  const row = document.createElement('div'), title = document.createElement('strong'), count = document.createElement('span');
  const total = counts.total || 0, completed = counts.completed || 0;
  title.textContent = name; count.className = 'daily-stage-count'; count.textContent = `${completed} / ${total}`;
  const progress = document.createElement('div'), bar = document.createElement('div');
  progress.className = 'progress daily-stage-progress'; bar.className = 'progress-bar';
  progress.setAttribute('role','progressbar'); progress.setAttribute('aria-label',name);
  progress.setAttribute('aria-valuemin','0'); progress.setAttribute('aria-valuemax',String(total || 1)); progress.setAttribute('aria-valuenow',String(completed));
  bar.style.width = `${total ? Math.min(100,Math.max(0,completed / total * 100)) : 0}%`; progress.append(bar);
  const status = document.createElement('span'); status.className = 'daily-stage-status';
  for (const [key,label] of [['running','进行中'],['pending','待处理'],['failed','失败'],...(counts.blocked ? [['blocked','阻塞']] : [])]) {
    const item = document.createElement('span'), value = document.createElement('b');
    value.textContent = counts[key] || 0; item.append(document.createTextNode(label + ' '),value); status.append(item);
  }
  row.append(title,count,progress,status); return row;
}
