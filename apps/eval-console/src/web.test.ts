import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

const task = (index: number, status = "draft", source = "wencai") => ({
  id: "console-00000000-0000-4000-8000-" + String(index).padStart(12, "0"), name: "任务" + index, source, status,
  createdAt: "2026-11-02T08:00:00Z", concurrency: 2, output: "/outputs", inputDirectory: "/inputs", batchId: "search_eval",
  inputs: [{ name: "Fast 搜索", paths: ["/inputs/day-one/fast.jsonl", "/inputs/day-two/fast.jsonl"] }], logs: ["/logs/runtime.log"],
  dataCheck: { status: "ready", files: 2, bytes: 200, elapsedMs: 1, readRecords: 4, total: 2, skipped: 0, pending: 2,
    invalidRecords: 0, unavailable: 0, issues: [], unit: "场对比", destinations: [
      "/outputs/comparison/a_fast_vs_b_fast/a_fast_vs_b_fast-search_eval.jsonl", "/outputs/criteria/criteria-search_eval.jsonl",
    ] },
});
async function until(condition: () => boolean) {
  for (let i = 0; i < 100; i++) { if (condition()) return; await new Promise(resolve => setImmediate(resolve)); }
  assert.fail("UI did not reach the expected state");
}
async function view(t: TestContext) {
  const [html, script] = await Promise.all(["index.html", "console.js"].map(file =>
    readFile(new URL("../../../../apps/eval-console/web/" + file, import.meta.url), "utf8")));
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://console.test" });
  t.after(() => dom.window.close());
  const { window } = dom, document = window.document;
  const fixture = { tasks: [task(1), task(2, "finished"), task(3, "running"), task(4, "draft", "aime")],
    failing: new Set<string>(), deletes: [] as string[], confirm: true, prompts: [] as string[], created: [] as { parent: string; name: string }[] };
  window.setInterval = () => 1;
  window.confirm = message => { fixture.prompts.push(String(message)); return fixture.confirm; };
  window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  window.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); this.dispatchEvent(new window.Event("close")); };
  window.fetch = (async (source: string, init?: RequestInit) => {
    const url = new URL(source, "http://console.test"), stats = { files: 2, records: 42, pendingFiles: 0, checkedAt: "2026-11-02T08:00:00Z" };
    if (url.pathname.endsWith("/delete")) {
      const id = url.pathname.split("/")[3]; fixture.deletes.push(id);
      if (fixture.failing.has(id)) return Response.json({ error: "删除失败，请重试" }, { status: 500 });
      fixture.tasks = fixture.tasks.filter(item => item.id !== id); return Response.json({ deleted: true });
    }
    if (url.pathname === "/api/tasks") return Response.json(fixture.tasks);
    if (url.pathname === "/api/presets") return Response.json([{
      id: "wencai", source: "wencai", name: "问财", inputDirectory: "/inputs", output: "/outputs", concurrency: 2,
    }]);
    if (url.pathname === "/api/directories") {
      if (init?.method === "POST") {
        const value = JSON.parse(String(init.body)); fixture.created.push(value);
        return Response.json({ path: value.parent + "/" + value.name });
      }
      const input = url.searchParams.get("kind") === "input", current = url.searchParams.get("path") || "/";
      const folder = (name: string, base = current) => ({ name, path: base.replace(/\/$/, "") + "/" + name, kind: "directory", stats: input ? stats : undefined });
      const entries = current === "/" ? [folder("inputs"), folder("outputs")] : current === "/inputs" ? [folder(".archive"), folder("search"),
        { name: "raw.jsonl", path: "/inputs/raw.jsonl", kind: "file", bytes: 200, records: 42 }] : current === "/outputs" ? [folder("existing")] : [];
      return Response.json({ root: "/", path: current, parent: current === "/" ? null : current.slice(0, current.lastIndexOf("/")) || "/", refreshing: false, stats: input ? stats : undefined, entries });
    }
    return Response.json({ error: "Unexpected request " + source }, { status: 404 });
  }) as typeof window.fetch;
  window.eval(script);
  await until(() => document.querySelectorAll("#task-list tr").length === 3);
  const click = (selector: string) => { const element = document.querySelector<HTMLElement>(selector); assert(element, selector); element.click(); };
  return { fixture, document, window, click };
}

test("bulk deletion protects running tasks, reports partial failures and retains failed selections", async t => {
  const { fixture, document, click } = await view(t);
  fixture.failing.add(fixture.tasks[1].id);
  assert.equal(document.querySelectorAll<HTMLInputElement>(".task-select:disabled").length, 1);
  click("#select-all"); assert.match(document.querySelector("#selection-count")!.textContent!, /已选 2/);
  click("#delete-selected");
  await until(() => fixture.deletes.length === 2 && document.querySelector("#task-error")!.textContent!.includes("1 项未删除"));
  assert.deepEqual(fixture.deletes, [task(1).id, task(2).id]);
  assert.match(fixture.prompts[0], /2 个任务/);
  assert.equal(document.querySelectorAll("#task-list tr").length, 2);
  assert.equal(document.querySelectorAll(".task-select:checked").length, 1);
  fixture.failing.clear(); click("#delete-selected");
  await until(() => document.querySelectorAll("#task-list tr").length === 1);
  assert.match(document.querySelector("#selection-count")!.textContent!, /已选 0/);
});

test("cancelled deletion sends no request and switching sources clears selection", async t => {
  const { fixture, document, click } = await view(t);
  fixture.confirm = false; click("#select-all"); click("#delete-selected");
  assert.equal(fixture.deletes.length, 0);
  click('[data-source="aime"]');
  assert.match(document.querySelector("#selection-count")!.textContent!, /已选 0/);
  assert.equal(document.querySelectorAll("#task-list tr").length, 1);
});

test("path previews group models and output folders; folder selection shows indexed archive counts", async t => {
  const { document, click } = await view(t);
  click(".task-title");
  assert.match(document.querySelector("#preview-summary .path-root code")!.textContent!, /\/inputs/);
  assert.match(document.querySelector("#preview-summary .file-group summary")!.textContent!, /Fast 搜索/);
  const files = [...document.querySelectorAll("#preview-summary .file-list code")].map(item => item.textContent);
  assert(files.includes("day-one/fast.jsonl")); assert(files.includes("day-two/fast.jsonl"));
  assert(files.includes("a_fast_vs_b_fast-search_eval.jsonl")); assert(files.includes("criteria-search_eval.jsonl"));
  assert.match(document.querySelector("#preview-summary")!.textContent!, /对比结果 · a_fast_vs_b_fast/);
  click("#close-create"); click("#new-task");
  assert.equal(document.querySelector<HTMLInputElement>("#batch-id")!.value, "");
  click("#choose-input"); await until(() => document.querySelectorAll(".folder-option").length === 3);
  assert.match(document.querySelector("#folder-list")!.textContent!, /42 条/);
  assert.match(document.querySelector("#folder-list")!.textContent!, /\.archive/);
  click('.folder-option[data-path="/inputs/.archive"] .folder-name');
  assert.equal(document.querySelector<HTMLTextAreaElement>("#input-directory")!.value, "/inputs", "single-click selects without committing the form");
  click('#use-folder');
  assert.equal(document.querySelector<HTMLTextAreaElement>("#input-directory")!.value, "/inputs/.archive");
  assert.match(document.querySelector("#input-folder-stats")!.textContent!, /42 条输入/);
  click("#choose-output"); await until(() => document.querySelectorAll(".folder-option").length === 1);
  click(".folder-option .folder-name"); click("#use-folder");
  assert.equal(document.querySelector<HTMLTextAreaElement>("#output")!.value, "/outputs/existing");
});

test("filesystem navigation supports double-click, history, breadcrumbs, address jumps and file protection", async t => {
  const { document, window, click } = await view(t);
  click('#new-task'); click('#choose-input');
  await until(() => document.querySelectorAll('.folder-option').length === 3);
  click('.folder-option[data-path="/inputs/raw.jsonl"] .folder-name');
  assert.equal(document.querySelector<HTMLButtonElement>('#use-folder')!.disabled, true);
  document.querySelector('.folder-option[data-path="/inputs/.archive"]')!.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
  await until(() => document.querySelector<HTMLInputElement>('#folder-location')!.value === '/inputs/.archive');
  click('#folder-back'); await until(() => document.querySelector<HTMLInputElement>('#folder-location')!.value === '/inputs');
  click('#folder-forward'); await until(() => document.querySelector<HTMLInputElement>('#folder-location')!.value === '/inputs/.archive');
  const crumb = [...document.querySelectorAll<HTMLButtonElement>('#folder-breadcrumbs button')].find(item => item.textContent === 'inputs')!;
  crumb.click(); await until(() => document.querySelector<HTMLInputElement>('#folder-location')!.value === '/inputs');
  document.querySelector<HTMLInputElement>('#folder-location')!.value = '/inputs/search';
  document.querySelector('#folder-location-form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => document.querySelector<HTMLInputElement>('#folder-location')!.value === '/inputs/search' && document.querySelector('#folder-selected')!.textContent === '/inputs/search');
  click('#use-folder'); assert.equal(document.querySelector<HTMLTextAreaElement>('#input-directory')!.value, '/inputs/search');
});

test("output folder creation uses the current filesystem location and can be selected immediately", async t => {
  const { document, window, fixture, click } = await view(t);
  click('#new-task'); click('#choose-output');
  await until(() => document.querySelector<HTMLInputElement>('#folder-location')!.value === '/outputs');
  click('#new-folder'); document.querySelector<HTMLInputElement>('#new-folder-name')!.value = '新结果';
  document.querySelector('#new-folder-form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => document.querySelector('#folder-selected')!.textContent === '/outputs/新结果');
  assert.equal(fixture.created[0].parent, '/outputs'); assert.equal(fixture.created[0].name, '新结果');
  click('#use-folder'); assert.equal(document.querySelector<HTMLTextAreaElement>('#output')!.value, '/outputs/新结果');
});
