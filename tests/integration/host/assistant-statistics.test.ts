import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { writeJson, writeJsonl } from "@eval/data";
import { PublicationStatistics } from "@eval/workflows/comparison";
import { readPublishedStatistics } from "../../../apps/host/src/assistant-statistics.js";
import { LocalAnalysisData } from "../../../apps/host/src/assistant-data.js";
import { object } from "@eval/contracts";

test("Eris historical statistics select the latest completed upload, validate it and keep live runs separate", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "eris-statistics-"));
  const files = { stateFile: path.join(directory, "state.json"), logFile: path.join(directory, "statistics.jsonl"),
    deliveryFile: path.join(directory, "delivery.json") };
  const statistics = new PublicationStatistics([]);
  const older = statistics.record("older", 1000), latest = statistics.record("published", 2000), pending = statistics.record("pending", 3000);
  try {
    await writeJsonl(files.logFile, [older, latest, pending]);
    await writeJson(files.stateFile, { statistics: { lastTraceId: "published", lastWindow: 1, generatedAt: 2000, nextAt: 4000, attempts: 0 } });
    await writeJson(files.deliveryFile, { records: { published: { traceId: "published", status: "uploaded", uploadedAt: 2100,
      automationId: "test", logFile: files.logFile, logUrl: "http://example.test/upload", writtenAt: 2000, updatedAt: 2100, attempts: 1 } } });
    const result = await readPublishedStatistics(files);
    assert.equal(result.traceId, "published", "neither file order nor an unfinished newer upload chooses the snapshot");
    assert.equal(result.snapshotAt, latest.logtime);
    assert.deepEqual(result.stats, (latest.data as { stats: unknown }).stats);
    assert.equal(result.progress.battleCompletionRate, null);
    assert.equal(result.progress.caseCompletionRate, null);
    const source = new LocalAnalysisData(path.join(directory, "runs"), files);
    const overview = await source.list({ view: "statistics" });
    assert(overview.kind === "statistics");
    assert.equal(overview.history.status, "published");
    assert.equal(overview.additive, false);
    assert.deepEqual(overview.currentRuns, []);
    await writeJson(path.join(directory, "runs/broken/state.json"), {});
    const isolated = await source.list({ view: "statistics" });
    assert(isolated.kind === "statistics");
    assert.deepEqual(isolated.history, overview.history, "an unrelated missing overview must not hide the published snapshot");
    assert.equal(isolated.runDirectory.complete, false);
    await writeJson(path.join(directory, "not-a-directory"), {});
    const unavailableDirectory = await new LocalAnalysisData(path.join(directory, "not-a-directory"), files).list({ view: "statistics" });
    assert(unavailableDirectory.kind === "statistics");
    assert.deepEqual(unavailableDirectory.history, overview.history);
    assert.equal(unavailableDirectory.runDirectory.complete, false);
    await writeJsonl(files.logFile, [older, pending]);
    await assert.rejects(readPublishedStatistics(files), /日志记录缺失/, "missing published records never fall back silently");
    const partial = await source.list({ view: "statistics" });
    assert(partial.kind === "statistics");
    assert.equal(partial.history.status, "unavailable");
    await writeJsonl(files.logFile, [older, { ...latest, data: { ...(latest.data as object), caseCount: "0" } }]);
    await assert.rejects(readPublishedStatistics(files), /frozen contract/);
    await writeJson(files.stateFile, { statistics: { attempts: 0, nextAt: 0 } });
    await assert.rejects(readPublishedStatistics(files), /没有完整发布成功/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Eris supplies completion percentages and losses without changing the frozen published record", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "eris-rates-"));
  const files = { stateFile: path.join(directory, "state.json"), logFile: path.join(directory, "statistics.jsonl"),
    deliveryFile: path.join(directory, "delivery.json") };
  const record = new PublicationStatistics([]).record("published", 2000);
  const metric = { p50: null, p90: null, count: 0 };
  Object.assign(object(record.data), { totalCaseCount: 20554, caseCount: 12114,
    progress: { expectedBattleCount: 35838, completedBattleCount: 22293, completedCaseCount: 11753 },
    models: [{ id: "a_fast", name: "A Fast" }, { id: "a_expert", name: "A Expert" }],
    stats: [{ id: "a_fast", name: "A Fast", evaluated: 10, wins: 3, both_good: 4, both_bad: 1, winRate: 30,
      accuracy: { correct: 0, count: 0, rate: null }, first: metric, total: metric, input: metric, output: metric },
      { id: "a_expert", name: "A Expert", evaluated: 0, wins: 0, both_good: 0, both_bad: 0, winRate: 0,
        accuracy: { correct: 0, count: 0, rate: null }, first: metric, total: metric, input: metric, output: metric }],
  });
  const data = object(record.data);
  const task = { id: "reasoning", name: "推理", count: 20554, evaluatedCount: 12114, stats: data.stats, progress: data.progress };
  data.tasks = [task];
  data.difficultyLevels = [{ ...task, description: "需要多步推理", difficulty: "困难", tasks: [task] }];
  data.requestDates = ["2026-10-12", "2026-10-11"].map(date => ({ date, count: data.totalCaseCount, caseCount: data.caseCount,
    totalCaseCount: data.totalCaseCount, models: data.models, stats: data.stats, tasks: data.tasks, progress: data.progress, difficultyLevels: data.difficultyLevels }));
  try {
    await writeJsonl(files.logFile, [record]);
    await writeJson(files.stateFile, { statistics: { lastTraceId: "published", lastWindow: 1, generatedAt: 2000, nextAt: 4000, attempts: 0 } });
    await writeJson(files.deliveryFile, { records: { published: { traceId: "published", status: "uploaded", uploadedAt: 2100,
      automationId: "test", logFile: files.logFile, logUrl: "http://example.test/upload", writtenAt: 2000, updatedAt: 2100, attempts: 1 } } });
    const before = await readFile(files.logFile);
    const source = new LocalAnalysisData(path.join(directory, "runs"), files);
    const result = await source.list({ view: "statistics" });
    assert(result.kind === "statistics" && result.history.status === "published");
    assert.equal(result.history.progress.battleCompletionRate, 62.2);
    assert.equal(result.history.progress.caseCompletionRate, 57.18, "fully completed cases use total included cases, not partially evaluated cases");
    assert.equal(result.history.stats[0].losses, 2, "both-good and both-bad outcomes are not losses");
    assert.equal(result.history.stats[0].winRate, 30);
    assert.equal(result.history.stats[0].lossRate, 20);
    assert.equal(result.history.stats[0].bothGoodRate, 40);
    assert.equal(result.history.stats[0].bothBadRate, 10);
    assert.equal(result.history.stats[1].winRate, null, "no evaluated samples is unknown, not a zero-percent win rate");
    assert.equal(result.history.stats[1].lossRate, null);
    const daily = await readPublishedStatistics(files, { breakdown: "date", limit: 1 });
    assert.equal(daily.breakdown?.nextOffset, 1);
    const day = daily.breakdown!.items[0];
    assert("date" in day);
    assert.equal(day.date, "2026-10-12");
    assert.equal(daily.breakdown?.items[0].stats[0].winRate, 30);
    assert.equal(daily.breakdown?.items[0].progress.battleCompletionRate, 62.2);
    assert(!("tasks" in daily.breakdown!.items[0]), "breakdown pages omit repeated nested snapshots");
    const next = await readPublishedStatistics(files, { breakdown: "date", offset: 1, limit: 1 });
    const older = next.breakdown!.items[0];
    assert("date" in older);
    assert.equal(older.date, "2026-10-11");
    assert.equal(next.breakdown?.hasMore, false);
    for (const breakdown of ["task", "difficulty"] as const) {
      const page = await readPublishedStatistics(files, { breakdown });
      const group = page.breakdown!.items[0];
      assert("name" in group);
      assert.equal(group.name, "推理");
      assert.equal(page.breakdown?.items[0].stats[0].winRate, 30);
    }
    assert.deepEqual(await readFile(files.logFile), before, "derived fields belong only to Eris's read projection");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
