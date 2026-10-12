import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { writeJson, writeJsonl } from "@eval/data";
import { PublicationStatistics } from "@eval/workflows/comparison";
import { readPublishedStatistics } from "../../../apps/host/src/assistant-statistics.js";
import { LocalAnalysisData } from "../../../apps/host/src/assistant-data.js";

test("Eris historical statistics select the latest completed upload, validate it and keep live runs separate", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "eris-statistics-"));
  const files = { stateFile: path.join(directory, "state.json"), logFile: path.join(directory, "statistics.jsonl") };
  const completed = (traceId: string, completedAt: number) => ({ traceId, completedAt, status: "completed", log: { status: "uploaded" } });
  const statistics = new PublicationStatistics([]);
  const older = statistics.record("older", 1000), latest = statistics.record("published", 2000), pending = statistics.record("pending", 3000);
  try {
    await writeJsonl(files.logFile, [older, latest, pending]);
    await writeJson(files.stateFile, { publicationHistory: [completed("published", 2100), completed("older", 1100)],
      publication: { traceId: "pending", status: "running", log: { status: "sending" } } });
    const result = await readPublishedStatistics(files);
    assert.equal(result.traceId, "published", "neither file order nor an unfinished newer upload chooses the snapshot");
    assert.equal(result.snapshotAt, latest.logtime);
    assert.deepEqual(result.stats, (latest.data as { stats: unknown }).stats);
    const source = new LocalAnalysisData(path.join(directory, "runs"), files);
    const overview = await source.list({ view: "statistics" });
    assert(overview.kind === "statistics");
    assert.equal(overview.history.status, "published");
    assert.equal(overview.additive, false);
    assert.deepEqual(overview.currentRuns, []);
    await writeJsonl(files.logFile, [older, pending]);
    await assert.rejects(readPublishedStatistics(files), /日志记录缺失/, "missing published records never fall back silently");
    const partial = await source.list({ view: "statistics" });
    assert(partial.kind === "statistics");
    assert.equal(partial.history.status, "unavailable");
    await writeJsonl(files.logFile, [older, { ...latest, data: { ...(latest.data as object), caseCount: "0" } }]);
    await assert.rejects(readPublishedStatistics(files), /frozen contract/);
    await writeJson(files.stateFile, { publicationHistory: [], publication: { traceId: "pending", status: "uncertain", log: { status: "uploaded" } } });
    await assert.rejects(readPublishedStatistics(files), /没有完整发布成功/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
