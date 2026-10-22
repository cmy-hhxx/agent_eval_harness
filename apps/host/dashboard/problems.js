const escapeHtml = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
const colors = [{ color: "var(--model-0, #3562a4)", soft: "#edf3fa" }, { color: "var(--model-1, #7460a8)", soft: "#f2eff8" }, { color: "var(--model-2, #087f83)", soft: "#eaf5f4" }, { color: "var(--model-3, #a3632e)", soft: "#fbf2e9" }];
const chevron = '<svg class="tree-chevron" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m4.5 3 3 3-3 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" /></svg>';
const separator = '<svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m4.5 3 3 3-3 3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" /></svg>';
const arrow = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8h9M8 4l4 4-4 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /></svg>';
const loading = (label) => `<span class="loading" role="status" aria-label="${escapeHtml(label)}"><span class="spinner" aria-hidden="true"></span></span>`;
const recallReasons = { run_missing: "运行已删除", sample_missing: "样本缺失", result_missing: "归因结果缺失", finding_missing: "归因项缺失", input_unavailable: "输入不可读", run_unavailable: "运行不可读" };
const dateText = (value, time = false) => value ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", ...(time ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}) }).format(new Date(value)) : "—";
const modelName = (model) => model.name || model.model;
const classKey = (id) => `class:${id}`;
const componentKey = (id) => `component:${id}`;
const classMatches = (problem, query) => !query || `${problem.label} ${problem.definition} ${problem.aliases.join(" ")} ${(problem.category_paths || []).map(path => path.join(" / ")).join(" ")}`.toLocaleLowerCase().includes(query);
const componentMatches = (component, query) => query && `${component.label} ${component.definition} ${component.aliases.join(" ")}`.toLocaleLowerCase().includes(query);
const API_ROOT = globalThis.location?.pathname.startsWith("/runtime/") ? "/runtime/api/dashboard" : "/api/dashboard";

/** Read-only browser for the current input models' shared problem libraries. */
export function createProblemBrowser(document, request = globalThis.fetch) {
  const $ = (selector) => document.querySelector(selector);
  const state = { models: null, model: null, classId: null, detail: null, search: "", expanded: new Set(), modelExpanded: true, focusKey: "model", remembered: new Map(), listRequest: 0, detailRequest: 0 };
  const currentModel = () => state.models?.find((model) => model.model === state.model);
  const query = () => state.search.trim().toLocaleLowerCase();
  const classUrl = (model, id, page) => `${API_ROOT}/library/${encodeURIComponent(model)}/classes/${encodeURIComponent(id)}?page=${page}`;
  async function get(url) {
    const response = await request(url, { signal: AbortSignal.timeout(60000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
    return data;
  }
  function highlight(value) {
    const text = String(value ?? ""), needle = query(), index = needle ? text.toLocaleLowerCase().indexOf(needle) : -1;
    return index < 0 ? escapeHtml(text) : `${escapeHtml(text.slice(0, index))}<mark>${escapeHtml(text.slice(index, index + needle.length))}</mark>${escapeHtml(text.slice(index + needle.length))}`;
  }
  function filteredComponents() {
    return (currentModel()?.components || []).map((component) => ({ ...component, classes: component.classes.filter((problem) => componentMatches(component, query()) || classMatches(problem, query())) })).filter((component) => !query() || component.classes.length);
  }
  function renderModels() {
    $("#problem-models").innerHTML = (state.models || []).map((model, index) => {
      const palette = colors[index % colors.length], active = model.model === state.model;
      return `<button class="problem-model-tab" type="button" role="tab" id="problem-model-${index}" aria-selected="${active}" aria-controls="problem-workspace" tabindex="${active ? "0" : "-1"}" data-model="${escapeHtml(model.model)}" style="--model-color:${palette.color};--model-soft:${palette.soft}"><span class="problem-model-name">${escapeHtml(modelName(model))}</span><span class="problem-model-count"><b>${model.totals.classes}</b> 问题类 · <b>${model.totals.occurrences}</b> 次出现</span></button>`;
    }).join("") || '<span class="empty-state">无模型</span>';
    const index = state.models?.findIndex((model) => model.model === state.model) ?? -1;
    const palette = colors[Math.max(0, index) % colors.length];
    $("#problem-workspace").style.setProperty("--model-color", palette.color);
    $("#problem-workspace").style.setProperty("--model-soft", palette.soft);
    if (index >= 0) $("#problem-workspace").setAttribute("aria-labelledby", `problem-model-${index}`);
    else $("#problem-workspace").removeAttribute("aria-labelledby");
    $("#problem-updated").textContent = currentModel()?.updated_at ? `更新于 ${dateText(currentModel().updated_at, true)}` : "";
  }
  function renderTree(focus = false) {
    const model = currentModel(), components = filteredComponents();
    const visible = ["model", ...(state.modelExpanded ? components.flatMap((component) => [componentKey(component.id), ...(state.expanded.has(component.id) ? component.classes.map((problem) => classKey(problem.id)) : [])]) : [])];
    if (!visible.includes(state.focusKey)) state.focusKey = "model";
    const tabIndex = (key) => key === state.focusKey ? "0" : "-1";
    $("#problem-tree").innerHTML = !model ? '' : `<ul role="none"><li role="none"><button type="button" role="treeitem" aria-level="1" aria-expanded="${state.modelExpanded}" tabindex="${tabIndex("model")}" data-node-key="model" data-node-kind="model">${chevron}<span class="tree-label">${escapeHtml(modelName(model))}</span><span class="tree-count">${model.totals.classes}</span></button>${state.modelExpanded ? `<ul role="group">${components.map((component) => `<li role="none"><button type="button" role="treeitem" aria-level="2" aria-expanded="${state.expanded.has(component.id)}" tabindex="${tabIndex(componentKey(component.id))}" data-node-key="${escapeHtml(componentKey(component.id))}" data-node-kind="component" data-component="${escapeHtml(component.id)}">${chevron}<span class="tree-label">${highlight(component.label)}</span><span class="tree-count">${component.classes.length}</span></button>${state.expanded.has(component.id) ? `<ul role="group">${component.classes.map((problem) => `<li role="none"><button type="button" role="treeitem" aria-level="3" aria-selected="${state.classId === problem.id}" tabindex="${tabIndex(classKey(problem.id))}" data-node-key="${escapeHtml(classKey(problem.id))}" data-node-kind="class" data-class="${escapeHtml(problem.id)}" data-component="${escapeHtml(component.id)}"><span class="tree-class-dot" aria-hidden="true"></span><span class="tree-label">${highlight(problem.label)}</span><span class="tree-count" aria-label="${problem.occurrences} 次出现">${problem.occurrences}</span></button></li>`).join("")}</ul>` : ""}</li>`).join("")}</ul>` : ""}</li></ul>`;
    $("#problem-tree-result").textContent = !model ? "无问题库" : query() ? `${components.reduce((count, component) => count + component.classes.length, 0)} 个匹配问题类` : `${model.totals.components} 个组件 · ${model.totals.classes} 个问题类`;
    $("#problem-topics").innerHTML = model?.categories?.length ? `<details><summary>主题 ${model.categories.length}</summary><ul class="problem-merge-list">${model.categories.map(topic => `<li><button type="button" data-topic="${escapeHtml(topic.path.join(" / "))}">${escapeHtml(topic.path.join(" / "))}</button><span>${topic.occurrences} 次出现</span></li>`).join("")}</ul></details>` : "";
    $("#problem-merges").innerHTML = model?.merged.length ? `<details><summary>已合并 ${model.merged.length} 个类</summary>${mergeList(model.merged)}</details>` : "";
    if (focus) focusTreeNode(state.focusKey);
  }
  function focusTreeNode(key) {
    const node = [...$("#problem-tree").querySelectorAll("[data-node-key]")].find((item) => item.dataset.nodeKey === key);
    if (node) {
      state.focusKey = key;
      for (const item of $("#problem-tree").querySelectorAll("[data-node-key]")) item.tabIndex = item === node ? 0 : -1;
      node.focus({ preventScroll: true });
      if (typeof node.scrollIntoView === "function") node.scrollIntoView({ block: "nearest", behavior: "instant" });
    }
  }
  function mergeList(merges) {
    return `<ul class="problem-merge-list">${merges.map((merge) => `<li><span>${escapeHtml(merge.label)} → <button type="button" data-merge-target="${escapeHtml(merge.into)}">${escapeHtml(merge.into_label || merge.into)}</button></span>${merge.reason ? `<span>${escapeHtml(merge.reason)}</span>` : ""}</li>`).join("")}</ul>`;
  }
  function metadata(problem) {
    const origin = problem.first_seen;
    return `<details class="problem-class-meta"><summary>类记录</summary><dl><dt>类 ID</dt><dd><code>${escapeHtml(problem.id)}</code></dd>${origin ? `<dt>首次出现</dt><dd>${dateText(origin.at, true)}</dd><dt>首次样本</dt><dd><code>${escapeHtml(origin.batch_id)} / ${escapeHtml(origin.case_id)}</code></dd><dt>评测器</dt><dd>${escapeHtml(origin.evaluator_version)}</dd>` : ""}</dl></details>`;
  }
  function occurrenceHtml(occurrence) {
    const recall = occurrence.recall;
    const fileName = occurrence.source.file.split(/[\\/]/).at(-1);
    const evidence = occurrence.evidence_status === "established" ? "已确认" : occurrence.evidence_status === "uncertain" ? "待核实" : "状态缺失";
    return `<section class="problem-occurrence" aria-label="样本 ${escapeHtml(occurrence.case_id)}"><div class="occurrence-head"><div class="occurrence-identity"><strong>${escapeHtml(occurrence.case_id)}</strong><span class="occurrence-batch">${escapeHtml(occurrence.batch_id)}</span></div>${recall.available && recall.url ? `<a class="occurrence-recall" href="${escapeHtml(recall.url)}" aria-label="召回样本 ${escapeHtml(occurrence.case_id)}">召回样本${arrow}</a>` : `<div class="occurrence-unavailable"><strong>不可召回</strong><span>${escapeHtml(recallReasons[recall.reason] || recall.reason || "来源不可用")}</span></div>`}</div><div class="occurrence-state"><span class="occurrence-evidence ${escapeHtml(occurrence.evidence_status)}">${evidence}</span><span>${occurrence.classification === "created" ? "新建类" : "归入"}${occurrence.previous_class_id ? " · 合并迁入" : ""}</span><time datetime="${escapeHtml(occurrence.at)}">${dateText(occurrence.at)}</time></div><details class="occurrence-origin"><summary>来源 <code>${escapeHtml(fileName)}:${occurrence.source.line}</code></summary><dl><dt>源文件</dt><dd><code>${escapeHtml(occurrence.source.file)}:${occurrence.source.line}</code></dd><dt>运行</dt><dd><code>${escapeHtml(occurrence.run_id)}</code></dd><dt>归因项</dt><dd><code>${escapeHtml(occurrence.finding_id)}</code></dd><dt>消息</dt><dd>#${escapeHtml(occurrence.message_index)}</dd><dt>评测器</dt><dd>${escapeHtml(occurrence.evaluator_version)}</dd>${occurrence.previous_class_id ? `<dt>原问题类</dt><dd><code>${escapeHtml(occurrence.previous_class_id)}</code></dd>` : ""}</dl></details></section>`;
  }
  function renderDetail() {
    const detail = state.detail, model = currentModel();
    const node = $("#problem-detail");
    node.setAttribute("aria-busy", "false");
    if (!detail) { node.innerHTML = '<p class="problem-detail-empty">暂无问题类</p>'; return; }
    const problem = detail.class, pages = Math.max(1, Math.ceil(detail.total / detail.page_size));
    const available = detail.occurrences.filter((occurrence) => occurrence.recall.available).length;
    node.innerHTML = `<div class="problem-detail-enter"><div class="problem-breadcrumb"><span>${escapeHtml(modelName(model))}</span>${separator}<span>${escapeHtml(detail.component?.label || "无组件")}</span></div><div class="problem-detail-heading"><h1>${escapeHtml(problem.label)}</h1><span class="problem-class-status">${problem.status === "merged" ? "已合并" : "活跃"}</span></div><p class="problem-definition">${escapeHtml(problem.definition)}</p>${detail.rewrite_error ? `<p class="problem-detail-error" role="alert">改写来源读取失败：${escapeHtml(detail.rewrite_error)}</p>` : ""}${problem.aliases.length ? `<div class="problem-aliases"><span>别名</span>${problem.aliases.map((alias) => `<span>${escapeHtml(alias)}</span>`).join("")}</div>` : ""}${problem.category_paths?.length ? `<div class="problem-aliases"><span>主题</span>${problem.category_paths.map(path => `<span>${escapeHtml(path.join(" / "))}</span>`).join("")}</div>` : ""}${metadata(problem)}${problem.status === "merged" && problem.merged_into ? `<div class="problem-aliases"><span>合并至</span><button class="table-link" type="button" data-merge-target="${escapeHtml(problem.merged_into)}">${escapeHtml(model.merged.find((merge) => merge.id === problem.id)?.into_label || problem.merged_into)}</button></div>` : ""}<section class="problem-occurrences" aria-labelledby="problem-occurrences-title"><div class="problem-occurrences-heading"><h2 id="problem-occurrences-title">出现样本 <span>${detail.total}</span></h2><span class="problem-recall-count">本页可召回 ${available} / ${detail.occurrences.length}</span></div>${detail.occurrences.map(occurrenceHtml).join("") || '<p class="empty-state">暂无出现样本</p>'}${pages > 1 ? `<div class="problem-pager"><button type="button" class="button" data-page="${detail.page - 1}" ${detail.page <= 1 ? "disabled" : ""}>上一页</button><span>${detail.page} / ${pages}</span><button type="button" class="button" data-page="${detail.page + 1}" ${detail.page >= pages ? "disabled" : ""}>下一页</button></div>` : ""}</section>${detail.lineage?.length ? `<details class="problem-lineage"><summary>合并记录 ${detail.lineage.length}</summary>${mergeList(detail.lineage)}</details>` : ""}</div>`;
  }
  function expandForSelection() {
    const components = filteredComponents();
    state.expanded.clear();
    for (const component of components) if (query() || component.classes.some((problem) => problem.id === state.classId)) state.expanded.add(component.id);
    state.modelExpanded = true;
    state.focusKey = state.classId && components.some((component) => component.classes.some((problem) => problem.id === state.classId)) ? classKey(state.classId) : "model";
  }
  async function selectModel(modelId) {
    if (!state.models?.some((model) => model.model === modelId)) return;
    if (state.model !== modelId) state.classId = state.remembered.get(modelId) || null;
    state.model = modelId;
    const classes = currentModel().components.flatMap((component) => component.classes);
    if (!classes.some((problem) => problem.id === state.classId)) state.classId = classes[0]?.id || null;
    state.detail = null;
    ++state.detailRequest;
    expandForSelection();
    renderModels();
    renderTree();
    if (state.classId) await loadClass(state.classId, 1);
    else renderDetail();
  }
  async function loadClass(id, page = 1, scroll = false, focusDetail = false) {
    if (!state.model) return;
    const modelId = state.model, token = ++state.detailRequest;
    state.classId = id;
    state.remembered.set(modelId, id);
    const component = currentModel().components.find((item) => item.classes.some((problem) => problem.id === id));
    if (component) state.expanded.add(component.id);
    state.modelExpanded = true;
    state.detail = null;
    renderTree();
    $("#problem-detail").setAttribute("aria-busy", "true");
    $("#problem-detail").innerHTML = loading("正在读取问题类");
    try {
      const detail = await get(classUrl(modelId, id, page));
      if (token !== state.detailRequest || modelId !== state.model) return;
      state.detail = detail;
      renderDetail();
      if (focusDetail) {
        const target = $("#problem-detail h1");
        target.tabIndex = -1;
        target.focus({ preventScroll: true });
      }
      if (scroll && document.defaultView?.matchMedia?.("(max-width: 680px)").matches) $("#problem-detail").scrollIntoView({ behavior: document.defaultView.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
    } catch (error) {
      if (token !== state.detailRequest) return;
      $("#problem-detail").setAttribute("aria-busy", "false");
      $("#problem-detail").innerHTML = `<div class="problem-detail-error"><p>问题类读取失败：${escapeHtml(error.message)}</p><button type="button" class="button" data-retry-class="${escapeHtml(id)}" data-retry-page="${page}">重新读取</button></div>`;
    }
  }
  async function load() {
    const token = ++state.listRequest;
    $("#problem-refresh").disabled = true;
    $("#problem-error").hidden = true;
    try {
      const models = await get(`${API_ROOT}/library`);
      if (token !== state.listRequest) return;
      state.models = models;
      const initial = new URLSearchParams(document.defaultView?.location?.search || "").get("model");
      await selectModel(models.some((model) => model.model === state.model) ? state.model : models.some((model) => model.model === initial) ? initial : models[0]?.model);
      if (!models.length) { renderModels(); renderTree(); renderDetail(); }
    } catch (error) {
      if (token !== state.listRequest) return;
      $("#problem-error").textContent = `问题库读取失败：${error.message}`;
      $("#problem-error").hidden = false;
      if (!state.models) { $("#problem-models").innerHTML = ""; $("#problem-detail").innerHTML = '<p class="problem-detail-empty">读取失败</p>'; }
    } finally { if (token === state.listRequest) $("#problem-refresh").disabled = false; }
  }
  function setSearch(value) {
    state.search = value;
    $("#problem-search").value = value;
    $("#problem-search-clear").hidden = !value;
    $(".problem-search").classList.toggle("has-query", !!value);
    expandForSelection();
    renderTree();
  }
  $("#problem-refresh").addEventListener("click", () => void load());
  $("#problem-models").addEventListener("click", (event) => {
    const tab = event.target.closest("[data-model]");
    if (tab) {
      const id = tab.dataset.model;
      void selectModel(id);
      [...$("#problem-models").querySelectorAll("[role=tab]")].find((item) => item.dataset.model === id)?.focus({ preventScroll: true });
    }
  });
  $("#problem-models").addEventListener("keydown", (event) => {
    const tabs = [...$("#problem-models").querySelectorAll("[role=tab]")], index = tabs.indexOf(event.target);
    if (index < 0 || !["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    void selectModel(tabs[next].dataset.model);
    $("#problem-models").querySelectorAll("[role=tab]")[next].focus();
  });
  $("#problem-search").addEventListener("input", (event) => setSearch(event.target.value));
  $("#problem-search-clear").addEventListener("click", () => { setSearch(""); $("#problem-search").focus(); });
  $("#problem-topics").addEventListener("click", (event) => {
    const topic = event.target.closest("[data-topic]");
    if (topic) setSearch(topic.dataset.topic);
  });
  $("#problem-tree").addEventListener("click", (event) => {
    const node = event.target.closest("[data-node-key]");
    if (!node) return;
    state.focusKey = node.dataset.nodeKey;
    if (node.dataset.nodeKind === "model") { state.modelExpanded = !state.modelExpanded; renderTree(true); }
    else if (node.dataset.nodeKind === "component") {
      if (state.expanded.has(node.dataset.component)) state.expanded.delete(node.dataset.component); else state.expanded.add(node.dataset.component);
      renderTree(true);
    } else { void loadClass(node.dataset.class, 1, true); focusTreeNode(state.focusKey); }
  });
  $("#problem-tree").addEventListener("focusin", (event) => {
    const node = event.target.closest("[data-node-key]");
    if (!node) return;
    state.focusKey = node.dataset.nodeKey;
    for (const item of $("#problem-tree").querySelectorAll("[data-node-key]")) item.tabIndex = item === node ? 0 : -1;
  });
  $("#problem-tree").addEventListener("keydown", (event) => {
    const node = event.target.closest("[data-node-key]"), nodes = [...$("#problem-tree").querySelectorAll("[data-node-key]")];
    if (!node || !["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = nodes.indexOf(node), kind = node.dataset.nodeKind;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") focusTreeNode(nodes[Math.max(0, Math.min(nodes.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))].dataset.nodeKey);
    else if (event.key === "Home" || event.key === "End") focusTreeNode(nodes[event.key === "Home" ? 0 : nodes.length - 1].dataset.nodeKey);
    else if (event.key === "ArrowRight") {
      if (node.getAttribute("aria-expanded") === "false") {
        if (kind === "model") state.modelExpanded = true; else state.expanded.add(node.dataset.component);
        renderTree(true);
      } else if (kind !== "class" && nodes[index + 1]) focusTreeNode(nodes[index + 1].dataset.nodeKey);
    } else if (event.key === "ArrowLeft") {
      if (node.getAttribute("aria-expanded") === "true") {
        if (kind === "model") state.modelExpanded = false; else state.expanded.delete(node.dataset.component);
        renderTree(true);
      } else if (kind === "class") focusTreeNode(componentKey(node.dataset.component));
      else if (kind === "component") focusTreeNode("model");
    }
  });
  $("#problem-workspace").addEventListener("click", (event) => {
    const target = event.target.closest("[data-merge-target], [data-page], [data-retry-class]");
    if (!target || target.disabled) return;
    if (target.dataset.mergeTarget) { state.focusKey = classKey(target.dataset.mergeTarget); void loadClass(target.dataset.mergeTarget, 1, true, true); }
    else if (target.dataset.page && state.detail) void loadClass(state.classId, Number(target.dataset.page), false, true);
    else if (target.dataset.retryClass) void loadClass(target.dataset.retryClass, Number(target.dataset.retryPage), false, true);
  });
  return { state, load, selectModel, loadClass, setSearch, renderTree, renderDetail };
}

if (typeof document !== "undefined") void createProblemBrowser(document).load();
