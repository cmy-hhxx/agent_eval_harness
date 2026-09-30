import { mkdir, open } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { errorText, redact, type JsonObject, type LogSink } from "@eval/contracts";
import { runLock } from "./files.js";

const ERROR_INTERVAL_MS = 60_000;
const evaluationKey = (record: JsonObject) =>
  JSON.stringify([record.workflow, record.run_id, record.task_id, record.submission_id]);
const errorKey = (record: JsonObject) =>
  JSON.stringify([record.component, record.event, record.run_id, record.message]);

/** Incremental indexes come only from the two logs, with no sidecar ledger or content fingerprints. */
class Journal {
  private offset = 0;
  private identity = "";
  private readonly seen = new Map<string, number>();
  constructor(
    private readonly file: string,
    private readonly runtime: boolean,
  ) {}

  async append(record: JsonObject): Promise<void> {
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
      const keyFor = this.runtime ? errorKey : evaluationKey;
      if (this.runtime)
        for (const [key, time] of this.seen) if (now - time >= ERROR_INTERVAL_MS) this.seen.delete(key);
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
            if (!this.runtime || now - time < ERROR_INTERVAL_MS) this.seen.set(keyFor(saved), time);
          }
          this.offset += end + 1;
          pending = pending.subarray(end + 1);
        }
        // Only an unfinished final line is removed. Complete malformed records remain visible as errors.
        if (pending.length) await handle.truncate(this.offset);
      }
      const key = keyFor(record);
      if (this.seen.has(key)) return;
      const bytes = Buffer.from(JSON.stringify(record) + "\n");
      await handle.writeFile(bytes);
      await handle.sync();
      this.offset += bytes.length;
      this.seen.set(key, Date.parse(String(record.time)));
    } finally {
      await handle.close();
    }
  }
}

export function createFileLogger(options: { directory: string; lockDirectory: string; secrets?: string[] }) {
  const secrets = new Set(options.secrets || []);
  const runtime = new Journal(path.join(options.directory, "runtime.log"), true);
  const evaluations = new Journal(path.join(options.directory, "evaluation.log"), false);
  let queue = Promise.resolve();
  let lastFailure = "";

  async function locked(operation: () => Promise<void>): Promise<boolean> {
    const next = queue.then(async () => {
      const deadline = Date.now() + 30_000;
      let release: (() => Promise<void>) | undefined;
      while (!release) {
        try {
          release = await runLock(options.lockDirectory);
        } catch (error) {
          if (
            Date.now() >= deadline ||
            !/^(Run (?:already owned|lock)|Could not acquire run lock)/.test(errorText(error))
          )
            throw error;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      try {
        await mkdir(options.directory, { recursive: true });
        for (const name of ["runtime.log", "evaluation.log"]) {
          const handle = await open(path.join(options.directory, name), "a");
          await handle.close();
        }
        await operation();
        lastFailure = "";
      } finally {
        await release();
      }
    });
    queue = next.catch(() => {});
    try {
      await next;
      return true;
    } catch (error) {
      const message = redact(errorText(error), [...secrets]);
      if (message !== lastFailure) console.error(`日志写入失败：${message}`);
      lastFailure = message;
      return false;
    }
  }
  const clean = (value: unknown): JsonObject =>
    JSON.parse(
      JSON.stringify(value, (_key, item) => (typeof item === "string" ? redact(item, [...secrets]) : item)),
    );
  const sink: LogSink = {
    async error(error, context) {
      const message = redact(errorText(error), [...secrets]).slice(0, 4096);
      await locked(() =>
        runtime.append(
          clean({
            time: new Date().toISOString(),
            level: "error",
            pid: process.pid,
            ...context,
            message,
            ...(error instanceof Error && error.stack
              ? { stack: redact(error.stack, [...secrets]).slice(0, 8192) }
              : {}),
          }),
        ),
      );
    },
    async evaluation(record) {
      return locked(() => evaluations.append(clean(record)));
    },
  };
  return {
    ...sink,
    async event(event: string, context: JsonObject & { component: string }) {
      return locked(() => runtime.append(clean({
        ...context, time: new Date().toISOString(), level: "info", pid: process.pid,
        event,
      })));
    },
    initialize: () => locked(async () => {}),
    addSecrets: (...values: string[]) => {
      for (const value of values) if (value) secrets.add(value);
    },
  };
}
