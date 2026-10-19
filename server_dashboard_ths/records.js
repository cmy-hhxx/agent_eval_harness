import { markdownPreview, renderMarkdown } from "./records-markdown.js";

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
const PAGE_SIZE = 20;
const DATASET = location.pathname.split("/")[1];
const BASE_PATH = ["gpt", "aime", "ifind"].includes(DATASET) ? `/${DATASET}` : "";
const params = new URLSearchParams(location.search);
const date = params.get("date") || "";
const model = params.get("model") || "";
let page = Math.max(1, Number.parseInt(params.get("page") || "1", 10) || 1);
let total = 0;

const list = document.querySelector("#records-list");
const title = document.querySelector("#records-title");
const count = document.querySelector("#records-count");
const previous = document.querySelector("#previous-page");
const next = document.querySelector("#next-page");
const pageStatus = document.querySelector("#page-status");
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
      const focused = document.activeElement;
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
  updateQuestionOverflow();
}

function makeRecordQuestion(value) {
  const text = displayText(value) || "（空）";
  const question = document.createElement("div");
  question.className = "question-content";
  const full = document.createElement("div");
  full.className = "question-text question-preview"; full.textContent = text;
  const action = document.createElement("button");
  action.type = "button"; action.hidden = true;
  action.setAttribute("aria-expanded", "false");
  action.className = "question-action"; action.textContent = "展开问句";
  action.addEventListener("click", () => {
    const open = action.getAttribute("aria-expanded") !== "true";
    action.setAttribute("aria-expanded", String(open));
    question.classList.toggle("is-expanded", open);
    full.classList.toggle("question-preview", !open);
    action.textContent = open ? "收起问句" : "展开问句";
    if (!open) updateQuestionOverflow();
  });
  question.append(full, action);
  return question;
}

function updateQuestionOverflow() {
  for (const question of list.querySelectorAll(".question-content")) {
    const action = question.querySelector(".question-action");
    if (action.getAttribute("aria-expanded") === "true") continue;
    const text = question.querySelector(".question-text");
    action.hidden = true;
    action.hidden = text.scrollHeight <= text.clientHeight + 1;
  }
}

function makeRecordAnswer(item) {
  const details = document.createElement("details");
  details.className = "answer-details";
  const summary = document.createElement("summary");
  const preview = document.createElement("span");
  preview.className = "answer-preview";
  const text = displayText(item.answer);
  preview.textContent = markdownPreview(text) || text.slice(0, 1000).replace(/\s+/g, " ").trim() || "（空）";
  const action = document.createElement("span");
  action.className = "answer-action"; action.textContent = "展开回答";
  summary.append(preview, action);
  details.addEventListener("toggle", () => {
    preview.hidden = details.open;
    action.textContent = details.open ? "收起回答" : "展开回答";
    if (details.open && !fields.childNodes.length) {
      fields.append(makeAnswerField("回答", item.answer));
      if (Object.prototype.hasOwnProperty.call(item, "standard_answer")) fields.append(makeAnswerField("标准答案", item.standard_answer));
    }
  });
  const fields = document.createElement("div");
  fields.className = "answer-fields";
  details.append(summary, fields);
  return details;
}

function updatePagination() {
  const pages = Math.ceil(total / PAGE_SIZE);
  previous.disabled = page <= 1;
  next.disabled = page >= pages;
  pageStatus.textContent = `${pages ? page : 0} / ${pages || 0}`;
  count.textContent = `${formatCount(total)} 条`;
}

async function loadPage() {
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
    const response = await fetch(`${BASE_PATH}/records/${encodeURIComponent(date)}/${encodeURIComponent(model)}?page=${page}&page_size=${PAGE_SIZE}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    total = data.total;
    const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (page > lastPage) {
      page = lastPage;
      params.set("page", String(page));
      history.replaceState({}, "", `${location.pathname}?${params.toString()}`);
      return loadPage();
    }
    renderItems(data.items);
    updatePagination();
    const first = total ? (page - 1) * PAGE_SIZE + 1 : 0;
    const last = Math.min(page * PAGE_SIZE, total);
    count.textContent = total ? `${formatCount(first)}–${formatCount(last)} / ${formatCount(total)} 条` : "0 条";
  } catch {
    list.innerHTML = '<p class="records-message records-error">样本暂不可用</p>';
    pageStatus.textContent = "—";
    count.textContent = "";
  }
}

function setPage(value) {
  page = value;
  params.set("page", String(page));
  history.pushState({}, "", `${location.pathname}?${params.toString()}`);
  loadPage();
  window.scrollTo(0, 0);
}

previous.addEventListener("click", () => setPage(page - 1));
next.addEventListener("click", () => setPage(page + 1));
window.addEventListener("popstate", () => {
  page = Math.max(1, Number.parseInt(new URLSearchParams(location.search).get("page") || "1", 10) || 1);
  loadPage();
});
window.addEventListener("resize", updateQuestionOverflow);
loadPage();
