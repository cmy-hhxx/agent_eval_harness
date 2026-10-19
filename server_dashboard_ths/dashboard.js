const PAIRS = [
  { id: "fast", label: "A Fast 对 B组 Fast", a: "a_fast", b: "b_fast" },
  { id: "expert", label: "A Expert 对 B组 Expert", a: "a_expert", b: "b_expert" },
];
const DATASET = location.pathname.split("/")[1];
const BASE_PATH = ["gpt", "aime", "ifind"].includes(DATASET) ? `/${DATASET}` : "";
const IS_GPT = BASE_PATH === "/gpt";
const SINGLE_MODELS = {
  aime: ["aime_fast", "aime_expert"],
  ifind: ["ifind_normal_agent", "ifind_deep_research"],
}[DATASET];
const GROUPS = [
  { label: "Fast", models: ["a_fast", "b_fast", "6_luna"] },
  { label: "Expert", models: ["a_expert", "b_expert", "6.1sol"] },
].map(group => ({ ...group, pairs: group.models.flatMap((a, index) => group.models.slice(index + 1).map(b => ({
  id: [a, b].sort().join("__vs__"), a, b,
}))) }));
const MODEL_LABELS = {
  a_fast: "A Fast",
  b_fast: "B组 Fast",
  a_expert: "A Expert",
  b_expert: "B组 Expert",
  "6_luna": "6_luna",
  "6.1sol": "6.1sol",
  aime_fast: "aime Fast",
  aime_expert: "aime Expert",
  ifind_normal_agent: "ifind Fast",
  ifind_deep_research: "ifind Expert",
};
const DAILY_BATTLE_LIMIT = 300;
const DATES_PER_PAGE = 14;

const rows = document.querySelector("#date-rows");
const pagination = document.querySelector("#date-pagination");
const previousPageButton = document.querySelector("#previous-page");
const nextPageButton = document.querySelector("#next-page");
const pageSummary = document.querySelector("#page-summary");
const datasetRange = document.querySelector("#dataset-range-dates");
const state = document.querySelector("#service-state");
const readyCount = document.querySelector("#ready-count");
const totalRows = document.querySelector("#total-rows");
const errorMessage = document.querySelector("#connection-error");
const refreshButton = document.querySelector("#refresh");
let loading = false;
let hasLoadedCatalog = false;
let currentPage = 0;
let currentCatalog = null;

if (IS_GPT) {
  document.body.classList.add("gpt-dataset");
  document.title = "GPT 六路评测数据";
  document.querySelector(".dataset-range-models").textContent = "6 个模型";
  document.querySelector(".results-table caption").textContent = "每日 GPT 六路模型数据及同档两两对战进度";
  const headings = document.querySelectorAll(".results-table thead th");
  GROUPS.forEach((group, index) => {
    headings[index + 1].replaceChildren(document.createTextNode(group.models.map(id => MODEL_LABELS[id]).join(" · ")));
    const quota = document.createElement("span");
    quota.className = "pair-quota";
    headings[index + 1].append(quota);
  });
}
if (SINGLE_MODELS) {
  document.body.classList.add("single-dataset");
  document.title = `${DATASET} 评测输入数据`;
  document.querySelector(".dataset-range-models").textContent = `${DATASET} · Fast / Expert`;
  document.querySelector(".results-table caption").textContent = `每日 ${DATASET} Fast 和 Expert 输入数据`;
  const headings = document.querySelectorAll(".results-table thead th");
  ["Fast", "Expert"].forEach((label, index) => headings[index + 1].replaceChildren(document.createTextNode(label)));
}
document.querySelector(`[data-dataset="${BASE_PATH ? DATASET : "root"}"]`).setAttribute("aria-current", "page");

const formatCount = (count) => new Intl.NumberFormat("zh-CN").format(Number.isInteger(count) ? count : 0);
const dateTime = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
});
function formatBytes(bytes) {
  for (const [unit, size] of [["GiB", 1024 ** 3], ["MiB", 1024 ** 2], ["KiB", 1024]])
    if (bytes >= size) return `${(bytes / size).toFixed(2)} ${unit}`;
  return `${formatCount(bytes)} B`;
}

function renderProcessing(info) {
  const error = document.querySelector("#processing-error");
  error.hidden = Boolean(info && !info.error);
  if (!error.hidden) return;
  for (const [id, value] of [["last-received", info.received_at], ["last-published", info.published_at]]) {
    const element = document.querySelector(`#${id}`);
    element.textContent = value ? dateTime.format(new Date(value)) : "暂无";
    element.title = value ? new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) + " 北京时间" : "";
  }
  document.querySelector("#pending-archives").textContent = formatCount(info.pending);
  const failed = document.querySelector("#failed-archives");
  failed.textContent = formatCount(info.failed.length);
  failed.classList.toggle("has-failures", info.failed.length > 0);
  document.querySelector("#processing-failures").hidden = info.failed.length === 0;
  const errors = document.querySelector("#archive-errors");
  errors.replaceChildren(...info.failed.map(item => {
    const li = document.createElement("li");
    li.textContent = `${item.name}：${item.error}`;
    return li;
  }));
  const archive = info.archive;
  document.querySelector("#archive-summary").textContent = archive
    ? `归档 ${formatCount(archive.packages)} 包 · ${formatBytes(archive.bytes)} · ${formatCount(archive.partitions)} 卷`
    : "归档未巡检";
  document.querySelector("#archive-checked").textContent = archive ? `巡检 ${dateTime.format(new Date(archive.checked_at))}` : "";
}
for (const label of document.querySelectorAll(".pair-quota"))
  label.textContent = `${IS_GPT ? "每对模型" : ""}每天最多评测 ${formatCount(DAILY_BATTLE_LIMIT)} 次对战`;

function quotaProgress(counts) {
  if (!counts) return counts;
  const remaining = Math.max(0, DAILY_BATTLE_LIMIT - counts.completed_cases - counts.running_cases);
  const failed = Math.min(counts.failed_cases, remaining);
  const exceeded = Math.max(0, counts.total_cases - counts.skipped_cases -
    Math.max(DAILY_BATTLE_LIMIT, counts.completed_cases + counts.running_cases));
  return { ...counts, total_cases: counts.total_cases - exceeded,
    queued_cases: Math.min(counts.queued_cases, remaining - failed), failed_cases: failed, exceeded_cases: exceeded };
}

function makeModelLink(day, model, item) {
  if (!item?.ready) {
    const pending = document.createElement("span");
    pending.className = "model-link-pending";
    pending.textContent = `${MODEL_LABELS[model]} —`;
    return pending;
  }
  const link = document.createElement("a");
  link.className = "model-link";
  link.href = `${BASE_PATH}/records?date=${encodeURIComponent(day)}&model=${encodeURIComponent(model)}`;
  link.textContent = `${MODEL_LABELS[model]} ${formatCount(item.row_count)} 条`;
  link.setAttribute("aria-label", `查看 ${day} ${MODEL_LABELS[model]} 问句`);
  return link;
}

function progressLabel(run, counts, entry, pair) {
  if (!counts || !counts.total_cases) return "暂无";
  // Finished tasks cover only the reported snapshot, not later source arrivals.
  if (!counts.failed_cases && !counts.running_cases && !counts.queued_cases &&
      counts.completed_cases + counts.skipped_cases === counts.total_cases) {
    if (counts.completed_cases >= DAILY_BATTLE_LIMIT) return "✅";
    const models = [entry.models?.[pair.a], entry.models?.[pair.b]];
    if (!entry.ready || models.some(model => !model?.ready || !Number.isSafeInteger(model.row_count))) return "数据准备中";
    if (models.some(model => model.row_count > counts.total_cases)) return "有新增待评测";
    if (counts.skipped_cases) return counts.completed_cases ? "等待配对" : "无可评测样本";
    if (models.some(model => model.row_count !== counts.total_cases)) return "数据已变化";
    return counts.completed_cases > 0 ? "✅" : "无可评测样本";
  }
  if (run?.status === "running" && run.stale) return "停更";
  if (run?.status === "running") return "评测中";
  if (run?.status === "finished") {
    if (counts.failed_cases) return "存在评测失败";
    return "仍有待评测项";
  }
  if (run?.status === "interrupted") return "已中断";
  return "暂无";
}

function makePairCell(day, entry, pair, evaluation, dayProgress, grouped = false) {
  const cell = document.createElement(grouped ? "div" : "td");
  cell.className = grouped ? "gpt-pair-progress" : "pair-cell";
  if (grouped) {
    const label = document.createElement("span");
    label.className = "gpt-pair-label";
    label.textContent = `${MODEL_LABELS[pair.a]} 对 ${MODEL_LABELS[pair.b]}`;
    cell.append(label);
  }
  const counts = quotaProgress(dayProgress?.pairs?.[pair.id]);
  const total = counts?.total_cases || 0;
  if (!entry.ready && !total) {
    cell.classList.add("pair-empty-cell");
    cell.append(document.createTextNode(grouped ? "等待数据" : "—"));
    return cell;
  }
  if (!grouped) {
    const inputs = document.createElement("div");
    inputs.className = "pair-inputs";
    inputs.append(
      makeModelLink(day, pair.a, entry.models?.[pair.a]),
      makeModelLink(day, pair.b, entry.models?.[pair.b]),
    );
    cell.append(inputs);
  }
  if (!total) {
    const empty = document.createElement("span");
    empty.className = "pair-empty";
    empty.textContent = grouped && [pair.a, pair.b].some(id => !entry.models?.[id]?.ready) ? "等待数据" : "暂无进度";
    cell.append(empty);
    return cell;
  }

  const completed = counts?.completed_cases || 0;
  const failed = counts?.failed_cases || 0;
  const skipped = counts?.skipped_cases || 0;
  const running = counts?.running_cases || 0;
  const queued = (counts?.queued_cases || 0) + failed;
  const overview = document.createElement("div");
  overview.className = "pair-overview";
  const label = progressLabel(evaluation, counts, entry, pair);
  const status = document.createElement("span");
  status.className = "pair-status";
  status.dataset.status = label === "评测中" ? "running"
    : label === "✅" ? "finished"
    : label === "存在评测失败" ? "failed"
    : ["仍有待评测项", "有新增待评测", "等待配对", "数据准备中", "数据已变化"].includes(label) ? "queued"
    : label === "停更" || label === "已中断" ? "stale" : "none";
  status.textContent = label;
  if (label === "✅") {
    const completedScope = completed >= DAILY_BATTLE_LIMIT ? "当日评测额度已完成" : "当前数据已评测完成";
    status.setAttribute("aria-label", completedScope);
    status.title = completedScope;
  }
  overview.append(status);

  const tally = document.createElement("span");
  tally.className = "pair-tally";
  tally.append(document.createTextNode(`${completed > DAILY_BATTLE_LIMIT ? "历史已完成" : "已完成"} ${formatCount(completed)} 条`));
  if (skipped) {
    const unavailable = document.createElement("span");
    unavailable.className = "skipped-count";
    unavailable.textContent = `未配对（答案缺失或无效）${formatCount(skipped)} 条`;
    tally.append(unavailable);
  }
  if (failed) {
    const failure = document.createElement("span");
    failure.className = "failed-count";
    failure.textContent = `其中失败待重试 ${formatCount(failed)} 条`;
    tally.append(failure);
  }
  overview.append(tally);
  if (running || queued) {
    const active = document.createElement("span");
    active.className = "active-counts";
    active.textContent = `运行中 ${formatCount(running)} · 排队 ${formatCount(queued)}`;
    overview.append(active);
  }
  cell.append(overview);
  if (counts.exceeded_cases) {
    const excluded = document.createElement("div");
    excluded.className = "quota-excluded";
    excluded.textContent = `${formatCount(counts.exceeded_cases)} 条超过评测配额，不评测`;
    cell.append(excluded);
  }
  return cell;
}

function makeDateRow(entry, evaluation) {
  const row = document.createElement("tr");
  const dateCell = document.createElement("th");
  dateCell.className = "date-value";
  dateCell.scope = "row";
  const date = document.createElement("time");
  date.textContent = entry.date;
  const count = document.createElement("span");
  count.className = "date-count";
  const rowCount = Object.values(entry.models || {}).reduce(
    (sum, item) => sum + (item?.ready ? Number(item.row_count) || 0 : 0), 0,
  );
  count.textContent = entry.ready ? `${formatCount(rowCount)} 条` : "待就绪";
  dateCell.append(date, count);
  row.append(dateCell);

  const dayProgress = evaluation?.dates?.find((item) => item.date === entry.date);
  if (SINGLE_MODELS) {
    for (const model of SINGLE_MODELS) {
      const cell = document.createElement("td");
      cell.className = "input-cell";
      cell.append(makeModelLink(entry.date, model, entry.models?.[model]));
      const stages = dayProgress?.models?.[model];
      for (const [stage, label, unit] of [["criteria", "标准制定", "任务"], ["attribution", "归因", "任务"], ["clustering", "聚类", "任务"]]) {
        const counts = stages?.[stage];
        const line = document.createElement("div");
        line.className = "stage-progress";
        if (!counts?.total) {
          line.textContent = `${label} · 暂无进度`;
        } else {
          const tally = [`${label} · 已完成 ${formatCount(counts.completed)} / ${formatCount(counts.total)} ${unit}`];
          for (const [key, text] of [["running", "运行中"], ["pending", "排队"], ["failed", "失败"], ["blocked", "阻塞"], ["cancelled", "已中断"]])
            if (counts[key]) tally.push(`${text} ${formatCount(counts[key])}`);
          if (evaluation?.status === "running" && evaluation.stale) tally.push("进度停更");
          line.textContent = tally.join(" · ");
        }
        cell.append(line);
      }
      row.append(cell);
    }
  } else if (IS_GPT) {
    for (const group of GROUPS) {
      const cell = document.createElement("td");
      cell.className = "pair-cell gpt-group-cell";
      const inputs = document.createElement("div");
      inputs.className = "pair-inputs";
      inputs.append(...group.models.map(model => makeModelLink(entry.date, model, entry.models?.[model])));
      cell.append(inputs, ...group.pairs.map(pair => makePairCell(entry.date, entry, pair, evaluation, dayProgress, true)));
      row.append(cell);
    }
  } else {
    for (const pair of PAIRS) row.append(makePairCell(entry.date, entry, pair, evaluation, dayProgress));
  }
  return row;
}

function renderCatalog(data) {
  const dates = data.dates || [];
  const pageCount = Math.max(1, Math.ceil(dates.length / DATES_PER_PAGE));
  currentPage = Math.min(currentPage, pageCount - 1);
  const pageStart = currentPage * DATES_PER_PAGE;
  const pageEnd = Math.min(pageStart + DATES_PER_PAGE, dates.length);
  const dateRange = dates.map((entry) => entry.date).filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day)).sort();
  datasetRange.textContent = dateRange.length
    ? `${dateRange[0]} — ${dateRange[dateRange.length - 1]}`
    : "暂无数据";
  const availableDays = dates.filter((entry) => entry.ready).length;
  const rowTotal = dates.reduce((sum, entry) => sum + Object.values(entry.models || {}).reduce(
    (total, item) => total + (item?.ready ? Number(item.row_count) || 0 : 0), 0,
  ), 0);
  readyCount.textContent = `${formatCount(availableDays)} / ${formatCount(dates.length)}`;
  totalRows.textContent = formatCount(rowTotal);
  pagination.hidden = pageCount === 1;
  previousPageButton.disabled = currentPage === 0;
  nextPageButton.disabled = currentPage >= pageCount - 1;
  pageSummary.textContent = dates.length
    ? `第 ${pageStart + 1}–${pageEnd} 天 / 共 ${formatCount(dates.length)} 天 · ${currentPage + 1} / ${pageCount} 页`
    : "0 天";
  rows.replaceChildren();

  if (!dates.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.className = "loading-cell";
    cell.colSpan = 3;
    cell.textContent = "暂无数据";
    row.append(cell);
    rows.append(row);
  } else {
    for (const entry of dates.slice(pageStart, pageEnd)) rows.append(makeDateRow(entry, data.evaluation));
  }

  hasLoadedCatalog = true;
  state.dataset.state = "online";
  state.querySelector(".state-label").textContent = "在线";
  errorMessage.hidden = true;
}

async function loadCatalog() {
  if (loading) return;
  loading = true;
  refreshButton.disabled = true;
  refreshButton.setAttribute("aria-busy", "true");
  try {
    const [response, processing] = await Promise.all([
      fetch(`${BASE_PATH}/dashboard-data`, { cache: "no-store" }),
      fetch(`${BASE_PATH}/processing-status`, { cache: "no-store" })
        .then(response => response.ok ? response.json() : null).catch(() => null),
    ]);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    currentCatalog = await response.json();
    renderCatalog(currentCatalog);
    renderProcessing(processing);
  } catch {
    state.dataset.state = "offline";
    state.querySelector(".state-label").textContent = "离线";
    errorMessage.textContent = "数据目录暂不可用";
    errorMessage.hidden = false;
    if (!hasLoadedCatalog) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.className = "loading-cell";
      cell.colSpan = 3;
      cell.textContent = "无法读取数据";
      row.replaceChildren(cell);
      rows.replaceChildren(row);
    }
  } finally {
    loading = false;
    refreshButton.disabled = false;
    refreshButton.removeAttribute("aria-busy");
  }
}

previousPageButton.addEventListener("click", () => {
  if (!currentCatalog || currentPage === 0) return;
  currentPage -= 1;
  renderCatalog(currentCatalog);
});
nextPageButton.addEventListener("click", () => {
  if (!currentCatalog || currentPage >= Math.ceil(currentCatalog.dates.length / DATES_PER_PAGE) - 1) return;
  currentPage += 1;
  renderCatalog(currentCatalog);
});
refreshButton.addEventListener("click", loadCatalog);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") loadCatalog();
});
window.setInterval(() => {
  if (document.visibilityState === "visible") loadCatalog();
}, 15000);
loadCatalog();
