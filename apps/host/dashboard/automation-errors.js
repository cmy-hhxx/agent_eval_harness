const $ = id => document.getElementById(id);
const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const number = value => Number(value).toLocaleString("zh-CN");
const format = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const time = value => value && Number.isFinite(new Date(value).getTime()) ? format.format(new Date(value)) : "—";
let page = 1, busy = false, timer, generation = 0;

async function refresh() {
  if (busy) return;
  clearTimeout(timer); busy = true; $("refresh").disabled = true;
  const version = generation;
  const expanded = new Set([...document.querySelectorAll("details[open]")].map(node => node.dataset.id));
  try {
    const query = new URLSearchParams({ page: String(page), hours: $("time-filter").value, date: $("date-filter").value });
    const source = new URL(location.href).searchParams.get("source");
    if (source) query.set("source", source);
    const response = await fetch("/runtime/api/errors?" + query, { cache: "no-store", signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`读取错误日志失败（HTTP ${response.status}）`);
    const data = await response.json();
    if (version !== generation) return;
    const url = new URL(location.href);
    url.searchParams.set("source", data.sourceId);
    history.replaceState(null, "", url);
    $("monitor-link").href = `/runtime/?source=${encodeURIComponent(data.sourceId)}`;
    $("page-title").textContent = `错误日志 · ${data.sourceName}`;
    document.title = `自动化错误日志 · ${data.sourceName}`;
    page = data.page;
    const selected = $("date-filter").value;
    $("date-filter").innerHTML = '<option value="">全部日期</option>' + data.dates.map(date => `<option value="${escape(date)}">${escape(date)}</option>`).join("");
    $("date-filter").value = selected;
    $("error-total").textContent = `${number(data.total)} 条错误日志`;
    $("sample-time").textContent = `更新 ${time(data.sampledAt)} · 北京时间`;
    $("error-rows").innerHTML = data.records.map(({ id, date, record }) => `<tr><td>${time(record.time)}</td><td>${escape(date || "—")}<span class="table-sub error-task">${escape(record.run_id || "")}</span><span class="table-sub error-task">${escape(record.task_id || "")}</span></td><td><details data-id="${id}" ${expanded.has(String(id)) ? "open" : ""}><summary class="error-message">${escape(record.message || record.event)}</summary><pre class="error-detail">${escape(JSON.stringify(record, null, 2))}</pre></details></td></tr>`).join("") || '<tr><td colspan="3" class="empty">暂无错误</td></tr>';
    $("pagination").hidden = data.total <= data.pageSize;
    $("page-range").textContent = `${number((page - 1) * data.pageSize + 1)}–${number(Math.min(page * data.pageSize, data.total))} / ${number(data.total)} 条`;
    $("page-number").textContent = `${page} / ${Math.max(1, Math.ceil(data.total / data.pageSize))} 页`;
    $("previous").disabled = page === 1;
    $("next").disabled = page * data.pageSize >= data.total;
    $("connection-error").hidden = true;
  } catch (error) {
    if (version === generation) {
      $("connection-error").textContent = `连接中断：${error.message}`;
      $("connection-error").hidden = false;
    }
  } finally {
    busy = false; $("refresh").disabled = false;
    if (version !== generation) void refresh();
    else timer = setTimeout(refresh, 5000);
  }
}
function update() { generation++; void refresh(); }
$("refresh").addEventListener("click", update);
for (const id of ["date-filter", "time-filter"]) $(id).addEventListener("change", () => { page = 1; update(); });
$("previous").addEventListener("click", () => { page--; update(); });
$("next").addEventListener("click", () => { page++; update(); });
void refresh();
