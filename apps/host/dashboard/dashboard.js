const state = {
  runs: [], selectedRun: null, run: null, cases: null, selectedCase: null,
  caseDetail: null, selectedInput: null, rawInput: null, config: null, page: 1,
  preview: null, runRequest: 0, caseRequest: 0, casePageRequest: 0, filters: {},
};
const $ = (selector) => document.querySelector(selector);
const stageLabels = { attribution: "归因", comparison: "对比", rewrite: "改写" };
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
const urlFor = (id) => `/api/dashboard/runs/${encodeURIComponent(id)}`;

async function api(url, options) {
  const response = await fetch(url, { headers: { "content-type": "application/json" }, ...options });
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
  const list = $("#run-list");
  if (!state.runs.length) {
    list.innerHTML = '<p class="empty-state">还没有运行。请先设置并预检。</p>';
    return;
  }
  list.innerHTML = state.runs.map((run) => `
    <button class="run-select ${state.selectedRun === run.run_id ? "selected" : ""}" type="button"
      data-run="${escapeHtml(run.run_id)}" aria-current="${state.selectedRun === run.run_id ? "true" : "false"}">
      <span class="run-name">${escapeHtml(run.run_id)}</span>
      <span class="run-meta"><span class="status-indicator ${escapeHtml(run.status)}"></span>${escapeHtml(run.engine)} · ${escapeHtml(statusText(run))}</span>
      <span class="run-progress">${run.progress?.accepted || 0} 已接受 · ${run.progress?.running || 0} 执行中</span>
    </button>`).join("");
}
function renderOverview() {
  const run = state.run;
  if (!run) {
    $("#run-title").textContent = "选择一个运行";
    $("#run-description").textContent = "运行概览与样本会在这里显示。";
    $("#run-actions").innerHTML = "";
    $("#stage-summary").innerHTML = '<p class="empty-state">暂无运行状态</p>';
    return;
  }
  $("#run-title").textContent = run.run_id;
  const progress = run.progress || {};
  $("#run-description").textContent = `${statusText(run)} · ${run.engine} · ${dateText(run.started_at)} · 已接受 ${progress.accepted || 0} / 排队 ${progress.queued || 0} / 运行 ${progress.running || 0}`;
  $("#run-actions").innerHTML = run.status === "running"
    ? `<form id="concurrency-form" class="inline-form"><label for="live-concurrency">并发</label><input id="live-concurrency" type="number" min="1" value="${Number(progress.concurrency) || 1}" required /><button class="button" type="submit">调整</button></form><button class="button button-danger" type="button" data-stop="${escapeHtml(run.run_id)}">停止运行</button>`
    : `<button class="button" type="button" data-resume="${escapeHtml(run.run_id)}">用此 ID 续跑</button>`;
  $("#stage-summary").innerHTML = ["attribution", "comparison", "rewrite"].map((stage) => {
    const counts = run.stages?.[stage] || {};
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    return `<div class="stage-row"><strong>${stageLabel(stage)}</strong><span>${total ? `${counts.succeeded || 0}/${total} 已接受` : "未启用"}</span><span>${counts.running || 0} 执行 · ${(counts.failed || 0) + (counts.timed_out || 0) + (counts.blocked || 0)} 异常</span></div>`;
  }).join("");
}
function filterQuery() {
  return new URLSearchParams({ page: String(state.page), ...state.filters }).toString();
}
function renderCases() {
  const page = state.cases;
  if (!page) {
    $("#case-count").textContent = "—";
    $("#case-list").innerHTML = `<p class="empty-state">${state.selectedRun ? "正在读取样本…" : "选择运行后查看样本。"}</p>`;
    $("#page-label").textContent = "—";
    $("#prev-page").disabled = $("#next-page").disabled = true;
    return;
  }
  $("#case-count").textContent = `${page.total} 个样本`;
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
      <span class="case-question">${escapeHtml(item.question || "问题不可用")}</span>
      <span class="case-progress ${bad ? "has-failure" : ""}">${accepted}/${item.task_count} 已接受${bad ? " · 有异常" : ""}</span>
    </button>`;
  }).join("") : '<p class="empty-state">当前筛选下没有样本。请清除筛选条件。</p>';
}
function compactJson(value) {
  const text = JSON.stringify(value, (_key, content) =>
    typeof content === "string" && content.length > 40000 ? `${content.slice(0, 40000)}… [内容过长，请查看源文件]` : content, 2);
  return escapeHtml(text ?? "—");
}
function renderInput() {
  const input = state.rawInput;
  if (!state.selectedInput) return '<p class="empty-state">选择版本查看原始回答和消息链路。</p>';
  if (!input) return '<p class="empty-state">正在读取原始输入…</p>';
  if (input.error) return `<p class="inline-error">${escapeHtml(input.error)}<br />正式结果仍可独立查看。</p>`;
  const raw = input.raw || {};
  const messages = Array.isArray(raw.messages) ? raw.messages : [];
  const lastAnswer = messages.findLast((message) => message.role === "assistant" && message.content);
  const standard = raw.has_standard_answer === false ? "本记录明确忽略标准答案" :
    (raw.meta?.ground_truth ?? raw.meta?.std_answer ?? "本记录未提供标准答案");
  return `<p class="source-note">当前源记录 · 第 ${input.line} 行${input.recorded_line !== input.line ? `（登记时第 ${input.recorded_line} 行）` : ""}。源数据可能在评测后变化，已接受结果不会重评。</p>
    <div class="input-highlights"><div><strong>最终回答</strong><pre>${compactJson(lastAnswer?.content ?? "无")}</pre></div><div><strong>本记录标准答案</strong><pre>${compactJson(standard)}</pre></div></div>
    <details class="trace-details"><summary>原始消息 · ${messages.length} 条（展开核对证据）</summary><div class="trace-list">${messages.map((message, index) => `<article class="trace-message" id="message-${escapeHtml(input.input_id)}-${index}">
      <div class="trace-heading"><strong>#${index} · ${escapeHtml(message.type || message.role || "消息")}</strong><span>${escapeHtml(message.role || "")}</span></div>
      <pre>${compactJson(message.content ?? message)}</pre>
    </article>`).join("") || '<p class="empty-state">这条记录没有消息。</p>'}</div></details>
    <details class="raw-details"><summary>查看源记录字段</summary><pre>${compactJson(raw)}</pre></details>`;
}
function evidence(items, version) {
  if (!Array.isArray(items) || !items.length) return "";
  return `<ul class="evidence-list">${items.map((item) => `<li>
    <button type="button" class="evidence-link" data-evidence-version="${escapeHtml(version)}" data-evidence-index="${Number(item.message_index)}">消息 #${escapeHtml(item.message_index)}</button>
    <span>${escapeHtml(item.quote || item.observation || "")}</span></li>`).join("")}</ul>`;
}
function renderResult(task, detail) {
  const row = task.result;
  if (!row) return `<p class="muted">${task.status === "succeeded" ? "收据正在写入正式结果，请稍后刷新。" : "尚无已接受的正式结果。"}</p>`;
  if (task.stage === "attribution") {
    const value = row.evaluation || {};
    return `<div class="result-body"><p><strong>结论</strong> ${escapeHtml(value.summary || "—")}</p>
      <p><strong>标准答案判定</strong> ${value.is_correct === null ? "无标准答案" : value.is_correct ? "正确" : "错误"} ${escapeHtml(value.correctness_reason || "")}</p>
      ${evidence(value.correctness_evidence, row.version)}
      <h4>发现 · ${(value.findings || []).length}</h4>
      ${(value.findings || []).map((finding) => `<div class="finding"><strong>${escapeHtml(finding.type)} · ${escapeHtml(finding.stage)}</strong><p>${escapeHtml(finding.text)}</p><p class="muted">${escapeHtml(finding.reason)}</p>${evidence(finding.evidence, row.version)}</div>`).join("")}
    </div>`;
  }
  if (task.stage === "comparison") {
    const names = Object.fromEntries(Object.entries(row.models || {}).map(([id, info]) => [id, info.version || id]));
    return `<div class="result-body"><p><strong>任务分析</strong> ${escapeHtml(row.task_analysis?.goal || "—")}</p>
      <p><strong>本题共享标准答案</strong> ${row.ground_truth?.available ? escapeHtml(JSON.stringify(row.ground_truth.value)) : "无"}</p>
      <h4>排名</h4><ol class="ranking">${(row.ranking || []).map((tier) => `<li>${tier.map((id) => escapeHtml(names[id] || id)).join(" · ")}</li>`).join("")}</ol>
      <p><strong>权衡</strong> ${escapeHtml(row.decision_basis?.tradeoff || "—")}</p>
      <h4>决定性发现</h4><p>${(row.decision_basis?.decisive_findings || []).map((ref) => `${escapeHtml(names[ref.candidate] || ref.candidate)} · 发现 #${escapeHtml(ref.finding_index)}`).join("；") || "未引用发现"}</p>
      <h4>候选评估</h4>${Object.entries(row.assessments || {}).map(([id, item]) => `<p><strong>${escapeHtml(names[id] || id)} · ${item.meets_core ? "满足核心要求" : "未满足核心要求"}</strong><br />${escapeHtml(item.summary)}</p>`).join("")}
      <h4>两两判决</h4>${Object.entries(row.verdicts || {}).map(([pair, verdict]) => `<p><strong>${pair.split("__vs__").map((id) => escapeHtml(names[id] || id)).join(" / ")} · ${escapeHtml(verdict.result === "win" ? verdict.winner_name || verdict.winner_version : verdict.result)}</strong><br />${escapeHtml(verdict.reason)}</p>`).join("")}
    </div>`;
  }
  const source = detail.tasks.find((item) => item.id === task.rewrite_of?.taskId);
  const original = source?.result?.evaluation || source?.result;
  return `<div class="result-body"><p class="muted">源任务 ${escapeHtml(row.source_task_id || "—")} · 正式判决不会被改写覆盖</p>
    ${(row.rewrites || []).map((item) => {
      let before = item.id === "summary" ? original?.summary
        : item.id === "correctness_reason" ? original?.correctness_reason
        : item.id === "tradeoff" ? original?.decision_basis?.tradeoff : null;
      const assessment = /^assessment\.([A-Z])\.summary$/.exec(item.id);
      if (assessment) {
        const version = source?.versions[assessment[1].charCodeAt(0) - 65];
        before = original?.assessments?.[version]?.summary;
      }
      const verdict = /^verdict\.([A-Z])__vs__([A-Z])\.reason$/.exec(item.id);
      if (verdict) {
        const first = source?.versions[verdict[1].charCodeAt(0) - 65];
        const second = source?.versions[verdict[2].charCodeAt(0) - 65];
        before = original?.verdicts?.[`${first}__vs__${second}`]?.reason || original?.verdicts?.[`${second}__vs__${first}`]?.reason;
      }
      return `<div class="rewrite-item"><strong>${escapeHtml(item.id)}</strong>${before ? `<p class="muted">原文：${escapeHtml(before)}</p>` : ""}<p>改写：${escapeHtml(item.text)}</p></div>`;
    }).join("")}
  </div>`;
}
function renderDetail() {
  const detail = state.caseDetail;
  if (!detail) {
    $("#case-detail").innerHTML = `<p class="empty-state">${state.selectedCase ? "正在读取样本详情…" : "选择左侧样本，核对原始输入和正式评测结果。"}</p>`;
    return;
  }
  const candidates = detail.candidates || [];
  const inputs = candidates.map((candidate) => `<button type="button" class="candidate-tab ${state.selectedInput === candidate.input_id ? "selected" : ""}" data-input="${escapeHtml(candidate.input_id)}">${escapeHtml(candidate.name || candidate.version)}</button>`).join("");
  $("#case-detail").innerHTML = `<div class="detail-heading"><span class="case-identity">${escapeHtml(detail.batch_id)} / ${escapeHtml(detail.case_id)}</span><h2>${escapeHtml(detail.question || "问题不可用")}</h2></div>
    <div class="detail-section"><h3>评测输入</h3><div class="candidate-tabs" role="group" aria-label="选择版本">${inputs}</div><div class="input-view">${renderInput()}</div></div>
    <div class="detail-section"><h3>Agent 与正式输出</h3>${detail.tasks.map((task) => `<details class="task-detail" ${["failed", "running"].includes(task.status) || (task.stage === "comparison" && task.result) ? "open" : ""}>
      <summary><span><strong>${escapeHtml(stageLabel(task.stage))}</strong>${task.versions.length ? ` · ${task.versions.map(escapeHtml).join(" / ")}` : ` · ${escapeHtml(task.rewrite_of?.stage || "")}`}</span>
      <span class="task-status ${escapeHtml(task.status)}">${escapeHtml(label(task.status))} · ${task.attempts} 次尝试</span></summary>
      <div class="task-content"><p class="muted">任务 ${escapeHtml(task.id)} · 最近进展 ${escapeHtml(dateText(task.last_progress_at))}${task.duration_ms != null ? ` · 累计 ${Math.round(task.duration_ms / 1000)} 秒` : ""}</p>
      ${task.reason ? `<p class="inline-error">${escapeHtml(task.reason)}</p>` : ""}${renderResult(task, detail)}
      ${task.result ? `<details class="raw-details"><summary>查看正式结果 JSON</summary><pre>${compactJson(task.result)}</pre></details>` : ""}</div>
    </details>`).join("") || '<p class="empty-state">此样本没有登记任务。</p>'}</div>`;
}
async function loadInput(inputId) {
  state.selectedInput = inputId;
  state.rawInput = null;
  renderDetail();
  const runId = state.selectedRun;
  try {
    const input = await api(`${urlFor(runId)}/inputs/${encodeURIComponent(inputId)}`);
    if (state.selectedRun !== runId || state.selectedInput !== inputId) return;
    state.rawInput = input;
  } catch (error) {
    if (state.selectedRun !== runId || state.selectedInput !== inputId) return;
    state.rawInput = { error: error.message };
  }
  renderDetail();
}
async function loadCase(batch, caseId) {
  const runId = state.selectedRun;
  const request = ++state.caseRequest;
  state.selectedCase = { batch, caseId };
  renderCases();
  try {
    const params = new URLSearchParams({ batch, case: caseId });
    const detail = await api(`${urlFor(runId)}/cases/detail?${params}`);
    if (request !== state.caseRequest || runId !== state.selectedRun) return;
    const previous = state.caseDetail;
    const signature = (value) => JSON.stringify(value.tasks.map((item) => [item.id, item.status, item.attempts, Boolean(item.result)]));
    state.caseDetail = detail;
    if (previous?.batch_id === batch && previous?.case_id === caseId && signature(previous) === signature(detail)) return;
    const available = detail.candidates.some((item) => item.input_id === state.selectedInput);
    if (!available) { state.selectedInput = null; state.rawInput = null; }
    renderDetail();
    if (!state.selectedInput && detail.candidates.length) await loadInput(detail.candidates[0].input_id);
  } catch (error) {
    if (request !== state.caseRequest || runId !== state.selectedRun) return;
    state.caseDetail = null;
    $("#case-detail").innerHTML = `<p class="inline-error">无法读取此样本：${escapeHtml(error.message)}。请检查结果文件或稍后重试。</p>`;
  }
}
async function loadCases() {
  const request = ++state.casePageRequest;
  if (!state.selectedRun) { state.cases = null; renderCases(); return; }
  const runId = state.selectedRun;
  try {
    const page = await api(`${urlFor(runId)}/cases?${filterQuery()}`);
    if (state.selectedRun !== runId || request !== state.casePageRequest) return;
    state.cases = page;
    renderCases();
    if (!state.selectedCase && page.cases.length) void loadCase(page.cases[0].batch_id, page.cases[0].case_id);
  } catch (error) {
    if (state.selectedRun !== runId || request !== state.casePageRequest) return;
    showError(`样本列表读取失败：${error.message}`);
  }
}
async function refresh() {
  const request = ++state.runRequest;
  try {
    const { runs, errors } = await api("/api/dashboard/runs");
    if (request !== state.runRequest) return;
    state.runs = runs;
    const previousRun = state.selectedRun;
    if (state.selectedRun && !runs.some((item) => item.run_id === state.selectedRun)) state.selectedRun = null;
    if (!state.selectedRun && runs.length) state.selectedRun = runs[0].run_id;
    if (previousRun !== state.selectedRun) {
      ++state.caseRequest;
      state.selectedCase = state.caseDetail = state.selectedInput = state.rawInput = null;
      renderDetail();
    }
    renderRuns();
    if (state.selectedRun) {
      state.run = await api(urlFor(state.selectedRun));
      if (request !== state.runRequest) return;
    } else { state.run = null; state.cases = null; state.caseDetail = null; renderDetail(); }
    renderOverview();
    showError(errors?.length ? `${errors.length} 个运行状态无法读取：${errors.map((item) => item.run_id).join("、")}。请检查对应 state.json。` : "");
    await loadCases();
    $("#refresh-time").textContent = `更新于 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`;
  } catch (error) {
    if (request === state.runRequest) showError(`运行状态读取失败：${error.message}。请刷新重试。`);
  }
}
async function selectRun(runId) {
  if (runId === state.selectedRun) return;
  ++state.caseRequest;
  state.selectedRun = runId;
  state.selectedCase = state.caseDetail = state.selectedInput = state.rawInput = state.cases = null;
  state.page = 1;
  renderRuns(); renderCases(); renderDetail();
  await refresh();
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
  $("#model-fields").innerHTML = Object.entries(settings.bindings || {}).map(([stage, binding]) => `
    <label><span>${escapeHtml(stageLabel(stage))}模型 ID</span><input data-model-stage="${escapeHtml(stage)}" value="${escapeHtml(binding.model)}" placeholder="填写网关模型 ID" /></label>
    <label><span>${escapeHtml(stageLabel(stage))}推理等级</span><select data-thinking-stage="${escapeHtml(stage)}">${thinkingLevels.map((level) => `<option value="${level}" ${binding.thinking === level ? "selected" : ""}>${level}</option>`).join("")}</select></label>`).join("");
  $("#setting-concurrency").value = settings.execution.concurrency;
  $("#setting-timeout").value = settings.execution.timeoutSeconds;
  $("#setting-tools").value = settings.execution.maxToolCalls;
  $("#setting-retries").value = settings.execution.retries;
  $("#rewrite-attribution").checked = settings.rewrite.attribution;
  $("#rewrite-comparison").checked = settings.rewrite.comparison;
}
function launchPayload() {
  const batch = $("#batch").value.split(",").map((value) => value.trim()).filter(Boolean);
  const cases = $("#case").value.split(",").map((value) => value.trim()).filter(Boolean);
  const bindings = {};
  document.querySelectorAll("[data-model-stage]").forEach((input) => {
    const stage = input.dataset.modelStage;
    const thinking = document.querySelector(`[data-thinking-stage="${stage}"]`).value;
    bindings[stage] = { ...(input.value.trim() ? { model: input.value.trim() } : {}), thinking };
  });
  const limit = $("#limit-cases").value;
  return {
    runId: $("#run-id").value.trim(), engine: $("#engine").value,
    ...(batch.length ? { batch } : {}), ...(cases.length ? { case: cases } : {}),
    ...(limit ? { limitCases: Number(limit) } : {}),
    debug: $("#debug").checked,
    settings: {
      bindings,
      execution: {
        concurrency: Number($("#setting-concurrency").value),
        timeoutSeconds: Number($("#setting-timeout").value),
        maxToolCalls: Number($("#setting-tools").value),
        retries: Number($("#setting-retries").value),
      },
      rewrite: { attribution: $("#rewrite-attribution").checked, comparison: $("#rewrite-comparison").checked },
    },
  };
}
function invalidatePreview() {
  state.preview = null;
  $("#launch-button").disabled = true;
  $("#preview-result").textContent = "设置已更改，请重新预检。";
}
async function preview() {
  if (!$("#start-form").reportValidity()) return;
  $("#preview-button").disabled = true;
  $("#preview-result").textContent = "正在检查输入与运行设置…";
  try {
    const value = await api("/api/dashboard/preview", { method: "POST", body: JSON.stringify(launchPayload()) });
    state.preview = value;
    $("#launch-button").disabled = !value.resuming && !value.tasks;
    const summary = value.summary || {};
    const issues = summary.issues || [];
    $("#preview-result").innerHTML = `<strong>${value.resuming ? `续跑预检完成：${value.remaining || 0} 个未完成任务` : `预检完成：${summary.cases || 0} 个 Case · ${value.tasks || 0} 个任务`}</strong>
      <p>${escapeHtml(value.selection_note || `有效输入 ${summary.valid_inputs || 0} · 输入异常 ${summary.issues_count || 0} · 跳过组 ${summary.skipped_count || 0}`)}</p>
      ${value.resuming ? `<p>当前来源异常 ${summary.issues_count || 0} · 跳过组 ${summary.skipped_count || 0}。已接受结果保持不变。</p>` : ""}
      ${issues.length ? `<details><summary>查看前 ${issues.length} 条输入异常</summary><pre>${compactJson(issues)}</pre></details>` : ""}`;
  } catch (error) {
    state.preview = null;
    $("#launch-button").disabled = true;
    $("#preview-result").textContent = `预检失败：${error.message}`;
  } finally { $("#preview-button").disabled = false; }
}
async function startRun() {
  if (!state.preview || !$("#start-form").reportValidity()) return;
  $("#launch-button").disabled = true;
  try {
    const value = await api("/api/dashboard/runs", { method: "POST", body: JSON.stringify(launchPayload()) });
    toast(`已提交运行 ${value.run_id}，等待 Host 启动`);
    state.preview = null;
    $("#preview-result").textContent = "已提交。若运行未出现，请检查根目录 log/runtime.log。";
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
    $("#run-id").value = node.dataset.resume;
    $("#engine").value = state.run.engine === "prime" ? "prime" : "pi";
    invalidatePreview();
    $("#config").scrollIntoView({ behavior: "smooth" });
    $("#run-id").focus();
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
  state.caseDetail = state.rawInput = state.selectedInput = null;
  renderDetail();
  void loadCase(node.dataset.batch, node.dataset.case);
});
$("#case-detail").addEventListener("click", async (event) => {
  const input = event.target.closest("[data-input]");
  if (input) { await loadInput(input.dataset.input); return; }
  const evidence = event.target.closest("[data-evidence-version]");
  if (!evidence) return;
  const candidate = state.caseDetail?.candidates.find((item) => item.version === evidence.dataset.evidenceVersion);
  if (!candidate) return;
  if (state.selectedInput !== candidate.input_id) await loadInput(candidate.input_id);
  const trace = document.querySelector(".trace-details");
  if (trace) trace.open = true;
  document.getElementById(`message-${candidate.input_id}-${evidence.dataset.evidenceIndex}`)?.scrollIntoView({ block: "center" });
});
$("#case-filters").addEventListener("submit", (event) => {
  event.preventDefault();
  state.filters = Object.fromEntries([["batch", "#filter-batch"], ["query", "#filter-query"], ["stage", "#filter-stage"], ["status", "#filter-status"]]
    .map(([key, id]) => [key, $(id).value.trim()]).filter(([, value]) => value));
  state.page = 1;
  state.selectedCase = state.caseDetail = state.selectedInput = state.rawInput = null;
  renderDetail();
  void loadCases();
});
$("#prev-page").addEventListener("click", () => { state.page--; state.selectedCase = state.caseDetail = null; renderDetail(); void loadCases(); });
$("#next-page").addEventListener("click", () => { state.page++; state.selectedCase = state.caseDetail = null; renderDetail(); void loadCases(); });
$("#refresh-button").addEventListener("click", async () => {
  await refresh();
  if (state.selectedCase) {
    await loadCase(state.selectedCase.batch, state.selectedCase.caseId);
    if (state.selectedInput) await loadInput(state.selectedInput);
  }
});
$("#start-form").addEventListener("input", invalidatePreview);
$("#start-form").addEventListener("change", invalidatePreview);
$("#preview-button").addEventListener("click", () => void preview());
$("#start-form").addEventListener("submit", (event) => { event.preventDefault(); void startRun(); });

(async () => {
  try { state.config = await api("/api/dashboard/config"); renderConfig(); }
  catch (error) { showError(`配置读取失败：${error.message}`); }
  await refresh();
  let ticks = 0;
  setInterval(async () => {
    await refresh();
    if (++ticks % 3 === 0 && state.run?.status === "running" && state.selectedCase)
      await loadCase(state.selectedCase.batch, state.selectedCase.caseId);
  }, 5000);
})();
