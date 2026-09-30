const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
const state = { data: null, inventory: null, inventoryError: "", section: "inputs", stage: "attribution", document: "result", date: null, search: "", page: 1 };
const stageNames = { attribution: "归因", comparison: "对比", rewrite: "改写", clustering: "聚类", exports: "正式导出" };
const documentNames = { request: "请求 Schema", submission: "提交 Schema", result: "结果 Schema", system: "系统提示词", instructions: "任务提示词", submissionNudge: "补交提示词", comparison: "对比结果", clustering: "聚类结果" };
const onOff = (value) => value ? "开启" : "关闭";
async function get(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `请求失败（${response.status}）`);
  return result;
}
function table(headers, rows, className = "") {
  return `<div class="table-scroll"><table class="data-table ${className}"><thead><tr>${headers.map((item) => `<th scope="col">${escapeHtml(item)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
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
  return table(["样本 / 批次", ...versions.map((item) => item.display_name || item.name)], rows)
    + (!cases.length ? '<p class="empty-state">无匹配样本</p>' : "")
    + `<div class="reference-pager"><span>${cases.length} 个样本</span>${pages > 1 ? `<button class="button" data-case-page="${state.page - 1}" ${state.page === 1 ? "disabled" : ""}>上一页</button><span>${state.page} / ${pages}</span><button class="button" data-case-page="${state.page + 1}" ${state.page === pages ? "disabled" : ""}>下一页</button>` : ""}</div>`;
}
function inputsHtml() {
  const versions = state.data.inputs.versions;
  const inventory = state.inventory;
  const coverage = state.inventoryError ? `<p class="inline-error">${escapeHtml(state.inventoryError)}</p>`
    : !inventory ? '<span class="loading" role="status" aria-label="正在读取输入"><span class="spinner" aria-hidden="true"></span></span>'
    : table(["日期", "样本", ...versions.map((item) => item.display_name || item.name)], inventory.dates.map((date) =>
      `<tr class="${state.date === date.date ? "selected-row" : ""}"><td><button class="table-link" data-date="${escapeHtml(date.date)}" aria-pressed="${state.date === date.date}">${escapeHtml(date.date)}</button></td><td>${date.cases.length}</td>${versions.map((version) => `<td>${date.cases.filter((item) => item.versions.includes(version.id)).length}</td>`).join("")}</tr>`));
  const sources = table(["版本", "适配器", "数据源"], versions.map((version) => row([
    `<strong>${escapeHtml(version.display_name || version.name)}</strong><code class="table-sub">${escapeHtml(version.id)}</code>`,
    `<code>${escapeHtml(version.adapter)}</code>`,
    version.sources.map((source) => `<code class="source-path">${escapeHtml(source.path)}</code>`).join(""),
  ])));
  const fields = [
    ["batch_id", "顶层 → meta.batch_id → 配置默认值；原值分批"],
    ["case_id", "顶层或 meta.case_id；同时存在时必须一致"],
    ["version", "由来源配置决定；记录值若存在，须与配置 name 一致"],
    ["messages", "问题、回答与调用链；保留原始消息序号"],
    ["meta.ground_truth / std_answer", "同批次、同 case 共享有效标准答案；冲突时样本无效"],
    ["has_standard_answer", "false 忽略本条标准答案；最终判对口径取样本共享值"],
    ["request_time", "原样保留；缺失为 null"],
    ["meta / trace_id", "采集状态、模型、耗时与追踪标识"],
  ];
  return section("数据覆盖", coverage, inventory ? `${inventory.issues} 项输入异常` : "")
    + (state.date ? section(escapeHtml(state.date), `<div class="reference-toolbar"><input id="case-search" type="search" aria-label="搜索样本或批次" placeholder="搜索样本或批次" value="${escapeHtml(state.search)}" /></div><div id="coverage-cases">${caseRows()}</div>`) : "")
    + section("输入来源", sources)
    + section("对比组", `<ul class="plain-list">${state.data.comparisons.map((group) => `<li>${group.map(escapeHtml).join('<span class="list-separator"> / </span>')}</li>`).join("")}</ul>`)
    + `<details class="reference-disclosure"><summary>字段与适配规则</summary>${table(["字段", "读取规则"], fields.map((items) => row([`<code>${items[0]}</code>`, items[1]])))}
      ${table(["适配器", "消息类型"], [row(["a", "message · reasoning · function_call · function_call_output"]), row(["b", "user_question · llm_turn · tool_call · tool_result · final_answer"])])}
      <ul class="rule-list"><li>样本身份：batch_id + case_id；回答身份再加 version。</li><li>标识重复、问题冲突、标准答案冲突会阻止对应比较。</li><li>meta.ok=false、最终回答缺失、消息类型无效的记录不参与比较。</li><li>对比组须集齐全部有效版本；原始输入只保留在数据源。</li></ul>
    </details>`;
}
function flowHtml() {
  const data = state.data;
  const policyNames = { concurrency: "并发", idleTimeoutSeconds: "无进展超时（秒）", repairAttempts: "提交修正次数", codeTimeoutSeconds: "代码执行超时（秒）", maxOutputChars: "工具输出字符上限", timeoutSeconds: "任务超时（秒）", maxToolCalls: "工具调用上限", retries: "传输重试次数", retryDelaySeconds: "重试间隔（秒）", initialContextChars: "初始上下文字符", maxClassesPerModel: "每模型类上限", maxNewClassesPerTask: "单次新增类预算", maxComponentsPerModel: "每模型组件上限", consolidateAt: "合并整理阈值", minSupport: "新类最少样本", maxCasesPerTask: "分片 case 上限", enabled: "聚类" };
  const settings = (value) => table(["设置", "当前值"], Object.entries(value).map(([key, item]) => row([`${escapeHtml(policyNames[key] || key)}<code class="table-sub">${escapeHtml(key)}</code>`, escapeHtml(typeof item === "boolean" ? onOff(item) : item)])));
  return section("处理关系", `<div class="flow-map"><div>输入预检</div><span aria-hidden="true">→</span><div>单回答归因</div><span aria-hidden="true">→</span><div>组内对比</div></div><div class="flow-branches"><p><strong>归因 / 对比 → 改写</strong><span>归因 ${onOff(data.rewrite.attribution)} · 对比 ${onOff(data.rewrite.comparison)}</span></p><p><strong>归因问题 → 聚类 → 问题库</strong><span>${onOff(data.clustering.enabled)}</span></p></div>`)
    + section("阶段职责", table(["阶段 / 单位", "输入 → 输出", "依赖"], data.stages.map((stage) => row([
      `<button class="table-link" data-open-stage="${stage.id}">${stage.name}</button><span class="table-sub">${stage.unit}</span>`,
      `${stage.input}<span class="table-sub">${stage.output}</span>`, escapeHtml(stage.dependency),
    ]))))
    + section("判决与证据", `<ul class="rule-list"><li>对比确认既有 finding，按核心要求与分层排名派生两两判决。</li><li>归因提交 evidence_id，接受后展开为 message_index + quote。</li><li>改写仅处理文本槽位；排名、对错和证据沿用已接受结果。</li><li>聚类负责归类、新建与合并；问题库按模型跨 run 持续维护。</li><li>同 run ID 续跑保留已接受任务，只补未完成与新增任务。</li></ul>`)
    + section("保存位置", table(["内容", "文件"], [
      ...data.stages.map((stage) => row([stage.name, `<code>${escapeHtml(data.storage.runs)}/&lt;run-id&gt;/results/${stage.file}</code>`])),
      row(["恢复索引与进度", "<code>state.json</code>"]), row(["跨 run 问题库", `<code>${escapeHtml(data.storage.problems)}/&lt;version&gt;.json</code>`]),
      row(["运行 / 评测日志", "<code>log/runtime.log · log/evaluation.log</code>"]),
    ]))
    + `<div class="reference-columns">${section("执行预算", settings(data.execution))}${section("聚类约束", settings(data.clustering))}</div>`;
}
function resolveRef(schema, root) {
  if (!schema?.$ref?.startsWith("#/")) return schema;
  return schema.$ref.slice(2).split("/").reduce((value, part) => value?.[part.replaceAll("~1", "/").replaceAll("~0", "~")], root) || schema;
}
function schemaHtml(schema, root = schema, name = "root", required = false, depth = 0) {
  schema = resolveRef(schema, root);
  if (typeof schema === "boolean") return `<p>${schema ? "允许任意值" : "不允许值"}</p>`;
  const type = Array.isArray(schema.type) ? schema.type.join(" | ") : schema.type || (schema.enum ? "enum" : schema.$ref || "union");
  const constraints = [schema.enum ? schema.enum.map((item) => JSON.stringify(item)).join(" · ") : "", schema.additionalProperties === false ? "禁止额外字段" : "", ...[["minItems", "最少条目"], ["maxItems", "最多条目"], ["minLength", "最短字符"], ["maxLength", "最长字符"], ["minimum", "最小值"], ["maximum", "最大值"]].filter(([key]) => schema[key] !== undefined).map(([key, title]) => `${title} ${schema[key]}`), schema.uniqueItems ? "条目唯一" : ""].filter(Boolean);
  const children = [
    ...Object.entries(schema.properties || {}).map(([key, value]) => schemaHtml(value, root, key, schema.required?.includes(key), depth + 1)),
    ...(schema.items ? [schemaHtml(schema.items, root, "[ ]", false, depth + 1)] : []),
    ...(schema.additionalProperties && typeof schema.additionalProperties === "object" ? [schemaHtml(schema.additionalProperties, root, "{ key }", false, depth + 1)] : []),
    ...(schema.oneOf || schema.anyOf || schema.allOf || []).map((value, index) => schemaHtml(value, root, `分支 ${index + 1}`, false, depth + 1)),
  ].join("");
  const head = `<code>${escapeHtml(name)}</code><span class="schema-type">${escapeHtml(type)}</span>${required ? '<span class="schema-required">必填</span>' : ""}`;
  const notes = constraints.length || schema.description ? `<p class="schema-constraints">${escapeHtml([schema.description, ...constraints].filter(Boolean).join("；"))}</p>` : "";
  return children ? `<details class="schema-node" ${depth < 1 ? "open" : ""}><summary>${head}</summary>${notes}<div class="schema-children">${children}</div></details>` : `<div class="schema-leaf"><div>${head}</div>${notes}</div>`;
}
function contractHtml() {
  const isExport = state.stage === "exports";
  const stage = state.data.stages.find((item) => item.id === state.stage);
  const documents = isExport ? state.data.exports : { ...stage.schemas, ...stage.prompts };
  if (!Object.hasOwn(documents, state.document)) state.document = isExport ? "comparison" : "result";
  const value = documents[state.document];
  const prompt = typeof value === "string";
  const derivedSubmission = !isExport && state.document === "submission" && ["comparison", "clustering"].includes(stage.id);
  const schemaFile = isExport ? { comparison: "export", clustering: "clustering" }[state.document]
    : derivedSubmission ? "result" : state.document;
  const source = prompt ? (state.document === "submissionNudge" ? "packages/prompts/resources/shared/nudge.md" : `packages/prompts/resources/${stage.id}/default/${state.document === "system" ? "system" : "instructions"}.md`)
    : `schemas/${isExport ? "workflow" : stage.id}/${schemaFile}.schema.json${derivedSubmission ? "（去掉 rewritten 字段后派生）" : ""}`;
  return `<div class="contract-layout"><nav class="contract-stages" aria-label="评测阶段">${Object.entries(stageNames).map(([id, name]) => `<button data-stage="${id}" aria-pressed="${id === state.stage}">${name}</button>`).join("")}</nav><section class="contract-content">
    <header class="section-heading"><h2>${stageNames[state.stage]}</h2>${stage ? `<span class="muted">${stage.unit}</span>` : ""}</header>
    <nav class="document-tabs" aria-label="定义类型">${Object.keys(documents).map((key) => `<button data-document="${key}" aria-pressed="${key === state.document}">${!isExport && key === "result" && stage.id === "rewrite" ? "提交 / 结果 Schema" : documentNames[key]}</button>`).join("")}</nav>
    <p class="definition-source"><code>${source}</code></p>
    ${prompt ? `<div class="prompt-text">${escapeHtml(value)}</div>` : `<div class="schema-tree">${schemaHtml(value)}</div>`}
    ${!prompt ? `<details class="reference-disclosure"><summary>JSON 定义</summary><pre class="schema-json">${escapeHtml(JSON.stringify(value, null, 2))}</pre></details>` : ""}
    ${stage ? `<div class="contract-tools"><strong>工具描述</strong><span>${Object.entries(stage.toolDescriptions).map(([name, description]) => `<span><code>${escapeHtml(name)}</code> · ${escapeHtml(description)}</span>`).join("<br>")}</span></div>` : ""}
  </section></div>`;
}
function render() {
  if (!state.data) return;
  $("#reference-content").innerHTML = state.section === "inputs" ? inputsHtml() : state.section === "flow" ? flowHtml() : contractHtml();
  document.querySelectorAll("[data-section]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.section === state.section)));
}
document.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button || button.disabled) return;
  if (button.dataset.section) state.section = button.dataset.section;
  else if (button.dataset.stage) { state.stage = button.dataset.stage; state.document = "result"; }
  else if (button.dataset.openStage) { state.section = "contracts"; state.stage = button.dataset.openStage; state.document = "result"; }
  else if (button.dataset.document) state.document = button.dataset.document;
  else if (button.dataset.date) { state.date = state.date === button.dataset.date ? null : button.dataset.date; state.search = ""; state.page = 1; }
  else if (button.dataset.casePage) { state.page = Number(button.dataset.casePage); $("#coverage-cases").innerHTML = caseRows(); return; }
  else return;
  render();
});
document.addEventListener("input", (event) => {
  if (event.target.id !== "case-search") return;
  state.search = event.target.value;
  state.page = 1;
  $("#coverage-cases").innerHTML = caseRows();
});
async function init() {
  const inventory = get("/api/dashboard/inputs").then((value) => {
    state.inventory = value;
  }).catch((error) => { state.inventoryError = error.message; });
  try {
    state.data = await get("/api/dashboard/reference");
    $("#reference-version").textContent = `当前定义 · 评测器 ${state.data.evaluator_version}`;
    render();
  } catch (error) {
    $("#reference-error").textContent = error.message;
    $("#reference-error").hidden = false;
    $("#reference-content").innerHTML = "";
  }
  await inventory;
  render();
}
void init();
