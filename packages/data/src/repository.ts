import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import {
  canonical,
  safeId,
  type JsonObject,
  type PlannedTask,
  type ResultReference,
  type RunRepository,
  type RunState,
} from "@eval/contracts";
import { atomicWrite, exists, readJson, readJsonlText } from "./files.js";
import { createResultFileWriter } from "./result-file.js";
import { locateRun } from "./run-layout.js";
import { writeRunOverview } from "./run-overview.js";
import { applyRunJournalDelta, readProgressJournal } from "./run-journal.js";
import { compactCheckpointState } from "./checkpoint-state.js";

/** Codecs are pure business conversions. Only this module accesses run files. */
export interface RunCodec<Checkpoint> {
  encode(state: RunState): Checkpoint;
  overview?(checkpoint: Checkpoint, state: RunState): unknown;
  references(checkpoint: Checkpoint, taskIds?: ReadonlySet<string>): ResultReference[];
  resultId(row: JsonObject): string;
  decode(
    checkpoint: Checkpoint,
    row: (reference: ResultReference) => JsonObject,
    taskIds?: ReadonlySet<string>,
  ): RunState;
}
export type ResultEncoder = (
  task: PlannedTask,
  state: RunState,
  inputs: Record<string, unknown>,
) => ResultReference & { row: JsonObject; auxiliary?: boolean };

export function createRunRepository<Checkpoint>(
  codec: RunCodec<Checkpoint>,
  encodeResult: ResultEncoder,
): RunRepository {
  async function readState(run: string, taskIds?: ReadonlySet<string>): Promise<RunState> {
    const layout = locateRun(run);
    const checkpoint = await readJson<Checkpoint>(layout.stateFile);
    const byFile = new Map<string, Set<string>>();
    for (const reference of codec.references(checkpoint, taskIds)) {
      const name = safeId(reference.file!);
      (byFile.get(name) ?? byFile.set(name, new Set()).get(name)!).add(reference.id);
    }
    const rows = new Map<string, JsonObject>();
    for (const [name, ids] of byFile) {
      const file = path.join(layout.results, name);
      if (!(await exists(file))) continue;
      // An interrupted append can leave an incomplete last line. Durable receipts rebuild it.
      for await (const line of readJsonlText(file)) {
        const row = JSON.parse(line) as JsonObject,
          id = codec.resultId(row);
        if (taskIds && !ids.has(id)) continue;
        const key = name + "\u0000" + id,
          previous = rows.get(key);
        if (previous && canonical(previous) !== canonical(row))
          throw new Error("结果 ID 对应冲突结果：" + id);
        rows.set(key, row);
      }
    }
    const decoded = codec.decode(checkpoint, (reference) => {
      const row = rows.get(safeId(reference.file!) + "\u0000" + reference.id);
      if (!row) throw new Error(`结果文件缺失：${reference.id}（${safeId(reference.file!)}）`);
      return row;
    }, taskIds);
    if (!taskIds)
      for (const event of await readProgressJournal(run, decoded.manifest.journalSequence ?? 0))
        applyRunJournalDelta(decoded, event.event);
    return decoded;
  }
  return {
    async writeRun(run, state) {
      const compact = compactCheckpointState(state);
      const checkpoint = codec.encode(compact), overview = codec.overview?.(checkpoint, compact);
      await atomicWrite(locateRun(run).stateFile, JSON.stringify(checkpoint) + "\n");
      if (codec.overview) await writeRunOverview(run, overview);
    },
    readRun: (run) => readState(run),
    readTasks: (run, taskIds) => readState(run, new Set(taskIds)),
    createResultWriter(run, inputs) {
      const written = new Map<string, ResultReference & { row: JsonObject; auxiliary?: boolean }>();
      const directory = locateRun(run).results;
      const files = new Map<string, ReturnType<typeof createResultFileWriter>>();
      let existingRows: Map<string, JsonObject> | undefined;
      let initialized = false;
      return async (state) => {
        const { manifest, receipts } = state;
        try {
          if (!existingRows) {
            existingRows = new Map();
            await mkdir(directory, { recursive: true });
            for (const name of await readdir(directory)) {
              if (!name.endsWith(".jsonl")) continue;
              for await (const line of readJsonlText(path.join(directory, name))) {
                const row = JSON.parse(line) as JsonObject;
                const key = safeId(name) + "\u0000" + codec.resultId(row), previous = existingRows.get(key);
                if (previous && canonical(previous) !== canonical(row)) throw new Error("结果 ID 对应冲突结果：" + codec.resultId(row));
                existingRows.set(key, row);
              }
            }
          }
          for (const [id, exported] of written) if (receipts[id]) receipts[id].exported = exported;
          const pending = manifest.tasks.filter((task) => receipts[task.id] && !written.has(task.id));
          if (initialized && !pending.length) return;
          const exports = new Map(written);
          const updates = new Set<string>();
          const groups: Record<string, Map<string, JsonObject>> = {};
          for (const task of pending) {
            const result = encodeResult(task, state, inputs);
            const file = safeId(result.file!);
            const existing = existingRows.get(file + "\u0000" + result.id);
            const matching = [...exports].filter(([, value]) => value.file === file && value.id === result.id);
            if (matching.some(([, value]) => canonical(value.row) !== canonical(result.row)) && !result.auxiliary)
              throw new Error("结果 ID 对应冲突结果：" + result.id);
            if (existing) {
              const changed = canonical(existing) !== canonical(result.row);
              if (changed && !result.auxiliary)
                throw new Error("结果 ID 对应冲突结果：" + result.id);
              if (changed) {
                updates.add(file);
                (groups[file] ??= new Map()).set(result.id, result.row);
              }
              exports.set(task.id, result);
              if (changed) existingRows.set(file + "\u0000" + result.id, result.row);
              continue;
            }
            if (matching.length) updates.add(file);
            for (const [id, previous] of matching)
              exports.set(id, { ...previous, row: result.row });
            (groups[file] ??= new Map()).set(result.id, result.row);
            exports.set(task.id, result);
          }
          for (const [file, rows] of Object.entries(groups)) {
            let writer = files.get(file);
            if (!writer) files.set(file, writer = createResultFileWriter(path.join(directory, file)));
            if (!initialized || updates.has(file)) {
              const all = new Map<string, JsonObject>();
              for (const result of exports.values())
                if (result.file === file) all.set(result.id, result.row);
              await writer.replace(all.values());
            } else await writer.append(rows.values());
            for (const [id, row] of rows) existingRows.set(file + "\u0000" + id, row);
          }
          for (const [id, exported] of exports) {
            receipts[id].exported = exported;
            written.set(id, exported);
          }
          initialized = true;
        } catch (error) {
          written.clear();
          files.clear();
          existingRows = undefined;
          initialized = false;
          throw error;
        }
      };
    },
  };
}
