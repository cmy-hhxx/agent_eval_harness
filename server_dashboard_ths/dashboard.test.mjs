import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { JSDOM } from "jsdom";

const html = await readFile(new URL("dashboard.html", import.meta.url), "utf8");
const source = await readFile(new URL("dashboard.js", import.meta.url), "utf8");
const done = { total_cases: 90, completed_cases: 90, running_cases: 0, queued_cases: 0, failed_cases: 0, skipped_cases: 0 };

async function render(status, stale = false, counts = done, catalogDates = null, sourceRows = counts.total_cases) {
  const dom = new JSDOM(html, { url: "http://localhost/", runScripts: "outside-only" });
  const dates = catalogDates || ["2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-30", "2026-10-08"];
  const active = { ...done, completed_cases: 10, running_cases: 1, queued_cases: 79 };
  dom.window.fetch = async () => ({ ok: true, json: async () => ({
    dates: dates.map(date => ({ date, ready: true, models: Object.fromEntries(["a_fast", "b_fast", "a_expert", "b_expert"].map(id => [id, { ready: true, row_count: sourceRows }])) })),
    evaluation: { status, stale, dates: dates.map(date => ({ date, pairs: {
      fast: date === "2026-09-30" ? active : counts,
      expert: date === "2026-09-30" ? active : counts,
    } })) },
  }) });
  dom.window.setInterval = () => 0;
  vm.runInContext(source, dom.getInternalVMContext());
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
    assert.match(cell.textContent, /660 条超过评测配额，不评测/);
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
    assert.match(cell.textContent, /220 条超过评测配额，不评测/);
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
