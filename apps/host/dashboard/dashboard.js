const state = {
  runs: [],
  selected: null,
  details: null,
  config: null,
};

const $ = (selector) => document.querySelector(selector);
const statusLabels = {
  running: "运行中",
  finished: "已完成",
  interrupted: "已中止",
  failed: "失败",
  pending: "排队",
  succeeded: "已接受",
  timed_out: "超时",
  cancelled: "已取消",
  blocked: "已阻塞",
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function statusLabel(status) {
  return statusLabels[status] || status;
}

function dateText(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(value);
}

async function api(url, options) {
  const response = await fetch(url, { headers: { "content-type": "application/json" }, ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `请求失败（${response.status}）`);
  return payload;
}

function toast(message, error = false) {
  const node = $("#toast");
  node.textContent = message;
  node.style.borderColor = error ? "#6e3c3c" : "#38516a";
  node.classList.add("visible");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove("visible"), 3200);
}

function renderMetrics() {
  const active = state.runs.filter((run) => run.status === "running");
  $("#metric-runs").textContent = active.length;
  $("#metric-running").textContent = state.runs.reduce((sum, run) => sum + (run.progress?.running || 0), 0);
  $("#metric-accepted").textContent = state.runs.reduce((sum, run) => sum + (run.progress?.accepted || 0), 0);
  $("#metric-concurrency").textContent = state.config?.config?.execution?.concurrency ?? "—";
}

function renderRuns() {
  const list = $("#run-list");
  if (!state.runs.length) {
    list.innerHTML = '<div class="empty-state">还没有运行。用下方表单创建第一个 run。</div>';
    return;
  }
  list.innerHTML = state.runs.map((run) => {
    const progress = run.progress || {};
    const total = (progress.accepted || 0) + (progress.running || 0) + (progress.queued || 0);
    const action = run.status === "running"
      ? `<button class="button button-danger" data-stop="${escapeHtml(run.run_id)}" type="button">停止运行</button>`
      : run.status === "interrupted"
        ? `<button class="button" data-continue="${escapeHtml(run.run_id)}" data-engine="${escapeHtml(run.engine)}" type="button">继续</button>`
        : "";
    return `
      <div class="run-row ${state.selected === run.run_id ? "selected" : ""}">
        <button class="run-select" data-select="${escapeHtml(run.run_id)}" type="button" aria-label="选择 ${escapeHtml(run.run_id)}">
          <span class="run-status-dot ${escapeHtml(run.status)}"></span>
          <span class="run-main">
            <span class="run-name">${escapeHtml(run.run_id)}</span>
            <span class="run-meta"><span>${escapeHtml(run.engine)}</span><span>${escapeHtml(statusLabel(run.status))}</span><span>${escapeHtml(dateText(run.started_at))}</span></span>
          </span>
          <span class="run-progress">${progress.accepted || 0}${total ? ` / ${total}` : ""} 已接受</span>
        </button>
        <span class="run-actions">${action}</span>
      </div>`;
  }).join("");

  list.querySelectorAll("[data-select]").forEach((node) => {
    node.addEventListener("click", () => selectRun(node.dataset.select));
  });
  list.querySelectorAll("[data-stop]").forEach((node) => node.addEventListener("click", () => stopRun(node.dataset.stop)));
  list.querySelectorAll("[data-continue]").forEach((node) => node.addEventListener("click", () => {
    startRun(node.dataset.continue, node.dataset.engine);
  }));
}

function renderConfig() {
  if (!state.config) return;
  $("#config-path").textContent = state.config.path;
  $("#config-json").textContent = JSON.stringify(state.config.config, null, 2);
  const env = state.config.environment || {};
  $("#env-status").innerHTML = `
    <span class="env-item ${env.base_url_configured ? "ready" : "missing"}">URL ${env.base_url_configured ? "已配置" : "缺失"}</span>
    <span class="env-item ${env.api_key_configured ? "ready" : "missing"}">Key ${env.api_key_configured ? "已配置" : "缺失"}</span>`;
}

function renderDetails() {
  const detail = state.details;
  if (!detail) {
    $("#selected-run").textContent = "未选择运行";
    $("#activity-summary").innerHTML = "";
    $("#task-list").innerHTML = '<tr><td class="table-empty" colspan="6">选择运行</td></tr>';
    return;
  }
  $("#selected-run").textContent = detail.run_id;
  const progress = detail.progress || {};
  $("#activity-summary").innerHTML = `
    <span>状态 <strong>${escapeHtml(statusLabel(detail.status))}</strong></span>
    <span>排队 <strong>${progress.queued || 0}</strong></span>
    <span>运行 <strong>${progress.running || 0}</strong></span>
    <span>已接受 <strong>${progress.accepted || 0}</strong></span>
    <span>并发 <strong>${progress.concurrency || 0}</strong></span>`;
  const tasks = detail.tasks || [];
  if (!tasks.length) {
    $("#task-list").innerHTML = '<tr><td class="table-empty" colspan="6">这个运行没有登记任务</td></tr>';
    return;
  }
  $("#task-list").innerHTML = tasks.map((task) => {
    const item = task.state || {};
    const failure = item.failure?.errors?.[0]?.message || "";
    const reason = failure || item.reason || "";
    return `<tr>
      <td>${escapeHtml(task.id)}</td>
      <td>${escapeHtml(task.stage)}</td>
      <td>${escapeHtml(task.batch_id || "—")} / ${escapeHtml(task.case_id || "—")}</td>
      <td><span class="status-text ${escapeHtml(item.status)}">${escapeHtml(statusLabel(item.status))}</span></td>
      <td>${escapeHtml(item.attempts || 0)}</td>
      <td><span class="reason" title="${escapeHtml(reason)}">${escapeHtml(reason || "—")}</span></td>
    </tr>`;
  }).join("");
}

async function selectRun(runId) {
  state.selected = runId;
  renderRuns();
  try {
    state.details = await api(`/api/dashboard/runs/${encodeURIComponent(runId)}`);
    renderDetails();
  } catch (error) {
    toast(error.message, true);
  }
}

async function loadConfig() {
  try {
    state.config = await api("/api/dashboard/config");
    renderConfig();
    renderMetrics();
  } catch (error) {
    toast(`配置读取失败：${error.message}`, true);
  }
}

async function refresh(silent = false) {
  try {
    const payload = await api("/api/dashboard/runs");
    state.runs = payload.runs || [];
    if (state.selected && !state.runs.some((run) => run.run_id === state.selected)) state.selected = null;
    if (!state.selected && state.runs[0]) state.selected = state.runs[0].run_id;
    renderMetrics();
    renderRuns();
    if (state.selected) {
      state.details = await api(`/api/dashboard/runs/${encodeURIComponent(state.selected)}`);
      renderDetails();
    } else renderDetails();
    $("#refresh-time").textContent = `更新于 ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
  } catch (error) {
    if (!silent) toast(`状态读取失败：${error.message}`, true);
  }
}

async function stopRun(runId) {
  if (!runId || !confirm(`确定停止 ${runId}？`)) return;
  try {
    await api(`/api/dashboard/runs/${encodeURIComponent(runId)}/stop`, { method: "POST" });
    toast(`已发送停止信号：${runId}`);
    setTimeout(() => refresh(true), 500);
  } catch (error) {
    toast(`停止失败：${error.message}`, true);
  }
}

async function startRun(runId, engine) {
  try {
    await api("/api/dashboard/runs", {
      method: "POST",
      body: JSON.stringify({ runId, engine }),
    });
    $("#run-id").value = runId;
    $("#engine").value = engine || "pi";
    toast(`已启动：${runId}`);
    setTimeout(() => refresh(true), 500);
  } catch (error) {
    toast(`启动失败：${error.message}`, true);
  }
}

$("#refresh-button").addEventListener("click", () => refresh());
$("#start-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const runId = $("#run-id").value.trim();
  const batch = $("#batch").value.trim();
  const limit = $("#limit-cases").value;
  const payload = {
    runId,
    engine: $("#engine").value,
    ...(batch ? { batch: [batch] } : {}),
    ...(limit ? { limitCases: Number(limit) } : {}),
    ...( $("#debug").checked ? { debug: true } : {}),
  };
  try {
    await api("/api/dashboard/runs", { method: "POST", body: JSON.stringify(payload) });
    toast(`已启动：${runId}`);
    await new Promise((resolve) => setTimeout(resolve, 450));
    await refresh(true);
  } catch (error) {
    toast(`启动失败：${error.message}`, true);
  }
});

loadConfig();
refresh();
setInterval(() => refresh(true), 3000);
