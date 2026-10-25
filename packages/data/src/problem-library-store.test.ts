import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProblemLibrary } from "@eval/contracts";
import { writeJson } from "./files.js";
import { readProblemLibrary, writeProblemLibrary } from "./problem-library-store.js";

function library(): ProblemLibrary {
  return { model: "a_fast", updated_at: "2026-10-14T08:00:00Z", components: {}, classes: {}, events: [], occurrences: [{
    id: randomUUID(), class_id: randomUUID(), version: "a_fast", evaluator_version: "fixture", batch_id: "2026-10-14",
    case_id: "case", input_id: randomUUID(), run_id: "cluster", task_id: randomUUID(), submission_id: randomUUID(),
    finding_id: "f1", evidence_status: "已确认", message_index: 3, source: { file: "/inputs/original.jsonl", line: 1 },
    classification: "assigned", previous_class_id: null, at: "2026-10-14T08:00:00Z",
  }] };
}

test("problem library round-trips reference-only occurrences", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "problem-library-refs-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "a_fast.json"), value = library();
  await writeProblemLibrary(file, value);
  assert.deepEqual(await readProblemLibrary(file), value);
  assert.equal(Object.hasOwn((await readProblemLibrary(file))!.occurrences[0], "quote"), false);
});

test("problem library readers and writers reject evidence text fields instead of persisting or stripping them", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "problem-library-refs-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "a_fast.json"), value = library();
  await writeProblemLibrary(file, value);
  const before = await readFile(file, "utf8");
  for (const quote of ["copied evidence body", ""]) {
    const invalid = structuredClone(value); Object.assign(invalid.occurrences[0], { quote });
    await assert.rejects(writeProblemLibrary(file, invalid), /不允许 quote/);
    assert.equal(await readFile(file, "utf8"), before, "invalid writes cannot replace a valid bank");
    await writeJson(file, invalid);
    await assert.rejects(readProblemLibrary(file), /不允许 quote/);
    await writeProblemLibrary(file, value);
  }
});
