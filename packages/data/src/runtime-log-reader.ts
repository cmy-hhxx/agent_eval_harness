import { open } from "node:fs/promises";
import type { JsonObject } from "@eval/contracts";

export interface LogPosition { identity: string; offset: number; bytes: number }

function decode(bytes: Buffer): JsonObject {
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a log object");
    return value;
  } catch {
    return { level: "error", component: "logging", event: "invalid_log_record", message: bytes.toString("utf8") };
  }
}

/** Index complete appended lines; details remain in the journal and are loaded by page. */
export class RuntimeLogReader {
  private offset = 0;
  private identity = "";
  constructor(private readonly file: string) {}

  async poll(visit: (record: JsonObject, position: LogPosition) => void, reset: () => void): Promise<void> {
    let handle;
    try { handle = await open(this.file, "r"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.offset = 0; this.identity = ""; reset(); return;
    }
    try {
      const info = await handle.stat(), identity = `${info.dev}:${info.ino}`;
      if (identity !== this.identity || info.size < this.offset) {
        this.offset = 0; this.identity = identity; reset();
      }
      if (info.size === this.offset) return;
      let pending = Buffer.alloc(0);
      for await (const chunk of handle.createReadStream({ start: this.offset, end: info.size - 1, autoClose: false })) {
        pending = Buffer.concat([pending, chunk]);
        let start = 0, end: number;
        while ((end = pending.indexOf(10, start)) >= 0) {
          const bytes = end - start + 1, line = pending.subarray(start, end);
          if (line.length) {
            const record = decode(line);
            if (record.level === "error") visit(record, { identity, offset: this.offset, bytes });
          }
          this.offset += bytes;
          start = end + 1;
        }
        pending = pending.subarray(start);
      }
    } finally { await handle.close(); }
  }

  async read(position: LogPosition): Promise<JsonObject> {
    const handle = await open(this.file, "r");
    try {
      const info = await handle.stat();
      if (`${info.dev}:${info.ino}` !== position.identity || info.size < position.offset + position.bytes)
        throw new Error("Runtime log changed; refresh the error list");
      const buffer = Buffer.alloc(position.bytes);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position.offset);
      if (bytesRead !== buffer.length) throw new Error("Incomplete runtime log record; refresh the error list");
      return decode(buffer);
    } finally { await handle.close(); }
  }
}
