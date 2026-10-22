
export function mountReference(root, options = {}) {
const $ = (selector) => root.querySelector(selector);
const API_ROOT = options.apiRoot || "/api/dashboard";
const escapeHtml = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
const state = { data: null, inventory: null, inventoryError: "", stage: "criteria", profile: "default", document: "result", date: null, search: "", page: 1 };
const documentNames = { request: "请求 Schema", submission: "提交 Schema", modelSubmission: "模型提交基础 Schema", result: "结果 Schema", inspection: "首查保存 Schema", modelInspection: "首查提交 Schema", system: "系统提示词", instructions: "任务提示词", submissionNudge: "补交提示词", taskType: "任务类型文案", sourceRule: "原文验收规则", referenceRule: "标准答案验收规则", reviewPending: "待复核文案", notApplicable: "不适用文案", tools: "工具描述与 Schema", comparison: "对比结果", clustering: "聚类结果", material: "材料文案", evidence: "证据说明", taskFocus: "任务聚焦", budget: "预算提示", recovery: "恢复提示", nudge: "补交提示" };
const onOff = (value) => value ? "开启" : "关闭";
async function get(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `请求失败（${response.status}）`);
  return result;
}
function table(headers, rows, className = "", modelStart = -1) {
  return `<div class="table-scroll"><table class="data-table ${className}"><thead><tr>${headers.map((item, index) => `<th scope="col">${index >= modelStart && modelStart >= 0 ? `<span class="model-column model-color-${index - modelStart}">${escapeHtml(item)}</span>` : escapeHtml(item)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}
function row(cells) { return `<tr>${cells.map((item) => `<td>${item}</td>`).join("")}</tr>`; }
function section(title, body, meta = "") {
  return `<section class="reference-section"><div class="section-heading"><h2>${title}</h2>${meta ? `<span class="muted">${meta}</span>` : ""}</div>${body}</section>`;
}
function caseRows() {
  const date = state.inventory?.dates.find((item) => item.date === state.date);
  const versions = state.data.inputs.versions;
  const query = state.search.trim().toLocaleLowerCase();
  const cases = (date?.cases || []).filter((item) => `${item.id} ${item.batches.join(" ")}`.toLocaleLowerCase().includes(query));
  const pageSize = 20;
  const pages = Math.max(1, Math.ceil(cases.length / pageSize));
  state.page = Math.min(state.page, pages);
  const rows = cases.slice((state.page - 1) * pageSize, state.page * pageSize).map((item) => row([
    `<strong>${escapeHtml(item.id)}</strong><span class="table-sub">${escapeHtml(item.batches.join(" / "))}</span>`,
    ...versions.map((version) => `<span class="coverage ${item.versions.includes(version.id) ? "present" : "missing"}">${item.versions.includes(version.id) ? "有" : "缺失"}</span>`),
  ]));
  return table(["样本 / 批次", ...versions.map((item) => item.display_name || item.name)], rows, "case-coverage-table", 1)
    + (!cases.length ? '<p class="empty-state">无匹配样本</p>' : "")
    + `<div class="reference-pager"><span>${cases.length} 个样本</span>${pages > 1 ? `<button class="button" data-case-page="${state.page - 1}" ${state.page === 1 ? "disabled" : ""}>上一页</button><span>${state.page} / ${pages}</span><button class="button" data-case-page="${state.page + 1}" ${state.page === pages ? "disabled" : ""}>下一页</button>` : ""}</div>`;
}
function inputsHtml() {
  const versions = state.data.inputs.versions;
  const inventory = state.inventory;
  const coverage = state.inventoryError ? `<p class="inline-error">${escapeHtml(state.inventoryError)}</p>`
    : !inventory ? '<span class="loading" role="status" aria-label="正在读取输入"><span class="spinner" aria-hidden="true"></span></span>'
    : table(["日期", "样本", ...versions.map((item) => item.display_name || item.name)], inventory.dates.map((date) => !date.cases
      ? `<tr><td>${escapeHtml(date.date)}</td><td colspan="${versions.length + 1}">${loadingInputs()}</td></tr>` :
      `<tr class="${state.date === date.date ? "selected-row" : ""}"><td><button class="table-link date-link" data-date="${escapeHtml(date.date)}" aria-pressed="${state.date === date.date}" aria-label="${escapeHtml(date.date)}，${date.cases.length} 个样本">${escapeHtml(date.date)}<span aria-hidden="true">${state.date === date.date ? "−" : "+"}</span></button></td><td class="coverage-total">${date.cases.length}</td>${versions.map((version, index) => {
        const count = date.cases.filter((item) => item.versions.includes(version.id)).length;
        return `<td class="coverage-value model-color-${index}"><span>${count}</span><span class="coverage-meter" aria-hidden="true"><i style="width:${date.cases.length ? count / date.cases.length * 100 : 0}%"></i></span></td>`;
      }).join("")}</tr>`), "coverage-table", 2);
  const sources = table(["版本", "适配器", "数据源"], versions.map((version) => row([
    `<strong>${escapeHtml(version.display_name || version.name)}</strong><code class="table-sub">${escapeHtml(version.id)}</code>`,
    `<code>${escapeHtml(version.adapter)}</code>`,
    version.sources.map((source) => `<code class="source-path">${escapeHtml(source.path)}</code>`).join(""),
  ])));
  return section("数据覆盖", coverage, inventory?.issues != null ? `<span class="inventory-state ${inventory.issues ? "has-issues" : ""}">${inventory.issues} 项输入异常</span>` : "")
    + (state.date ? section(escapeHtml(state.date), `<div class="reference-toolbar"><input id="case-search" type="search" aria-label="搜索样本或批次" placeholder="搜索样本或批次" value="${escapeHtml(state.search)}" /></div><div id="coverage-cases">${caseRows()}</div>`) : "")
    + section("输入来源", sources)
    + section("对比组", `<ul class="comparison-groups">${state.data.comparisons.map((group) => `<li>${group.map((id) => {
      const index = versions.findIndex((version) => version.id === id);
      return `<span class="model-column model-color-${index}">${escapeHtml(versions[index]?.display_name || versions[index]?.name || id)}</span>`;
    }).join('<span class="list-separator" aria-label="对比">↔</span>')}</li>`).join("")}</ul>`);
}
function flowHtml() {
  const data = state.data;
  const policyNames = { concurrency: "并发", idleTimeoutSeconds: "无进展超时（秒）", repairAttempts: "提交修正次数", codeTimeoutSeconds: "代码执行超时（秒）", maxOutputChars: "工具输出字符上限", timeoutSeconds: "任务超时（秒）", maxToolCalls: "工具调用上限", retries: "传输重试次数", retryDelaySeconds: "重试间隔（秒）", initialContextChars: "初始上下文字符", maxClassesPerModel: "每模型类上限", maxNewClassesPerTask: "单次新增类预算", maxComponentsPerModel: "每模型组件上限", consolidateAt: "合并整理阈值", minSupport: "新类最少样本", maxCasesPerTask: "分片 case 上限", enabled: "聚类" };
  const settings = (value) => table(["设置", "当前值"], Object.entries(value).map(([key, item]) => row([`${escapeHtml(policyNames[key] || key)}<code class="table-sub">${escapeHtml(key)}</code>`, typeof item === "object" && item !== null ? `<code>${escapeHtml(JSON.stringify(item))}</code>` : escapeHtml(typeof item === "boolean" ? onOff(item) : item)])));
  const stepName = (step) => step.stage
    ? `<button class="table-link" data-open-stage="${escapeHtml(step.stage)}" ${step.profile ? `data-open-profile="${escapeHtml(step.profile)}"` : ""}>${escapeHtml(step.name)}</button>`
    : `<span>${escapeHtml(step.name)}</span>`;
  const stepData = (step) => step.input || step.output ? `<dl class="flow-step-data">${[["输入", step.input], ["输出", step.output]].filter(([, value]) => value).map(([name, value]) => `<div><dt>${name}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>` : "";
  const flow = `<ol class="flow-sequence">${data.flow.steps.map((step, index) => `<li><span class="flow-number" aria-hidden="true">${index + 1}</span><div class="flow-step"><h3>${stepName(step)}</h3>${stepData(step)}</div></li>`).join("")}</ol>`
    + `<div class="flow-branch-list">${data.flow.branches.map((branch) => `<section class="flow-branch"><div class="flow-branch-head"><h3>${escapeHtml(branch.name)}</h3>${typeof branch.enabled === "boolean" ? `<span class="flow-branch-condition">${onOff(branch.enabled)}</span>` : ""}</div><div class="flow-branch-condition">${escapeHtml(branch.condition)}</div><ul class="flow-branch-steps">${branch.steps.map((step) => `<li><div>${stepName(step)}${stepData(step)}</div></li>`).join("")}</ul></section>`).join("")}</div>`;
  return section("处理关系", flow)
    + section("阶段职责", table(["阶段 / 单位", "输入 → 输出", "依赖"], data.stages.map((stage) => row([
      `<button class="table-link" data-open-stage="${stage.id}">${stage.name}</button><span class="table-sub">${stage.unit}</span>`,
      `${escapeHtml(stage.input)}<span class="table-sub">${escapeHtml(stage.output)}</span>`, escapeHtml(stage.dependency),
    ]))))
    + section("判决与证据", `<ul class="rule-list">${data.flow.rules.map((rule) => `<li>${escapeHtml(rule)}</li>`).join("")}</ul><section class="reference-disclosure"><header>流程来源</header><div class="flow-source">${data.flow.sources.map((source) => `<code>${escapeHtml(source)}</code>`).join("")}</div></section>`)
    + section("保存位置", table(["内容", "文件"], [
      ...data.stages.map((stage) => row([stage.name, stage.id === "rewrite" ? escapeHtml(stage.file)
        : stage.file.split(" / ").map((file) => `<code>${escapeHtml(data.storage.runs)}/&lt;run-id&gt;/results/${escapeHtml(file)}</code>`).join("<br>")])),
      row(["恢复索引与进度", "<code>state.json</code>"]), row(["跨 run 问题库", `<code>${escapeHtml(data.storage.problems)}/&lt;version&gt;.json</code>`]),
      row(["运行 / 评测日志", "<code>log/runtime.log · log/evaluation.log</code>"]),
    ]))
    + `<div class="reference-columns">${section("执行预算", settings(data.execution))}${section("聚类约束", settings(data.clustering))}</div>`;
}
function contractHtml() {
  const isExport = state.stage === "exports";
  const isShared = state.stage === "shared";
  const stage = state.data.stages.find((item) => item.id === state.stage);
  const profile = stage ? stage.profiles.find((item) => item.id === state.profile) || stage.profiles[0] : null;
  if (profile) state.profile = profile.id;
  const documents = isExport ? state.data.exports : isShared ? Object.fromEntries(Object.entries(state.data.sharedPrompts).map(([key, value]) => [key, value.text])) : { ...profile.schemas, ...profile.prompts };
  const toolDocument = profile && Object.keys(profile.toolDescriptions).length > 0;
  if (!Object.hasOwn(documents, state.document) && !(toolDocument && state.document === "tools")) state.document = isExport ? "comparison" : isShared ? Object.keys(documents)[0] : "result";
  const value = documents[state.document];
  const prompt = typeof value === "string";
  const tools = state.document === "tools";
  const sources = isExport ? state.data.exportSources[state.document] : isShared ? [state.data.sharedPrompts[state.document].source] : profile.sources[tools ? "toolSchemas" : state.document];
  const select = (key, label, items) => `<label>${label}<select data-pick="${key}" aria-label="${label}">${items.map(([id, name]) => `<option value="${escapeHtml(id)}" data-${key}="${escapeHtml(id)}" ${state[key] === id ? "selected" : ""}>${escapeHtml(name)}</option>`).join("")}</select></label>`;
  return `<div class="contract-layout"><div class="definition-filters">
    ${select("stage", "阶段", [...state.data.stages, { id:"shared", name:"共用提示词" }, { id:"exports", name:"正式导出" }].map(item => [item.id, item.name]))}
    ${stage?.profiles.length > 1 ? select("profile", "流程", stage.profiles.map(item => [item.id, item.name])) : ""}
    ${select("document", "内容", [...Object.keys(documents), ...(toolDocument ? ["tools"] : [])].map(key => [key, documentNames[key] || key]))}
    </div><section class="contract-content">
    ${sources?.length ? sources.length > 1 ? `<section class="reference-disclosure definition-provenance"><header>来源 · ${sources.length} 项</header><div class="definition-source">${sources.map((source) => `<code>${escapeHtml(source)}</code>`).join("")}</div></section>` : `<p class="definition-source"><code>${escapeHtml(sources[0])}</code></p>` : ""}
    ${tools ? `<dl class="tool-definitions">${Object.entries(profile.toolDescriptions).map(([name, description]) => `<div><dt>${escapeHtml(name)}</dt><dd>${escapeHtml(description)}${profile.toolSchemas[name] ? `<section class="reference-disclosure"><header>${name === "submit_evaluation" && profile.requestBoundSubmission ? "工具基础 Schema" : "工具 Schema"}</header><pre class="schema-json">${escapeHtml(JSON.stringify(profile.toolSchemas[name], null, 2))}</pre></section>` : ""}</dd></div>`).join("")}</dl>`
      : prompt ? `<div class="prompt-text">${escapeHtml(value)}</div>` : `<pre class="schema-json">${escapeHtml(JSON.stringify(value, null, 2))}</pre>`}
  </section></div>`;
}
function render() {
  if (!state.data) return;
  const content = $("#reference-content");
  const focused = root.activeElement;
  const pick = focused?.dataset.pick;
  content.innerHTML = inputsHtml() + flowHtml() + contractHtml();
  if (pick) root.querySelector(`[data-pick="${pick}"]`)?.focus({ preventScroll:true });
}
root.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button || button.disabled) return;
  if (button.dataset.stage) { state.stage = button.dataset.stage; state.profile = "default"; state.document = "result"; }
  else if (button.dataset.openStage) { state.stage = button.dataset.openStage; state.profile = button.dataset.openProfile || "default"; state.document = "result"; }
  else if (button.dataset.profile) state.profile = button.dataset.profile;
  else if (button.dataset.document) state.document = button.dataset.document;
  else if (button.dataset.date) { state.date = state.date === button.dataset.date ? null : button.dataset.date; state.search = ""; state.page = 1; }
  else if (button.dataset.casePage) { state.page = Number(button.dataset.casePage); $("#coverage-cases").innerHTML = caseRows(); return; }
  else return;
  render();
  if (button.dataset.openStage) root.querySelector('[data-pick="stage"]')?.focus({ preventScroll:true });
});
root.addEventListener("input", (event) => {
  if (event.target.id !== "case-search") return;
  state.search = event.target.value;
  state.page = 1;
  $("#coverage-cases").innerHTML = caseRows();
});
async function init() {
  const inventory = loadInventory();
  try {
    state.data = await get(`${API_ROOT}/reference`);
    $("#reference-version").textContent = `评测器 ${state.data.evaluator_version}`;
    render();
  } catch (error) {
    $("#reference-error").textContent = error.message;
    $("#reference-error").hidden = false;
    $("#reference-content").innerHTML = "";
  }
  await inventory;
  render();
}
function loadingInputs() { return '<span class="loading" role="status" aria-label="正在读取输入"><span class="spinner" aria-hidden="true"></span></span>'; }
async function loadInventory() {
  try {
    state.inventory = await get(`${API_ROOT}/inputs`);
    state.inventoryError = "";
    if (state.inventory.status === "loading") setTimeout(() => void loadInventory(), 1000);
  } catch (error) { state.inventoryError = error.message; }
  render();
}
root.addEventListener("change", event => {
  const key = event.target.dataset.pick;
  if (!["stage", "profile", "document"].includes(key)) return;
  state[key] = event.target.value;
  if (key === "stage") { state.profile = "default"; state.document = "result"; }
  render();
});
void init();

}
if (globalThis.document?.querySelector("#reference-content")) mountReference(document);
