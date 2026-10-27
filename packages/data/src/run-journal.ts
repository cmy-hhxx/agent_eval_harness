import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  PlannedTask,
  RunManifest,
  RunState,
  SubmissionReceipt,
  TaskState,
  Usage,
} from "@eval/contracts";
import { canonical, safeId } from "@eval/contracts";
import { appendJsonl, readJsonl } from "./files.js";

export type ManifestJournalPatch = Partial<Omit<RunManifest, "tasks" | "states" | "inputCatalog">> & {
  inputCatalog?: unknown[];
};

/** A compact state delta. Accepted bodies are written once and indexed by task identity. */
export interface RunJournalDelta {
  at: number;
  manifest?: ManifestJournalPatch;
  taskOrder?: string[];
  tasks?: PlannedTask[];
  states?: Record<string, TaskState>;
  receipts?: Record<string, SubmissionReceipt>;
  usage?: Usage;
  recordedAttempts?: number;
}

export interface StoredRunJournalEvent {
  seq: number;
  event: RunJournalDelta;
}

/** Outbox projection may add a result reference, but must preserve the accepted event. */
export function isRunJournalProjection(event: RunJournalDelta, projection: RunJournalDelta): boolean {
  const receipts = event.receipts && Object.fromEntries(Object.entries(event.receipts).map(([id, receipt]) => {
    const exported = receipt.exported ?? projection.receipts?.[id]?.exported;
    return [id, exported ? { ...receipt, exported } : receipt];
  }));
  return canonical(receipts ? { ...event, receipts } : event) === canonical(projection);
}

export interface OutboxStats {
  count: number;
  bytes: number;
  oldestAt?: number;
}

const schema = `
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS events_delivery_idx ON events(delivered, seq);
  CREATE TABLE IF NOT EXISTS receipt_ids (
    submission_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL
  );
`;

/**
 * Local hot state for one RunStore. SQLite transactions replace whole-checkpoint
 * writes; the outbox is projected to Ceph by the caller.
 */
export class RunHotStore {
  private readonly database: DatabaseSync;

  constructor(file: string, identity: string) {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    this.database = new DatabaseSync(file);
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
    this.database.exec(schema);
    const existing = this.database.prepare("SELECT value FROM meta WHERE key = 'identity'").get() as
      | { value: string }
      | undefined;
    if (existing && existing.value !== identity) throw new Error("热状态身份与当前 run 不一致");
    this.database.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES ('identity', ?)").run(identity);
  }

  append(event: RunJournalDelta): number {
    const payload = JSON.stringify(event);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const [taskId, receipt] of Object.entries(event.receipts ?? {})) {
        try {
          this.database.prepare("INSERT INTO receipt_ids(submission_id, task_id) VALUES (?, ?)")
            .run(receipt.submissionId, taskId);
        } catch (error) {
          const existing = this.database.prepare(
            "SELECT task_id FROM receipt_ids WHERE submission_id = ?",
          ).get(receipt.submissionId) as { task_id: string } | undefined;
          if (existing?.task_id === taskId) continue;
          throw error;
        }
      }
      const result = this.database.prepare(
        "INSERT INTO events(payload, created_at) VALUES (?, ?)",
      ).run(payload, event.at);
      const seq = Number(result.lastInsertRowid);
      this.database.exec("COMMIT");
      return seq;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  eventsAfter(sequence = 0): StoredRunJournalEvent[] {
    return (this.database.prepare(
      "SELECT seq, payload FROM events WHERE seq > ? ORDER BY seq",
    ).all(sequence) as { seq: number; payload: string }[]).map(row => ({
      seq: Number(row.seq),
      event: JSON.parse(row.payload) as RunJournalDelta,
    }));
  }

  pending(limit = 500): StoredRunJournalEvent[] {
    return (this.database.prepare(
      "SELECT seq, payload FROM events WHERE delivered = 0 ORDER BY seq LIMIT ?",
    ).all(limit) as { seq: number; payload: string }[]).map(row => ({
      seq: Number(row.seq),
      event: JSON.parse(row.payload) as RunJournalDelta,
    }));
  }

  markDelivered(sequences: readonly number[]): void {
    if (!sequences.length) return;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const update = this.database.prepare("UPDATE events SET delivered = 1 WHERE seq = ?");
      for (const seq of sequences) update.run(seq);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  outboxStats(): OutboxStats {
    const row = this.database.prepare(
      "SELECT COUNT(*) AS count, COALESCE(SUM(length(payload) + 32), 0) AS bytes, MIN(created_at) AS oldest FROM events WHERE delivered = 0",
    ).get() as { count: number; bytes: number; oldest: number | null };
    return { count: Number(row.count), bytes: Number(row.bytes), ...(row.oldest === null ? {} : { oldestAt: row.oldest }) };
  }

  lastSequence(): number {
    const row = this.database.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").get() as { seq: number };
    return Number(row.seq);
  }

  lastDeliveredSequence(): number {
    const row = this.database.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE delivered = 1").get() as { seq: number };
    return Number(row.seq);
  }

  setSequenceFloor(sequence: number): void {
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("Invalid journal sequence");
    const current = this.database.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'events'").get() as
      | { seq: number }
      | undefined;
    if ((current?.seq ?? 0) < sequence) {
      // sqlite_sequence.name has no UNIQUE constraint, so it cannot be an UPSERT target.
      this.database.prepare(current
        ? "UPDATE sqlite_sequence SET seq = ? WHERE name = 'events'"
        : "INSERT INTO sqlite_sequence(seq, name) VALUES (?, 'events')").run(sequence);
    }
  }

  close(): void { this.database.close(); }
}

/** Apply a delta to a checkpoint loaded from Ceph. Replay is intentionally idempotent. */
export function applyRunJournalDelta(state: RunState, event: RunJournalDelta): void {
  if (event.manifest) state.manifest = { ...state.manifest, ...event.manifest } as RunManifest;
  if (event.tasks?.length) {
    const tasks = new Map(state.manifest.tasks.map(task => [task.id, task]));
    for (const task of event.tasks) tasks.set(task.id, task);
    state.manifest.tasks = state.manifest.tasks.map(task => tasks.get(task.id) ?? task);
    for (const task of event.tasks) if (!state.manifest.tasks.some(item => item.id === task.id)) state.manifest.tasks.push(task);
  }
  if (event.taskOrder) {
    const tasks = new Map(state.manifest.tasks.map(task => [task.id, task]));
    const ordered = event.taskOrder.map(id => {
      const task = tasks.get(id);
      if (!task) throw new Error("热状态任务顺序引用未知任务：" + id);
      return task;
    });
    state.manifest.tasks = ordered;
  }
  for (const [taskId, taskState] of Object.entries(event.states ?? {})) state.manifest.states[taskId] = taskState;
  for (const [taskId, receipt] of Object.entries(event.receipts ?? {})) state.receipts[taskId] = receipt;
  if (event.usage) state.usage = event.usage;
  if (event.recordedAttempts !== undefined) state.recordedAttempts = event.recordedAttempts;
}

export function runHotFile(root: string, run: string): string {
  const key = Buffer.from(path.resolve(run), "utf8").toString("base64url");
  return path.join(root, safeId(key) + ".sqlite");
}

export function runJournalIdentity(state: RunState): string {
  return JSON.stringify([state.manifest.format, state.manifest.runId, state.manifest.startedAt]);
}

export function runProgressFile(run: string): string { return path.join(run, "progress.jsonl"); }

const progressSequences = new Map<string, number>();

async function progressSequence(file: string): Promise<number> {
  const cached = progressSequences.get(file);
  if (cached !== undefined) return cached;
  let sequence = 0;
  try {
    for await (const row of readJsonl(file)) {
      const value = row as { seq?: unknown; event?: unknown };
      if (!Number.isSafeInteger(value.seq) || (value.seq as number) < 1 || !value.event)
        throw new Error("进度事件流损坏：" + file);
      sequence = Math.max(sequence, value.seq as number);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  progressSequences.set(file, sequence);
  return sequence;
}

/** Append ordered deltas to the durable Ceph projection without rewriting prior events. */
export async function appendProgressJournal(run: string, events: readonly StoredRunJournalEvent[]): Promise<void> {
  if (!events.length) return;
  const file = runProgressFile(run), current = await progressSequence(file);
  const rows = events.filter(event => event.seq > current).sort((a, b) => a.seq - b.seq);
  if (!rows.length) return;
  if (rows[0]!.seq !== current + 1) throw new Error("进度事件流缺少连续序号");
  await appendJsonl(file, rows.map(row => ({ seq: row.seq, event: row.event })));
  progressSequences.set(file, rows.at(-1)!.seq);
}

export async function readProgressJournal(run: string, after = 0): Promise<StoredRunJournalEvent[]> {
  const events: StoredRunJournalEvent[] = [];
  try {
    for await (const row of readJsonl(runProgressFile(run))) {
      const value = row as { seq?: unknown; event?: unknown };
      if (!Number.isSafeInteger(value.seq) || (value.seq as number) <= after || !value.event) continue;
      events.push({ seq: value.seq as number, event: value.event as RunJournalDelta });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return events.sort((a, b) => a.seq - b.seq);
}
