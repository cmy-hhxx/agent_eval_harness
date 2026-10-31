import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeJsonl, readJsonl } from "./files.js";
import { businessDate, createBusinessPublisher, readBusinessResults, type BusinessResult } from "./business-results.js";

test("business dates use complete batch dates without interpreting request timestamps", () => {
  assert.equal(businessDate("2026-10-26"), "2026-10-26");
  assert.equal(businessDate("2024-02-29"), "2024-02-29");
  for (const value of ["2026-02-29", "2026-10-26T00:00:00Z", "20261026", "daily-production-20261029", "2026-13-01"])
    assert.throws(() => businessDate(value));
});

test("business publication keeps the latest complete verdict and can repair a missing delivery", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "business-results-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const publish = createBusinessPublisher(root);
  const record = (run: string, acceptedAt: number, complete = true): Omit<BusinessResult, "line" | "published"> => ({
    id: "same-answer", date: "2026-10-26", file: "aime_fast/aime_fast_attribution-2026-10-26.jsonl", stage: "attribution-session", scope: {},
    answers: [{ id: "answer-uuid", batch: "2026-10-26", caseId: "case", model: "aime_fast", session: "session",
      traces: ["trace"], source: "/source/input.jsonl", line: 1 }], acceptedAt, evaluatorVersion: "old", judge: "judge", submissionId: run, complete,
    origin: { run: path.join(root, run), taskId: run, reference: { id: run, file: "attribution.jsonl", line: 1 } },
  });
  const older = { session_summary: "早期判词" }, newer = { session_summary: "最新判词" };
  for (const [name, row] of [["old-run", older], ["new-run", newer]] as const)
    await writeJsonl(path.join(root, name, "results", "attribution.jsonl"), [row]);
  await publish(record("old-run", 1), older);
  await publish(record("new-run", 2), newer);
  await publish(record("old-run", 3, false), older);
  const file = path.join(root, "aime_fast/aime_fast_attribution-2026-10-26.jsonl");
  const rows = async () => { const result = []; for await (const row of readJsonl(file)) result.push(row); return result; };
  assert.deepEqual(await rows(), [newer]);
  await rm(file);
  await createBusinessPublisher(root)(record("new-run", 2), newer);
  assert.deepEqual(await rows(), [newer]);
  const provenance = await readBusinessResults(root);
  assert(provenance.some(entry => entry.origin.taskId === "old-run"));
  assert(provenance.some(entry => entry.origin.taskId === "new-run" && entry.published));
  assert(provenance.every(entry => !Object.hasOwn(entry.origin.reference, "row")), "provenance never duplicates verdict bodies");
});

test("organized existing rows are indexed in place and unrelated unindexed rows survive replacement", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "organized-results-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "aime_fast/aime_fast_attribution-2026-10-26.jsonl");
  const original = { session_summary: "已有判词" }, unrelated = { session_summary: "尚未核实的另一条原结果" };
  await writeJsonl(file, [original, unrelated]);
  const run = path.join(root, "original-run");
  await writeJsonl(path.join(run, "results/attribution.jsonl"), [original]);
  const record: Omit<BusinessResult, "line" | "published"> = { id: "answer", date: "2026-10-26",
    file: "aime_fast/aime_fast_attribution-2026-10-26.jsonl", stage: "attribution-session", scope: {}, answers: [],
    acceptedAt: 1, evaluatorVersion: "old", judge: "judge", submissionId: "first", complete: true,
    origin: { run, taskId: "task", reference: { id: "task", file: "attribution.jsonl", line: 1 } } };
  const publish = createBusinessPublisher(root);
  await assert.rejects(publish(record, original), /缺少可核实的整理映射/);
  await publish(record, original, false, 1);
  const nextRun = path.join(root, "next-run"), latest = { session_summary: "最新判词" };
  await writeJsonl(path.join(nextRun, "results/attribution.jsonl"), [latest]);
  await publish({ ...record, acceptedAt: 2, submissionId: "second", origin: { ...record.origin, run: nextRun } }, latest);
  const rows = []; for await (const row of readJsonl(file)) rows.push(row);
  assert.deepEqual(rows, [latest, unrelated]);
});
