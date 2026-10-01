import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "../../fixtures/services.js";

const { JSDOM } = createRequire(import.meta.url)("jsdom");
const { createProblemBrowser } = await import(pathToFileURL(path.join(ROOT, "apps/host/dashboard/problems.js")).href);

function model(id: string, name: string, count = 1) {
  return { model: id, name, updated_at: "2026-10-01T01:00:00Z", totals: { components: 1, classes: count, occurrences: count * 2 }, merged: [], components: [{ id: `component-${id}`, label: "推理与验证", definition: "计算与判断", aliases: [], classes: Array.from({ length: count }, (_, index) => ({ id: `class-${id}-${index}`, label: index ? "答案缺少核对" : "计算存在错误", definition: index ? "未核对结果" : "计算结果不正确", aliases: index ? ["检查缺失"] : [], occurrences: 2, first_seen: null })) }] };
}
function detail(id: string, page = 1) {
  return { model: id, name: id, class: { id: `class-${id}-0`, label: "计算存在错误", definition: "计算结果不正确", aliases: [], status: "active", first_seen: null }, component: { id: `component-${id}`, label: "推理与验证", definition: "计算与判断" }, total: 51, page, page_size: 50, lineage: [{ id: "old", label: "旧类", into: `class-${id}-0`, into_label: "计算存在错误", reason: "同义" }], occurrences: [true, false].map((available, index) => ({ id: `occurrence-${index}`, run_id: "run-1", batch_id: "batch-1", case_id: `case-${index}`, version: id, evaluator_version: "r52", finding_id: "f0", evidence_status: index ? "uncertain" : "established", message_index: 3, quote: index ? "待核实证据" : "确认的证据", source: { file: "/data/2026-10-01.jsonl", line: index + 1 }, classification: "assigned", previous_class_id: null, at: "2026-10-01T01:00:00Z", recall: { available, reason: available ? null : "run_missing", url: available ? "/?run=run-1&batch=batch-1&case=case-0&task=task-1&finding=f0" : null, attribution_task_id: available ? "task-1" : null } })) };
}
async function page(respond: (url: string) => unknown) {
  const dom = new JSDOM(await readFile(path.join(ROOT, "apps/host/dashboard/problems.html"), "utf8"), { url: "http://127.0.0.1:4173/problems" });
  const browser = createProblemBrowser(dom.window.document, async (url: string) => {
    const value = await respond(url);
    return value instanceof Response ? value : new Response(JSON.stringify(value));
  });
  return { ...browser, dom, document: dom.window.document };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("problem browser keeps four model tabs and searchable model/component/class hierarchy", async () => {
  const models = [model("af", "A组Fast", 2), model("ae", "A组Expert"), model("bf", "B组Fast"), model("be", "B组Expert", 0)];
  const view = await page((url) => url === "/api/dashboard/library" ? models : detail("af"));
  try {
    await view.load();
    assert.deepEqual([...view.document.querySelectorAll("[role=tab]")].map((tab) => tab.textContent.split(" 问题类")[0]), ["A组Fast2", "A组Expert1", "B组Fast1", "B组Expert0"]);
    assert.equal(view.document.querySelectorAll("[role=tab][aria-selected=true]").length, 1);
    view.setSearch("检查缺失");
    assert.equal(view.document.querySelectorAll("[aria-level='1']").length, 1);
    assert.equal(view.document.querySelectorAll("[aria-level='2']").length, 1);
    assert.equal(view.document.querySelectorAll("[aria-level='3']").length, 1);
    assert.match(view.document.querySelector("[aria-level='3']").textContent, /答案缺少核对/);
    assert.equal(view.document.querySelector("#problem-tree-result").textContent, "1 个匹配问题类");
    await view.selectModel("be");
    assert.equal(view.state.detail, null);
    assert.match(view.document.querySelector("#problem-detail").textContent, /暂无问题类/);
  } finally { view.dom.window.close(); }
});

test("problem tree offers roving focus and left/right keyboard expansion", async () => {
  const view = await page((url) => url === "/api/dashboard/library" ? [model("af", "A组Fast", 2)] : detail("af"));
  try {
    await view.load();
    const leaf = view.document.querySelector("[aria-level='3']");
    leaf.focus();
    leaf.dispatchEvent(new view.dom.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    assert.equal(view.document.activeElement.dataset.nodeKind, "component");
    view.document.activeElement.dispatchEvent(new view.dom.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    assert.equal(view.document.querySelectorAll("[aria-level='3']").length, 0);
    assert.equal(view.document.activeElement.getAttribute("aria-expanded"), "false");
    view.document.activeElement.dispatchEvent(new view.dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    assert.equal(view.document.querySelectorAll("[aria-level='3']").length, 2);
    view.document.activeElement.dispatchEvent(new view.dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    assert.equal(view.document.activeElement.dataset.nodeKind, "class");
    assert.equal(view.document.querySelectorAll("#problem-tree [tabindex='0']").length, 1);
  } finally { view.dom.window.close(); }
});

test("problem samples expose working recall links, unavailable reasons, provenance and pagination", async () => {
  const calls: string[] = [];
  const view = await page((url) => { calls.push(url); return url === "/api/dashboard/library" ? [model("af", "A组Fast")] : detail("af", url.endsWith("page=2") ? 2 : 1); });
  try {
    await view.load();
    const link = view.document.querySelector(".occurrence-recall");
    assert.equal(link.getAttribute("href"), "/?run=run-1&batch=batch-1&case=case-0&task=task-1&finding=f0");
    assert.equal(view.document.querySelectorAll(".occurrence-recall").length, 1);
    assert.match(view.document.querySelector(".occurrence-unavailable").textContent, /不可召回.*运行已删除/);
    assert.match(view.document.querySelector(".occurrence-origin dl").textContent, /\/data\/2026-10-01.jsonl:1.*run-1.*f0/);
    assert.equal(view.document.querySelector(".problem-recall-count").textContent, "本页可召回 1 / 2");
    assert.match(view.document.querySelector(".problem-lineage").textContent, /旧类.*计算存在错误.*同义/);
    view.document.querySelector("[data-page='2']").click();
    await settle();
    assert(calls.includes("/api/dashboard/library/af/classes/class-af-0?page=2"));
    assert.equal(view.state.detail.page, 2);
    assert.equal(view.document.activeElement.tagName, "H1", "pagination retains keyboard position in the loaded detail");
  } finally { view.dom.window.close(); }
});

test("switching models discards a late class response and class errors can retry", async () => {
  let resolveFirst: (value: unknown) => void = () => {}, delay = false, fail = false;
  const view = await page((url) => {
    if (url === "/api/dashboard/library") return [model("af", "A组Fast"), model("ae", "A组Expert")];
    if (fail) return new Response(JSON.stringify({ error: "库文件不可读" }), { status: 500 });
    if (delay && url.includes("/af/")) return new Promise((resolve) => { resolveFirst = resolve; });
    return detail(url.includes("/ae/") ? "ae" : "af");
  });
  try {
    await view.load();
    delay = true;
    const first = view.loadClass("class-af-0");
    await view.selectModel("ae");
    resolveFirst(detail("af"));
    await first;
    assert.equal(view.state.detail.model, "ae");
    fail = true;
    await view.loadClass("class-ae-0");
    assert.equal(view.document.querySelector("#problem-detail").getAttribute("aria-busy"), "false");
    assert.match(view.document.querySelector(".problem-detail-error").textContent, /库文件不可读/);
    fail = false;
    view.document.querySelector("[data-retry-class]").click();
    await settle();
    assert.equal(view.state.detail.model, "ae");
  } finally { view.dom.window.close(); }
});
