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

test("a journaled result whose row write was interrupted is rebuilt before the next publication", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "business-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "aime_fast/aime_fast_attribution-2026-10-26.jsonl"), journal = path.join(root, ".delivery/provenance/2026-10-26.jsonl");
  const first = { session_summary: "已完成判词" }, interrupted = { session_summary: "中断前已入索引" }, next = { session_summary: "下一条判词" };
  const record = (id: string, run: string, acceptedAt: number): Omit<BusinessResult, "line" | "published"> => ({
    id, date: "2026-10-26", file: "aime_fast/aime_fast_attribution-2026-10-26.jsonl", stage: "attribution-session", scope: {}, answers: [],
    acceptedAt, evaluatorVersion: "r513", judge: "judge", submissionId: id, complete: true,
    origin: { run: path.join(root, run), taskId: id, reference: { id, file: "attribution.jsonl", line: 1 } },
  });
  for (const [run, row] of [["first-run", first], ["interrupted-run", interrupted], ["next-run", next]] as const)
    await writeJsonl(path.join(root, run, "results/attribution.jsonl"), [row]);
  const publish = createBusinessPublisher(root);
  await publish(record("first", "first-run", 1), first);
  const saved = []; for await (const entry of readJsonl(journal)) saved.push(entry);
  await writeJsonl(journal, [...saved, { ...record("interrupted", "interrupted-run", 2), line: 2, published: false }]);
  await publish(record("next", "next-run", 3), next);
  const rows = []; for await (const row of readJsonl(file)) rows.push(row);
  assert.deepEqual(rows, [first, interrupted, next]);
  const provenance = await readBusinessResults(root);
  assert(provenance.some(entry => entry.id === "interrupted" && entry.published), "the rebuilt row is journalled as published");
  assert(provenance.some(entry => entry.id === "next" && entry.published));
});

test("an unresolved comparison refresh preserves its old artifact and appends once to unified delivery", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "comparison-delivery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const record: Omit<BusinessResult, "line" | "published"> = {
    id: "unresolved", date: "2026-10-26", file: "review/pair.jsonl", stage: "comparison", scope: {}, answers: [],
    acceptedAt: 1, evaluatorVersion: "fixture", judge: "judge", submissionId: "accepted", complete: false,
    origin: { run: path.join(root, "run"), taskId: "comparison", reference: { id: "comparison", file: "comparison-review.jsonl", line: 1 } },
  };
  const original = { reason: "缺少决定性信息" }, rewritten = { reason: "无法判定：两个模型都缺少用于核实结论的数据。" };
  const publish = createBusinessPublisher(root);
  await publish(record, original);
  const unified = { ...record, file: "comparison/pair.jsonl",
    origin: { ...record.origin, reference: { id: "comparison", file: "comparison.jsonl", line: 1 } } };
  await publish({ ...unified, id: "other", submissionId: "other", complete: true }, { reason: "已有另一对局" });
  await assert.rejects(publish({ ...unified, submissionId: "different" }, rewritten, true), /不同交付文件/);
  await publish(unified, rewritten, true);
  await createBusinessPublisher(root)(unified, rewritten, true);
  const rows = []; for await (const row of readJsonl(path.join(root, unified.file))) rows.push(row);
  assert.deepEqual(rows, [{ reason: "已有另一对局" }, rewritten]);
  const old = []; for await (const row of readJsonl(path.join(root, record.file))) old.push(row);
  assert.deepEqual(old, [original]);
  const provenance = (await readBusinessResults(root)).filter(entry => entry.id === record.id);
  assert.equal(provenance.at(-1)?.line, 2);
  assert(provenance.every(entry => entry.submissionId === record.submissionId && entry.acceptedAt === record.acceptedAt));
  await assert.rejects(publish({ ...unified, id: "other", submissionId: "other", complete: true, file: "elsewhere.jsonl" }, rewritten, true), /不同交付文件/);
});

test("a publication batch appends every accepted row and replaces a verdict in place", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "business-batch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const record = (id: string, acceptedAt: number, submission = id): Omit<BusinessResult, "line" | "published"> => ({
    id, date: "2026-10-26", file: "aime_fast/aime_fast_attribution-2026-10-26.jsonl", stage: "attribution-session", scope: {},
    answers: [{ id: `answer-${id}`, batch: "2026-10-26", caseId: "case", model: "aime_fast", session: "session",
      traces: ["trace"], source: "/source/input.jsonl", line: 1 }],
    acceptedAt, evaluatorVersion: "r513", judge: "judge", submissionId: submission, complete: true,
    origin: { run: path.join(root, `run-${submission}`), taskId: id, reference: { id, file: "attribution.jsonl", line: 1 } },
  });
  const file = path.join(root, "aime_fast/aime_fast_attribution-2026-10-26.jsonl");
  const rows = async () => { const result = []; for await (const row of readJsonl(file)) result.push(row); return result; };
  for (const id of ["a", "b", "b2", "c", "d"]) await writeJsonl(path.join(root, `run-${id}`, "results", "attribution.jsonl"),
    [{ session_summary: id.toUpperCase() }]);
  const publish = createBusinessPublisher(root);
  await publish.many([
    { record: record("a", 1), row: { session_summary: "A" } },
    { record: record("b", 1), row: { session_summary: "B" } },
    { record: record("c", 1), row: { session_summary: "C" } },
  ]);
  assert.deepEqual(await rows(), [{ session_summary: "A" }, { session_summary: "B" }, { session_summary: "C" }]);
  await publish.many([
    { record: record("b", 2, "b2"), row: { session_summary: "B2" } },
    { record: record("d", 2), row: { session_summary: "D" } },
  ]);
  assert.deepEqual(await rows(), [{ session_summary: "A" }, { session_summary: "B2" }, { session_summary: "C" }, { session_summary: "D" }]);
  const provenance = new Map((await readBusinessResults(root)).map(entry => [entry.id, entry]));
  assert.deepEqual([...provenance.values()].filter(entry => entry.published).map(entry => [entry.id, entry.line]).sort(),
    [["a", 1], ["b", 2], ["c", 3], ["d", 4]]);
});

test("a publication batch rebuilds a journaled row the delivery file never received", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "business-batch-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const record = (id: string, acceptedAt: number): Omit<BusinessResult, "line" | "published"> => ({
    id, date: "2026-10-26", file: "aime_fast/aime_fast_attribution-2026-10-26.jsonl", stage: "attribution-session", scope: {},
    answers: [{ id: `answer-${id}`, batch: "2026-10-26", caseId: "case", model: "aime_fast", session: "session",
      traces: ["trace"], source: "/source/input.jsonl", line: 1 }],
    acceptedAt, evaluatorVersion: "r513", judge: "judge", submissionId: id, complete: true,
    origin: { run: path.join(root, `run-${id}`), taskId: id, reference: { id, file: "attribution.jsonl", line: 1 } },
  });
  const file = path.join(root, "aime_fast/aime_fast_attribution-2026-10-26.jsonl");
  const journal = path.join(root, ".delivery/provenance/2026-10-26.jsonl");
  for (const id of ["a", "b", "c"]) await writeJsonl(path.join(root, `run-${id}`, "results", "attribution.jsonl"),
    [{ session_summary: id.toUpperCase() }]);
  const publish = createBusinessPublisher(root);
  await publish.many([{ record: record("a", 1), row: { session_summary: "A" } }]);
  await publish(record("b", 2), { session_summary: "B" });
  // Crash between journaling the second result and appending its delivery row.
  const saved = []; for await (const entry of readJsonl(journal)) saved.push(entry);
  await writeJsonl(journal, saved.filter(entry => !((entry as { id: string; published: boolean }).id === "b" &&
    (entry as { published: boolean }).published)));
  await writeJsonl(file, [{ session_summary: "A" }]);
  await publish.many([{ record: record("c", 3), row: { session_summary: "C" } }]);
  const rows = []; for await (const row of readJsonl(file)) rows.push(row);
  assert.deepEqual(rows, [{ session_summary: "A" }, { session_summary: "B" }, { session_summary: "C" }]);
  const published = (await readBusinessResults(root)).filter(entry => entry.published).map(entry => entry.id).sort();
  assert.deepEqual(published, ["a", "b", "c"]);
});

test("concurrent publishers on one root queue and release after a failed publication", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "business-queue-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const record = (id: string, date: string): Omit<BusinessResult, "line" | "published"> => ({
    id, date, file: `aime_fast/aime_fast_attribution-${date}.jsonl`, stage: "attribution-session", scope: {},
    answers: [{ id: `answer-${id}`, batch: date, caseId: "case", model: "aime_fast", session: "session",
      traces: ["trace"], source: "/source/input.jsonl", line: 1 }],
    acceptedAt: 1, evaluatorVersion: "r513", judge: "judge", submissionId: id, complete: true,
    origin: { run: path.join(root, `run-${id}`), taskId: id, reference: { id, file: "attribution.jsonl", line: 1 } },
  });
  const first = createBusinessPublisher(root), second = createBusinessPublisher(root);
  await writeJsonl(path.join(root, "aime_fast/aime_fast_attribution-2026-10-01.jsonl"), [{ existing: true }]);
  await assert.rejects(first(record("bad", "2026-10-01"), { existing: true }), /缺少可核实的整理映射/);
  await Promise.all(Array.from({ length: 20 }, (_, index) => {
    const date = `2026-10-${String(index + 2).padStart(2, "0")}`;
    return (index % 2 ? second : first)(record(`answer-${index}`, date), { value: index });
  }));
  for (let index = 0; index < 20; index++) {
    const date = `2026-10-${String(index + 2).padStart(2, "0")}`, rows = [];
    for await (const row of readJsonl(path.join(root, `aime_fast/aime_fast_attribution-${date}.jsonl`))) rows.push(row);
    assert.deepEqual(rows, [{ value: index }]);
  }
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
