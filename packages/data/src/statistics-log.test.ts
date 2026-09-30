import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendStatisticsLog, readStatisticsLog } from "./statistics-log.js";

test("statistics append preserves history bytes and recovers the same trace after a lost state save", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "statistics-log-")), file = path.join(directory, "statistics.jsonl");
  try {
    const history = '{"traceId":"comparison-snapshot-2026-09-22", "data":{"caseCount":70}}\n';
    await writeFile(file, history);
    const record = { traceId: "snapshot-2026-09-30-window", data: { caseCount: 3 } };
    await appendStatisticsLog(file, record);
    assert.deepEqual(await appendStatisticsLog(file, { ...record, data: { caseCount: 4 } }), record);
    assert.equal(await readFile(file, "utf8"), history + JSON.stringify(record) + "\n");
    assert.deepEqual(await readStatisticsLog(file, record.traceId), record);
    await writeFile(file, history + '{"traceId":');
    await assert.rejects(appendStatisticsLog(file, record), SyntaxError);
    assert.equal(await readFile(file, "utf8"), history + '{"traceId":');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
