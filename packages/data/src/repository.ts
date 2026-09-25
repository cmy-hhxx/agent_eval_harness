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
import { appendJsonl, exists, readJson, writeJson, writeJsonl } from "./files.js";

/** Codecs are pure business conversions. Only this module accesses run files. */
export interface RunCodec<Checkpoint> {
  encode(state: RunState): Checkpoint;
  references(checkpoint: Checkpoint): ResultReference[];
  resultId(row: JsonObject): string;
  decode(checkpoint: Checkpoint, row: (reference: ResultReference) => JsonObject): RunState;
}
export type ResultEncoder = (
  task: PlannedTask,
  state: RunState,
  inputs: Record<string, unknown>,
) => ResultReference & { row: JsonObject };

export function createRunRepository<Checkpoint>(
  codec: RunCodec<Checkpoint>,
  encodeResult: ResultEncoder,
): RunRepository {
  return {
    async writeRun(run, state) {
      await writeJson(path.join(run, "state.json"), codec.encode(state));
    },
    async readRun(run) {
      const checkpoint = await readJson<Checkpoint>(path.join(run, "state.json"));
      const files = new Map<string, Map<string, JsonObject>>();
      for (const reference of codec.references(checkpoint)) {
        const name = safeId(reference.file!);
        if (files.has(name)) continue;
        const file = path.join(run, "results", name);
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
    createResultWriter(run, inputs) {
      const written = new Map<string, ResultReference & { row: JsonObject }>();
      const directory = path.join(run, "results");
      let initialized = false;
      return async (state) => {
        const { manifest, receipts } = state;
        try {
          for (const [id, exported] of written) if (receipts[id]) receipts[id].exported = exported;
          const pending = manifest.tasks.filter((task) => receipts[task.id] && !written.has(task.id));
          if (initialized && !pending.length) return;
          const groups: Record<string, JsonObject[]> = {};
          const exports = new Map<string, ResultReference & { row: JsonObject }>();
          for (const task of pending) {
            const result = encodeResult(task, state, inputs);
            (groups[safeId(result.file!)] ??= []).push(result.row);
            exports.set(task.id, result);
          }
          if (!initialized) {
            await mkdir(directory, { recursive: true });
            for (const file of await readdir(directory))
              if (file.endsWith(".jsonl") && !groups[file]) await writeJsonl(path.join(directory, file), []);
            for (const [file, rows] of Object.entries(groups))
              await writeJsonl(path.join(directory, file), rows);
          } else
            for (const [file, rows] of Object.entries(groups))
              await appendJsonl(path.join(directory, file), rows);
          for (const task of pending) {
            receipts[task.id].exported = exports.get(task.id)!;
            written.set(task.id, receipts[task.id].exported!);
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
