/** The offline check page consumes only curated summaries and reference coordinates. */
export function renderAttributionReview(data, baseCss, problemCss) {
  const payload = JSON.stringify({ attributionTree: data.attributionTree })
    .replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
  const extraCss = [
    ".review-page{margin:auto;max-width:1640px;padding:28px 32px 40px}",
    ".review-header{display:flex;align-items:baseline;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:18px}",
    ".review-header h1{font-size:24px;font-weight:650;letter-spacing:-.025em}",
    ".review-coverage{display:flex;gap:8px 16px;flex-wrap:wrap;color:var(--muted);font-size:12px}",
    ".review-coverage b{color:var(--text);font-weight:650}",
    ".review-page .problem-models{grid-template-columns:repeat(4,minmax(0,1fr))}",
    ".review-page .problem-workspace{grid-template-columns:minmax(245px,.48fr) minmax(0,1.8fr)}",
    ".review-filters{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:10px}",
    ".review-filters label{min-width:0;font-size:11px;color:var(--muted)}.review-filters select{width:100%;min-width:0;font-size:12px}",
    ".review-filter-reset{padding:3px 0;background:none;border:0;color:var(--accent);font-size:12px;text-align:left}",
    ".review-entry{width:100%;padding:11px 16px;color:var(--model-color);background:var(--surface);border:0;border-top:1px solid var(--line);font-size:12px;text-align:left}",
    ".review-entry[aria-pressed=true]{background:var(--model-soft);font-weight:600}.review-entry-count{float:right;color:var(--muted);font:11px var(--mono)}",
    ".review-page .problem-tree{max-height:calc(100vh - 430px);min-height:190px}",
    ".review-page .problem-detail{padding:25px 26px}.review-stats{display:flex;gap:12px 22px;flex-wrap:wrap;margin:18px 0;color:var(--muted);font-size:12px}",
    ".review-stats b{color:var(--text);font-size:16px;font-weight:650}",
    ".review-table-wrap{overflow:auto;border-top:1px solid var(--line);border-bottom:1px solid var(--line);scrollbar-width:thin}",
    ".review-sample-table{width:100%;min-width:1080px;border-collapse:collapse;font-size:13px;line-height:1.7}",
    ".review-sample-table th{padding:12px 10px;text-align:left;font-size:12px;font-weight:600;color:var(--muted);background:var(--soft);white-space:nowrap}",
    ".review-sample-table td{padding:15px 10px;vertical-align:top;border-top:1px solid var(--line);overflow-wrap:anywhere}",
    ".review-sample-table .review-date{width:100px;white-space:nowrap;font-variant-numeric:tabular-nums}.review-model{width:95px;white-space:nowrap}.review-sample-id{width:95px;white-space:nowrap}",
    ".review-task-summary{min-width:180px;width:24%}.review-problem-summary{min-width:240px;width:29%}.review-responsibility{min-width:90px}.review-value{white-space:nowrap}",
    ".review-table-empty{text-align:center;color:var(--muted)}",
    '.review-evidence[data-status="已确认"]{color:var(--success)}.review-evidence[data-status="待核实"]{color:var(--warning)}',
    ".review-page .problem-pager{flex-wrap:wrap;justify-content:space-between;font:12px var(--mono)}.review-page-size{display:flex;align-items:center;gap:7px;font:12px inherit}.review-page-size select{padding:4px 7px;font-size:12px}",
    ".review-page-controls{display:flex;align-items:center;gap:10px}.review-page-controls button{min-height:32px;font-size:12px}.review-page-controls button:disabled{opacity:.4;cursor:default}",
    "@media(max-width:680px){.review-page{padding:18px 14px 30px}.review-page .problem-detail{padding:20px 16px}.review-header h1{font-size:22px}.review-coverage{gap:7px 12px}.review-page .problem-models{grid-template-columns:repeat(2,minmax(0,1fr))}}",
    "@container problem-page (max-width:660px){.review-page .problem-models{grid-template-columns:repeat(2,minmax(0,1fr))}.review-page .problem-workspace{grid-template-columns:1fr}.review-page .problem-tree{max-height:300px;min-height:140px}}",
  ].join("\n");
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>归因检查</title><style>' +
    baseCss + "\n" + problemCss + "\n" + extraCss +
    '</style></head><body><main class="main-content problems-page review-page"><header class="review-header"><h1>归因树</h1><div id="coverage" class="review-coverage"></div></header>' +
    '<div id="problem-models" class="problem-models" role="tablist" aria-label="模型筛选"></div><section id="problem-workspace" class="problem-workspace" role="tabpanel" aria-label="归因聚类与关联样本">' +
    '<aside class="problem-tree-panel"><div class="problem-tree-toolbar"><label class="problem-search" for="problem-search"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5" stroke="currentColor" stroke-width="1.5" /><path d="m12 12 4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg><span>搜索聚类或样本</span><input id="problem-search" type="search" aria-label="搜索聚类或样本" autocomplete="off"><button id="problem-search-clear" type="button" aria-label="清空搜索" hidden>×</button></label>' +
    '<div class="review-filters"><label>日期<select id="date"><option value="">全部日期</option></select></label><label>归属状态<select id="focus"><option value="">全部状态</option><option value="deferred">待观察</option><option value="unlocated">责任未定位</option><option value="classified">已归类</option><option value="uncertain">待核实</option><option value="unclassified">未归类</option><option value="mixed">多种状态</option><option value="no_problem">无问题记录</option></select></label>' +
    '<label>标准答案<select id="standard"><option value="">全部</option><option value="yes">有标准答案</option><option value="no">无标准答案</option></select></label><button id="reset" type="button" class="review-filter-reset">重置筛选</button></div></div>' +
    '<div id="problem-tree" class="problem-tree" role="tree" aria-label="责任与问题聚类"></div><button id="pending-pool" class="review-entry" type="button" aria-pressed="false">待观察池</button><button id="all-samples" class="review-entry" type="button" aria-pressed="false">已接受样本</button><button id="unfinished-samples" class="review-entry" type="button" aria-pressed="false">未完成样本</button><div id="problem-tree-result" class="problem-tree-result" role="status" aria-live="polite"></div></aside>' +
    '<article id="problem-detail" class="problem-detail" aria-live="polite"></article></section></main><script id="report-data" type="application/json">' + payload + '</script><script>(' + mountAttributionReview.toString() + ')();</script></body></html>';
}

function mountAttributionReview() {
  const data = JSON.parse(document.getElementById("report-data").textContent), tree = data.attributionTree;
  const $ = id => document.getElementById(id), samples = new Map([...tree.samples, ...tree.unfinished].map(sample => [sample.id, sample]));
  const palette = [{ color: "var(--model-0)", soft: "#edf3fa" }, { color: "var(--model-1)", soft: "#f2eff8" }, { color: "var(--model-2)", soft: "#eaf5f4" }, { color: "var(--model-3)", soft: "#fbf2e9" }];
  const importanceNames = { high: "高", medium: "中", low: "低" }, evidenceNames = { 已确认: "已确认", 待核实: "待核实", mixed: "混合" };
  const initialModel = tree.models.find(model => model.model === "a_fast")?.model ?? tree.models[0]?.model;
  const firstNode = tree.nodes.find(node => node.model === initialModel);
  const state = { model: initialModel, kind: firstNode ? "node" : tree.pending.samples.some(id => samples.get(id)?.model === initialModel) ? "pending"
    : tree.samples.some(sample => sample.model === initialModel) ? "all" : tree.unfinished.some(sample => sample.model === initialModel) ? "unfinished" : "all",
    nodeId: firstNode?.id, page: 1, pageSize: 10, remembered: new Map(firstNode ? [[initialModel, firstNode.id]] : []),
    expanded: new Set(firstNode ? [firstNode.category] : []), rootExpanded: true, focusKey: null };
  const el = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = String(text); if (cls) node.className = cls; return node; };
  const append = (parent, ...nodes) => { for (const node of nodes) if (node) parent.append(node); return parent; };
  const unique = values => [...new Set(values.filter(value => value != null && value !== ""))];
  const num = value => Number(value ?? 0).toLocaleString("zh-CN");
  const modelNodes = () => tree.nodes.filter(node => node.model === state.model);
  const query = () => $("problem-search").value.trim().toLocaleLowerCase();
  const observationsFor = id => [...modelNodes().flatMap(node => node.observations), ...tree.pending.observations].filter(item => item.sampleId === id);
  const highestImportance = observations => ["high", "medium", "low"].find(value => observations.some(item => item.importance === value)) ?? null;
  const evidenceStatus = observations => { const values = unique(observations.map(item => item.evidenceStatus)); return values.length === 1 ? values[0] : values.length ? "mixed" : null; };
  function entries(kind = state.kind, nodeId = state.nodeId) {
    if (kind === "unfinished") return tree.unfinished.filter(sample => sample.model === state.model).map(sample => ({ sample, observations: [],
      search: [sample.id, sample.caseId, sample.taskSummary].join(" ").toLocaleLowerCase() }));
    const node = modelNodes().find(item => item.id === nodeId), context = kind === "node" ? node : kind === "pending" ? tree.pending : null;
    const ids = context?.samples ?? tree.samples.map(sample => sample.id), seen = new Set(), result = [];
    for (const id of ids) {
      const sample = samples.get(id); if (!sample || sample.model !== state.model || seen.has(sample.inputId ?? id)) continue;
      seen.add(sample.inputId ?? id);
      const observations = context ? context.observations.filter(item => item.sampleId === id) : observationsFor(id);
      result.push({ sample, observations, summary: context ? unique(observations.map(item => item.summary)).join("；") : sample.summary,
        components: unique(observations.flatMap(item => item.components.length ? item.components : ["责任未定位"])),
        importance: context ? highestImportance(observations) : sample.importance,
        evidenceStatus: context ? evidenceStatus(observations) : sample.evidenceStatus,
        search: [sample.id, sample.caseId, sample.taskSummary, context?.label, context?.definition, node?.category,
          ...(!context ? modelNodes().filter(item => item.samples.includes(id)).flatMap(item => [item.label, item.definition, item.category]) : []),
          ...(!context ? [sample.summary] : []), ...observations.map(item => item.summary),
          ...observations.flatMap(item => item.components)].join(" ").toLocaleLowerCase() });
    }
    return result;
  }
  function matches(entry) {
    const sample = entry.sample, focus = $("focus").value;
    return sample.model === state.model &&
      (!$("date").value || sample.date === $("date").value) &&
      (!$("standard").value || sample.hasStandard === ($("standard").value === "yes")) &&
      (!focus || (focus === "no_problem" ? sample.problemCount === 0 : entry.observations.some(item => item.libraryStatus === focus || (focus === "mixed" && item.findingLibraryStatus === "mixed")))) &&
      (!query() || entry.search.includes(query()));
  }
  const visibleEntries = (kind, nodeId) => entries(kind, nodeId).filter(matches);
  const problemCount = entries => new Set(entries.flatMap(entry => entry.observations.map(item => entry.sample.taskId + ":" + item.findingId))).size;
  const visibleNodes = () => modelNodes().filter(node => !query() || [node.label, node.definition, node.category].join(" ").toLocaleLowerCase().includes(query()) || visibleEntries("node", node.id).length);
  function select(kind, nodeId) {
    state.kind = kind; state.nodeId = nodeId ?? state.nodeId; state.page = 1;
    if (kind === "unfinished") $("focus").value = "";
    if (kind === "node") {
      const node = modelNodes().find(item => item.id === nodeId);
      state.remembered.set(state.model, node.id); state.expanded.add(node.category); state.rootExpanded = true;
    }
    render();
  }
  function selectModel(model) {
    state.model = model; state.page = 1; state.focusKey = null; state.rootExpanded = true;
    const node = modelNodes().find(item => item.id === state.remembered.get(model)) ?? modelNodes()[0];
    state.nodeId = node?.id; state.expanded = new Set(node ? [node.category] : []);
    const focus = $("focus").value;
    state.kind = focus === "no_problem" ? "all" : focus === "unlocated" ? (entries("pending").length ? "pending" : "all")
      : node ? "node" : entries("pending").length ? "pending" : !focus && !entries("all").length && entries("unfinished").length ? "unfinished" : "all";
    if (node) state.remembered.set(model, node.id);
    render();
  }
  function renderModels() {
    const host = $("problem-models"); host.replaceChildren();
    tree.models.forEach((model, index) => {
      const tab = el("button", undefined, "problem-model-tab"), colors = palette[index % palette.length];
      tab.type = "button"; tab.setAttribute("role", "tab"); tab.dataset.model = model.model;
      tab.style.setProperty("--model-color", colors.color); tab.style.setProperty("--model-soft", colors.soft);
      tab.setAttribute("aria-selected", String(model.model === state.model)); tab.tabIndex = model.model === state.model ? 0 : -1;
      append(tab, el("span", model.label, "problem-model-name"), el("span", num(model.targetCount) + " 目标 · " + num(model.sampleCount) + " 已接受 · " + num(model.unfinishedCount) + " 未完成", "problem-model-count"));
      tab.onclick = () => { selectModel(model.model); [...host.children].find(item => item.dataset.model === model.model)?.focus({ preventScroll: true }); };
      tab.onkeydown = event => {
        if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
        event.preventDefault(); const tabs = [...host.children], current = tabs.indexOf(tab);
        const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
        tabs[next].click();
      };
      host.append(tab);
    });
    const index = tree.models.findIndex(model => model.model === state.model), colors = index < 0 ? { color: "var(--accent)", soft: "#eaf5f4" } : palette[index % palette.length];
    $("problem-workspace").style.setProperty("--model-color", colors.color); $("problem-workspace").style.setProperty("--model-soft", colors.soft);
    const current = tree.models[index], pendingProblems = new Set(tree.pending.observations.filter(item => samples.get(item.sampleId)?.model === state.model).map(item => item.sampleId + ":" + item.findingId)).size;
    $("coverage").replaceChildren();
    for (const [label, count] of [["目标", current.targetCount], ["已接受", current.sampleCount], ["未完成", current.unfinishedCount],
      ["归因问题", current.problemCount], ["聚类节点", modelNodes().length], ["待观察池问题", pendingProblems]])
      $("coverage").append(append(el("span"), el("b", num(count)), el("span", " " + label)));
  }
  function treeButton(kind, key, label, count, level, expanded) {
    const button = el("button"); button.type = "button"; button.setAttribute("role", "treeitem"); button.setAttribute("aria-level", level);
    button.dataset.nodeKind = kind; button.dataset.nodeKey = key; button.tabIndex = -1;
    if (expanded !== undefined) { button.setAttribute("aria-expanded", expanded); button.append(el("span", "›", "tree-chevron")); }
    else button.append(el("span", undefined, "tree-class-dot"));
    append(button, el("span", label, "tree-label"), el("span", num(count), "tree-count"));
    if (kind === "node") { button.dataset.problem = key; button.setAttribute("aria-selected", String(state.kind === "node" && state.nodeId === key)); }
    button.onfocus = () => { state.focusKey = key; for (const item of $("problem-tree").querySelectorAll('[role="treeitem"]')) item.tabIndex = item === button ? 0 : -1; };
    button.onclick = () => {
      state.focusKey = key;
      if (kind === "root") { state.rootExpanded = !state.rootExpanded; renderTree(); focusTree(key); }
      else if (kind === "category") { state.expanded.has(key) ? state.expanded.delete(key) : state.expanded.add(key); renderTree(); focusTree(key); }
      else { select("node", key); focusTree(key); }
    };
    return button;
  }
  function focusTree(key) { [...$("problem-tree").querySelectorAll('[role="treeitem"]')].find(item => item.dataset.nodeKey === key)?.focus({ preventScroll: true }); }
  function renderTree() {
    const host = $("problem-tree"), nodes = visibleNodes(), root = el("ul"), rootItem = el("li"); host.replaceChildren(root);
    rootItem.append(treeButton("root", "root", "相似问题聚类", nodes.length, 1, state.rootExpanded)); root.append(rootItem);
    if (state.rootExpanded) {
      const categories = el("ul"); categories.setAttribute("role", "group"); rootItem.append(categories);
      for (const category of unique(nodes.map(node => node.category))) {
        const own = nodes.filter(node => node.category === category), item = el("li"), count = new Set(own.flatMap(node => visibleEntries("node", node.id).map(entry => entry.sample.inputId ?? entry.sample.id))).size;
        item.append(treeButton("category", category, category, count, 2, state.expanded.has(category))); categories.append(item);
        if (!state.expanded.has(category)) continue;
        const children = el("ul"); children.setAttribute("role", "group"); item.append(children);
        for (const node of own) children.append(append(el("li"), treeButton("node", node.id, node.label, visibleEntries("node", node.id).length, 3)));
      }
    }
    const buttons = [...host.querySelectorAll('[role="treeitem"]')], active = buttons.find(button => button.dataset.nodeKey === state.focusKey) ?? buttons.find(button => button.getAttribute("aria-selected") === "true") ?? buttons[0];
    if (active) active.tabIndex = 0;
    $("problem-tree-result").textContent = num(nodes.length) + " 聚类节点";
    for (const [id, kind, label] of [["pending-pool", "pending", "本模型" + tree.pending.label], ["all-samples", "all", "本模型已接受样本"], ["unfinished-samples", "unfinished", "本模型未完成样本"]]) {
      const button = $(id); button.replaceChildren(el("span", label), el("span", num(visibleEntries(kind).length), "review-entry-count"));
      button.setAttribute("aria-pressed", String(state.kind === kind));
    }
  }
  function renderDetail() {
    const host = $("problem-detail"), node = modelNodes().find(item => item.id === state.nodeId), rows = visibleEntries(state.kind, state.nodeId), supported = entries(state.kind, state.nodeId);
    host.replaceChildren(); host.dataset.view = state.kind; host.dataset.nodeId = state.kind === "node" ? state.nodeId : "";
    const label = state.kind === "node" ? node.label : state.kind === "pending" ? tree.pending.label : state.kind === "unfinished" ? "未完成样本" : "已接受样本";
    const heading = append(el("div", undefined, "problem-detail-heading"), el("h1", label)); host.append(heading);
    if (state.kind === "node") host.append(el("p", node.definition, "problem-definition"));
    append(host, append(el("div", undefined, "review-stats"), append(el("span"), el("b", num(supported.length)), el("span", " 关联回答")),
      state.kind === "unfinished" ? null : append(el("span"), el("b", num(problemCount(supported))), el("span", " 归因问题"))));
    const section = el("section", undefined, "problem-occurrences"), table = el("table", undefined, "review-sample-table"), thead = el("thead"), labels = ["日期", "模型", "样本编号", "任务摘要"];
    if (state.kind !== "unfinished") labels.push(state.kind === "node" ? "本节点问题摘要" : "问题摘要", "责任", "影响程度", "证据状态");
    const tr = el("tr"); for (const label of labels) { const th = el("th", label); th.scope = "col"; tr.append(th); } thead.append(tr); table.append(thead);
    const body = el("tbody"); table.append(body);
    const pages = Math.max(1, Math.ceil(rows.length / state.pageSize)); state.page = Math.min(state.page, pages);
    const start = (state.page - 1) * state.pageSize;
    for (const entry of rows.slice(start, start + state.pageSize)) {
      const sample = entry.sample, tr = el("tr"); tr.dataset.sampleId = sample.id; tr.dataset.inputId = sample.inputId;
      const identity = el("td", sample.id, "review-sample-id");
      append(tr, el("td", sample.date, "review-date"), el("td", sample.modelName, "review-model"), identity, el("td", sample.taskSummary, "review-task-summary"));
      if (state.kind === "unfinished") { body.append(tr); continue; }
      const responsibility = entry.components.length ? entry.components.join("、") : sample.problemCount ? "责任未定位" : "—";
      const evidence = el("td", evidenceNames[entry.evidenceStatus] ?? "—", "review-value review-evidence"); evidence.dataset.status = entry.evidenceStatus ?? "none";
      append(tr, el("td", entry.summary || "无问题记录", "review-problem-summary"),
        el("td", responsibility, "review-responsibility"), el("td", importanceNames[entry.importance] ?? "—", "review-value"), evidence); body.append(tr);
    }
    if (!rows.length) { const cell = el("td", "无匹配样本", "review-table-empty"); cell.colSpan = labels.length; body.append(append(el("tr"), cell)); }
    const count = el("span", num(rows.length) + " 份回答", "problem-recall-count"); count.id = "sample-count";
    append(section, append(el("div", undefined, "problem-occurrences-heading"), el("h2", "关联样本"), count), append(el("div", undefined, "review-table-wrap"), table));
    const pager = el("div", undefined, "problem-pager"), sizeLabel = el("label", "每页", "review-page-size"), size = el("select");
    size.id = "page-size"; size.setAttribute("aria-label", "每页回答数");
    for (const value of [10, 20, 50]) { const option = el("option", value); option.value = value; size.append(option); } size.value = state.pageSize;
    size.onchange = () => { state.pageSize = Number(size.value); state.page = 1; renderDetail(); $("page-size").focus({ preventScroll: true }); }; sizeLabel.append(size);
    const previous = el("button", "上一页"), next = el("button", "下一页"), status = el("span", state.page + " / " + pages + " 页");
    previous.id = "page-prev"; next.id = "page-next"; status.id = "page-status"; status.setAttribute("role", "status");
    previous.disabled = state.page === 1; next.disabled = state.page === pages;
    for (const [button, direction] of [[previous, -1], [next, 1]]) button.onclick = () => { state.page += direction; renderDetail(); $(button.id).focus({ preventScroll: true }); };
    append(pager, sizeLabel, append(el("div", undefined, "review-page-controls"), previous, status, next)); append(section, pager); host.append(section);
  }
  function render() { renderModels(); renderTree(); renderDetail(); }
  function filtersChanged() {
    state.page = 1;
    if ($("focus").value === "no_problem") state.kind = "all";
    else if ($("focus").value === "unlocated") state.kind = entries("pending").length ? "pending" : "all";
    if (state.kind === "node" && !visibleNodes().some(node => node.id === state.nodeId)) {
      const node = visibleNodes()[0]; if (node) { state.nodeId = node.id; state.remembered.set(state.model, node.id); state.expanded.add(node.category); }
    }
    $("problem-search").closest("label").classList.toggle("has-query", Boolean(query())); $("problem-search-clear").hidden = !query(); renderTree(); renderDetail();
  }
  $("problem-tree").onkeydown = event => {
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "Enter", " "].includes(event.key)) return;
    const buttons = [...$("problem-tree").querySelectorAll('[role="treeitem"]')], current = document.activeElement, index = buttons.indexOf(current); if (index < 0) return;
    event.preventDefault();
    if (event.key === "ArrowDown") buttons[Math.min(buttons.length - 1, index + 1)]?.focus();
    else if (event.key === "ArrowUp") buttons[Math.max(0, index - 1)]?.focus();
    else if (event.key === "Home") buttons[0]?.focus(); else if (event.key === "End") buttons.at(-1)?.focus();
    else if (event.key === "Enter" || event.key === " ") current.click();
    else if (event.key === "ArrowRight") { if (current.getAttribute("aria-expanded") === "false") current.click(); else if (current.hasAttribute("aria-expanded")) buttons[index + 1]?.focus(); }
    else if (current.getAttribute("aria-expanded") === "true") current.click();
    else { const level = Number(current.getAttribute("aria-level")); buttons.slice(0, index).reverse().find(button => Number(button.getAttribute("aria-level")) < level)?.focus(); }
  };
  for (const date of unique(tree.samples.map(sample => sample.date)).sort()) { const option = el("option", date); option.value = date; $("date").append(option); }
  for (const id of ["date", "focus", "standard"]) $(id).onchange = filtersChanged;
  $("problem-search").oninput = filtersChanged;
  $("problem-search-clear").onclick = () => { $("problem-search").value = ""; filtersChanged(); $("problem-search").focus(); };
  $("reset").onclick = () => { for (const id of ["date", "focus", "standard", "problem-search"]) $(id).value = ""; filtersChanged(); };
  $("all-samples").onclick = () => select("all"); $("pending-pool").onclick = () => select("pending"); $("unfinished-samples").onclick = () => select("unfinished");
  render();
}
