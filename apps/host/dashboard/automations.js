const $ = (id) => document.getElementById(id);
const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const number = (value) => Number(value ?? 0).toLocaleString("zh-CN");
const dateFormat = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const time = (value) => value ? dateFormat.format(value) : "—";
const stages = ["attribution", "comparison", "rewrite", "clustering"];
const labels = { running: "运行中", stopped: "已停止", pending: "等待中", downloading: "下载中", ready: "已就绪", retry: "等待重试", evaluating: "评测中", completed: "已完成", waiting_inputs: "已完成，等待新增输入", blocked: "已暂停", uncertain: "待核实", sending: "上传中", uploaded: "已上传" };
const tones = { running: "active", evaluating: "active", downloading: "active", completed: "success", uploaded: "success", ready: "success", retry: "warning", uncertain: "warning", blocked: "error" };
const status = (value, label = labels[value] ?? value) => `<span class="status-label tone-${tones[value] ?? "neutral"}">${escape(label)}</span>`;
const sub = (value, className = "") => `<span class="table-sub ${className}">${escape(value)}</span>`;
const empty = (columns, text) => `<tr><td colspan="${columns}" class="empty">${text}</td></tr>`;
let data, busy = false, connected = false, timer;

const inputCount = (rows) => rows ? Object.values(rows).reduce((a, b) => a + b, 0) : undefined;
const confirmedMongo = (job) => [...(job.mongoHistory ?? []), ...(job.mongo?.status === "completed" && job.mongo.counts ? [{ ...job.mongo, verified: false }] : []),
  ...(job.mongo?.verified ? [{ counts: job.mongo.verified, completedAt: job.mongo.verified.at, verified: true }] : [])]
  .sort((a, b) => b.completedAt - a.completedAt)[0];
function downloadLabel(job) {
  if (job.download === "downloading") return status("downloading", job.downloaded ? "核对更新中" : "首次下载中");
  if (job.download === "installing") return status("downloading", "更新本地输入");
  if (job.download === "ready") return job.downloadError ? status("retry", "核对更新待重试") : status("ready", "本地已就绪");
  return status(job.download, job.download === "pending" ? (job.downloaded ? "本地待核验" : "等待首次下载") : "下载待重试");
}

function render() {
  if (!data) return;
  const selected = $("date-filter").value;
  const jobs = data.jobs.filter((job) => !selected || job.date === selected);
  const range = $("time-filter").value;
  // Bucket-aligned ranges are explicit below; a partial hour is never presented as an exact rolling count.
  const cutoff = range === "all" ? 0 : Math.floor(data.sampledAt / 3600000) * 3600000 - (Number(range) - 1) * 3600000;
  $("pipeline-status").innerHTML = connected ? status(data.status) : "连接中断";
  $("sample-time").textContent = `更新 ${time(data.sampledAt)}`;
  $("poll-time").textContent = `远端检查 ${time(data.lastPollAt)}`;
  $("log-path").textContent = data.logFile;
  $("mongo-collection").textContent = data.mongoCollection;
  const errors = [data.pollError, data.reportError].filter(Boolean);
  $("pipeline-errors").hidden = !errors.length;
  $("pipeline-errors").textContent = errors.join("\n");
  $("date-total").textContent = `${number(jobs.length)} 个日期`;
  $("date-rows").innerHTML = jobs.map((job) => {
    const error = [["retry", "blocked"].includes(job.evaluation) ? job.evaluationError : undefined, job.monitorError].filter(Boolean).join("\n");
    const cells = ["attribution", "rewrite", "clustering"].map((name) => {
      const stage = job.summary?.stages[name];
      if (!stage) return "<td>—</td>";
      return `<td>${number(stage.completed)} / ${number(stage.total)}${stage.running ? sub(`进行中 ${number(stage.running)}`, "tone-active") : ""}${stage.pending ? sub(`待执行 ${number(stage.pending)}`) : ""}${stage.cancelled ? sub(`已中断 ${number(stage.cancelled)}`, "tone-warning") : ""}${stage.blocked ? sub(`依赖阻塞 ${number(stage.blocked)}`, "tone-warning") : ""}${stage.failed ? sub(`失败 ${number(stage.failed)}`, "tone-error") : ""}</td>`;
    }).join("");
    const counts = (key) => Object.values(job.summary?.stages ?? {}).reduce((n, stage) => n + (stage[key] ?? 0), 0);
    const local = inputCount(job.downloaded), comparison = job.summary?.stages.comparison;
    const retries = counts("failed") + counts("cancelled");
    const pool = job.summary ? `待执行 ${number(counts("pending"))}${sub(`待重试 ${number(retries)}`, retries ? "tone-warning" : "")}${sub(`依赖阻塞 ${number(counts("blocked"))}`)}${counts("running") ? sub(`进行中 ${number(counts("running"))}`, "tone-active") : ""}` : "—";
    return `<tr><td><strong>${escape(job.date)}</strong>${job.adopted ? sub("历史已完成") : ""}</td>
      <td class="remote-inputs">${number(inputCount(job.observed))}</td><td class="local-inputs">${local === undefined ? "—" : number(local)}${job.summary?.skipped ? sub(`预检跳过 ${number(job.summary.skipped)}`) : ""}${job.summary?.issues ? sub(`输入异常 ${number(job.summary.issues)}`, "tone-error") : ""}</td>
      <td>${downloadLabel(job)}${job.downloadError ? sub(data.status === "stopped" ? "启动后核对" : `重试 ${time(job.nextDownloadAt)}`) + sub(job.downloadError, "row-error") : ""}</td>
      <td>${status(job.evaluation)}${job.evaluation === "retry" ? sub(data.status === "stopped" ? "启动后重试" : `重试 ${time(job.nextEvaluationAt)}`) : ""}${error ? sub(error, "row-error") : ""}</td>
      <td class="completed-comparisons">${comparison ? `${number(job.summary.readyComparisons)} / ${number(comparison.total)}` : "—"}${sub(`全阶段 ${number(job.hours.reduce((total, hour) => total + hour.completed, 0))}`)}</td>
      <td class="task-pool">${pool}</td>${cells}</tr>`;
  }).join("") || empty(10, "暂无日期");

  const hours = new Map();
  for (const job of jobs) for (const hour of job.hours) {
    if (hour.start < cutoff) continue;
    const merged = hours.get(hour.start) ?? { start: hour.start, completed: 0, stages: {} };
    merged.completed += hour.completed;
    for (const name of stages) merged.stages[name] = (merged.stages[name] ?? 0) + (hour.stages[name] ?? 0);
    hours.set(hour.start, merged);
  }
  const sorted = [...hours.values()].sort((a, b) => b.start - a.start);
  const maximum = Math.max(1, ...sorted.map((hour) => hour.completed));
  $("activity-total").textContent = `${cutoff ? time(cutoff) + " 起 · " : ""}${number(sorted.reduce((total, hour) => total + hour.completed, 0))} 条全阶段对比`;
  $("activity-rows").innerHTML = sorted.map((hour) => `<tr><td>${time(hour.start)} — ${time(Math.min(hour.start + 3600000, data.sampledAt))}</td>
    <td class="volume-cell"><div class="volume"><strong>${number(hour.completed)}</strong><span class="volume-track" aria-hidden="true"><span style="width:${hour.completed / maximum * 100}%"></span></span></div></td>
    ${stages.map((name) => `<td>${number(hour.stages[name])}</td>`).join("")}</tr>`).join("") || empty(6, "此时段暂无完成记录");

  const deliveries = [...(data.publicationHistory ?? []), ...(data.publication?.traceId ? [data.publication] : [])];
  const visible = deliveries.filter((delivery) => Math.max(delivery.startedAt ?? 0, delivery.completedAt ?? 0, delivery.log?.uploadedAt ?? 0, delivery.log?.confirmedAt ?? 0, delivery.window ?? 0) >= cutoff || ["running", "retry", "uncertain"].includes(delivery.status)).sort((a, b) => (b.window ?? 0) - (a.window ?? 0));
  $("delivery-total").textContent = `${number(visible.length)} 次日志交付`;
  $("delivery-rows").innerHTML = visible.map((delivery) => {
    const log = delivery.log, counts = delivery.counts;
    return `<tr><td>全看板${sub(time(delivery.window))}</td>
      <td>${status(delivery.status)}${delivery.status === "retry" ? sub(`重试 ${time(delivery.nextAt)}`) : ""}${delivery.error ? sub(delivery.error, "row-error") : ""}</td>
      <td>${counts ? `${number(counts.cases)} / ${number(counts.comparisons)}` : "—"}</td>
      <td>${time(log?.writtenAt)}</td>
      <td>${log ? status(log.status) : "—"}${log?.uploadedAt ? sub(time(log.uploadedAt)) : log?.confirmedAt ? sub(`人工确认 ${time(log.confirmedAt)}`) : log?.startedAt ? sub(`尝试 ${time(log.startedAt)}`) : ""}${log?.requestId ? sub(log.requestId, "receipt") : ""}</td></tr>`;
  }).join("") || empty(5, "此时段暂无日志记录");

  const mongo = jobs.flatMap((job) => [
    ...(job.mongoHistory ?? []).map((receipt) => ({ ...receipt, status: "completed" })),
    ...(job.mongo?.startedAt ? [job.mongo] : []),
  ].map((delivery) => ({ ...delivery, date: job.date })));
  const mongoVisible = mongo.filter((delivery) => Math.max(delivery.startedAt ?? 0, delivery.completedAt ?? 0) >= cutoff ||
    ["running", "retry", "pending"].includes(delivery.status)).sort((a, b) => b.startedAt - a.startedAt || b.date.localeCompare(a.date));
  const confirmed = jobs.flatMap((job) => { const receipt = confirmedMongo(job); return receipt ? [receipt] : []; });
  $("mongo-total").textContent = `已确认输入 ${number(confirmed.reduce((n, row) => n + row.counts.inputs, 0))} 条 · 已确认评测输出 ${number(confirmed.reduce((n, row) => n + row.counts.comparisons, 0))} 条${confirmed.length < jobs.length ? ` · ${number(jobs.length - confirmed.length)} 个日期未登记` : ""}`;
  $("mongo-progress-rows").innerHTML = jobs.map((job) => {
    const receipt = confirmedMongo(job), counts = receipt?.counts;
    const pending = counts && job.summary ? Math.max(0, job.summary.readyComparisons - counts.comparisons) : 0;
    return `<tr><td>${escape(job.date)}</td><td>${job.mongo ? pending && job.mongo.status === "completed" ? status("pending", "等待同步新输出") : status(job.mongo.status) : job.adopted ? "历史已交付" : "未同步"}${job.mongo?.error ? sub(job.mongo.error, "row-error") : ""}</td>
      <td class="mongo-inputs">${counts ? number(counts.inputs) : "未登记"}</td><td class="mongo-outputs">${counts ? number(counts.comparisons) : "未登记"}${pending ? sub(`待上传 ${number(pending)}`) : ""}</td><td>${receipt?.verified ? "核验 " : ""}${time(receipt?.completedAt)}</td></tr>`;
  }).join("") || empty(5, "暂无日期");
  $("mongo-history-total").textContent = `${number(mongoVisible.length)} 次同步`;
  $("mongo-rows").innerHTML = mongoVisible.map((delivery) => `<tr><td>${escape(delivery.date)}</td>
    <td>${status(delivery.status)}${delivery.status === "retry" ? sub(`重试 ${time(delivery.nextAt)}`) : ""}${delivery.error ? sub(delivery.error, "row-error") : ""}</td>
    <td>${time(delivery.startedAt)}</td><td>${time(delivery.completedAt)}</td>
    <td>${delivery.counts ? number(delivery.counts.inputs) : "—"}</td><td>${delivery.counts ? number(delivery.counts.comparisons) : "—"}</td>
    <td>${delivery.counts ? `新增 ${number(delivery.counts.inserted)}${sub(`更新 ${number(delivery.counts.updated)}`)}` : "—"}</td></tr>`).join("") || empty(7, "此时段暂无 MongoDB 同步记录");
}

async function refresh() {
  if (busy) return;
  clearTimeout(timer);
  busy = true; $("refresh").disabled = true;
  try {
    const response = await fetch("/api/status", { cache: "no-store", signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`读取状态失败（HTTP ${response.status}）`);
    data = await response.json();
    connected = true;
    const selected = $("date-filter").value;
    $("date-filter").innerHTML = '<option value="">全部日期</option>' + data.jobs.map((job) => `<option value="${escape(job.date)}">${escape(job.date)}</option>`).join("");
    $("date-filter").value = data.jobs.some((job) => job.date === selected) ? selected : "";
    $("connection-error").hidden = true;
    render();
  } catch (error) {
    connected = false;
    $("connection-error").hidden = false;
    $("connection-error").textContent = `连接中断：${error.message}${data ? `；保留 ${time(data.sampledAt)} 的状态` : ""}`;
    $("pipeline-status").textContent = "连接中断";
  } finally {
    busy = false; $("refresh").disabled = false;
    timer = setTimeout(refresh, 10000);
  }
}
$("refresh").addEventListener("click", refresh);
$("date-filter").addEventListener("change", render);
$("time-filter").addEventListener("change", render);
void refresh();
