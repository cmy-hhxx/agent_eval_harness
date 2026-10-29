import { mkdir, open, readdir } from "node:fs/promises";
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
import { exists, readJson, readJsonlText, writeCheckpointJson } from "./files.js";
import { createResultFileWriter } from "./result-file.js";
import { locateRun } from "./run-layout.js";
import { writeRunOverview } from "./run-overview.js";
import { applyRunJournalDelta, CheckpointAdvancedError, readProgressJournal } from "./run-journal.js";
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
) => (ResultReference & { row: JsonObject; auxiliary?: boolean }) | null;

export function createRunRepository<Checkpoint>(
  codec: RunCodec<Checkpoint>,
  encodeResult: ResultEncoder,
  options: { appendOnly?: boolean; indexedFiles?: readonly string[]; semanticReferences?: boolean } = {},
): RunRepository {
  const indexedFiles = new Set(options.indexedFiles);
  async function readState(run: string, taskIds?: ReadonlySet<string>): Promise<RunState> {
    for (let attempt = 0; ; attempt++) {
      try { return await readSnapshot(run, taskIds); }
      catch (error) { if (!(error instanceof CheckpointAdvancedError) || attempt === 2) throw error; }
    }
  }
  async function readSnapshot(run: string, taskIds?: ReadonlySet<string>): Promise<RunState> {
    const layout = locateRun(run);
    const checkpoint = await readJson<Checkpoint>(layout.stateFile);
    const byFile = new Map<string, Map<string, ResultReference>>();
    for (const reference of codec.references(checkpoint, taskIds)) {
      const name = safeId(reference.file!);
      const references = byFile.get(name) ?? byFile.set(name, new Map()).get(name)!;
      if (indexedFiles.has(name) && !options.semanticReferences && (!Number.isSafeInteger(reference.line) || reference.line! < 1))
        throw new Error("结果行引用无效：" + reference.id);
      const previous = references.get(reference.id);
      if (previous && previous.line !== reference.line) throw new Error("结果 ID 对应冲突行：" + reference.id);
      references.set(reference.id, reference);
    }
    const rows = new Map<string, JsonObject>();
    const rowLines = new Map<string, number>();
    for (const [name, references] of byFile) {
      const file = path.join(layout.results, name);
      if (!(await exists(file))) continue;
      // An interrupted append can leave an incomplete last line. Durable receipts rebuild it.
      const idsByLine = new Map<number, string>();
      for (const ref of references.values()) if (ref.line !== undefined) {
        if (idsByLine.has(ref.line)) throw new Error("结果行被多个身份引用：" + name + ":" + ref.line);
        idsByLine.set(ref.line, ref.id);
      }
      let lineNumber = 0;
      for await (const line of readJsonlText(file)) {
        lineNumber++;
        const indexedId = idsByLine.get(lineNumber);
        if (indexedFiles.has(name) && !indexedId &&
            !(options.semanticReferences && references.has(codec.resultId(JSON.parse(line) as JsonObject)))) continue;
        const row = JSON.parse(line) as JsonObject,
          id = indexedId ?? codec.resultId(row);
        if (taskIds && !references.has(id)) continue;
        const key = name + "\u0000" + id,
          previous = rows.get(key);
        if (previous && canonical(previous) !== canonical(row))
          throw new Error("结果 ID 对应冲突结果：" + id);
        rows.set(key, row);
        if (!rowLines.has(key)) rowLines.set(key, lineNumber);
      }
    }
    const decoded = codec.decode(checkpoint, (reference) => {
      const row = rows.get(safeId(reference.file!) + "\u0000" + reference.id);
      if (!row) throw new Error(`结果文件缺失：${reference.id}（${safeId(reference.file!)}）`);
      return row;
    }, taskIds);
    for (const receipt of Object.values(decoded.receipts)) if (receipt.exported?.file && receipt.exported.line === undefined)
      receipt.exported.line = rowLines.get(safeId(receipt.exported.file!) + "\u0000" + receipt.exported.id);
    if (!taskIds)
      for (const event of await readProgressJournal(run, decoded.manifest.journalSequence ?? 0))
        applyRunJournalDelta(decoded, event.event);
    return decoded;
  }
  return {
    async writeRun(run, state) {
      const compact = compactCheckpointState(state);
      const checkpoint = codec.encode(compact), overview = codec.overview?.(checkpoint, compact);
      const bytes = await writeCheckpointJson(locateRun(run).stateFile, checkpoint);
      if (codec.overview) await writeRunOverview(run, overview);
      return bytes;
    },
    readRun: (run) => readState(run),
    readTasks: (run, taskIds) => readState(run, new Set(taskIds)),
    createResultWriter(run, inputs) {
      const written = new Map<string, ResultReference & { row: JsonObject; auxiliary?: boolean }>();
      const processed = new Set<string>();
      const directory = locateRun(run).results;
      const files = new Map<string, ReturnType<typeof createResultFileWriter>>();
      const lineCounts = new Map<string, number>();
      const existingLines = new Map<string, number>();
      const incomplete = new Set<string>();
      let existingRows: Map<string, JsonObject> | undefined;
      let initialized = false;
      const write = async (state: RunState) => {
        const { manifest, receipts } = state;
        try {
          if (!existingRows) {
            existingRows = new Map();
            await mkdir(directory, { recursive: true });
            for (const name of await readdir(directory)) {
              if (!name.endsWith(".jsonl")) continue;
              if (indexedFiles.has(name)) continue;
              if (options.appendOnly) {
                const handle = await open(path.join(directory, name), "r");
                try {
                  const { size } = await handle.stat(), tail = Buffer.alloc(1);
                  if (size) { await handle.read(tail, 0, 1, size - 1); if (tail[0] !== 10) incomplete.add(name); }
                } finally { await handle.close(); }
              }
              for await (const line of readJsonlText(path.join(directory, name))) {
                const row = JSON.parse(line) as JsonObject;
                const key = safeId(name) + "\u0000" + codec.resultId(row), previous = existingRows.get(key);
                if (previous && canonical(previous) !== canonical(row)) throw new Error("结果 ID 对应冲突结果：" + codec.resultId(row));
                existingRows.set(key, row);
                const number = (lineCounts.get(name) ?? 0) + 1;
                lineCounts.set(name, number);
                if (!existingLines.has(key)) existingLines.set(key, number);
              }
            }
          }
          for (const [id, exported] of written) if (receipts[id]) receipts[id].exported = exported;
          const pending = manifest.tasks.filter((task) => receipts[task.id] && !processed.has(task.id));
          if (initialized && !pending.length) return;
          const exports = new Map(written);
          const indexedIds = new Set([...exports.values()].filter(result => indexedFiles.has(result.file!))
            .map(result => result.file + "\u0000" + result.id));
          const updates = new Set<string>();
          const groups: Record<string, Map<string, JsonObject>> = {};
          for (const task of pending) {
            const result = encodeResult(task, state, inputs);
            processed.add(task.id);
            if (!result) continue;
            const file = safeId(result.file!);
            if (indexedFiles.has(file)) {
              const key = file + "\u0000" + result.id;
              if (indexedIds.has(key))
                throw new Error("重复结果身份：" + result.id);
              indexedIds.add(key);
              (groups[file] ??= new Map()).set(result.id, result.row);
              exports.set(task.id, result);
              continue;
            }
            groups[file] ??= new Map();
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
            const openedFile = !!writer;
            if (!writer) files.set(file, writer = createResultFileWriter(path.join(directory, file)));
            if (indexedFiles.has(file)) {
              const results = [...exports.values()].filter(result => result.file === file && (!initialized || rows.has(result.id)))
                .sort((a, b) => (a.line ?? Infinity) - (b.line ?? Infinity));
              const opened = lineCounts.has(file);
              let line = lineCounts.get(file) ?? 0;
              for (const result of results) result.line = ++line;
              // Receipts are authoritative. Rebuild once on open to discard an append interrupted
              // before its checkpoint; identical bodies still belong to distinct task identities.
              if (opened) await writer.append(results.map(result => result.row));
              else if (options.appendOnly && await exists(path.join(directory, file))) {
                const handle = await open(path.join(directory, file), "r");
                let prefix = true, count = 0;
                try {
                  const before = await handle.stat(), tail = Buffer.alloc(1);
                  if (before.size) { await handle.read(tail, 0, 1, before.size - 1); prefix = tail[0] === 10; }
                  for await (const text of readJsonlText(path.join(directory, file))) {
                    if (!results[count] || canonical(JSON.parse(text)) !== canonical(results[count].row)) prefix = false;
                    count++;
                  }
                  const after = await handle.stat();
                  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
                    throw new Error("Result file changed while verifying accepted rows");
                } finally { await handle.close(); }
                if (prefix) await writer.append(results.slice(count).map(result => result.row));
                else await writer.replace(results.map(result => result.row));
              } else await writer.replace(results.map(result => result.row));
              lineCounts.set(file, line);
              continue;
            }
            if ((!openedFile && !options.appendOnly) || incomplete.has(file) || updates.has(file)) {
              const all = new Map<string, JsonObject>();
              if (options.appendOnly) for (const [key, row] of existingRows)
                if (key.startsWith(file + "\u0000")) all.set(codec.resultId(row), row);
              for (const result of exports.values())
                if (result.file === file) all.set(result.id, result.row);
              await writer.replace(all.values());
              let line = 0;
              for (const id of all.keys()) existingLines.set(file + "\u0000" + id, ++line);
              lineCounts.set(file, line);
              incomplete.delete(file);
            } else {
              await writer.append(rows.values());
              let line = lineCounts.get(file) ?? 0;
              for (const id of rows.keys()) existingLines.set(file + "\u0000" + id, ++line);
              lineCounts.set(file, line);
            }
            for (const result of exports.values()) if (result.file === file)
              result.line = existingLines.get(file + "\u0000" + result.id);
            for (const [id, row] of rows) existingRows.set(file + "\u0000" + id, row);
          }
          for (const [id, exported] of exports) {
            if (receipts[id]) receipts[id].exported = exported;
            written.set(id, exported);
          }
          initialized = true;
        } catch (error) {
          written.clear();
          processed.clear();
          files.clear();
          lineCounts.clear();
          existingLines.clear();
          incomplete.clear();
          existingRows = undefined;
          initialized = false;
          throw error;
        }
      };
      // Outbox projections and checkpoint snapshots share this writer's row index.
      // Serialize the complete transaction, including reference assignment.
      let pending = Promise.resolve();
      return (state) => {
        const next = pending.then(() => write(state));
        pending = next.catch(() => {});
        return next;
      };
    },
  };
}
