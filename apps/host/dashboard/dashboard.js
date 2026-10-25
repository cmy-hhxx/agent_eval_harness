import { createDashboardViews, groupCaseCandidates } from "./dashboard-view.js";

export function mountRuns(root, options = {}) {

const state = {
  runs: [], selectedRun: null, startingRun: null, run: null, cases: null, selectedCase: null,
  clusteringTasks: null, clusteringRun: null, clusteringRequest: 0,
  caseDetail: null, selectedInputs: {}, inputViews: {}, inputsLoading: new Set(), config: null, page: 1,
  deletingRun: null, pendingDelete: null,
  preview: null, runRequest: 0, caseRequest: 0, casePageRequest: 0, runId: "",
  inputs: null, inputsTimer: 0, selectedDates: new Set(), datesReady: false,
  selectedModels: new Set(), modelsReady: false,
  sampledCases: null, sampleInfo: null, rangeLocked: false,
  inputOpen: true, taskResults: {}, taskResultsLoading: new Set(), openTasks: new Set(), openFindings: new Set(), expandedTexts: new Set(),
  refreshTimer: 0, runsSignature: "", overviewSignature: "", casesSignature: "", datesSignature: "", modelsSignature: "",
};
const $ = (selector) => root.querySelector(selector);
const stageLabels = { criteria: "共同标准", attribution: "归因", comparison: "对比", rewrite: "改写", clustering: "聚类" };
const statusLabels = {
  running: "运行中", finished: "已结束", interrupted: "已中断", pending: "排队",
  succeeded: "已接受", failed: "失败", timed_out: "超时", blocked: "阻塞", cancelled: "取消",
  needs_review: "待复核",
};
const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
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
const API_ROOT = options.apiRoot || "/api/dashboard";
const apiUrl = (path) => `${API_ROOT}${path}`;
const urlFor = (id) => apiUrl(`/runs/${encodeURIComponent(id)}`);
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
function progressCounts(progress = {}) {
  const failures = Object.values(progress.failures || {}).reduce((total, n) => total + n, 0);
  const blocked = progress.blocked || 0, cancelled = progress.cancelled || 0;
  return { failures, blocked, cancelled,
    total: (progress.accepted || 0) + (progress.queued || 0) + (progress.preparing || 0) + (progress.running || 0) + (progress.repairing || 0) + failures + blocked + cancelled };
}
function statusText(run) {
  const counts = progressCounts(run.progress);
  const stopped = [[counts.failures, "失败"], [counts.blocked, "阻塞"], [counts.cancelled, "取消"]]
    .filter(([count]) => count).map(([, status]) => status);
  if (run.status === "finished" && stopped.length) return `已结束（有${stopped.join("、")}）`;
  if (run.status === "running" && !run.live) return "Host 未连接 · 上次快照";
  return label(run.status);
}
function renderRuns() {
  const signature = JSON.stringify([state.selectedRun, state.deletingRun, state.runs]);
  if (signature === state.runsSignature) return;
  state.runsSignature = signature;
  const list = $("#run-list");
  if (!state.runs.length) {
    list.innerHTML = "";
    if (options.resultsOnly) {
      const empty = document.createElement('div'); empty.className = 'results-empty';
      const text = document.createElement('p'); text.textContent = '暂无问财评测运行'; empty.append(text);
      if (options.onEvaluate) { const action = document.createElement('button'); action.type = 'button'; action.className = 'button'; action.textContent = '去评测'; action.onclick = options.onEvaluate; empty.append(action); }
      list.append(empty);
    }
    return;
  }
  list.innerHTML = state.runs.map((run) => {
    const progress = run.progress || {};
    const { failures, blocked, cancelled, total } = progressCounts(progress);
    const selected = state.selectedRun === run.run_id;
    const canDelete = run.status !== "running" && state.startingRun?.id !== run.run_id && state.deletingRun !== run.run_id;
    return `<div class="run-entry"><button class="run-item ${selected ? "selected" : ""}" type="button" data-run="${escapeHtml(run.run_id)}" title="${escapeHtml(run.run_id)}" aria-current="${selected}">
      <span class="run-line"><span class="status-dot ${escapeHtml(run.status)}${failures ? " has-failure" : ""}"></span><span class="run-label">${escapeHtml(runLabel(run))}</span></span>
      <span class="run-meta">${escapeHtml(run.engine)} · 评测器 ${escapeHtml(run.evaluator_version)} · ${progress.accepted || 0}/${total}${failures ? ` · ${failures} 失败` : ""}${blocked ? ` · ${blocked} 阻塞` : ""}${cancelled ? ` · ${cancelled} 取消` : ""}</span>
    </button><button class="run-delete" type="button" data-delete="${escapeHtml(run.run_id)}" aria-label="删除运行 ${escapeHtml(runLabel(run))}" title="${canDelete ? "删除运行" : run.status === "running" ? "停止后可删除" : "删除中"}" ${canDelete ? "" : "disabled"}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></svg></button></div>`;
  }).join("");
  if (options.resultsOnly) list.querySelectorAll('[data-delete]').forEach(button => button.hidden = true);
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
  const totalTasks = progressCounts(progress).total;
  const libraryModels = Object.keys(run.problem_library || {}).length;
  const engineLabel = run.engine === "prime" ? "Prime" : "Pi";
  $("#run-description").textContent = `${engineLabel} · ${progress.accepted || 0}/${totalTasks} 已接受${libraryModels ? ` · 问题库 ${libraryModels} 个模型` : ""}${run.live && progress.updated_at ? ` · 更新 ${new Date(progress.updated_at).toLocaleTimeString()}` : ""}`;
  $("#run-actions").innerHTML = run.status === "running"
    ? `<form id="concurrency-form" class="inline-form"><label for="live-concurrency">并发</label><input id="live-concurrency" type="number" min="1" value="${Number(progress.concurrency) || 1}" required /><button class="button" type="submit">调整</button></form><button class="button button-danger" type="button" data-stop="${escapeHtml(run.run_id)}">停止</button>`
    : `<button class="button" type="button" data-resume="${escapeHtml(run.run_id)}">续跑此运行</button><button class="button button-danger" type="button" data-delete="${escapeHtml(run.run_id)}">删除运行</button>`;
  $("#run-actions").hidden = options.resultsOnly === true;
  $("#stage-summary").innerHTML = ["criteria", "attribution", "comparison", "rewrite", "clustering"].map((stage) => {
    const counts = run.stages?.[stage] || {};
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    const failures = (counts.failed || 0) + (counts.timed_out || 0);
    const live = run.live ? progress.stages?.[stage] : undefined;
    const note = live ? `${live.queued || 0} 排队 · ${live.preparing || 0} 等待材料准备 · ${live.running || 0} 模型执行 · ${live.repairing || 0} 修复 · ${live.failed || 0} 失败`
      : `${counts.running || 0} 上次执行${failures ? ` · ${failures} 失败` : ""}${counts.blocked ? ` · ${counts.blocked} 阻塞` : ""}${counts.cancelled ? ` · ${counts.cancelled} 取消` : ""}`;
    return `<div class="stage-row"><strong>${stageLabel(stage)}</strong><span class="stage-count">${total ? `${counts.succeeded || 0}/${total}` : "—"}</span><span class="stage-note">${total ? note : "未启用"}</span></div>`;
  }).join("");
}
function scrollBehavior() {
  return (root.ownerDocument || root).defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth";
}
async function restoreRecall(params = new URLSearchParams((root.ownerDocument || root).defaultView.location.search)) {
  const runId = params.get("run"), batch = params.get("batch"), caseId = params.get("case");
  if (!runId) return;
  if (!state.runs.some((run) => run.run_id === runId)) { showError("样本召回失败：运行不可用"); return; }
  await selectRun(runId);
  if (!batch || !caseId || state.selectedRun !== runId) return;
  await loadCase(batch, caseId);
  if (state.selectedRun !== runId || state.caseDetail?.batch_id !== batch || state.caseDetail?.case_id !== caseId) return;
  const model = params.get("model");
  for (const group of groupCaseCandidates(state.caseDetail.candidates || [])) {
    const candidate = group.candidates.find((item) => item.version === model);
    if (candidate) state.selectedInputs[group.id] = candidate.input_id;
  }
  const taskId = params.get("task"), findingId = params.get("finding");
  const task = state.caseDetail.tasks.find((item) => item.id === taskId && item.stage === "attribution");
  if (taskId && (!task || task.status !== "succeeded")) { showError("样本召回失败：归因结果不可用"); return; }
  if (!task) { $("#case-detail").scrollIntoView?.({ behavior: scrollBehavior(), block: "start" }); return; }
  state.openTasks.add(task.id);
  renderDetail();
  await loadTaskResult(task.id);
  if (state.selectedRun !== runId || state.selectedCase?.batch !== batch || state.selectedCase?.caseId !== caseId) return;
  const result = state.taskResults[task.id];
  if (result?.error) { showError(`样本召回失败：${result.error}`); return; }
  const index = result?.result?.Problem?.findIndex((finding) => finding.problem_id === findingId) ?? -1;
  if (findingId && index < 0) { showError("样本召回失败：归因 finding 不可用"); return; }
  if (index >= 0) {
    const path = `${task.id}.Problem.${index}`;
    state.openFindings.add(path);
    renderTaskResult(task.id);
    const target = root.getElementById(`finding-${path}`);
    target?.setAttribute("tabindex", "-1");
    target?.focus({ preventScroll: true });
    target?.scrollIntoView?.({ behavior: scrollBehavior(), block: "start" });
  }
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
const compactJson = (value) => escapeHtml(JSON.stringify(value, null, 2) ?? "—");
const { renderDetail, renderTaskResult, renderClustering } = createDashboardViews({
  state,
  $,
  document: root,
  loading,
  escapeHtml,
  label,
  stageLabel,
  dateText,
});
async function loadClustering() {
  const runId = state.selectedRun;
  if (!runId) return;
  const request = ++state.clusteringRequest;
  if (state.clusteringRun !== runId) {
    state.clusteringRun = runId;
    state.clusteringTasks = null;
    renderClustering();
  }
  try {
    const tasks = await api(`${urlFor(runId)}/clustering`);
    if (state.selectedRun !== runId || request !== state.clusteringRequest) return;
    const changed = JSON.stringify(tasks) !== JSON.stringify(state.clusteringTasks);
    for (const task of tasks) {
      const old = state.clusteringTasks?.find((item) => item.id === task.id);
      if (!old || old.status !== task.status || JSON.stringify(old.rewrite_submission_ids) !== JSON.stringify(task.rewrite_submission_ids))
        delete state.taskResults[task.id];
    }
    state.clusteringTasks = tasks;
    if (changed) renderClustering();
    for (const task of tasks) void loadTaskResult(task.id);
  } catch (error) {
    if (state.selectedRun === runId && request === state.clusteringRequest)
      $("#clustering-tasks").innerHTML = `<p class="inline-error">${escapeHtml(error.message)}</p>`;
  }
}
const taskRequests = new Map();
function loadTaskResult(taskId) {
  const key = `${state.selectedRun}:${taskId}`;
  if (taskRequests.has(key)) return taskRequests.get(key);
  const request = readTaskResult(taskId).finally(() => taskRequests.delete(key));
  taskRequests.set(key, request);
  return request;
}
async function readTaskResult(taskId) {
  const task = [...(state.caseDetail?.tasks || []), ...(state.clusteringTasks || [])].find((task) => task.id === taskId);
  if (!taskId || task?.status !== "succeeded"
      || state.taskResults[taskId] || state.taskResultsLoading.has(taskId)) return;
  const results = state.taskResults, loadingResults = state.taskResultsLoading;
  loadingResults.add(taskId);
  const runId = state.selectedRun,
    caseId = state.caseDetail?.case_id;
  try {
    const value = await api(`${urlFor(runId)}/tasks/${encodeURIComponent(taskId)}/result`);
    if (results !== state.taskResults || state.selectedRun !== runId || (task.stage !== "clustering" && state.caseDetail?.case_id !== caseId)) return;
    state.taskResults[taskId] = { result: value.result ?? null };
  } catch (error) {
    if (results !== state.taskResults || runId !== state.selectedRun) return;
    results[taskId] = { error: error.message };
  } finally {
    loadingResults.delete(taskId);
  }
  renderTaskResult(taskId);
}
function resetInputs() {
  state.selectedInputs = {};
  state.inputViews = {};
  state.inputsLoading = new Set();
}
async function loadInput(inputId, groupId) {
  const changed = state.selectedInputs[groupId] !== inputId;
  state.selectedInputs[groupId] = inputId;
  // Reuse the selected case input while its request is pending.
  if (state.inputViews[inputId] || state.inputsLoading.has(inputId)) {
    if (changed) renderDetail();
    return;
  }
  renderDetail();
  const runId = state.selectedRun;
  const views = state.inputViews, loadingInputs = state.inputsLoading;
  loadingInputs.add(inputId);
  try {
    const input = await api(`${urlFor(runId)}/inputs/${encodeURIComponent(inputId)}`);
    if (state.selectedRun !== runId || state.inputViews !== views) return;
    views[inputId] = input;
  } catch (error) {
    if (state.selectedRun !== runId || state.inputViews !== views) return;
    views[inputId] = { error: error.message };
  } finally { loadingInputs.delete(inputId); }
  renderDetail();
}
async function loadCaseInputs() {
  if (!state.inputOpen || !state.caseDetail) return;
  await Promise.all(groupCaseCandidates(state.caseDetail.candidates || []).map((group) => {
    const selected = group.candidates.find((item) => item.input_id === state.selectedInputs[group.id]) || group.candidates[0];
    return selected ? loadInput(selected.input_id, group.id) : undefined;
  }));
}
async function loadCase(batch, caseId) {
  const runId = state.selectedRun;
  const request = ++state.caseRequest;
  const changed = state.selectedCase?.batch !== batch || state.selectedCase?.caseId !== caseId;
  state.selectedCase = { batch, caseId };
  if (changed) {
    resetInputs();
    state.taskResults = {};
    state.taskResultsLoading = new Set();
    state.openTasks = new Set();
    state.expandedTexts = new Set();
    state.inputOpen = true;
  }
  renderCases();
  try {
    const params = new URLSearchParams({ batch, case: caseId });
    const detail = await api(`${urlFor(runId)}/cases/detail?${params}`);
    if (request !== state.caseRequest || runId !== state.selectedRun) return;
    const previous = state.caseDetail;
    const signature = (value) => JSON.stringify(value.tasks.map((item) => [
      item.id, item.status, item.attempts, item.rewrite_submission_ids,
      item.review_of, item.result_status,
    ]));
    state.caseDetail = detail;
    for (const task of detail.tasks) {
      const oldTask = previous?.tasks.find((item) => item.id === task.id);
      if (oldTask && oldTask.status === task.status && oldTask.attempts === task.attempts && JSON.stringify(oldTask.rewrite_submission_ids) === JSON.stringify(task.rewrite_submission_ids)) continue;
      delete state.taskResults[task.id];
      if (["failed", "timed_out"].includes(task.status)) state.openTasks.add(task.id);
    }
    if (previous?.batch_id === batch && previous?.case_id === caseId && signature(previous) === signature(detail)) return;
    for (const group of groupCaseCandidates(detail.candidates || [])) {
      if (!group.candidates.some((item) => item.input_id === state.selectedInputs[group.id]))
        state.selectedInputs[group.id] = group.candidates[0]?.input_id;
    }
    renderDetail();
    for (const node of $("#case-detail").querySelectorAll(".task-detail"))
      void loadTaskResult(node.dataset.task);
    void loadCaseInputs();
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
  const wasRunning = state.run?.status === "running";
  try {
    const { runs, errors } = await api(apiUrl("/runs"));
    if (request !== state.runRequest) return;
    state.runs = runs;
    if (options.resultsOnly && !state.selectedRun) state.selectedRun = runs[0]?.run_id || null;
    const previousRun = state.selectedRun;
    if (state.startingRun) {
      if (runs.some((run) => run.run_id === state.startingRun.id)) {
        state.selectedRun = state.startingRun.id;
        state.startingRun = null;
        state.page = 1;
      } else if (Date.now() >= state.startingRun.deadline) {
        const id = state.startingRun.id;
        state.startingRun = null;
        throw new Error(`运行 ${id} 启动等待超时`);
      }
    }
    if (state.selectedRun && !runs.some((item) => item.run_id === state.selectedRun)) state.selectedRun = null;
    if (previousRun !== state.selectedRun) {
      ++state.caseRequest;
      state.selectedCase = state.caseDetail = null;
      resetInputs();
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
    if (state.selectedCase && (!auto || (wasRunning && state.run?.status !== "running")))
      await loadCase(state.selectedCase.batch, state.selectedCase.caseId);
    if (state.selectedRun) await loadClustering();
    if (!auto) $("#refresh-time").textContent = `更新于 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`;
  } catch (error) {
    if (request === state.runRequest) showError(`运行状态读取失败：${error.message}`);
  } finally {
    scheduleAutoRefresh();
  }
}
let autoBusy = false, autoTicks = 0;
/** Include the gap between spawn and the first checkpoint; idle pages stop polling. */
function scheduleAutoRefresh() {
  clearTimeout(state.refreshTimer);
  if (autoBusy) return;
  const live = state.run?.status === "running" || state.runs.some((run) => run.status === "running");
  if (live || state.startingRun)
    state.refreshTimer = setTimeout(() => void autoRefresh(), state.startingRun ? 1000 : 5000);
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
  state.selectedCase = state.caseDetail = state.cases = null;
  resetInputs();
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
  return (date.cases || []).filter((item) => groups.some((group) => group.filter((id) => item.versions.includes(id)).length >= 2)).length;
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
    const count = date.cases === null ? "扫描中" : `${viableCount(date)} / ${date.cases.length}`;
    const accessible = date.cases === null ? `${date.date}，扫描中` : `${date.date}，可评测 ${viableCount(date)}，总数 ${date.cases.length}`;
    return `<button type="button" class="date-option ${on ? "is-on" : ""}" data-date-option="${escapeHtml(date.date)}" title="${escapeHtml(date.batches.join(" "))}" aria-label="${escapeHtml(accessible)}" aria-pressed="${on}" ${state.rangeLocked ? "disabled" : ""}><span>${escapeHtml(date.date)}</span><span class="date-count">${count}</span></button>`;
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
  $("#sample-seed").disabled = selected;
}
function viableCases() {
  const groups = selectedGroups();
  const cases = new Set();
  for (const date of state.inputs?.dates || []) {
    if (!state.selectedDates.has(date.date)) continue;
    for (const item of date.cases || [])
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
    for (const item of date.cases || []) cases.add(item.id);
  }
  return { full: selected.length === dates.length, batches: [...batches], cases: [...cases] };
}
function pickSample() {
  const size = sampleSize(),
    viable = viableCases();
  if (!size) return { cases: null, size: null, available: viable.length };
  const seedValue = $("#sample-seed").value.trim();
  let random = Math.random;
  if (seedValue) {
    // Stable case order and a fresh Mulberry32 stream make each seeded preview reproducible.
    viable.sort();
    let seed = Number(seedValue);
    random = () => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let value = Math.imul(seed ^ (seed >>> 15), seed | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
  }
  for (let i = viable.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [viable[i], viable[j]] = [viable[j], viable[i]];
  }
  return { cases: viable.slice(0, size), size, available: viable.length };
}
async function loadInputs() {
  clearTimeout(state.inputsTimer);
  if (!state.inputs) $("#date-options").innerHTML = loading("正在读取日期");
  try {
    const inventory = await api(apiUrl("/inputs"));
    state.inputs = inventory;
    $("#preview-button").disabled = inventory.status !== "ready";
    if (inventory.status === "loading") state.inputsTimer = setTimeout(() => void loadInputs(), 500);
    const known = new Set(inventory.dates.map((date) => date.date));
    if (!state.datesReady) {
      state.selectedDates = new Set(known);
      state.datesReady = true;
    } else for (const id of [...state.selectedDates]) if (!known.has(id)) state.selectedDates.delete(id);
    renderDateOptions();
  } catch (error) {
    state.inputs = null;
    state.datesSignature = "";
    $("#preview-button").disabled = true;
    $("#date-options").innerHTML = `<p class="inline-error">${escapeHtml(error.message)}</p>`;
  }
}
async function loadConfig() {
  try {
    state.config = await api(apiUrl("/config"));
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
    ["URL", env.base_url_configured], ["Key", env.api_key_configured],
  ].map(([name, ready]) => `<span class="env-item ${ready ? "ready" : "missing"}">${name} ${ready ? "已配置" : "缺失"}</span>`).join("")
    + (config.model_catalog_failures || []).map(failure => `<span class="env-item missing">${escapeHtml(failure.name)}：${escapeHtml(failure.message)}</span>`).join("");
  const gatewayModels = config.model_catalog || [];
  const modelOptions = (selected) => gatewayModels.length
    ? `<option value="" ${selected ? "" : "selected"}>未选模型</option>${gatewayModels.map((model) => `<option value="${escapeHtml(JSON.stringify([model.channel, model.id]))}" ${JSON.stringify([model.channel, model.id]) === selected ? "selected" : ""}>${escapeHtml(model.name || model.id)}</option>`).join("")}`
    : `<option value="" selected>${escapeHtml(config.model_catalog_error || "网关未返回可用模型")}</option>`;
  $("#model-fields").innerHTML = `<div class="model-fields-head" aria-hidden="true"><span>阶段</span><span>模型</span><span>推理</span></div>${Object.entries(settings.bindings || {}).map(([stage, binding]) => {
    const selected = gatewayModels.some((model) => model.channel === binding.channel && model.id === binding.model) ? JSON.stringify([binding.channel, binding.model]) : "";
    return `
    <div class="model-field-row"><span class="model-stage">${escapeHtml(stageLabel(stage))}</span><select data-model-stage="${escapeHtml(stage)}" aria-label="${escapeHtml(stageLabel(stage))}模型 ID" ${gatewayModels.length ? "" : "disabled"}>${modelOptions(selected)}</select><select data-thinking-stage="${escapeHtml(stage)}" aria-label="${escapeHtml(stageLabel(stage))}推理等级">${thinkingLevels.map((level) => `<option value="${level}" ${binding.thinking === level ? "selected" : ""}>${level}</option>`).join("")}</select></div>`;
  }).join("")}`;
  $("#setting-concurrency").value = settings.execution.concurrency;
  $("#setting-timeout").value = settings.execution.timeoutSeconds;
  $("#setting-tools").value = settings.execution.maxToolCalls;
  $("#setting-retries").value = settings.execution.retries;
  $("#rewrite-attribution").checked = settings.rewrite.attribution;
  $("#rewrite-comparison").checked = settings.rewrite.comparison;
  $("#rewrite-clustering").checked = settings.rewrite.clustering;
  $("#clustering-enabled").checked = settings.clustering?.enabled === true;
}
function launchPayload() {
  const scope = selectionScope();
  const sample = state.sampledCases || [];
  const batches = scope.full && !sample.length ? [] : scope.batches;
  const cases = sample.length ? sample : scope.full ? [] : scope.cases;
  const bindings = {};
  root.querySelectorAll("[data-model-stage]").forEach((input) => {
    const stage = input.dataset.modelStage;
    const thinking = root.querySelector(`[data-thinking-stage="${stage}"]`).value;
    const selected = input.value ? JSON.parse(input.value) : undefined;
    bindings[stage] = { ...(selected ? { channel: selected[0], model: selected[1] } : {}), thinking };
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
      rewrite: { attribution: $("#rewrite-attribution").checked, comparison: $("#rewrite-comparison").checked, clustering: $("#rewrite-clustering").checked },
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
  if (state.inputs?.status !== "ready") return;
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
  const sampleInfo = pickSample();
  state.sampleInfo = sampleInfo;
  state.sampledCases = sampleInfo.cases;
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
    const value = await api(apiUrl("/preview"), { method: "POST", body: JSON.stringify(launchPayload()) });
    if (state.sampleInfo !== sampleInfo) return;
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
      `对局 ${summary.comparison_tasks || 0}`,
      ...(summary.comparison_verification_tasks ? [`独立核验 ${summary.comparison_verification_tasks}`] : []),
      ...(state.sampleInfo?.size ? [`抽样 ${(state.sampledCases || []).length} / 可用 ${state.sampleInfo.available}`] : []),
      `有效输入 ${summary.valid_inputs || 0}`,
      `输入异常 ${summary.issues_count || 0}`,
      `跳过组 ${summary.skipped_count || 0}`,
    ];
    status.className = "preview-result is-ready";
    status.innerHTML = `<div class="preview-stats">${stats.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}</div>
      ${issues.length ? `<section><header>输入异常 ${issues.length}</header><pre>${compactJson(issues)}</pre></section>` : ""}`;
  } catch (error) {
    if (state.sampleInfo !== sampleInfo) return;
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
  $("#launch-button").textContent = "启动中…";
  try {
    const value = await api(apiUrl("/runs"), { method: "POST", body: JSON.stringify(launchPayload()) });
    state.startingRun = { id: value.run_id, deadline: Date.now() + 120000 };
    toast(`已提交运行 ${value.run_id}`);
    state.preview = null;
    state.runId = suggestedRunId();
    $("#preview-result").className = "preview-result is-ready";
    $("#preview-result").textContent = "进程已启动";
    await new Promise((resolve) => setTimeout(resolve, 700));
    await refresh();
  } catch (error) {
    toast(`启动失败：${error.message}`, true);
    $("#launch-button").disabled = false;
  } finally { $("#launch-button").textContent = "启动"; }
}

function requestDelete(runId) {
  const run = state.runs.find((item) => item.run_id === runId);
  if (!run || run.status === "running" || state.deletingRun) return;
  state.pendingDelete = runId;
  $("#delete-run-label").textContent = `${runLabel(run)} · ${runId}`;
  $("#delete-error").textContent = "";
  $("#delete-error").hidden = true;
  $("#delete-dialog").showModal();
  $("#delete-cancel").focus();
}
async function deleteRun() {
  const runId = state.pendingDelete;
  if (!runId || state.deletingRun) return;
  state.deletingRun = runId;
  $("#delete-confirm").disabled = $("#delete-cancel").disabled = true;
  renderRuns();
  try {
    await api(urlFor(runId), { method: "DELETE" });
    $("#delete-dialog").close();
    if (state.runId === runId) { state.runId = suggestedRunId(); invalidatePreview(); }
    toast("已删除运行");
    await refresh();
  } catch (error) {
    $("#delete-error").textContent = `删除失败：${error.message}`;
    $("#delete-error").hidden = false;
  } finally {
    state.deletingRun = null;
    $("#delete-confirm").disabled = $("#delete-cancel").disabled = false;
    renderRuns();
  }
}
$("#delete-form").addEventListener("submit", (event) => { event.preventDefault(); void deleteRun(); });
$("#delete-cancel").addEventListener("click", () => $("#delete-dialog").close());
$("#delete-dialog").addEventListener("close", () => { state.pendingDelete = null; });
$("#delete-dialog").addEventListener("cancel", (event) => { if (state.deletingRun) event.preventDefault(); });
$("#run-list").addEventListener("click", (event) => {
  const remove = event.target.closest("[data-delete]");
  if (remove) { if (!remove.disabled) requestDelete(remove.dataset.delete); return; }
  const node = event.target.closest("[data-run]");
  if (node) void selectRun(node.dataset.run);
});
$("#run-actions").addEventListener("click", async (event) => {
  const node = event.target.closest("[data-stop], [data-resume], [data-delete]");
  if (!node) return;
  if (node.dataset.delete) requestDelete(node.dataset.delete);
  else if (node.dataset.resume) {
    if (state.run.batch_run && options.onBatchResume) { options.onBatchResume(node.dataset.resume); return; }
    state.runId = node.dataset.resume;
    $("#engine").value = state.run.engine === "prime" ? "prime" : "pi";
    invalidatePreview();
    $("#config").scrollIntoView({ behavior: scrollBehavior() });
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
  state.caseDetail = null;
  resetInputs();
  renderDetail();
  void loadCase(node.dataset.batch, node.dataset.case);
});
root.addEventListener("click", async (event) => {
  const findingLink = event.target.closest("[data-finding-target]");
  if (findingLink) {
    const finding = root.getElementById(findingLink.dataset.findingTarget);
    if (finding) {
      event.preventDefault();
      finding.setAttribute("tabindex", "-1"); finding.focus({ preventScroll:true });

    }
    return;
  }
  const input = event.target.closest("[data-input]");
  if (input) await loadInput(input.dataset.input, input.dataset.inputGroup);
});
$("#prev-page").addEventListener("click", () => { state.page--; state.selectedCase = state.caseDetail = null; resetInputs(); renderDetail(); void loadCases(); });
$("#next-page").addEventListener("click", () => { state.page++; state.selectedCase = state.caseDetail = null; resetInputs(); renderDetail(); void loadCases(); });
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
  if (!options.resultsOnly) await loadInputs();
  await refresh();
  if (state.selectedCase) {
    await loadCase(state.selectedCase.batch, state.selectedCase.caseId);
    state.inputViews = {};
    state.inputsLoading = new Set();
    await loadCaseInputs();
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

const ready = (async () => {
  state.runId = suggestedRunId();
  $("#config").hidden = options.resultsOnly === true;
  await Promise.all([...(options.resultsOnly ? [] : [loadConfig(), loadInputs()]), refresh().then(() => restoreRecall())]);
})();

return { ready, restoreRecall: async params => { await refresh(); await restoreRecall(params); } };
}
if (globalThis.document?.querySelector("#start-form")) mountRuns(document);
