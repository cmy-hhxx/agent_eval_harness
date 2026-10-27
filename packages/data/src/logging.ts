import { mkdir, open } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { inspect } from "node:util";
import { errorText, redact, type JsonObject, type LogSink } from "@eval/contracts";
import { runLock } from "./files.js";

/** The shared writer lock also protects journal maintenance from other Host / Worker processes. */
export async function withLogWriterLock<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const started = Date.now(), deadline = started + 30_000;
  let release: (() => Promise<void>) | undefined;
  while (!release) {
    try { release = await runLock(directory); }
    catch (error) {
      const now = Date.now();
      // A competing writer can be between exclusive creation and its first write.
      const initializing = error instanceof Error && error.cause instanceof SyntaxError && now - started < 1000;
      if (now >= deadline || !initializing && !/^(Run already owned by host PID |Could not acquire run lock$)/.test(errorText(error)))
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try { return await operation(); }
  finally { await release(); }
}

const EVENT_INTERVAL_MS = 60_000;
const evaluationKey = (record: JsonObject) =>
  JSON.stringify([record.workflow, record.run_id, record.task_id, record.submission_id]);
const eventKey = (record: JsonObject) =>
  JSON.stringify([record.component, record.event, record.run_id, record.task_id, record.attempt_id, record.message]);

/** Incremental indexes come only from the two logs, with no sidecar ledger or content fingerprints. */
class Journal {
  private offset = 0;
  private identity = "";
  private readonly seen = new Map<string, number>();
  constructor(
    private readonly file: string,
    private readonly runtime: boolean,
  ) {}

  async append(records: JsonObject[]): Promise<void> {
    if (!records.length) return;
    const handle = await open(this.file, "a+");
    try {
      const info = await handle.stat();
      const identity = `${info.dev}:${info.ino}`;
      if (identity !== this.identity || info.size < this.offset) {
        this.identity = identity;
        this.offset = 0;
        this.seen.clear();
      }
      const now = Date.now();
      const keyFor = this.runtime ? eventKey : evaluationKey;
      if (this.runtime)
        for (const [key, time] of this.seen) if (now - time >= EVENT_INTERVAL_MS) this.seen.delete(key);
      if (info.size > this.offset) {
        let pending = Buffer.alloc(0);
        const stream = createReadStream(this.file, { start: this.offset, end: info.size - 1 });
        for await (const chunk of stream) {
          pending = Buffer.concat([pending, chunk]);
          const end = pending.lastIndexOf(10);
          if (end < 0) continue;
          for (const line of pending.subarray(0, end).toString("utf8").split("\n")) {
            if (!line.trim()) continue;
            const saved = JSON.parse(line) as JsonObject;
            const time = Date.parse(String(saved.time));
            if (!this.runtime || saved.level !== "error" && now - time < EVENT_INTERVAL_MS) this.seen.set(keyFor(saved), time);
          }
          this.offset += end + 1;
          pending = pending.subarray(end + 1);
        }
        // Only an unfinished final line is removed. Complete malformed records remain visible as errors.
        if (pending.length) await handle.truncate(this.offset);
      }
      const rows: string[] = [];
      const added = new Map<string, number>();
      for (const record of records) {
        const key = keyFor(record);
        const deduplicate = !this.runtime || record.level !== "error";
        if (deduplicate && (this.seen.has(key) || added.has(key))) continue;
        rows.push(JSON.stringify(record) + "\n");
        if (deduplicate) added.set(key, Date.parse(String(record.time)));
      }
      if (!rows.length) return;
      const bytes = Buffer.from(rows.join(""));
      await handle.writeFile(bytes);
      await handle.sync();
      this.offset += bytes.length;
      for (const [key, time] of added) this.seen.set(key, time);
    } finally {
      await handle.close();
    }
  }
}

export function createFileLogger(options: { directory: string; lockDirectory: string; secrets?: string[] }) {
  const secrets = new Set(options.secrets || []);
  const runtime = new Journal(path.join(options.directory, "runtime.log"), true);
  const evaluations = new Journal(path.join(options.directory, "evaluation.log"), false);
  const queue: { journal?: Journal; record?: JsonObject; resolve: (saved: boolean) => void }[] = [];
  let flushing = false;
  let lastFailure = "";

  async function flush(): Promise<void> {
    while (queue.length) {
      const batch = queue.splice(0, 500);
      let saved = false;
      try {
        await withLogWriterLock(options.lockDirectory, async () => {
          await mkdir(options.directory, { recursive: true });
          for (const name of ["runtime.log", "evaluation.log"]) {
            const handle = await open(path.join(options.directory, name), "a");
            await handle.close();
          }
          for (const journal of [runtime, evaluations])
            await journal.append(batch.filter(item => item.journal === journal).map(item => item.record!));
        });
        lastFailure = "";
        saved = true;
      } catch (error) {
        const message = redact(errorText(error), [...secrets]);
        if (message !== lastFailure) console.error(`日志写入失败：${message}`);
        lastFailure = message;
      }
      for (const item of batch) item.resolve(saved);
    }
    flushing = false;
  }
  function locked(journal?: Journal, record?: JsonObject): Promise<boolean> {
    return new Promise(resolve => {
      queue.push({ journal, record, resolve });
      if (flushing) return;
      flushing = true;
      queueMicrotask(() => void flush());
    });
  }
  const clean = (value: unknown): JsonObject =>
    JSON.parse(
      JSON.stringify(value, (_key, item) => (typeof item === "string" ? redact(item, [...secrets]) : item)),
    );
  const sink: LogSink = {
    async error(error, context) {
      const message = redact(errorText(error), [...secrets]);
      await locked(runtime,
          clean({
            time: new Date().toISOString(),
            level: "error",
            pid: process.pid,
            ...context,
            message,
            ...(error instanceof Error && error.stack
              ? { stack: redact(error.stack, [...secrets]) }
              : {}),
            ...(error instanceof Error ? { detail: inspect(error, { depth: null, maxStringLength: null, maxArrayLength: null }) } : {}),
          }),
      );
    },
    async evaluation(record) {
      return locked(evaluations, clean(record));
    },
  };
  return {
    ...sink,
    async event(event: string, context: JsonObject & { component: string }) {
      return locked(runtime, clean({
        ...context, time: new Date().toISOString(), level: "info", pid: process.pid,
        event,
      }));
    },
    initialize: () => locked(),
    addSecrets: (...values: string[]) => {
      for (const value of values) if (value) secrets.add(value);
    },
  };
}
