import { mkdir, readdir, readFile } from "node:fs/promises";
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
import { appendJsonl, exists, readJson, readJsonlText, writeJson, writeJsonl } from "./files.js";
import { locateRun } from "./run-layout.js";

/** Codecs are pure business conversions. Only this module accesses run files. */
export interface RunCodec<Checkpoint> {
  encode(state: RunState): Checkpoint;
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
  return {
    async writeRun(run, state) {
      await writeJson(locateRun(run).stateFile, codec.encode(state));
    },
    async readRun(run) {
      const layout = locateRun(run);
      const checkpoint = await readJson<Checkpoint>(layout.stateFile);
      const files = new Map<string, Map<string, JsonObject>>();
      for (const reference of codec.references(checkpoint)) {
        const name = safeId(reference.file!);
        if (files.has(name)) continue;
        const file = path.join(layout.results, name);
        const text = (await exists(file)) ? await readFile(file, "utf8") : "";
        const rows = new Map<string, JsonObject>();
        // An interrupted append can leave an incomplete last line. Durable receipts rebuild it.
        for (const line of text.slice(0, text.lastIndexOf("\n") + 1).split("\n"))
          if (line.trim()) {
            const row = JSON.parse(line) as JsonObject,
              id = codec.resultId(row),
              previous = rows.get(id);
            if (previous && canonical(previous) !== canonical(row))
              throw new Error("结果 ID 对应冲突结果：" + id);
            rows.set(id, row);
          }
        files.set(name, rows);
      }
      return codec.decode(checkpoint, (reference) => {
        const row = files.get(reference.file!)?.get(reference.id);
        if (!row) throw new Error("结果文件缺失：" + reference.id);
        return row;
      });
    },
    /** Decode only the requested tasks; unrelated result rows stay on disk. */
    async readTasks(run, taskIds) {
      const layout = locateRun(run);
      const checkpoint = await readJson<Checkpoint>(layout.stateFile);
      const wanted = new Set(taskIds);
      const byFile = new Map<string, Set<string>>();
      for (const reference of codec.references(checkpoint, wanted)) {
        const name = safeId(reference.file!);
        (byFile.get(name) ?? byFile.set(name, new Set()).get(name)!).add(reference.id);
      }
      const rows = new Map<string, JsonObject>();
      for (const [name, ids] of byFile) {
        const file = path.join(layout.results, name);
        if (!(await exists(file))) continue;
        for await (const line of readJsonlText(file)) {
          const row = JSON.parse(line) as JsonObject,
            id = codec.resultId(row);
          if (!ids.has(id)) continue;
          const key = name + "\u0000" + id,
            previous = rows.get(key);
          if (previous && canonical(previous) !== canonical(row))
            throw new Error("结果 ID 对应冲突结果：" + id);
          rows.set(key, row);
        }
      }
      return codec.decode(
        checkpoint,
        (reference) => {
          const row = rows.get(safeId(reference.file!) + "\u0000" + reference.id);
          if (!row) throw new Error("结果文件缺失：" + reference.id);
          return row;
        },
        wanted,
      );
    },
    createResultWriter(run, inputs) {
      const written = new Map<string, ResultReference & { row: JsonObject; auxiliary?: boolean }>();
      const directory = locateRun(run).results;
      let initialized = false;
      return async (state) => {
        const { manifest, receipts } = state;
        try {
          for (const [id, exported] of written) if (receipts[id]) receipts[id].exported = exported;
          const pending = manifest.tasks.filter((task) => receipts[task.id] && !written.has(task.id));
          if (initialized && !pending.length) return;
          const exports = new Map(written);
          const updates = new Set<string>();
          const groups: Record<string, Map<string, JsonObject>> = {};
          for (const task of pending) {
            const result = encodeResult(task, state, inputs);
            const file = safeId(result.file!);
            const matching = [...exports].filter(([, value]) => value.file === file && value.id === result.id);
            if (matching.some(([, value]) => canonical(value.row) !== canonical(result.row)) && !result.auxiliary)
              throw new Error("结果 ID 对应冲突结果：" + result.id);
            if (matching.length) updates.add(file);
            for (const [id, previous] of matching)
              exports.set(id, { ...previous, row: result.row });
            (groups[file] ??= new Map()).set(result.id, result.row);
            exports.set(task.id, result);
          }
          if (!initialized) {
            await mkdir(directory, { recursive: true });
            for (const file of await readdir(directory))
              if (file.endsWith(".jsonl") && !groups[file]) await writeJsonl(path.join(directory, file), []);
          }
          for (const [file, rows] of Object.entries(groups)) {
            if (!initialized || updates.has(file)) {
              const all = new Map<string, JsonObject>();
              for (const result of exports.values())
                if (result.file === file) all.set(result.id, result.row);
              await writeJsonl(path.join(directory, file), [...all.values()]);
            } else await appendJsonl(path.join(directory, file), [...rows.values()]);
          }
          for (const [id, exported] of exports) {
            receipts[id].exported = exported;
            written.set(id, exported);
          }
          initialized = true;
        } catch (error) {
          written.clear();
          initialized = false;
          throw error;
        }
      };
    },
  };
}
