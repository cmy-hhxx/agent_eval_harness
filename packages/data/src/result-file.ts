import { open, stat, type FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import type { JsonObject } from "@eval/contracts";
import { atomicWrite } from "./files.js";

type Revision = Stats;
type Span = { offset: number; bytes: number };
const sameFile = (a: Revision, b: Revision) =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;

/** Accepted rows are immutable. Keep byte coordinates, never a second copy of their bodies. */
export function createResultFileWriter(file: string) {
  let revision: Revision | undefined;
  let spans = new Map<JsonObject, Span>();
  const invalidate = () => { revision = undefined; spans.clear(); };
  return {
    async replace(rows: Iterable<JsonObject>) {
      let source: FileHandle | undefined;
      const expected = revision, previous = spans, next = new Map<JsonObject, Span>();
      try {
        if (expected) {
          source = await open(file, "r").catch(error => {
            if (error.code !== "ENOENT") throw error;
            return undefined;
          });
          if (source && !sameFile(expected, await source.stat())) { await source.close(); source = undefined; }
        }
        async function* chunks() {
          let offset = 0, range: Span | undefined;
          async function* copy(span: Span) {
            yield* source!.createReadStream({ start: span.offset, end: span.offset + span.bytes - 1,
              autoClose: false, highWaterMark: 256 * 1024 });
          }
          for (const row of rows) {
            if (next.has(row)) throw new Error("Duplicate immutable result row");
            const span = source && previous.get(row);
            if (span) {
              if (range && range.offset + range.bytes !== span.offset) { yield* copy(range); range = undefined; }
              if (range) range.bytes += span.bytes;
              else range = { ...span };
              next.set(row, { offset, bytes: span.bytes });
              offset += span.bytes;
            } else {
              if (range) { yield* copy(range); range = undefined; }
              const bytes = Buffer.from(JSON.stringify(row) + "\n");
              next.set(row, { offset, bytes: bytes.length });
              offset += bytes.length;
              yield bytes;
            }
          }
          if (range) yield* copy(range);
          if (source && !sameFile(expected!, await source.stat())) throw new Error("Result file changed while copying accepted rows");
        }
        await atomicWrite(file, chunks());
        revision = await stat(file);
        spans = next;
      } catch (error) { invalidate(); throw error; }
      finally { await source?.close(); }
    },
    async append(rows: Iterable<JsonObject>) {
      try {
        if (!revision || !sameFile(revision, await stat(file))) invalidate();
        const handle = await open(file, "a"), next = new Map(spans);
        let offset = revision?.size ?? (await handle.stat()).size;
        try {
          for (const row of rows) {
            if (next.has(row)) throw new Error("Duplicate immutable result row");
            const bytes = Buffer.from(JSON.stringify(row) + "\n");
            next.set(row, { offset, bytes: bytes.length });
            offset += bytes.length;
            await handle.writeFile(bytes);
          }
          await handle.sync();
        } finally { await handle.close(); }
        const directory = await open(path.dirname(file), "r");
        try { await directory.sync(); } finally { await directory.close(); }
        // An append after losing the index cannot reconstruct earlier row coordinates.
        const updated = await stat(file);
        if (updated.size !== offset) throw new Error("Result file changed during append");
        if (revision) { revision = updated; spans = next; }
      } catch (error) { invalidate(); throw error; }
    },
  };
}
