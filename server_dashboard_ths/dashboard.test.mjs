import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const html = await readFile(new URL("dashboard.html", import.meta.url), "utf8");
const source = await readFile(new URL("dashboard.js", import.meta.url), "utf8");
const recordsSource = (await build({ entryPoints: [fileURLToPath(new URL("records.js", import.meta.url))], bundle: true, write: false, format: "iife", platform: "browser" })).outputFiles[0].text;
const done = { total_cases: 90, completed_cases: 90, running_cases: 0, queued_cases: 0, failed_cases: 0, skipped_cases: 0 };
const processing = {
  received_at: Date.parse("2026-10-19T05:47:00Z"), published_at: Date.parse("2026-10-19T05:48:00Z"),
  pending: 2, failed: [{ name: "broken.7z", error: "invalid header data" }], error: null,
  archive: { packages: 667, bytes: 3.38 * 1024 ** 3, partitions: 30, checked_at: Date.parse("2026-10-19T01:00:00Z"), oversized: [] },
};

async function render(status, stale = false, counts = done, catalogDates = null, sourceRows = counts.total_cases) {
  const dom = new JSDOM(html, { url: "http://localhost/data/wencai/", runScripts: "outside-only" });
  const dates = catalogDates || ["2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-30", "2026-10-08"];
  const active = { ...done, completed_cases: 10, running_cases: 1, queued_cases: 79 };
  dom.window.fetch = async url => url.endsWith("/processing-status")
    ? { ok: true, json: async () => processing } : ({ ok: true, json: async () => ({
    dates: dates.map(date => ({ date, ready: true, models: Object.fromEntries(["a_fast", "b_fast", "a_expert", "b_expert"].map(id => [id, { ready: true, row_count: sourceRows }])) })),
    evaluation: { status, stale, dates: dates.map(date => ({ date, pairs: {
      fast: date === "2026-09-30" ? active : counts,
      expert: date === "2026-09-30" ? active : counts,
    } })) },
  }) });
  dom.window.setInterval = () => 0;
  vm.runInContext(source.replace(/^export /gm, ""), dom.getInternalVMContext());
  await new Promise(setImmediate);
  return dom;
}

test("header date range follows the catalog as new daily data arrives", async () => {
  const dom = await render("running");
  try {
    assert.equal(dom.window.document.querySelector("#dataset-range-dates").textContent,
      "2026-09-22 — 2026-10-08");
    assert.equal(dom.window.document.querySelector(".dataset-range-separator").textContent, "·");
    assert.equal(dom.window.document.querySelector(".dataset-range-models").textContent,
      "4 个模型");
  } finally { dom.window.close(); }
});

test("processing panel shows timestamps in Shanghai, distinct failures and archive volume", async () => {
  const dom = await render("running");
  try {
    const document = dom.window.document;
    assert.match(document.querySelector("#last-received").textContent, /10.19.*13:47/);
    assert.equal(document.querySelector("#pending-archives").textContent, "2");
    assert.equal(document.querySelector("#failed-archives").textContent, "1");
    assert.equal(document.querySelector("#processing-failures").hidden, false);
    assert.match(document.querySelector("#archive-errors").textContent, /broken.7z：invalid header data/);
    assert.equal(document.querySelector("#archive-summary").textContent, "归档 667 包 · 3.38 GiB · 30 卷");
    dom.window.fetch = async url => {
      if (url.endsWith("/processing-status")) throw new Error("offline status");
      return { ok: true, json: async () => ({ dates: [], evaluation: null }) };
    };
    document.querySelector("#refresh").click();
    await new Promise(setImmediate);
    assert.equal(document.querySelector("#processing-error").hidden, false);
    assert.equal(document.querySelector("#service-state").dataset.state, "online");
    assert.equal(document.querySelector("#failed-archives").textContent, "1");
  } finally { dom.window.close(); }
});

test("date rows paginate newest-first in groups of fourteen and clamp at the last page", async () => {
  const dates = Array.from({ length: 30 }, (_, index) =>
    new Date(Date.UTC(2026, 8, 1 + index)).toISOString().slice(0, 10)).reverse();
  const dom = await render("running", false, done, dates);
  try {
    const document = dom.window.document;
    const rowDates = () => [...document.querySelectorAll("#date-rows time")].map((time) => time.textContent);
    assert.equal(rowDates().length, 14);
    assert.deepEqual(rowDates(), dates.slice(0, 14));
    assert.equal(document.querySelector("#page-summary").textContent, "第 1–14 天 / 共 30 天 · 1 / 3 页");
    document.querySelector("#next-page").click();
    assert.deepEqual(rowDates(), dates.slice(14, 28));
    assert.equal(document.querySelector("#page-summary").textContent, "第 15–28 天 / 共 30 天 · 2 / 3 页");
    document.querySelector("#next-page").click();
    assert.deepEqual(rowDates(), dates.slice(28));
    assert.equal(document.querySelector("#next-page").disabled, true);
  } finally { dom.window.close(); }
});

test("completed historical pairs remain finished while other dates evaluate, pause or stop updating", async () => {
  for (const [status, stale, activeLabel] of [["running", false, "评测中"], ["running", true, "停更"], ["interrupted", false, "已中断"], ["finished", false, "仍有待评测项"]]) {
    const dom = await render(status, stale);
    try {
      const rows = [...dom.window.document.querySelectorAll("#date-rows tr")];
      for (const row of rows.slice(0, 4)) {
        assert.deepEqual([...row.querySelectorAll(".pair-status")].map(el => [el.textContent, el.dataset.status]), [["✅", "finished"], ["✅", "finished"]]);
      }
      assert.deepEqual([...rows[4].querySelectorAll(".pair-status")].map(el => el.textContent), [activeLabel, activeLabel]);
    } finally { dom.window.close(); }
  }
});

test("skipped-only, failed and incomplete pairs never receive a success marker", async () => {
  for (const [status, counts, expected] of [
    ["running", { ...done, completed_cases: 0, skipped_cases: 90 }, "无可评测样本"],
    ["finished", { ...done, completed_cases: 54, failed_cases: 1 }, "存在评测失败"],
    ["running", { ...done, completed_cases: 54, queued_cases: 1 }, "评测中"],
    ["finished", { ...done, completed_cases: 54 }, "仍有待评测项"],
    ["running", { total_cases: 0 }, "暂无进度"],
  ]) {
    const dom = await render(status, false, counts);
    try {
      const row = dom.window.document.querySelector("#date-rows tr");
      assert.match(row.textContent, new RegExp(expected));
      assert.equal(row.querySelector('[data-status="finished"]'), null);
    } finally { dom.window.close(); }
  }
});

test("quota labels and capped progress keep completed, running and queued battles within 300", async () => {
  const dom = await render("running", false, {
    total_cases: 980, completed_cases: 120, running_cases: 12, queued_cases: 820, failed_cases: 8, skipped_cases: 20,
  });
  try {
    const document = dom.window.document, cell = document.querySelector(".pair-cell");
    assert.deepEqual([...document.querySelectorAll(".pair-quota")].map(el => el.textContent),
      ["每天最多评测 300 次对战", "每天最多评测 300 次对战"]);
    assert.match(cell.textContent, /已完成 120 条/);
    assert.match(cell.textContent, /运行中 12 · 排队 168/);
    assert.match(cell.textContent, /其中失败待重试 8 条/);
    assert.match(cell.textContent, /超额未评测 660 条/);
  } finally { dom.window.close(); }
});

test("historical completions above quota survive and excess work does not remain queued", async () => {
  const dom = await render("running", false, {
    total_cases: 1002, completed_cases: 674, running_cases: 0, queued_cases: 220, failed_cases: 0, skipped_cases: 108,
  });
  try {
    const cell = dom.window.document.querySelector(".pair-cell");
    assert.match(cell.textContent, /历史已完成 674 条/);
    assert.equal(cell.querySelector(".pair-status").dataset.status, "finished");
    assert.equal(cell.querySelector(".active-counts"), null);
    assert.match(cell.textContent, /超额未评测 220 条/);
  } finally { dom.window.close(); }
});

test("dates below quota retain their actual eligible count without inventing queued battles", async () => {
  const dom = await render("running", false, {
    total_cases: 291, completed_cases: 38, running_cases: 2, queued_cases: 208, failed_cases: 1, skipped_cases: 42,
  });
  try {
    const cell = dom.window.document.querySelector(".pair-cell");
    assert.match(cell.textContent, /运行中 2 · 排队 209/);
    assert.equal(cell.querySelector(".quota-excluded"), null);
  } finally { dom.window.close(); }
});

// The 10/13 checkpoint is complete, but the current source has hundreds of new records.
test("new source rows revoke success for an old completed snapshot", async () => {
  for (const [completed, skipped, rows] of [[20, 2, 804], [22, 0, 818]]) {
    const counts = { total_cases: 22, completed_cases: completed, skipped_cases: skipped,
      running_cases: 0, queued_cases: 0, failed_cases: 0 };
    const dom = await render("interrupted", false, counts, ["2026-10-13"], rows);
    try {
      const cell = dom.window.document.querySelector(".pair-cell");
      assert.equal(cell.querySelector(".pair-status").textContent, "有新增待评测");
      assert.equal(cell.querySelector('[data-status="finished"]'), null);
      assert.equal(cell.querySelector(".active-counts"), null, "row counts cannot invent a matched task queue");
    } finally { dom.window.close(); }
  }
});

test("missing pairs below the daily quota remain waiting even when the other side catches up", async () => {
  const dom = await render("finished", false, { total_cases: 22, completed_cases: 20, skipped_cases: 2,
    running_cases: 0, queued_cases: 0, failed_cases: 0 }, ["2026-10-13"], 22);
  try {
    const cell = dom.window.document.querySelector(".pair-cell");
    assert.equal(cell.querySelector(".pair-status").textContent, "等待配对");
    assert.equal(cell.querySelector('[data-status="finished"]'), null);
  } finally { dom.window.close(); }
});

test("a fulfilled daily quota stays complete when more source rows arrive", async () => {
  const dom = await render("interrupted", false, { total_cases: 302, completed_cases: 300, skipped_cases: 2,
    running_cases: 0, queued_cases: 0, failed_cases: 0 }, ["2026-10-13"], 804);
  try {
    const status = dom.window.document.querySelector(".pair-status");
    assert.equal(status.textContent, "✅");
    assert.equal(status.title, "当日评测额度已完成");
  } finally { dom.window.close(); }
});


for (const [provider, models] of [["aime", ["aime_fast", "aime_expert"]], ["ifind", ["ifind_normal_agent", "ifind_deep_research"]]]) {
  test(`${provider} presents separate modes and real stage progress without battle rules`, async () => {
    const dom = new JSDOM(html.replaceAll("__BASE__", `/data/${provider}`), { url: `http://localhost/data/${provider}/`, runScripts: "outside-only" });
    const requests = [];
    dom.window.fetch = async url => {
      requests.push(url);
      if (url.endsWith("/processing-status")) return { ok: true, json: async () => processing };
      return { ok: true, json: async () => ({
        dates: [{ date: "2026-10-14", ready: true, models: { [models[0]]: { ready: true, row_count: 800 }, [models[1]]: { ready: false, row_count: 0 } } }],
        evaluation: { status: "running", stale: true, dates: [{ date: "2026-10-14", models: { [models[0]]: {
          criteria: { total: 800, completed: 799, pending: 0, running: 1, failed: 0, blocked: 0, cancelled: 0 },
          attribution: { total: 780, completed: 780, pending: 0, running: 0, failed: 0, blocked: 0, cancelled: 0 },
          clustering: { total: 8, completed: 6, pending: 1, running: 0, failed: 1, blocked: 0, cancelled: 0 },
        } } }] },
      }) };
    };
    dom.window.setInterval = () => 0;
    try {
      vm.runInContext(source.replace(/^export /gm, ""), dom.getInternalVMContext());
      await new Promise(setImmediate);
      const doc = dom.window.document;
      assert.deepEqual(requests, [`/data/${provider}/dashboard-data`, `/data/${provider}/processing-status`]);
      assert.deepEqual([...doc.querySelectorAll("thead th")].map(el => el.textContent.trim()), ["日期", "Fast", "Expert"]);
      assert.equal(doc.querySelectorAll(".stage-progress").length, 6);
      assert.equal(doc.querySelectorAll(".pair-quota,.gpt-pair-progress,.pair-status").length, 0);
      assert.equal(doc.querySelectorAll(".model-link").length, 1);
      assert.equal(doc.querySelector(".model-link").getAttribute("href"), "#samples");
      assert.match(doc.querySelector(".input-cell").textContent, /归因 · 已完成 780 \/ 780 任务 · 进度停更/);
      assert.match(doc.querySelector(".input-cell").textContent, /聚类 · 已完成 6 \/ 8 任务 · 排队 1 · 失败 1/);
      assert.doesNotMatch(doc.querySelector(".results-table").textContent, /对战|300|配对/);
      assert.match(doc.querySelectorAll(".input-cell")[1].textContent, /标准制定 · 暂无进度/);
    } finally { dom.window.close(); }
  });
}


test("session sample viewer keeps all rounds and scoped pagination", async () => {
  const recordsHtml = await readFile(new URL("records.html", import.meta.url), "utf8");
  const dom = new JSDOM(recordsHtml.replaceAll("__BASE__", "/data/aime"), {
    url: "http://localhost/data/aime/records?date=2026-10-18&model=aime_fast", runScripts: "outside-only",
  });
  const requests = [];
  dom.window.fetch = async url => {
    requests.push(url);
    return { ok: true, json: async () => ({ total: 21, items: [{ format: "session", session_id: "session-id", turns: [
      { question: "First question", answer: "First answer" },
      { question: "Second question", answer: "" },
      { question: "Third question", answer: "Third answer" },
    ] }] }) };
  };
  dom.window.scrollTo = () => {};
  try {
    vm.runInContext(recordsSource, dom.getInternalVMContext());
    await new Promise(setImmediate);
    const doc = dom.window.document;
    assert.equal(doc.querySelector(".session-title").textContent, "Session · 3 轮");
    assert.equal(doc.querySelectorAll(".session-turn").length, 3);
    assert.equal(doc.querySelectorAll(".answer-details[open]").length, 0);
    assert.deepEqual([...doc.querySelectorAll(".question-text")].map(el => el.textContent), ["First question", "Second question", "Third question"]);
    assert.match(doc.querySelector("#records-title").textContent, /aime Fast/);
    doc.querySelector("#next-page").click();
    await new Promise(setImmediate);
    assert.ok(requests.every(url => url.startsWith("/data/aime/records/2026-10-18/aime_fast?")));
    assert.match(requests[1], /page=2/);
  } finally { dom.window.close(); }
});


async function samplePage(items, clipboard, questionHeight = () => 18) {
  const recordsHtml = await readFile(new URL("records.html", import.meta.url), "utf8");
  const dom = new JSDOM(recordsHtml.replaceAll("__BASE__", "/data/ifind"), {
    url: "http://example.test/data/ifind/records?date=2026-10-14&model=ifind_normal_agent", runScripts: "outside-only",
  });
  dom.window.fetch = async () => ({ ok: true, json: async () => ({ total: items.length, items }) });
  if (clipboard) Object.defineProperty(dom.window.navigator, "clipboard", { value: clipboard });
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    clientHeight: { get() { return this.classList.contains("question-text") ? 18 : 0; } },
    scrollHeight: { get() { return this.classList.contains("question-text") ? questionHeight(this) : 0; } },
  });
  vm.runInContext(recordsSource, dom.getInternalVMContext());
  await new Promise(setImmediate);
  return dom;
}

const traceSample = { format: "trace", trace_id: "trace-123456789012345678901234567890", session_id: null, question: "Question", answer: "**Answer**" };

test("sample table separates formats and groups session rounds with full, copyable trace IDs", async () => {
  const copied = [];
  const dom = await samplePage([{ ...traceSample, session_id: "trace-session" }, { format: "session", session_id: "session-2", turns: [
    { ...traceSample, trace_id: "round-one", question: "First" },
    { ...traceSample, trace_id: "round-two", question: "Second" },
  ] }], { writeText: async value => copied.push(value) });
  try {
    const doc = dom.window.document;
    assert.deepEqual([...doc.querySelectorAll(".records-table > thead th")].map(el => el.textContent), ["序号", "格式 / 会话", "Trace ID", "问句", "回答"]);
    assert.equal(doc.querySelectorAll(".records-table > tbody").length, 2);
    assert.equal(doc.querySelector(".format-badge").textContent, "单 trace");
    assert.equal(doc.querySelector(".record-format").querySelector(".record-identifier"), null);
    assert.equal(doc.querySelector(".session-title").textContent, "Session · 2 轮");
    assert.equal(doc.querySelectorAll(".record-format")[1].rowSpan, 2);
    assert.equal(doc.querySelectorAll(".record-trace code")[0].textContent, traceSample.trace_id);
    assert.equal(doc.querySelectorAll(".record-trace code")[0].title, traceSample.trace_id);
    const button = doc.querySelector(".record-trace .copy-id");
    button.click(); await new Promise(setImmediate);
    assert.deepEqual(copied, [traceSample.trace_id]);
    assert.equal(button.textContent, "已复制");
    assert.equal(doc.querySelectorAll("details[open]").length, 0);
    assert.equal(doc.querySelectorAll(".answer-markdown").length, 3, "selected page answers are directly visible");
  } finally { dom.window.close(); }
});

test("HTTP sample viewer copies through a selected textarea and reports denied copies accurately", async () => {
  for (const [success, useApi] of [[true, false], [true, true], [false, false]]) {
    const clipboard = useApi ? { writeText: async () => { throw new Error("permission denied"); } } : undefined;
    const dom = await samplePage([traceSample], clipboard);
    try {
      const doc = dom.window.document, button = doc.querySelector(".record-trace .copy-id");
      let copied;
      doc.execCommand = command => {
        assert.equal(command, "copy");
        copied = doc.activeElement.value;
        return success;
      };
      button.focus(); button.click(); await new Promise(setImmediate);
      assert.equal(copied, traceSample.trace_id);
      assert.equal(button.textContent, success ? "已复制" : "复制失败");
      assert.equal(doc.activeElement, button);
      assert.equal(doc.querySelectorAll(".clipboard-field").length, 0);
    } finally { dom.window.close(); }
  }
});




test("answers directly render GFM tables, lists and code while blocking raw HTML and unsafe URLs", async () => {
  const answer = ["# Heading", "", "**Bold** and *italic* and ~~deleted~~. [Safe](https://example.com)", "",
    "| Stock | Score |", "| :--- | ---: |", "| A | 9 |", "", "> Quote", "", "1. First", "2. Second", "", "~~~js", "const x = '<script>';", "~~~", "",
    "<script>window.injected = true</script>", "", "<img src=x onerror=alert(1)>", "",
    "[Unsafe](javascript:alert%281%29) ![Blocked](data:text/html,script)"].join("\n");
  const dom = await samplePage([{ ...traceSample, answer, standard_answer: "**Reference**" }]);
  try {
    const doc = dom.window.document;
    assert.equal(doc.querySelector("details"), null);
    const content = doc.querySelector(".answer-markdown");
    assert.equal(content.querySelector("h1").textContent, "Heading");
    assert.equal(content.querySelector("strong").textContent, "Bold");
    assert.equal(content.querySelector("em").textContent, "italic");
    assert.equal(content.querySelector("del").textContent, "deleted");
    assert.equal(content.querySelectorAll("table > tbody > tr").length, 1);
    assert.equal(content.querySelectorAll("ol > li").length, 2);
    assert.match(content.querySelector("pre code").textContent, /<script>/);
    assert.equal(content.querySelectorAll("script,img,iframe,[onerror]").length, 0);
    assert.equal(content.querySelectorAll("a").length, 1);
    assert.equal(content.querySelector("a").rel, "noopener noreferrer");
    assert.equal(dom.window.injected, undefined);
    assert.equal(doc.querySelectorAll(".answer-markdown")[1].querySelector("strong").textContent, "Reference");
  } finally { dom.window.close(); }
});

test("post-training task shows exactly two original model labels and opens samples in place", async () => {
  const dom = new JSDOM(html, { url:"http://localhost/data/post_training_model/", runScripts:"outside-only" });
  const selections = [];
  dom.window.setInterval = () => 0;
  dom.window.fetch = async url => ({ ok:true, json:async () => url.endsWith('/processing-status') ? processing : {
    dates:[{ date:'2026-10-19', ready:true, models:{ b_fast:{ ready:true,row_count:720 }, b_post_train_fast:{ ready:true,row_count:745 } } }], evaluation:null,
  } });
  try {
    vm.runInContext(source.replace(/^export /gm, '').replace(/if \(globalThis\.document\?\.querySelector\("#dataset-range"\)\) \{[\s\S]*$/, ''), dom.getInternalVMContext());
    dom.window.mountData(dom.window.document, { dataset:'post_training_model', onSamples:selection => selections.push(selection) });
    await new Promise(setImmediate);
    const doc=dom.window.document;
    assert.equal(doc.querySelectorAll('thead th').length,2);
    assert.equal(doc.querySelector('.dataset-range-models').textContent,'2 个模型');
    assert.match(doc.querySelector('thead').textContent,/AA-fast.*AA-post_train_fast_V1/);
    const links=[...doc.querySelectorAll('#date-rows .model-link')];
    assert.equal(links.length,2);
    links[1].click();
    assert.deepEqual(JSON.parse(JSON.stringify(selections)),[{dataset:'post_training_model',profile:'post_training_model',date:'2026-10-19',model:'b_post_train_fast'}]);
    assert.equal(dom.window.location.pathname,'/data/post_training_model/');
    assert.equal(doc.querySelector('#total-rows').textContent,'1,465');
  } finally { dom.window.close(); }
});
