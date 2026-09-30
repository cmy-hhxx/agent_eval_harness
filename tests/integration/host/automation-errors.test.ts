import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { automationErrors } from "../../../apps/host/src/automation-errors.js";
import type { AutomationState } from "@eval/automations";
import { ROOT } from "../../fixtures/services.js";

const { JSDOM } = createRequire(import.meta.url)("jsdom");
test("automation errors retain every raw record without grouping, page full details and poll appended records only", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "automation-errors-")), file = path.join(directory, "runtime.log");
  const now = Date.now(), date = "2026-09-30", runId = "daily-" + date;
  const state: AutomationState = { id: "test", sourceUrl: "http://test", status: "stopped", startedAt: now, updatedAt: now, jobs: {
    [date]: { date, runIds: [runId], observed: { a_fast: 1, a_expert: 1, b_fast: 1, b_expert: 1 }, adopted: false,
      download: "ready", evaluation: "retry", checkedAt: now, downloadAttempts: 0, evaluationAttempts: 1, nextDownloadAt: 0, nextEvaluationAt: 0 },
  } };
  const records = Array.from({ length: 12 }, (_, index) => ({ level: "error", time: new Date(now + index).toISOString(),
    component: "host", event: "attempt_failed", run_id: runId, task_id: "task-" + index, attempt_id: "attempt-" + index,
    stage: "attribution", message: `invalid evidence in task ${index}`, stack: "complete stack\nsecond line",
    errors: [{ category: "evidence", code: "evidence_id_invalid", path: "/findings/0/evidence", expected: "source-id", actual: "invented", message: "具体原因" }] }));
  const errorLog = automationErrors(file, () => state);
  try {
    await writeFile(file, [...records, { ...records[0], run_id: "unrelated" }, { ...records[0], level: "info" }].map(row => JSON.stringify(row)).join("\n") + "\n");
    const first = await errorLog(new URLSearchParams());
    assert.equal(first.total, 12); assert.equal(first.records.length, 10);
    assert.deepEqual(first.records[0].record, records[11]);
    assert.equal("groups" in first, false);
    const query = new URLSearchParams({ page: "2", date });
    const second = await errorLog(query);
    assert.equal(second.records.length, 2); assert.equal(second.page, 2);
    assert.equal(second.records[0].record.task_id, "task-1");
    assert.deepEqual(second.records[0].record.errors, records[1].errors);
    assert.equal(second.records[0].record.stack, records[1].stack);
    await appendFile(file, JSON.stringify({ ...records[0], event: "task_failed", stage: "rewrite", message: "timeout", errors: [] }) + "\n");
    const appended = await errorLog(new URLSearchParams());
    assert.equal(appended.total, 13); assert.equal(appended.records[0].record.message, "timeout");
    assert.equal((await errorLog(new URLSearchParams())).total, 13);
    await assert.rejects(errorLog(new URLSearchParams({ page: "0" })), /filter/);
    await assert.rejects(errorLog(new URLSearchParams({ date: "unknown" })), /date/);
    await writeFile(file, ""); assert.equal((await errorLog(new URLSearchParams())).total, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("error page keeps expanded details and pagination during refresh, escapes content, and retains the last page offline", async () => {
  const html = await readFile(path.join(ROOT, "apps/host/dashboard/automation-errors.html"), "utf8");
  const script = await readFile(path.join(ROOT, "apps/host/dashboard/automation-errors.js"), "utf8");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://fixture/errors" });
  let poll = async () => {}, failed = false;
  const requests: URLSearchParams[] = [];
  dom.window.setTimeout = (callback: () => Promise<void>) => { poll = callback; return 1; };
  dom.window.clearTimeout = () => {};
  dom.window.fetch = async (url: string) => {
    if (failed) throw new Error("offline");
    const query = new URL(url, "http://fixture").searchParams; requests.push(query);
    return { ok: true, json: async () => ({ sampledAt: Date.now(), dates: ["2026-09-30"], pageSize: 10,
      page: Number(query.get("page")), total: 12,
      records: [{ id: 3, date: "2026-09-30", record: { message: '<img src=x onerror="alert(1)">', errors: [{ code: "evidence_id_invalid", actual: "invented" }] } }],
    }) };
  };
  const settle = () => new Promise(resolve => setImmediate(resolve));
  try {
    dom.window.eval(script); await settle();
    const doc = dom.window.document;
    assert.equal(doc.getElementById("error-records").hidden, false);
    assert.equal(doc.querySelector("[data-group]"), null);
    assert.equal(doc.querySelector("img"), null);
    doc.querySelector("details").open = true;
    assert.match(doc.querySelector("pre").textContent, /evidence_id_invalid.*\n/);
    await poll(); assert.equal(doc.querySelector("details").open, true);
    doc.getElementById("next").click(); await settle();
    await poll(); assert.equal(requests.at(-1)!.get("page"), "2");
    failed = true; await poll(); assert.match(doc.getElementById("connection-error").textContent, /offline/);
    assert.match(doc.querySelector("pre").textContent, /invented/);
    failed = false;
    doc.getElementById("date-filter").value = "2026-09-30";
    doc.getElementById("date-filter").dispatchEvent(new dom.window.Event("change")); await settle();
    assert.equal(requests.at(-1)!.get("page"), "1");
    assert.equal(requests.at(-1)!.get("date"), "2026-09-30");
    assert.equal(requests.at(-1)!.has("group"), false);
  } finally { dom.window.close(); }
});
