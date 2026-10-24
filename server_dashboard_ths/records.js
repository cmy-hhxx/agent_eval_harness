import { renderMarkdown } from "./records-markdown.js";

export function mountRecords(root, options = {}) {

const MODEL_LABELS = {
  a_fast: "A Fast",
  b_fast: "B组 Fast",
  b_post_train_fast: "B post_train_fast",
  a_expert: "A Expert",
  b_expert: "B组 Expert",
  "6_luna": "6_luna",
  "6.1sol": "6.1sol",
  aime_fast: "aime Fast",
  aime_expert: "aime Expert",
  ifind_normal_agent: "ifind Fast",
  ifind_deep_research: "ifind Expert",
};
const PAGE_SIZE = 20;
const PATH_PARTS = location.pathname.split("/").filter(Boolean);
const DATASET = options.dataset || PATH_PARTS[1] || "wencai";
if ((options.profile || DATASET) === "post_training_model") {
  MODEL_LABELS.b_fast = "AA-fast";
  MODEL_LABELS.b_post_train_fast = "AA-post_train_fast_V1";
}
if ((options.profile || DATASET) === "wencai") { MODEL_LABELS.b_fast = "AA Fast"; MODEL_LABELS.b_expert = "AA Expert"; }
const BASE_PATH = `/data/${DATASET}`;
const params = new URLSearchParams(location.search);
const date = options.date || params.get("date") || "";
const model = options.model || params.get("model") || "";
let page = Math.max(1, Number.parseInt(params.get("page") || "1", 10) || 1);
let total = 0;
let request, disposed = false;

const list = root.querySelector("#records-list");
const title = root.querySelector("#records-title");
const count = root.querySelector("#records-count");
const previous = root.querySelector("#previous-page");
const next = root.querySelector("#next-page");
const pageStatus = root.querySelector("#page-status");
const formatCount = (value) => new Intl.NumberFormat("zh-CN").format(value);

function displayText(value) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return JSON.stringify(value, null, 2);
}

function makeAnswerField(label, value) {
  const section = document.createElement("section");
  section.className = "answer-field";
  const heading = document.createElement("h2");
  heading.textContent = label;
  const text = document.createElement("div");
  text.className = "answer-markdown";
  text.append(renderMarkdown(displayText(value) || "（空）"));
  section.append(heading, text);
  return section;
}

async function copyIdentifier(value, button) {
  try {
    let copied = false;
    if (navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(value); copied = true; } catch { /* Try HTTP's copy command. */ }
    }
    if (!copied) {
      const focused = root.activeElement;
      const field = document.createElement("textarea");
      field.value = value;
      field.className = "clipboard-field";
      field.setAttribute("aria-label", "复制标识");
      document.body.append(field);
      field.focus(); field.select();
      try {
        if (!document.execCommand("copy")) throw new Error("copy failed");
      } finally {
        field.remove();
        focused?.focus();
      }
    }
    button.textContent = "已复制";
  } catch {
    button.textContent = "复制失败";
  }
  window.setTimeout(() => { if (button.isConnected) button.textContent = "复制"; }, 2000);
}

function makeIdentifier(value, label) {
  const field = document.createElement("div");
  field.className = "record-identifier";
  const code = document.createElement("code");
  code.textContent = value || "未提供";
  if (value) code.title = value;
  field.append(code);
  if (value) {
    const button = document.createElement("button");
    button.type = "button"; button.className = "copy-id"; button.textContent = "复制";
    button.setAttribute("aria-label", `复制 ${label} ${value}`);
    button.setAttribute("aria-live", "polite");
    button.addEventListener("click", () => copyIdentifier(value, button));
    field.append(button);
  }
  return field;
}

function renderItems(items) {
  list.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "records-message";
    empty.textContent = "没有记录";
    list.append(empty);
    return;
  }
  if (options.compact) { renderCompact(items); return; }
  const scroll = document.createElement("div");
  scroll.className = "records-table-scroll";
  scroll.tabIndex = 0;
  scroll.setAttribute("aria-label", "样本表格，可横向滚动");
  const table = document.createElement("table");
  table.className = "records-table";
  const caption = document.createElement("caption");
  caption.className = "sr-only"; caption.textContent = "样本格式、标识及问答";
  const head = document.createElement("thead");
  const headings = document.createElement("tr");
  for (const label of ["序号", "格式 / 会话", "Trace ID", "问句", "回答"]) {
    const cell = document.createElement("th");
    cell.scope = "col"; cell.textContent = label; headings.append(cell);
  }
  head.append(headings);
  table.append(caption, head);
  items.forEach((item, index) => {
    const body = document.createElement("tbody");
    const session = item.format === "session";
    const turns = session ? item.turns : [item];
    turns.forEach((turn, round) => {
      const row = document.createElement("tr");
      row.className = session ? "session-turn" : "trace-row";
      if (round === 0) {
        const number = document.createElement("th");
        number.scope = "rowgroup"; number.rowSpan = turns.length;
        number.className = "record-number";
        number.textContent = formatCount((page - 1) * PAGE_SIZE + index + 1);
        const format = document.createElement("td");
        format.rowSpan = turns.length; format.className = "record-format";
        const label = document.createElement("span");
        label.className = session ? "session-title format-badge" : "format-badge";
        label.textContent = session ? `Session · ${formatCount(turns.length)} 轮` : "单 trace";
        format.append(label);
        if (session && item.session_id) {
          const name = document.createElement("span");
          name.className = "identifier-label"; name.textContent = "Session ID";
          format.append(name, makeIdentifier(item.session_id, "Session ID"));
        }
        row.append(number, format);
      }
      const trace = document.createElement("td");
      trace.className = "record-trace";
      if (session) {
        const label = document.createElement("span");
        label.className = "round-label"; label.textContent = `第 ${round + 1} 轮`;
        trace.append(label);
      }
      trace.append(makeIdentifier(turn.trace_id, "Trace ID"));
      const question = document.createElement("td");
      question.className = "record-question";
      question.append(makeRecordQuestion(turn.question));
      const answer = document.createElement("td");
      answer.className = "record-answer";
      answer.append(makeRecordAnswer(turn));
      row.append(trace, question, answer); body.append(row);
    });
    table.append(body);
  });
  scroll.append(table); list.append(scroll);
}

function renderCompact(items) {
  const table = document.createElement('table'); table.className = 'table compact-records-table';
  const head = document.createElement('thead'), headings = document.createElement('tr');
  for (const label of ['问句','回答']) { const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = label; headings.append(cell); }
  head.append(headings); table.append(head);
  items.forEach(item => {
    const body = document.createElement('tbody'), turns = item.format === 'session' ? item.turns : [item];
    turns.forEach((turn,index) => {
      const row = document.createElement('tr'), question = document.createElement('td'), answer = document.createElement('td');
      question.append(makeRecordQuestion(turn.question));
      const identity = document.createElement('details'), label = document.createElement('summary');
      label.textContent = turns.length > 1 ? `第 ${index+1} 轮 · 标识` : '标识'; identity.append(label,makeIdentifier(turn.trace_id,'Trace ID'));
      if (item.session_id) identity.append(makeIdentifier(item.session_id,'Session ID')); question.append(identity);
      const detail = document.createElement('details'), summary = document.createElement('summary'); summary.textContent = '查看回答'; detail.append(summary);
      let rendered = false;
      detail.addEventListener('toggle', () => { if (detail.open && !rendered) { const fields = makeRecordAnswer(turn); fields.firstElementChild?.querySelector('h2')?.remove(); detail.append(fields); rendered = true; } });
      answer.append(detail); row.append(question,answer); body.append(row);
    });
    table.append(body);
  });
  list.append(table);
}

function makeRecordQuestion(value) {
  const node = document.createElement("div");
  node.className = "question-text"; node.textContent = displayText(value) || "（空）";
  return node;
}
function makeRecordAnswer(item) {
  const fields = document.createElement("div"); fields.className = "answer-fields";
  fields.append(makeAnswerField("回答", item.answer));
  if (Object.hasOwn(item, "standard_answer")) fields.append(makeAnswerField("标准答案", item.standard_answer));
  return fields;
}

function updatePagination() {
  const pages = Math.ceil(total / PAGE_SIZE);
  previous.disabled = page <= 1;
  next.disabled = page >= pages;
  pageStatus.textContent = `${pages ? page : 0} / ${pages || 0}`;
  count.textContent = `${formatCount(total)} 条`;
}

async function loadPage() {
  if (disposed) return;
  request?.abort(); const controller = new AbortController(); request = controller;
  if (!date || !MODEL_LABELS[model]) {
    title.textContent = "无效的数据地址";
    list.innerHTML = '<p class="records-message records-error">请从数据目录打开样本</p>';
    return;
  }
  title.textContent = `${date} · ${MODEL_LABELS[model]}`;
  list.innerHTML = '<p class="records-message">读取中</p>';
  previous.disabled = true;
  next.disabled = true;
  try {
    const response = await fetch(`${BASE_PATH}/records/${encodeURIComponent(date)}/${encodeURIComponent(model)}?page=${page}&page_size=${PAGE_SIZE}`, { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (disposed || controller.signal.aborted) return;
    total = data.total;
    const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (page > lastPage) {
      page = lastPage;
      params.set("page", String(page));
      return loadPage();
    }
    renderItems(data.items);
    updatePagination();
    const first = total ? (page - 1) * PAGE_SIZE + 1 : 0;
    const last = Math.min(page * PAGE_SIZE, total);
    count.textContent = total ? `${formatCount(first)}–${formatCount(last)} / ${formatCount(total)} 条` : "0 条";
  } catch {
    if (disposed || controller.signal.aborted) return;
    list.innerHTML = '<p class="records-message records-error">样本暂不可用</p>';
    pageStatus.textContent = "—";
    count.textContent = "";
  }
}

function setPage(value) {
  page = value;
  params.set("page", String(page));
  loadPage();

}

previous.addEventListener("click", () => setPage(page - 1));
next.addEventListener("click", () => setPage(page + 1));
const ready = loadPage();
return { ready, destroy() { disposed = true; request?.abort(); } };
}
if (globalThis.document?.querySelector("#records-list")) mountRecords(document);
