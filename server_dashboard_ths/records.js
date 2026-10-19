const MODEL_LABELS = {
  a_fast: "A Fast",
  b_fast: "B组 Fast",
  a_expert: "A Expert",
  b_expert: "B组 Expert",
};
const PAGE_SIZE = 20;
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
  const text = document.createElement("p");
  text.className = "answer-text";
  text.textContent = displayText(value) || "（空）";
  section.append(heading, text);
  return section;
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
  for (const item of items) {
    const article = document.createElement("article");
    article.className = "record-item";
    const question = document.createElement("p");
    question.className = "question-text";
    question.textContent = displayText(item.question) || "（空）";

    const details = document.createElement("details");
    details.className = "answer-details";
    const summary = document.createElement("summary");
    summary.textContent = "展开回答";
    details.addEventListener("toggle", () => {
      summary.textContent = details.open ? "收起回答" : "展开回答";
    });
    const fields = document.createElement("div");
    fields.className = "answer-fields";
    fields.append(makeAnswerField("回答", item.answer));
    if (Object.prototype.hasOwnProperty.call(item, "standard_answer")) {
      fields.append(makeAnswerField("标准答案", item.standard_answer));
    }
    details.append(summary, fields);
    article.append(question, details);
    list.append(article);
  }
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
    const response = await fetch(`/records/${encodeURIComponent(date)}/${encodeURIComponent(model)}?page=${page}&page_size=${PAGE_SIZE}`, { cache: "no-store" });
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
loadPage();
