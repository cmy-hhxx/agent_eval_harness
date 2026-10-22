const $ = (id) => document.getElementById(id);
const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const number = (value) => Number(value ?? 0).toLocaleString("zh-CN");
const percent = (value) => value == null ? "暂无用量" : value.toLocaleString("zh-CN", { style: "percent", maximumFractionDigits: 1 });
const dateFormat = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const time = (value) => value ? dateFormat.format(value) : "—";
const stages = ["criteria", "attribution", "comparison", "rewrite"];
const stageLabels = { criteria: "标准任务", attribution: "归因任务", comparison: "对比任务", rewrite: "改写任务" };
const labels = { running: "运行中", stopped: "已停止", pending: "等待中", downloading: "下载中", ready: "已就绪", retry: "等待重试", evaluating: "评测中", completed: "已完成", waiting_inputs: "已完成，等待新增输入", blocked: "已暂停", uncertain: "待核实", sending: "上传中", uploaded: "已上传" };
const tones = { running: "active", evaluating: "active", downloading: "active", completed: "success", uploaded: "success", ready: "success", retry: "warning", uncertain: "warning", blocked: "error" };
const status = (value, label = labels[value] ?? value) => `<span class="status-label tone-${tones[value] ?? "neutral"}">${escape(label)}</span>`;
const sub = (value, className = "") => `<span class="table-sub ${className}">${escape(value)}</span>`;
const empty = (columns, text) => `<tr><td colspan="${columns}" class="empty">${text}</td></tr>`;
let data, busy = false, connected = false, timer, allocationRevision = 0;
const savingAllocations = new Set();
const pageSize = 10;
const pages = Object.fromEntries(["date", "activity", "mongo-progress", "mongo", "delivery"].map((id) => [id, 0]));
const tabs = [...document.querySelectorAll('[role="tab"]')];
const expandedDates = new Set();
let panel = "dates";

function errorDetails(value, key, label) {
  if (!value) return "";
  const review = /^Comparison remains unresolved: ([\w.-]+(?:, [\w.-]+)*)$/.exec(value);
  const ids = review?.[1].split(", ");
  const title = ids ? `对比待复核 · ${number(ids.length)} 项` : `查看${label}`;
  const detail = ids ? `Comparison remains unresolved:\n${ids.join("\n")}` : value;
  return `<details class="row-error" data-error-key="${escape(key)}"><summary>${escape(title)}</summary><pre tabindex="0" aria-label="${escape(label)}完整详情">${escape(detail)}</pre></details>`;
}

function renderSources() {
  const nav = $("source-nav");
  for (const source of data.sources) {
    let link = [...nav.children].find(node => node.dataset.source === source.id);
    if (!link) {
      link = document.createElement("a");
      link.dataset.source = source.id;
      link.innerHTML = "<strong></strong><span></span>";
      nav.append(link);
    }
    link.href = `/runtime/?source=${encodeURIComponent(source.id)}`;
    link.querySelector("strong").textContent = source.name;
    link.querySelector("span").textContent = `${source.status === "running" && !source.dateCount ? "等待数据" : labels[source.status] ?? source.status} · ${number(source.dateCount)} 个日期`;
    if (source.id === data.id) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  for (const link of [...nav.children]) if (!data.sources.some(source => source.id === link.dataset.source)) link.remove();
  $("errors-link").href = `/runtime/errors?source=${encodeURIComponent(data.id)}`;
}

function renderLlm() {
  const container = $("llm-allocations"), name = id => data.sources.find(source => source.id === id)?.name ?? id;
  for (const source of data.llm.sources) {
    let form = [...container.children].find(node => node.dataset.source === source.sourceId);
    if (!form) {
      form = document.createElement("form");
      form.className = "llm-allocation"; form.dataset.source = source.sourceId;
      const id = `llm-limit-${source.sourceId}`;
      form.innerHTML = `<label for="${escape(id)}">${escape(name(source.sourceId))}</label><div class="llm-allocation-controls"><span>LLM 并发</span><input id="${escape(id)}" type="number" min="0" step="1" required><button class="button" type="submit">应用</button></div><output aria-live="polite"></output>`;
      container.append(form);
    }
    const input = form.querySelector("input"), saving = savingAllocations.has(source.sourceId);
    if (!input.dataset.dirty && document.activeElement !== input) input.value = source.concurrency;
    input.disabled = !connected || saving;
    form.querySelector("button").disabled = !connected || saving;
    form.querySelector("output").textContent = !connected ? "连接中断" : saving ? "正在保存" :
      `${source.concurrency === 0 ? source.active ? "暂停中 · " : "LLM 已暂停 · " : ""}调用 ${number(source.active)} · 等待 ${number(source.waiting)}`;
  }
  for (const form of [...container.children]) if (!data.llm.sources.some(source => source.sourceId === form.dataset.source)) form.remove();
  $("llm-total").textContent = `· ${number(data.llm.active.length)} 个请求`;
  $("llm-requests").innerHTML = data.llm.active.map(call => `<tr><td>${escape(name(call.sourceId))}</td><td>${escape(call.date)}</td><td>${escape(stageLabels[call.stage] ?? call.stage)}</td><td>${escape(call.model)}${sub(call.channel)}</td><td>${time(call.startedAt)}</td><td title="${escape(call.taskId)}">${escape(call.taskId)}</td></tr>`).join("") || empty(6, "暂无 LLM 调用");
}

function retryText(at) {
  if (!connected) return "待恢复连接";
  if (data.status === "stopped") return "启动后重试";
  const seconds = Math.max(0, Math.ceil((at - Date.now()) / 1000));
  if (!seconds) return "等待调度";
  return `${seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ` : ""}${seconds % 60} 秒后`;
}
const retryCountdown = (at) => `<span class="retry-countdown" data-retry-at="${Number(at) || 0}">${retryText(at)}</span>`;
const retrySchedule = (at) => `<span class="table-sub">${retryCountdown(at)}${at ? ` · ${time(at)}` : ""}</span>`;
function updateCountdowns() {
  for (const node of document.querySelectorAll("[data-retry-at]")) node.textContent = retryText(Number(node.dataset.retryAt));
}

function renderExecution() {
  const execution = data?.execution;
  if (!execution) return;
  $("execution-overview").hidden = false;
  $("evaluator-version").textContent = execution.evaluatorVersion;
  const llm = data.llm.sources.find(source => source.sourceId === data.id);
  $("concurrency-label").textContent = connected ? "当前来源 LLM 并发" : "LLM 并发快照";
  $("live-concurrency").textContent = `${number(llm?.active)} / ${number(llm?.concurrency)} 请求`;
  $("slot-utilization").textContent = `LLM ${number(llm?.active)} · 运行任务 ${number(execution.runningTasks)}`;
  $("live-stages").textContent = `${number(execution.runningCases)} 题 · 标准 ${number(execution.stages.criteria)} · 归因 ${number(execution.stages.attribution)} · 对比 ${number(execution.stages.comparison)} · 改写 ${number(execution.stages.rewrite)}`;
  const retryJobs = data.jobs.filter((job) => job.evaluation === "retry");
  const retries = retryJobs.reduce((sum, job) => sum + stages.reduce((n, stage) => n + (job.summary?.stages[stage]?.failed ?? 0) +
    (job.summary?.stages[stage]?.cancelled ?? 0), 0), execution.retryingTasks);
  const retryDates = new Set([...retryJobs, ...data.jobs.filter((job) => job.execution?.retryingTasks)].map((job) => job.date));
  $("retry-count").textContent = `${number(retries)} 任务 · ${number(retryDates.size)} 日期`;
  const paused = data.jobs.filter((job) => job.evaluation === "blocked").length;
  $("paused-count").hidden = !paused;
  $("paused-count").textContent = `已暂停 ${number(paused)} 日期`;
  const deadlines = [...retryJobs.map((job) => job.nextEvaluationAt),
    ...(execution.nextRetryAt === undefined ? [] : [execution.nextRetryAt])];
  const next = deadlines.length ? Math.min(...deadlines) : undefined;
  $("next-retry").innerHTML = next === undefined ? "无" : retryCountdown(next);
  $("next-retry-time").textContent = next ? time(next) : "";
  $("cache-hit-rate").textContent = percent(data.cache?.hitRate);
  $("cache-tokens").textContent = data.cache?.inputTokens ? `命中 ${number(data.cache.readTokens)} / 输入 ${number(data.cache.inputTokens)} Token` : "";
  renderFlow();
}

for (const id of Object.keys(pages)) {
  const pager = $(`${id}-pagination`);
  pager.innerHTML = `<span class="page-range" aria-live="polite"></span><div class="page-controls"><button class="button" type="button" data-step="-1" aria-controls="${id}-rows">上一页</button><span class="page-number"></span><button class="button" type="button" data-step="1" aria-controls="${id}-rows">下一页</button></div>`;
  pager.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-step]");
    if (!button || button.disabled) return;
    pages[id] += Number(button.dataset.step);
    render();
  });
}

function pageRows(id, rows) {
  const total = Math.max(1, Math.ceil(rows.length / pageSize));
  pages[id] = Math.max(0, Math.min(pages[id], total - 1));
  const start = pages[id] * pageSize, pager = $(`${id}-pagination`);
  pager.hidden = rows.length <= pageSize;
  pager.querySelector(".page-range").textContent = `${number(start + 1)}–${number(Math.min(start + pageSize, rows.length))} / ${number(rows.length)} 条`;
  pager.querySelector(".page-number").textContent = `${pages[id] + 1} / ${total} 页`;
  pager.querySelector('[data-step="-1"]').disabled = pages[id] === 0;
  pager.querySelector('[data-step="1"]').disabled = pages[id] === total - 1;
  return rows.slice(start, start + pageSize);
}

function selectPanel(id) {
  panel = tabs.some((tab) => tab.getAttribute("aria-controls") === id) ? id : "dates";
  for (const tab of tabs) {
    const active = tab.getAttribute("aria-controls") === panel;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
    $(tab.getAttribute("aria-controls")).hidden = !active;
  }
  $("date-filter-label").hidden = panel === "deliveries";
  $("time-filter-label").hidden = panel === "dates";
  $("date-total").hidden = panel !== "dates";
  $("activity-total").hidden = panel !== "activity";
  render();
}

for (const tab of tabs) tab.addEventListener("click", () => {
  const id = tab.getAttribute("aria-controls");
  history.replaceState(null, "", `#${id}`);
  selectPanel(id);
});
document.querySelector('[role="tablist"]').addEventListener("keydown", (event) => {
  const index = tabs.indexOf(event.target);
  if (index < 0 || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next].focus(); tabs[next].click();
});
window.addEventListener("hashchange", () => selectPanel(location.hash.slice(1)));

const inputCount = (rows) => rows ? Object.values(rows).reduce((a, b) => a + b, 0) : undefined;
const inputsMatch = (job) => job.downloaded && Object.entries(job.observed).every(([model, count]) => job.downloaded[model] === count);
const confirmedMongo = (job) => [...(job.mongoHistory ?? []), ...(job.mongo?.status === "completed" && job.mongo.counts ? [{ ...job.mongo, verified: false }] : []),
  ...(job.mongo?.verified ? [{ counts: job.mongo.verified, completedAt: job.mongo.verified.at, verified: true }] : [])]
  .sort((a, b) => b.completedAt - a.completedAt)[0];
function renderFlow() {
  $("pipeline-flow").hidden = false;
  const stopped = !connected ? "连接中断" : data.status === "stopped" ? "已停止" : "";
  const downloading = data.jobs.find(job => ["downloading", "installing"].includes(job.download));
  const updates = data.jobs.filter(job => !inputsMatch(job) || ["pending", "retry"].includes(job.download));
  $("lane-download").textContent = stopped || (downloading ? `${downloading.date} · ${downloading.download === "installing" ? "落地中" : "下载中"}` :
    updates.some(job => job.sourceReady) ? "等待下载" : updates.length ? "等待远端就绪" : "等待更新");
  $("lane-download-queue").textContent = `待更新 ${number(updates.length)} 日期`;
  const evaluating = data.jobs.find(job => job.evaluation === "evaluating");
  const queued = data.jobs.filter(job => ["pending", "retry"].includes(job.evaluation));
  $("lane-evaluation").textContent = stopped || (data.llm.sources.find(source => source.sourceId === data.id)?.concurrency === 0 ? "LLM 已暂停" :
    evaluating ? `${evaluating.date} · 评测中` : queued.length ? "等待调度" : "等待新增输入");
  $("lane-evaluation-queue").textContent = evaluating && !stopped ? `可执行 ${number(data.execution.readyTasks)} · 等依赖 ${number(data.execution.waitingDependencies)}` : `排队 ${number(queued.length)} 日期`;
  const uploading = data.jobs.find(job => job.mongo?.status === "running");
  const unconfirmed = data.jobs.filter(job => !confirmedMongo(job));
  const pendingOutputs = data.jobs.reduce((total, job) => total + Math.max(0, (job.summary?.readyComparisons ?? 0) - (confirmedMongo(job)?.counts.comparisons ?? 0)), 0);
  $("lane-mongo").textContent = stopped || (uploading ? `${uploading.date} · 上传中` : data.jobs.some(job => job.mongo?.status === "retry") ? "等待重试" : "等待增量交付");
  $("lane-mongo-queue").textContent = unconfirmed.length ? `${number(unconfirmed.length)} 日期未登记` : `待传输出 ${number(pendingOutputs)} 条`;
  const statistics = data.statistics, deliveries = data.statisticsDeliveries ?? [];
  const pendingDeliveries = deliveries.filter(item => item.status !== "uploaded");
  $("lane-log").textContent = !data.publishStatisticsLog ? "已关闭" : stopped ||
    (pendingDeliveries.some(item => item.status === "uncertain") ? "待核实回执" :
      pendingDeliveries.some(item => item.status === "sending") ? "relay 上传中" :
        pendingDeliveries.length ? `待上传 ${number(pendingDeliveries.length)} 条` : statistics?.nextAt ? `下次 ${time(statistics.nextAt)}` : "等待调度");
  const receipts = deliveries.map(item => item.uploadedAt).filter(Boolean);
  $("lane-log-receipt").textContent = receipts.length ? `最近确认 ${time(Math.max(...receipts))}` : "无上传回执";
}
function downloadState(job) {
  const matched = inputsMatch(job);
  const difference = job.downloaded && !matched ? inputCount(job.observed) - inputCount(job.downloaded) : 0;
  const gap = job.downloaded && !matched ? sub(difference ? `远端${difference > 0 ? "多" : "少"} ${number(Math.abs(difference))} 条` : "模型数量不一致", "tone-warning") : "";
  if (job.download === "downloading") return status("downloading", job.downloaded ? (matched ? "核对更新中" : "下载更新中") : "首次下载中") + gap;
  if (job.download === "installing") return status("downloading", "更新本地输入");
  if (job.sourceReady === false) return status("pending", "远端准备中") + gap;
  if (job.downloadError) return status("retry", job.downloaded ? "更新输入待重试" : "下载待重试") + gap + retrySchedule(job.nextDownloadAt) + errorDetails(job.downloadError, `download:${job.date}`, "下载错误");
  if (job.download === "ready" && matched) return status("ready", "本地已就绪");
  const waiting = data.status === "stopped" ? "启动后更新" : job.evaluation === "evaluating" ? "等待当前评测结束" :
    job.mongo?.status === "running" ? "等待 MongoDB 交付" : data.publication?.status === "running" ? "等待日志快照" :
    data.jobs.some((other) => ["downloading", "installing"].includes(other.download)) ? "下载排队" :
    job.sourceReady === undefined ? "等待远端检查" : "等待下载";
  return status("pending", job.downloaded ? "待更新输入" : "等待首次下载") + gap + sub(waiting);
}

function render() {
  if (!data) return;
  const focusedDate = document.activeElement?.dataset?.dateDetails;
  const disclosures = new Map([...document.querySelectorAll(".row-error")].map(node => [node.dataset.errorKey, {
    open: node.open, top: node.querySelector("pre").scrollTop, left: node.querySelector("pre").scrollLeft,
    focused: node.contains(document.activeElement) ? document.activeElement.tagName.toLowerCase() : undefined,
  }]));
  renderSources();
  renderLlm();
  renderExecution();
  const selected = $("date-filter").value;
  const jobs = data.jobs.filter((job) => !selected || job.date === selected);
  const range = $("time-filter").value;
  $("reset-filters").disabled = (panel === "deliveries" || !selected) && (panel === "dates" || range === "24");
  // Bucket-aligned ranges are explicit below; a partial hour is never presented as an exact rolling count.
  const cutoff = range === "all" ? 0 : Math.floor(data.sampledAt / 3600000) * 3600000 - (Number(range) - 1) * 3600000;
  document.title = `自动化评测 · ${data.sourceName}`;
  $("source-url").textContent = data.sourceUrl;
  $("pipeline-status").innerHTML = connected ? status(data.status) : "连接中断";
  $("sample-time").textContent = `更新 ${time(data.sampledAt)}`;
  $("poll-time").textContent = time(data.lastPollAt);
  $("log-path").textContent = data.logFile;
  $("mongo-collection").textContent = data.mongoCollection;
  const errors = [data.pollError, data.reportError].filter(Boolean);
  $("pipeline-errors").hidden = !errors.length;
  $("pipeline-errors").textContent = errors.join("\n");
  $("date-total").textContent = `${number(jobs.length)} 个日期`;
  $("date-rows").innerHTML = pageRows("date", jobs).map((job) => {
    const error = (["retry", "blocked"].includes(job.evaluation) ? errorDetails(job.evaluationError, `evaluation:${job.date}`, "评测错误") : "") +
      errorDetails(job.monitorError, `monitor:${job.date}`, "状态读取错误");
    const cells = stages.map((name) => {
      const stage = job.summary?.stages[name];
      if (!stage) return `<div><dt>${stageLabels[name]}</dt><dd>—</dd></div>`;
      const retrying = job.execution?.retryingStages?.[name] ?? 0, pending = Math.max(0, (stage.pending ?? 0) - retrying);
      return `<div><dt>${stageLabels[name]}</dt><dd class="stage-tasks" data-stage="${name}">${number(stage.completed)} / ${number(stage.total)}${stage.running ? sub(`进行中 ${number(stage.running)}`, "tone-active") : ""}${pending ? sub(`待执行 ${number(pending)}`) : ""}${retrying ? sub(`待重试 ${number(retrying)}`, "tone-warning") : ""}${stage.cancelled ? sub(`已中断 ${number(stage.cancelled)}`, "tone-warning") : ""}${stage.blocked ? sub(`依赖阻塞 ${number(stage.blocked)}`, "tone-warning") : ""}${stage.failed ? sub(`失败 ${number(stage.failed)}`, "tone-error") : ""}</dd></div>`;
    }).join("");
    const counts = (key) => stages.reduce((n, name) => n + (job.summary?.stages[name]?.[key] ?? 0), 0);
    const local = inputCount(job.downloaded);
    const retrying = job.execution?.retryingTasks ?? 0, retries = counts("failed") + counts("cancelled") + retrying;
    const pool = job.summary ? `待执行 ${number(Math.max(0, counts("pending") - retrying))}${retries ? sub(`${job.evaluation === "blocked" ? "已暂停" : "待重试"} ${number(retries)}`, "tone-warning") : ""}${counts("blocked") ? sub(`依赖阻塞 ${number(counts("blocked"))}`) : ""}${counts("running") ? sub(`进行中 ${number(counts("running"))}`, "tone-active") : ""}` : "—";
    const open = expandedDates.has(job.date), detailId = `tasks-${job.date}`;
    return `<tr class="date-row"><td><strong>${escape(job.date)}</strong>${job.adopted ? sub("历史已完成") : ""}</td>
      <td class="remote-inputs">${number(inputCount(job.observed))}</td><td class="local-inputs">${local === undefined ? "—" : number(local)}${job.summary?.issues ? sub(`输入异常 ${number(job.summary.issues)}`, "tone-error") : ""}</td>
      <td>${downloadState(job)}</td>
      <td>${job.evaluation === "evaluating" && data.llm.sources.find(source => source.sourceId === data.id)?.concurrency === 0 ? status("pending", "LLM 已暂停") : status(job.evaluation)}${job.evaluation === "retry" ? retrySchedule(job.nextEvaluationAt) : ""}${job.execution?.retryingTasks ? sub(`任务重试 ${number(job.execution.retryingTasks)} 个`, "tone-warning") + retrySchedule(job.execution.nextRetryAt) : ""}${error}</td>
      <td class="completed-comparisons">${job.summary ? number(job.summary.readyComparisons) : "—"}</td>
      <td><button class="details-toggle" type="button" data-date-details="${escape(job.date)}" aria-label="${escape(job.date)} 任务明细" aria-expanded="${open}" aria-controls="${escape(detailId)}">${open ? "收起" : "展开"}</button></td></tr>
      <tr class="date-detail-row" id="${escape(detailId)}"${open ? "" : " hidden"}><td colspan="7"><dl class="task-facts" aria-label="${escape(job.date)} 任务明细"><div><dt>任务池</dt><dd class="task-pool">${pool}</dd></div>${cells}<div><dt>缓存命中率</dt><dd class="cache-rate">${percent(job.cache?.hitRate)}</dd></div></dl>${job.summary?.skipped || job.evaluation === "retry" ? `<div class="task-detail-meta">${job.summary?.skipped ? `<span>预检跳过 ${number(job.summary.skipped)}</span>` : ""}${job.evaluation === "retry" ? `<span>连续失败 ${number(job.evaluationAttempts)} 轮</span>` : ""}</div>` : ""}</td></tr>`;
  }).join("") || empty(7, "暂无日期");

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
  $("activity-total").textContent = `${cutoff ? time(cutoff) + " 起 · " : ""}${number(sorted.reduce((total, hour) => total + hour.completed, 0))} 条对比 · 含改写`;
  $("activity-rows").innerHTML = pageRows("activity", sorted).map((hour) => `<tr><td>${time(hour.start)} — ${time(Math.min(hour.start + 3600000, data.sampledAt))}</td>
    <td class="volume-cell"><div class="volume"><strong>${number(hour.completed)}</strong><span class="volume-track" aria-hidden="true"><span style="width:${hour.completed / maximum * 100}%"></span></span></div></td>
    ${stages.map((name) => `<td>${number(hour.stages[name])}</td>`).join("")}</tr>`).join("") || empty(6, "此时段暂无完成记录");

  const statisticsDeliveries = data.publishStatisticsLog ? data.statisticsDeliveries ?? [] : [];
  const visible = statisticsDeliveries.filter(delivery => Math.max(delivery.writtenAt ?? 0, delivery.updatedAt ?? 0, delivery.uploadedAt ?? 0) >= cutoff ||
    ["pending", "sending", "uncertain"].includes(delivery.status)).sort((a, b) => b.writtenAt - a.writtenAt);
  $("delivery-total").textContent = data.publishStatisticsLog ? `${number(visible.length)} 条统计记录` : "统计日志已关闭";
  $("delivery-rows").innerHTML = pageRows("delivery", visible).map((delivery) => {
    return `<tr><td><code title="${escape(delivery.traceId)}">${escape(delivery.traceId)}</code></td>
      <td>${status(delivery.status)}${delivery.attempts ? sub(`尝试 ${number(delivery.attempts)} 次`) : ""}</td>
      <td>${errorDetails(delivery.lastError, `log:${delivery.traceId}`, "日志交付错误") || "—"}</td><td>${time(delivery.writtenAt)}</td>
      <td>${time(delivery.updatedAt)}${delivery.requestId ? sub(delivery.requestId, "receipt") : ""}</td></tr>`;
  }).join("") || empty(5, data.publishStatisticsLog ? "此时段暂无日志记录" : "统计日志已关闭");

  const mongo = jobs.flatMap((job) => [
    ...(job.mongoHistory ?? []).map((receipt) => ({ ...receipt, status: "completed" })),
    ...(job.mongo?.startedAt ? [job.mongo] : []),
  ].map((delivery) => ({ ...delivery, date: job.date })));
  const mongoVisible = mongo.filter((delivery) => Math.max(delivery.startedAt ?? 0, delivery.completedAt ?? 0) >= cutoff ||
    ["running", "retry", "pending"].includes(delivery.status)).sort((a, b) => b.startedAt - a.startedAt || b.date.localeCompare(a.date));
  const confirmed = jobs.flatMap((job) => { const receipt = confirmedMongo(job); return receipt ? [receipt] : []; });
  $("mongo-total").textContent = `已确认输入 ${number(confirmed.reduce((n, row) => n + row.counts.inputs, 0))} 条 · 已确认评测输出 ${number(confirmed.reduce((n, row) => n + row.counts.comparisons, 0))} 条${confirmed.length < jobs.length ? ` · ${number(jobs.length - confirmed.length)} 个日期未登记` : ""}`;
  $("mongo-progress-rows").innerHTML = pageRows("mongo-progress", jobs).map((job) => {
    const receipt = confirmedMongo(job), counts = receipt?.counts;
    const pending = counts && job.summary ? Math.max(0, job.summary.readyComparisons - counts.comparisons) : 0;
    return `<tr><td>${escape(job.date)}</td><td>${job.mongo ? pending && job.mongo.status === "completed" ? status("pending", "等待同步新输出") : status(job.mongo.status) : job.adopted ? "历史已交付" : "未同步"}${job.mongo?.status === "retry" ? retrySchedule(job.mongo.nextAt) : ""}${errorDetails(job.mongo?.error, `mongo-progress:${job.date}`, "MongoDB 错误")}</td>
      <td class="mongo-inputs">${counts ? number(counts.inputs) : "未登记"}</td><td class="mongo-outputs">${counts ? number(counts.comparisons) : "未登记"}${pending ? sub(`待上传 ${number(pending)}`) : ""}</td><td>${receipt?.verified ? "核验 " : ""}${time(receipt?.completedAt)}</td></tr>`;
  }).join("") || empty(5, "暂无日期");
  $("mongo-history-total").textContent = `${number(mongoVisible.length)} 次同步`;
  $("mongo-rows").innerHTML = pageRows("mongo", mongoVisible).map((delivery) => `<tr><td>${escape(delivery.date)}</td>
    <td>${status(delivery.status)}${delivery.status === "retry" ? retrySchedule(delivery.nextAt) : ""}${errorDetails(delivery.error, `mongo:${delivery.date}:${delivery.startedAt}`, "MongoDB 错误")}</td>
    <td>${time(delivery.startedAt)}</td><td>${time(delivery.completedAt)}</td>
    <td>${delivery.counts ? number(delivery.counts.inputs) : "—"}</td><td>${delivery.counts ? number(delivery.counts.comparisons) : "—"}</td>
    <td>${delivery.counts ? `新增 ${number(delivery.counts.inserted)}${sub(`更新 ${number(delivery.counts.updated)}`)}` : "—"}</td></tr>`).join("") || empty(7, "此时段暂无 MongoDB 同步记录");
  for (const node of document.querySelectorAll(".row-error")) {
    const previous = disclosures.get(node.dataset.errorKey);
    if (!previous) continue;
    node.open = previous.open;
    node.querySelector("pre").scrollTop = previous.top;
    node.querySelector("pre").scrollLeft = previous.left;
    if (previous.focused) node.querySelector(previous.focused)?.focus({ preventScroll: true });
  }
  if (focusedDate) [...document.querySelectorAll("[data-date-details]")].find(node => node.dataset.dateDetails === focusedDate)?.focus({ preventScroll: true });
}

$("date-rows").addEventListener("click", (event) => {
  const button = event.target.closest("[data-date-details]");
  if (!button) return;
  const date = button.dataset.dateDetails, open = !expandedDates.has(date);
  if (open) expandedDates.add(date);
  else expandedDates.delete(date);
  button.setAttribute("aria-expanded", String(open));
  button.textContent = open ? "收起" : "展开";
  $(button.getAttribute("aria-controls")).hidden = !open;
});

async function refresh() {
  if (busy || savingAllocations.size) return;
  clearTimeout(timer);
  busy = true; $("refresh").disabled = true;
  try {
    const query = new URLSearchParams();
    const source = new URL(location.href).searchParams.get("source");
    if (source) query.set("source", source);
    const revision = allocationRevision;
    const response = await fetch("/runtime/api/status?" + query, { cache: "no-store", signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`读取状态失败（HTTP ${response.status}）`);
    const next = await response.json();
    if (revision !== allocationRevision && data) next.llm = data.llm;
    data = next;
    const url = new URL(location.href);
    url.searchParams.set("source", data.id);
    history.replaceState(null, "", url);
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
    renderExecution(); updateCountdowns();
    if (data) renderLlm();
  } finally {
    busy = false; $("refresh").disabled = false;
    timer = setTimeout(refresh, 5000);
  }
}
$("llm-allocations").addEventListener("input", event => {
  if (event.target.matches("input")) event.target.dataset.dirty = "true";
});
$("llm-allocations").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.target, sourceId = form.dataset.source, input = form.querySelector("input");
  if (!connected || savingAllocations.has(sourceId) || !form.reportValidity()) return;
  const concurrency = Number(input.value);
  allocationRevision++;
  savingAllocations.add(sourceId);
  $("llm-error").hidden = true;
  renderLlm();
  try {
    const response = await fetch("/runtime/api/llm-concurrency", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceId, concurrency }), signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
    data.llm = result;
    delete input.dataset.dirty;
    input.value = result.sources.find(source => source.sourceId === sourceId).concurrency;
  } catch (error) {
    $("llm-error").hidden = false;
    $("llm-error").textContent = `设置 LLM 并发失败：${error.message}`;
  } finally {
    savingAllocations.delete(sourceId);
    renderLlm();
    void refresh();
  }
});
$("refresh").addEventListener("click", refresh);
function filterChanged() {
  for (const id of Object.keys(pages)) pages[id] = 0;
  render();
}
$("date-filter").addEventListener("change", filterChanged);
$("time-filter").addEventListener("change", filterChanged);
$("reset-filters").addEventListener("click", () => {
  if (panel !== "deliveries") $("date-filter").value = "";
  if (panel !== "dates") $("time-filter").value = "24";
  filterChanged();
});
selectPanel(location.hash.slice(1));
setInterval(updateCountdowns, 1000);
void refresh();
