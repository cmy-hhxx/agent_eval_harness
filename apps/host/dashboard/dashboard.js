import { createDashboardViews } from "./dashboard-view.js";

const state = {
  runs: [], selectedRun: null, run: null, cases: null, selectedCase: null,
  caseDetail: null, selectedInput: null, inputView: null, config: null, page: 1,
  preview: null, runRequest: 0, caseRequest: 0, casePageRequest: 0, runId: "",
  inputs: null, selectedDates: new Set(), datesReady: false,
  selectedModels: new Set(), modelsReady: false,
  sampledCases: null, sampleInfo: null, rangeLocked: false,
  library: null, libraryDetail: null, libraryRequest: 0, libraryDetailRequest: 0,
  libraryRun: null, libraryShownRun: null, libraryStatus: null, libraryOpen: new Set(),
  inputOpen: false, taskResults: {}, taskResultsLoading: new Set(), openTasks: new Set(), expandedTexts: new Set(),
  refreshTimer: 0, runsSignature: "", overviewSignature: "", casesSignature: "", datesSignature: "", modelsSignature: "",
};
const $ = (selector) => document.querySelector(selector);
const stageLabels = { attribution: "归因", comparison: "对比", rewrite: "改写", clustering: "聚类" };
const statusLabels = {
  running: "运行中", finished: "已结束", interrupted: "已中断", pending: "排队",
  succeeded: "已接受", failed: "失败", timed_out: "超时", blocked: "阻塞", cancelled: "取消",
};
const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh"];
const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
const label = (status) => statusLabels[status] || status;
const stageLabel = (stage) => stageLabels[stage] || stage;
const dateText = (value) => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
const runLabel = (run) => run.started_at
  ? new Date(run.started_at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
  : "—";
function suggestedRunId() {
  const now = new Date(), pad = (value) => String(value).padStart(2, "0");
  return `eval-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}
const urlFor = (id) => `/api/dashboard/runs/${encodeURIComponent(id)}`;
const loading = (label) => `<span class="loading" role="status" aria-label="${escapeHtml(label)}"><span class="spinner" aria-hidden="true"></span></span>`;

async function api(url, options = {}) {
  const { timeoutMs = 30000, ...init } = options;
  let response;
  try {
    response = await fetch(url, {
      headers: { "content-type": "application/json" },
      ...init,
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(error?.name === "TimeoutError" ? "请求超时" : error.message);
  }
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || `请求失败（${response.status}）`);
  return value;
}
function toast(message, error = false) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.toggle("is-error", error);
  node.classList.add("visible");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove("visible"), 4500);
}
function showError(message) {
  const node = $("#error-banner");
  node.textContent = message || "";
  node.hidden = !message;
}
function statusText(run) {
  const failures = Object.values(run.progress?.failures || {}).reduce((total, n) => total + n, 0);
  if (run.status === "finished" && failures) return "已结束（有失败）";
  if (run.status === "running" && !run.live) return "运行中（Host 接口未就绪）";
  return label(run.status);
}
function renderRuns() {
  const signature = JSON.stringify([state.selectedRun, state.runs]);
  if (signature === state.runsSignature) return;
  state.runsSignature = signature;
  const list = $("#run-list");
  if (!state.runs.length) {
    list.innerHTML = "";
    return;
  }
  list.innerHTML = state.runs.map((run) => {
    const progress = run.progress || {};
    const failures = Object.values(progress.failures || {}).reduce((total, count) => total + count, 0);
    const total = (progress.accepted || 0) + (progress.queued || 0) + (progress.running || 0) + failures;
    const selected = state.selectedRun === run.run_id;
    return `<button class="run-item ${selected ? "selected" : ""}" type="button" data-run="${escapeHtml(run.run_id)}" title="${escapeHtml(run.run_id)}" aria-current="${selected}">
      <span class="run-line"><span class="status-dot ${escapeHtml(run.status)}${failures ? " has-failure" : ""}"></span><span class="run-label">${escapeHtml(runLabel(run))}</span></span>
      <span class="run-meta">${escapeHtml(run.engine)} · 评测器 ${escapeHtml(run.evaluator_version)} · ${progress.accepted || 0}/${total}${failures ? ` · ${failures} 异常` : ""}</span>
    </button>`;
  }).join("");
}
function renderOverview() {
  const run = state.run;
  // Visibility is enforced on every call; the signature only guards heavy content rebuilds.
  $("#run-overview").hidden = !run;
  $("#explorer").hidden = !run;
  const signature = JSON.stringify([state.selectedRun, state.run]);
  if (signature === state.overviewSignature) return;
  state.overviewSignature = signature;
  if (!run) return;
  $("#run-title").textContent = runLabel(run);
  const status = $("#run-status");
  status.textContent = statusText(run);
  status.className = `status-chip ${run.status}${Object.values(run.progress?.failures || {}).some(Boolean) ? " has-failure" : ""}`;
  const progress = run.progress || {};
  const totalTasks = (progress.accepted || 0) + (progress.queued || 0) + (progress.running || 0) + Object.values(progress.failures || {}).reduce((total, count) => total + count, 0);
  const libraryModels = Object.keys(run.problem_library || {}).length;
  const engineLabel = run.engine === "prime" ? "Prime" : "Pi";
  $("#run-description").textContent = `${engineLabel} · ${progress.accepted || 0}/${totalTasks} 已接受${libraryModels ? ` · 问题库 ${libraryModels} 个模型` : ""}`;
  $("#run-actions").innerHTML = run.status === "running"
    ? `<form id="concurrency-form" class="inline-form"><label for="live-concurrency">并发</label><input id="live-concurrency" type="number" min="1" value="${Number(progress.concurrency) || 1}" required /><button class="button" type="submit">调整</button></form><button class="button button-danger" type="button" data-stop="${escapeHtml(run.run_id)}">停止</button>`
    : `<button class="button" type="button" data-resume="${escapeHtml(run.run_id)}">续跑此运行</button>`;
  $("#stage-summary").innerHTML = ["attribution", "comparison", "rewrite", "clustering"].map((stage) => {
    const counts = run.stages?.[stage] || {};
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    return `<div class="stage-row"><strong>${stageLabel(stage)}</strong><span class="stage-count">${total ? `${counts.succeeded || 0}/${total}` : "—"}</span><span class="stage-note">${total ? `${counts.running || 0} 执行 · ${(counts.failed || 0) + (counts.timed_out || 0) + (counts.blocked || 0)} 异常` : "未启用"}</span></div>`;
  }).join("");
  // The library loads only when its panel is open; a run change drops stale data.
  if (state.libraryShownRun !== run.run_id) {
    state.libraryShownRun = run.run_id;
    state.libraryRun = null;
    state.libraryStatus = run.status;
    state.library = state.libraryDetail = null;
    ++state.libraryDetailRequest;
    state.libraryOpen = new Set();
    renderLibrary();
    if ($("#problem-library-panel")?.open) void loadLibrary(run.run_id);
  } else {
    if (state.libraryStatus === "running" && run.status !== "running" && state.libraryRun === run.run_id)
      void loadLibrary(run.run_id);
    state.libraryStatus = run.status;
  }
}
function libraryDetailHtml() {
  const detail = state.libraryDetail;
  if (!detail) return "";
  const pages = Math.max(1, Math.ceil(detail.total / detail.page_size));
  return `<div class="library-detail-card" id="library-detail">
    <h4>${escapeHtml(detail.class.label)} <span class="muted">${escapeHtml(detail.class.aliases.length ? `别名：${detail.class.aliases.join("、")}` : detail.class.id)}</span></h4>
    <p>${escapeHtml(detail.class.definition || "—")}</p>
    <p class="muted">${escapeHtml(detail.component?.label || "—")} · 出现 ${detail.total} 次${detail.class.status === "merged" ? " · 已合并" : ""}</p>
    ${detail.class.first_seen ? `<p class="muted">首次 ${escapeHtml(detail.class.first_seen.batch_id)} / ${escapeHtml(detail.class.first_seen.case_id)} · 评测器 ${escapeHtml(detail.class.first_seen.evaluator_version)} · ${dateText(detail.class.first_seen.at)}</p>` : ""}
    ${detail.occurrences.length ? detail.occurrences.map((item) => `<div class="library-occurrence">
      <p><strong>${escapeHtml(item.batch_id)} / ${escapeHtml(item.case_id)}</strong> · ${escapeHtml(item.version)} · 评测器 ${escapeHtml(item.evaluator_version)} · ${item.classification === "created" ? "新建" : "归入"} · ${item.evidence_status === "uncertain" ? "待核实" : item.evidence_status === "established" ? "已确认" : "状态缺失"}${item.previous_class_id ? "（由合并迁入）" : ""}</p>
      ${item.quote ? `<blockquote>${clipped(item.quote, 2000)}</blockquote>` : ""}
      <p class="muted">finding ${escapeHtml(item.finding_id)} · 消息 #${item.message_index} · ${escapeHtml(item.source.file)}:${item.source.line} · ${dateText(item.at)}</p>
    </div>`).join("") : '<p class="empty-state">暂无出现样本</p>'}
    ${pages > 1 ? `<div class="library-pager"><button type="button" class="button" data-library-page="${detail.page - 1}" ${detail.page <= 1 ? "disabled" : ""}>上一页</button><span class="muted">${detail.page} / ${pages}</span><button type="button" class="button" data-library-page="${detail.page + 1}" ${detail.page >= pages ? "disabled" : ""}>下一页</button></div>` : ""}
  </div>`;
}
function renderLibrary() {
  if (state.library === null) {
    $("#problem-library").innerHTML = state.libraryRun === state.selectedRun
      ? loading("正在读取问题库")
      : '<p class="empty-state">暂无问题类</p>';
    return;
  }
  const models = state.library;
  if (!models.length) {
    $("#problem-library").innerHTML = '<p class="empty-state">暂无问题类</p>';
    return;
  }
  $("#problem-library").innerHTML = models.map((model) => `
    <details class="library-model" data-library-model="${escapeHtml(model.model)}" ${state.libraryOpen.has(model.model) ? "open" : ""}>
      <summary><strong>${escapeHtml(model.model)}</strong><span class="muted">活跃类 ${model.totals.classes} · 组件 ${model.totals.components} · 出现样本 ${model.totals.occurrences}</span></summary>
      ${model.components.filter((component) => component.classes.length).map((component) => `
        <div class="library-component">
          <p class="library-component-label">${escapeHtml(component.label)}</p>
          ${component.classes.map((item) => `<button type="button" class="library-class ${state.libraryDetail?.class.id === item.id ? "selected" : ""}" data-library-model="${escapeHtml(model.model)}" data-library-class="${escapeHtml(item.id)}">
            <span class="library-class-label">${escapeHtml(item.label)}</span>
            <span class="library-class-count">${item.occurrences} 次${item.aliases.length ? ` · 别名 ${escapeHtml(item.aliases.join("、"))}` : ""}</span>
          </button>`).join("")}
        </div>`).join("") || '<p class="empty-state">暂无活跃类</p>'}
      ${model.merged.length ? `<details class="library-merged"><summary>已合并 ${model.merged.length} 个类</summary><ul>${model.merged.map((item) => `<li>${escapeHtml(item.label)} → ${escapeHtml(item.into_label || item.into)}${item.reason ? `（${escapeHtml(item.reason)}）` : ""}</li>`).join("")}</ul></details>` : ""}
    </details>`).join("") + libraryDetailHtml();
}
async function loadLibrary(runId) {
  const request = ++state.libraryRequest;
  state.libraryRun = runId;
  renderLibrary();
  try {
    const models = await api(`${urlFor(runId)}/library`);
    if (request !== state.libraryRequest) return;
    state.library = models;
    if (models.length === 1) state.libraryOpen.add(models[0].model);
    renderLibrary();
  } catch (error) {
    if (request === state.libraryRequest) {
      state.libraryRun = null;
      $("#problem-library").innerHTML = `<p class="empty-state">问题库读取失败：${escapeHtml(error.message)}</p>`;
    }
  }
}
async function loadLibraryClass(model, classId, page) {
  const request = ++state.libraryDetailRequest;
  const runId = state.selectedRun;
  try {
    const detail = await api(`${urlFor(runId)}/library/${encodeURIComponent(model)}/classes/${encodeURIComponent(classId)}?page=${page}`);
    if (request !== state.libraryDetailRequest || runId !== state.selectedRun) return;
    state.libraryDetail = detail;
    renderLibrary();
    $("#library-detail")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (error) { toast(`问题库读取失败：${error.message}`, true); }
}
function caseQuery() {
  return new URLSearchParams({ page: String(state.page) }).toString();
}
function renderCases() {
  const signature = JSON.stringify([state.selectedRun, state.selectedCase, state.cases]);
  if (signature === state.casesSignature) return;
  state.casesSignature = signature;
  const page = state.cases;
  if (!page) {
    $("#case-count").textContent = "—";
    $("#case-list").innerHTML = state.selectedRun ? loading("正在读取样本") : "";
    $("#page-label").textContent = "—";
    $("#prev-page").disabled = $("#next-page").disabled = true;
    $(".pager").hidden = true;
    return;
  }
  $("#case-count").textContent = `${page.total} 个样本`;
  $(".pager").hidden = page.total <= page.page_size;
  $("#page-label").textContent = `${page.page} / ${Math.max(1, Math.ceil(page.total / page.page_size))}`;
  $("#prev-page").disabled = page.page <= 1;
  $("#next-page").disabled = page.page * page.page_size >= page.total;
  $("#case-list").innerHTML = page.cases.length ? page.cases.map((item) => {
    const selected = state.selectedCase?.batch === item.batch_id && state.selectedCase?.caseId === item.case_id;
    const statuses = Object.values(item.stages).flatMap((counts) => Object.entries(counts));
    const accepted = statuses.filter(([key]) => key === "succeeded").reduce((sum, [, n]) => sum + n, 0);
    const bad = statuses.some(([key]) => ["failed", "blocked", "timed_out", "cancelled"].includes(key));
    return `<button class="case-row ${selected ? "selected" : ""}" type="button"
      data-batch="${escapeHtml(item.batch_id)}" data-case="${escapeHtml(item.case_id)}" aria-current="${selected}">
      <span class="case-identity">${escapeHtml(item.batch_id)} / ${escapeHtml(item.case_id)}</span>
      <span class="case-question">${escapeHtml(item.question || "—")}</span>
      <span class="case-progress ${bad ? "has-failure" : ""}">${accepted}/${item.task_count} 已接受${bad ? " · 有异常" : ""}</span>
    </button>`;
  }).join("") : '<p class="empty-state">无匹配样本</p>';
}
const clipped = (value, limit) => {
  const text = String(value ?? "");
  return escapeHtml(text.length > limit ? `${text.slice(0, limit)}…` : text);
};
const compactJson = (value) => escapeHtml(JSON.stringify(value, null, 2) ?? "—");
const { renderDetail, renderTaskResult } = createDashboardViews({
  state,
  $,
  document,
  loading,
  escapeHtml,
  label,
  stageLabel,
  dateText,
});
async function loadTaskResult(taskId) {
  if (!taskId || state.caseDetail?.tasks.find((task) => task.id === taskId)?.status !== "succeeded"
      || state.taskResults[taskId] || state.taskResultsLoading.has(taskId)) return;
  state.taskResultsLoading.add(taskId);
  const runId = state.selectedRun,
    caseId = state.caseDetail?.case_id;
  try {
    const value = await api(`${urlFor(runId)}/tasks/${encodeURIComponent(taskId)}/result`);
    if (state.selectedRun !== runId || state.caseDetail?.case_id !== caseId) return;
    state.taskResults[taskId] = { result: value.result ?? null };
  } catch (error) {
    state.taskResults[taskId] = { error: error.message };
  } finally {
    state.taskResultsLoading.delete(taskId);
  }
  renderTaskResult(taskId);
}
async function loadInput(inputId) {
  state.selectedInput = inputId;
  state.inputView = null;
  renderDetail();
  const runId = state.selectedRun;
  try {
    const input = await api(`${urlFor(runId)}/inputs/${encodeURIComponent(inputId)}`);
    if (state.selectedRun !== runId || state.selectedInput !== inputId) return;
    state.inputView = input;
  } catch (error) {
    if (state.selectedRun !== runId || state.selectedInput !== inputId) return;
    state.inputView = { error: error.message };
  }
  renderDetail();
}
async function loadCase(batch, caseId) {
  const runId = state.selectedRun;
  const request = ++state.caseRequest;
  const changed = state.selectedCase?.batch !== batch || state.selectedCase?.caseId !== caseId;
  state.selectedCase = { batch, caseId };
  if (changed) {
    state.taskResults = {};
    state.taskResultsLoading = new Set();
    state.openTasks = new Set();
    state.expandedTexts = new Set();
    state.inputOpen = false;
  }
  renderCases();
  try {
    const params = new URLSearchParams({ batch, case: caseId });
    const detail = await api(`${urlFor(runId)}/cases/detail?${params}`);
    if (request !== state.caseRequest || runId !== state.selectedRun) return;
    const previous = state.caseDetail;
    const signature = (value) => JSON.stringify(value.tasks.map((item) => [item.id, item.status, item.attempts]));
    state.caseDetail = detail;
    for (const task of detail.tasks) {
      const oldTask = previous?.tasks.find((item) => item.id === task.id);
      if (oldTask && oldTask.status === task.status && oldTask.attempts === task.attempts) continue;
      delete state.taskResults[task.id];
      if (["failed", "timed_out"].includes(task.status)) state.openTasks.add(task.id);
    }
    if (previous?.batch_id === batch && previous?.case_id === caseId && signature(previous) === signature(detail)) return;
    const available = detail.candidates.some((item) => item.input_id === state.selectedInput);
    if (!available) { state.selectedInput = null; state.inputView = null; }
    renderDetail();
    for (const node of $("#case-detail").querySelectorAll("details.task-detail[open]"))
      void loadTaskResult(node.dataset.task);
    if (!state.selectedInput && detail.candidates.length) await loadInput(detail.candidates[0].input_id);
  } catch (error) {
    if (request !== state.caseRequest || runId !== state.selectedRun) return;
    state.caseDetail = null;
    $("#case-detail").innerHTML = `<p class="inline-error">无法读取样本：${escapeHtml(error.message)}</p>`;
  }
}
async function loadCases() {
  const request = ++state.casePageRequest;
  if (!state.selectedRun) { state.cases = null; renderCases(); return; }
  const runId = state.selectedRun;
  try {
    const page = await api(`${urlFor(runId)}/cases?${caseQuery()}`);
    if (state.selectedRun !== runId || request !== state.casePageRequest) return;
    state.cases = page;
    renderCases();
  } catch (error) {
    if (state.selectedRun !== runId || request !== state.casePageRequest) return;
    showError(`样本列表读取失败：${error.message}`);
  }
}
async function refresh(auto = false) {
  const request = ++state.runRequest;
  try {
    const { runs, errors } = await api("/api/dashboard/runs");
    if (request !== state.runRequest) return;
    state.runs = runs;
    const previousRun = state.selectedRun;
    if (state.selectedRun && !runs.some((item) => item.run_id === state.selectedRun)) state.selectedRun = null;
    if (previousRun !== state.selectedRun) {
      ++state.caseRequest;
      state.selectedCase = state.caseDetail = state.selectedInput = state.inputView = null;
      renderDetail();
    }
    renderRuns();
    if (state.selectedRun) {
      state.run = await api(urlFor(state.selectedRun));
      if (request !== state.runRequest) return;
    } else { state.run = null; state.cases = null; state.caseDetail = null; renderDetail(); }
    renderOverview();
    showError(errors?.length ? `${errors.length} 个运行状态无法读取：${errors.map((item) => item.run_id).join("、")}` : "");
    await loadCases();
    if (!auto) $("#refresh-time").textContent = `更新于 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`;
  } catch (error) {
    if (request === state.runRequest) showError(`运行状态读取失败：${error.message}`);
  } finally {
    scheduleAutoRefresh();
  }
}
let autoBusy = false, autoTicks = 0;
/** Poll only while a run is live, one refresh at a time; idle pages stay static for annotation. */
function scheduleAutoRefresh() {
  clearTimeout(state.refreshTimer);
  if (autoBusy) return;
  const live = state.run?.status === "running" || state.runs.some((run) => run.status === "running");
  if (live) state.refreshTimer = setTimeout(() => void autoRefresh(), 5000);
}
async function autoRefresh() {
  autoBusy = true;
  try {
    await refresh(true);
    if (state.run?.status === "running" && state.selectedCase) {
      autoTicks++;
      if (autoTicks % 3 === 0) await loadCase(state.selectedCase.batch, state.selectedCase.caseId);
    }
  } finally {
    autoBusy = false;
    scheduleAutoRefresh();
  }
}
async function selectRun(runId) {
  if (runId === state.selectedRun) return;
  ++state.caseRequest;
  state.selectedRun = runId;
  state.selectedCase = state.caseDetail = state.selectedInput = state.inputView = state.cases = null;
  state.page = 1;
  renderRuns(); renderCases(); renderDetail();
  await refresh();
}
function selectedGroups() {
  const selected = state.selectedModels;
  return (state.config?.settings?.comparisons || [])
    .map((group) => group.filter((id) => selected.has(id)))
    .filter((group) => group.length >= 2);
}
function viableCount(date) {
  const groups = selectedGroups();
  return date.cases.filter((item) => groups.some((group) => group.every((id) => item.versions.includes(id)))).length;
}
function renderDateOptions() {
  const signature = JSON.stringify([state.rangeLocked, [...state.selectedDates], [...state.selectedModels], state.inputs]);
  if (signature === state.datesSignature) return;
  state.datesSignature = signature;
  const dates = state.inputs?.dates || [];
  $("#date-options").innerHTML = !state.inputs
    ? loading("正在读取日期")
    : dates.length ? dates.map((date) => {
    const on = state.selectedDates.has(date.date);
    return `<button type="button" class="chip ${on ? "is-on" : ""}" data-date-option="${escapeHtml(date.date)}" title="${escapeHtml(date.batches.join(" "))}" aria-pressed="${on}" ${state.rangeLocked ? "disabled" : ""}>${escapeHtml(date.date)}<span class="chip-count">${viableCount(date)}/${date.cases.length}</span></button>`;
  }).join("") : '<p class="empty-state">无可用日期</p>';
}
function renderModelOptions() {
  const signature = JSON.stringify([state.rangeLocked, [...state.selectedModels], state.config]);
  if (signature === state.modelsSignature) return;
  state.modelsSignature = signature;
  const models = state.config?.settings?.models || [];
  $("#model-options").innerHTML = models.length ? models.map((model) => {
    const on = state.selectedModels.has(model.id);
    return `<button type="button" class="chip ${on ? "is-on" : ""}" data-model-option="${escapeHtml(model.id)}" title="${escapeHtml(model.id)}" aria-pressed="${on}" ${state.rangeLocked ? "disabled" : ""}>${escapeHtml(model.name)}</button>`;
  }).join("") : '<p class="empty-state">无可用模型</p>';
}
function sampleSize() {
  const value = Number($("#sample-size").value);
  return Number.isInteger(value) && value > 0 ? value : null;
}
function syncSampleMode() {
  const input = $("#sample-size"), all = $("#sample-all");
  if (!input || !all) return;
  const selected = !input.value.trim();
  all.classList.toggle("selected", selected);
  all.setAttribute("aria-pressed", String(selected));
}
function viableCases() {
  const groups = selectedGroups();
  const cases = new Set();
  for (const date of state.inputs?.dates || []) {
    if (!state.selectedDates.has(date.date)) continue;
    for (const item of date.cases)
      if (groups.some((group) => group.every((id) => item.versions.includes(id))))
        cases.add(item.id);
  }
  return [...cases];
}
/** Selected dates map to the registered batch and case filters the run actually records. */
function selectionScope() {
  const dates = state.inputs?.dates || [],
    selected = dates.filter((date) => state.selectedDates.has(date.date));
  const batches = new Set(),
    cases = new Set();
  for (const date of selected) {
    for (const batch of date.batches) batches.add(batch);
    for (const item of date.cases) cases.add(item.id);
  }
  return { full: selected.length === dates.length, batches: [...batches], cases: [...cases] };
}
function pickSample() {
  const size = sampleSize(),
    viable = viableCases();
  if (!size) return { cases: null, size: null, available: viable.length };
  for (let i = viable.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [viable[i], viable[j]] = [viable[j], viable[i]];
  }
  return { cases: viable.slice(0, size), size, available: viable.length };
}
async function loadInputs() {
  state.datesSignature = "";
  $("#date-options").innerHTML = loading("正在读取日期");
  try {
    const inventory = await api("/api/dashboard/inputs");
    state.inputs = inventory;
    const known = new Set(inventory.dates.map((date) => date.date));
    if (!state.datesReady) {
      state.selectedDates = new Set(known);
      state.datesReady = true;
    } else for (const id of [...state.selectedDates]) if (!known.has(id)) state.selectedDates.delete(id);
    renderDateOptions();
  } catch (error) {
    state.inputs = null;
    $("#date-options").innerHTML = `<p class="inline-error">${escapeHtml(error.message)}</p>`;
  }
}
async function loadConfig() {
  try {
    state.config = await api("/api/dashboard/config");
    const known = new Set((state.config.settings?.models || []).map((model) => model.id));
    if (!state.modelsReady) {
      state.selectedModels = new Set(known);
      state.modelsReady = true;
    } else for (const id of [...state.selectedModels]) if (!known.has(id)) state.selectedModels.delete(id);
    renderConfig();
    renderModelOptions();
    renderDateOptions();
  } catch (error) { showError(`配置读取失败：${error.message}`); }
}
function renderConfig() {
  const config = state.config;
  if (!config) return;
  const settings = config.settings || {};
  $("#config-path").textContent = `配置来源：${(config.paths || []).join("、")}`;
  const env = config.environment || {};
  $("#env-status").innerHTML = [
    ["URL", env.base_url_configured], ["Key", env.api_key_configured], ["基础模型", env.model_configured],
  ].map(([name, ready]) => `<span class="env-item ${ready ? "ready" : "missing"}">${name} ${ready ? "已配置" : "缺失"}</span>`).join("");
  $("#model-fields").innerHTML = `<div class="model-fields-head" aria-hidden="true"><span>阶段</span><span>模型</span><span>推理</span></div>${Object.entries(settings.bindings || {}).map(([stage, binding]) => `
    <div class="model-field-row"><span class="model-stage">${escapeHtml(stageLabel(stage))}</span><input data-model-stage="${escapeHtml(stage)}" aria-label="${escapeHtml(stageLabel(stage))}模型 ID" value="${escapeHtml(binding.model)}" /><select data-thinking-stage="${escapeHtml(stage)}" aria-label="${escapeHtml(stageLabel(stage))}推理等级">${thinkingLevels.map((level) => `<option value="${level}" ${binding.thinking === level ? "selected" : ""}>${level}</option>`).join("")}</select></div>`).join("")}`;
  $("#setting-concurrency").value = settings.execution.concurrency;
  $("#setting-timeout").value = settings.execution.timeoutSeconds;
  $("#setting-tools").value = settings.execution.maxToolCalls;
  $("#setting-retries").value = settings.execution.retries;
  $("#rewrite-attribution").checked = settings.rewrite.attribution;
  $("#rewrite-comparison").checked = settings.rewrite.comparison;
  $("#clustering-enabled").checked = settings.clustering?.enabled === true;
}
function launchPayload() {
  const scope = selectionScope();
  const sample = state.sampledCases || [];
  const batches = scope.full && !sample.length ? [] : scope.batches;
  const cases = sample.length ? sample : scope.full ? [] : scope.cases;
  const bindings = {};
  document.querySelectorAll("[data-model-stage]").forEach((input) => {
    const stage = input.dataset.modelStage;
    const thinking = document.querySelector(`[data-thinking-stage="${stage}"]`).value;
    bindings[stage] = { ...(input.value.trim() ? { model: input.value.trim() } : {}), thinking };
  });
  return {
    runId: state.runId, engine: $("#engine").value,
    ...(batches.length ? { batch: batches } : {}), ...(cases.length ? { case: cases } : {}),
    debug: $("#debug").checked,
    settings: {
      versions: [...state.selectedModels],
      bindings,
      execution: {
        concurrency: Number($("#setting-concurrency").value),
        timeoutSeconds: Number($("#setting-timeout").value),
        maxToolCalls: Number($("#setting-tools").value),
        retries: Number($("#setting-retries").value),
      },
      rewrite: { attribution: $("#rewrite-attribution").checked, comparison: $("#rewrite-comparison").checked },
      clustering: { enabled: $("#clustering-enabled").checked },
    },
  };
}
function invalidatePreview() {
  state.preview = null;
  state.sampledCases = null;
  state.sampleInfo = null;
  $("#launch-button").disabled = true;
  const status = $("#preview-result");
  status.className = "preview-result is-stale";
  status.textContent = "设置已变化 · 请重新预检";
  if (state.rangeLocked) {
    state.rangeLocked = false;
    renderDateOptions();
    renderModelOptions();
  }
}
async function preview() {
  if (!$("#start-form").reportValidity()) return;
  if (!state.inputs) await loadInputs();
  if (!state.selectedDates.size) {
    const status = $("#preview-result");
    status.className = "preview-result is-error";
    status.textContent = "至少选择一个日期";
    return;
  }
  if (state.selectedModels.size < 2) {
    const status = $("#preview-result");
    status.className = "preview-result is-error";
    status.textContent = "至少选择两个模型";
    return;
  }
  state.sampleInfo = pickSample();
  state.sampledCases = state.sampleInfo.cases;
  if (state.sampleInfo.size && !state.sampledCases.length) {
    state.sampleInfo = null;
    state.sampledCases = null;
    const status = $("#preview-result");
    status.className = "preview-result is-error";
    status.textContent = "所选范围没有完整样本";
    return;
  }
  $("#preview-button").disabled = true;
  const status = $("#preview-result");
  status.className = "preview-result is-loading";
  status.innerHTML = loading("正在预检");
  try {
    const value = await api("/api/dashboard/preview", { method: "POST", body: JSON.stringify(launchPayload()) });
    state.preview = value;
    state.rangeLocked = Boolean(value.resuming);
    renderDateOptions();
    renderModelOptions();
    $("#launch-button").disabled = !value.resuming && !value.tasks;
    const summary = value.summary || {};
    const issues = summary.issues || [];
    const stats = [
      value.resuming ? `未完成 ${value.remaining || 0}` : `任务 ${value.tasks || 0}`,
      `样本 ${summary.cases || 0}`,
      ...(state.sampleInfo?.size ? [`抽样 ${(state.sampledCases || []).length} / 可用 ${state.sampleInfo.available}`] : []),
      `有效输入 ${summary.valid_inputs || 0}`,
      `输入异常 ${summary.issues_count || 0}`,
      `跳过组 ${summary.skipped_count || 0}`,
    ];
    status.className = "preview-result is-ready";
    status.innerHTML = `<div class="preview-stats">${stats.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>
      ${issues.length ? `<details><summary>输入异常 ${issues.length}</summary><pre>${compactJson(issues)}</pre></details>` : ""}`;
  } catch (error) {
    state.preview = null;
    state.rangeLocked = false;
    renderDateOptions();
    renderModelOptions();
    $("#launch-button").disabled = true;
    status.className = "preview-result is-error";
    status.textContent = `预检失败：${error.message}`;
  } finally { $("#preview-button").disabled = false; }
}
async function startRun() {
  if (!state.preview || !$("#start-form").reportValidity()) return;
  $("#launch-button").disabled = true;
  try {
    const value = await api("/api/dashboard/runs", { method: "POST", body: JSON.stringify(launchPayload()) });
    toast(`已提交运行 ${value.run_id}`);
    state.preview = null;
    state.runId = suggestedRunId();
    $("#preview-result").className = "preview-result is-ready";
    $("#preview-result").textContent = "已提交";
    await new Promise((resolve) => setTimeout(resolve, 700));
    await refresh();
  } catch (error) {
    toast(`启动失败：${error.message}`, true);
    $("#launch-button").disabled = false;
  }
}

$("#run-list").addEventListener("click", (event) => {
  const node = event.target.closest("[data-run]");
  if (node) void selectRun(node.dataset.run);
});
$("#run-actions").addEventListener("click", async (event) => {
  const node = event.target.closest("[data-stop], [data-resume]");
  if (!node) return;
  if (node.dataset.resume) {
    state.runId = node.dataset.resume;
    $("#engine").value = state.run.engine === "prime" ? "prime" : "pi";
    invalidatePreview();
    $("#config").scrollIntoView({ behavior: "smooth" });
    $("#preview-button").focus();
  } else if (node.dataset.stop && confirm(`确定停止 ${node.dataset.stop}？已接受结果会保留。`)) {
    try { await api(`${urlFor(node.dataset.stop)}/stop`, { method: "POST" }); toast("已发送停止请求"); await refresh(); }
    catch (error) { toast(`停止失败：${error.message}`, true); }
  }
});
$("#run-actions").addEventListener("submit", async (event) => {
  if (event.target.id !== "concurrency-form") return;
  event.preventDefault();
  try {
    const value = Number($("#live-concurrency").value);
    await api(`${urlFor(state.selectedRun)}/concurrency`, { method: "POST", body: JSON.stringify({ value }) });
    toast(`已调整目标并发为 ${value}`);
    await refresh();
  } catch (error) { toast(`并发调整失败：${error.message}`, true); }
});
$("#case-list").addEventListener("click", (event) => {
  const node = event.target.closest("[data-batch][data-case]");
  if (!node) return;
  state.caseDetail = state.inputView = state.selectedInput = null;
  renderDetail();
  void loadCase(node.dataset.batch, node.dataset.case);
});
$("#problem-library").addEventListener("click", (event) => {
  const classNode = event.target.closest("[data-library-class]");
  if (classNode) {
    state.libraryOpen.add(classNode.dataset.libraryModel);
    void loadLibraryClass(classNode.dataset.libraryModel, classNode.dataset.libraryClass, 1);
    return;
  }
  const pageNode = event.target.closest("[data-library-page]");
  if (pageNode && !pageNode.disabled && state.libraryDetail)
    void loadLibraryClass(
      state.libraryDetail.model,
      state.libraryDetail.class.id,
      Number(pageNode.dataset.libraryPage),
    );
});
// `toggle` does not bubble; capture it so re-renders keep user-opened models.
$("#problem-library").addEventListener(
  "toggle",
  (event) => {
    const node = event.target.closest?.(".library-model");
    if (!node) return;
    if (node.open) state.libraryOpen.add(node.dataset.libraryModel);
    else state.libraryOpen.delete(node.dataset.libraryModel);
  },
  true,
);
// The library fetch happens only when the operator opens its panel.
$("#problem-library-panel").addEventListener("toggle", (event) => {
  if (event.target.open && state.selectedRun && state.libraryRun !== state.selectedRun)
    void loadLibrary(state.selectedRun);
});
$("#case-detail").addEventListener("click", async (event) => {
  const toggle = event.target.closest("[data-expand-text]");
  if (toggle) {
    const key = toggle.dataset.expandText;
    const expanded = !state.expandedTexts.has(key);
    const content = document.getElementById(toggle.getAttribute("aria-controls"));
    const returnToPreview = !expanded && content.getBoundingClientRect().top < 0;
    if (expanded) state.expandedTexts.add(key); else state.expandedTexts.delete(key);
    content.classList.toggle("is-clamped", !expanded);
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.textContent = expanded ? "收起" : "展开";
    if (returnToPreview)
      toggle.closest(".expandable-text").scrollIntoView({ block: "start", behavior: "instant" });
    return;
  }
  const input = event.target.closest("[data-input]");
  if (input) await loadInput(input.dataset.input);
});
// `toggle` does not bubble; capture it so expanded tasks load their result once.
$("#case-detail").addEventListener(
  "toggle",
  (event) => {
    const inputDisclosure = event.target.matches?.(".input-disclosure") ? event.target : null;
    if (inputDisclosure) {
      state.inputOpen = inputDisclosure.open;
      return;
    }
    const node = event.target.matches?.(".task-detail") ? event.target : null;
    if (!node?.dataset.task) return;
    if (node.open) {
      state.openTasks.add(node.dataset.task);
      void loadTaskResult(node.dataset.task);
    } else state.openTasks.delete(node.dataset.task);
  },
  true,
);
$("#prev-page").addEventListener("click", () => { state.page--; state.selectedCase = state.caseDetail = null; renderDetail(); void loadCases(); });
$("#next-page").addEventListener("click", () => { state.page++; state.selectedCase = state.caseDetail = null; renderDetail(); void loadCases(); });
$("#date-options").addEventListener("click", (event) => {
  const chip = event.target.closest("[data-date-option]");
  if (!chip || chip.disabled) return;
  const id = chip.dataset.dateOption;
  if (state.selectedDates.has(id)) state.selectedDates.delete(id);
  else state.selectedDates.add(id);
  renderDateOptions();
  invalidatePreview();
});
$("#model-options").addEventListener("click", (event) => {
  const chip = event.target.closest("[data-model-option]");
  if (!chip || chip.disabled) return;
  const id = chip.dataset.modelOption;
  if (state.selectedModels.has(id)) state.selectedModels.delete(id);
  else state.selectedModels.add(id);
  renderModelOptions();
  renderDateOptions();
  invalidatePreview();
});
$("#date-all").addEventListener("click", () => {
  if (state.rangeLocked) return;
  for (const date of state.inputs?.dates || []) state.selectedDates.add(date.date);
  renderDateOptions();
  invalidatePreview();
});
$("#date-none").addEventListener("click", () => {
  if (state.rangeLocked) return;
  state.selectedDates.clear();
  renderDateOptions();
  invalidatePreview();
});
$("#model-all").addEventListener("click", () => {
  if (state.rangeLocked) return;
  for (const model of state.config?.settings?.models || []) state.selectedModels.add(model.id);
  renderModelOptions();
  renderDateOptions();
  invalidatePreview();
});
$("#model-none").addEventListener("click", () => {
  if (state.rangeLocked) return;
  state.selectedModels.clear();
  renderModelOptions();
  renderDateOptions();
  invalidatePreview();
});
$("#refresh-button").addEventListener("click", async () => {
  await loadInputs();
  await refresh();
  if (state.selectedCase) {
    await loadCase(state.selectedCase.batch, state.selectedCase.caseId);
    if (state.selectedInput) await loadInput(state.selectedInput);
  }
});
$("#start-form").addEventListener("input", invalidatePreview);
$("#start-form").addEventListener("change", invalidatePreview);
$("#sample-all").addEventListener("click", () => {
  $("#sample-size").value = "";
  syncSampleMode();
  invalidatePreview();
});
$("#sample-size").addEventListener("input", syncSampleMode);
syncSampleMode();
$("#preview-button").addEventListener("click", () => void preview());
$("#start-form").addEventListener("submit", (event) => { event.preventDefault(); void startRun(); });

(async () => {
  state.runId = suggestedRunId();
  await Promise.all([loadConfig(), loadInputs(), refresh()]);
})();
