import path from "node:path";
import { mkdir } from "node:fs/promises";
import type { JsonObject } from "@eval/contracts";
import { readJson, readStatisticsLogs, runLock, writeJson } from "@eval/data";
import { assertStatisticsLog } from "@eval/workflows/comparison";

export type StatisticsDeliveryStatus = "pending" | "sending" | "uploaded" | "uncertain";
export interface StatisticsDeliveryRecord {
  traceId: string;
  automationId: string;
  logFile: string;
  logUrl: string;
  status: StatisticsDeliveryStatus;
  writtenAt: number;
  updatedAt: number;
  attempts: number;
  claimedAt?: number;
  uploadedAt?: number;
  requestId?: string;
  lastError?: string;
  lastErrorAt?: number;
}
interface StatisticsDeliveryLedger { records: Record<string, StatisticsDeliveryRecord> }
export interface StatisticsAutomationSource { id: string; logFile: string; logUrl: string }

function emptyLedger(): StatisticsDeliveryLedger { return { records: {} }; }

/** Durable hand-off state between server snapshots and the local report relay. */
export class StatisticsDeliveryStore {
  constructor(private readonly stateFile: string, private readonly sendingTimeoutMs = 15 * 60_000) {}

  private async locked<T>(operation: (ledger: StatisticsDeliveryLedger) => T | Promise<T>): Promise<T> {
    await mkdir(path.dirname(this.stateFile), { recursive: true });
    const release = await runLock(path.join(path.dirname(this.stateFile), ".statistics-delivery"));
    try {
      const ledger = await this.readLedger();
      this.expireClaims(ledger);
      const result = await operation(ledger);
      await writeJson(this.stateFile, ledger);
      return result;
    } finally { await release(); }
  }

  private async readLedger(): Promise<StatisticsDeliveryLedger> {
    try {
      const value = await readJson<StatisticsDeliveryLedger>(this.stateFile);
      if (!value || typeof value !== "object" || Array.isArray(value) || !value.records ||
          typeof value.records !== "object" || Array.isArray(value.records))
        throw new Error("Invalid statistics delivery ledger: " + this.stateFile);
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyLedger();
      throw error;
    }
  }

  private expireClaims(ledger: StatisticsDeliveryLedger): void {
    const now = Date.now();
    for (const [traceId, entry] of Object.entries(ledger.records)) {
      if (entry.status === "sending" && entry.claimedAt && now - entry.claimedAt >= this.sendingTimeoutMs) {
        ledger.records[traceId] = { ...entry, status: "uncertain", updatedAt: now,
          lastError: "relay claim expired before a receipt was recorded", lastErrorAt: now };
      }
    }
  }

  /** Reconcile every configured log and expose the complete delivery history. */
  async list(sources: readonly StatisticsAutomationSource[], includeRecords = true) {
    return this.locked(async ledger => {
      const now = Date.now();
      const live = new Map<string, JsonObject>();
      const sourceByTrace = new Map<string, StatisticsAutomationSource>();
      for (const source of sources) {
        for (const row of await readStatisticsLogs(source.logFile).catch(error => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as JsonObject[];
          throw error;
        })) {
          assertStatisticsLog(row);
          const traceId = String(row.traceId);
          if (sourceByTrace.has(traceId)) throw new Error("Statistics traceId appears in multiple automation logs: " + traceId);
          sourceByTrace.set(traceId, source);
          if (!live.has(traceId)) live.set(traceId, row);
          if (!ledger.records[traceId]) {
            const writtenAt = Date.parse(String(row.logtime).replace(" ", "T") + "+08:00");
            ledger.records[traceId] = { traceId, automationId: source.id, logFile: source.logFile, logUrl: source.logUrl,
              status: "pending", writtenAt: Number.isFinite(writtenAt) ? writtenAt : now, updatedAt: now, attempts: 0 };
          }
        }
      }
      for (const traceId of live.keys()) if (!sourceByTrace.has(traceId))
        throw new Error("Statistics record has no configured automation source: " + traceId);
      for (const traceId of Object.keys(ledger.records)) if (!sourceByTrace.has(traceId))
        throw new Error("Statistics delivery is missing from configured logs: " + traceId);
      return Object.values(ledger.records).sort((a, b) => b.writtenAt - a.writtenAt)
        .map(entry => ({ ...entry, ...(includeRecords ? { record: live.get(entry.traceId)! } : {}) }));
    });
  }

  async register(source: StatisticsAutomationSource, record: JsonObject) {
    assertStatisticsLog(record);
    const traceId = String(record.traceId);
    return this.locked(async ledger => {
      const current = ledger.records[traceId];
      if (current) {
        if (current.automationId !== source.id) throw new Error("Statistics traceId belongs to another automation: " + traceId);
        return current;
      }
      const writtenAt = Date.parse(String(record.logtime).replace(" ", "T") + "+08:00");
      const entry: StatisticsDeliveryRecord = { traceId, automationId: source.id, logFile: source.logFile, logUrl: source.logUrl,
        status: "pending", writtenAt: Number.isFinite(writtenAt) ? writtenAt : Date.now(), updatedAt: Date.now(), attempts: 0 };
      ledger.records[traceId] = entry;
      return entry;
    });
  }

  async claim(traceId: string) {
    return this.locked(async ledger => {
      const entry = ledger.records[traceId];
      if (!entry) throw new Error("Unknown statistics delivery: " + traceId);
      if (entry.status === "sending") throw new Error("Statistics delivery is already claimed: " + traceId);
      if (entry.status !== "pending") throw new Error("Statistics delivery is not pending: " + traceId);
      const rows = await readStatisticsLogs(entry.logFile).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as JsonObject[];
        throw error;
      });
      const records = new Map(rows.map(row => { assertStatisticsLog(row); return [String(row.traceId), row] as const; }));
      const record = records.get(traceId);
      if (!record) throw new Error("Statistics delivery record is unavailable: " + traceId);
      const now = Date.now();
      const claimed = { ...entry, status: "sending" as const, attempts: entry.attempts + 1, claimedAt: now, updatedAt: now };
      delete claimed.lastError; delete claimed.lastErrorAt;
      ledger.records[traceId] = claimed;
      return claimed;
    });
  }

  async receipt(traceId: string, receipt: { status: "uploaded"; requestId: string } | { status: "pending" | "uncertain"; error: string }) {
    return this.locked(ledger => {
      const entry = ledger.records[traceId];
      if (!entry) throw new Error("Unknown statistics delivery: " + traceId);
      if (entry.status === "uploaded") {
        if (receipt.status === "uploaded" && receipt.requestId === entry.requestId) return entry;
        throw new Error("Statistics delivery already has a different receipt: " + traceId);
      }
      if (entry.status !== "sending") throw new Error("Statistics delivery is not sending: " + traceId);
      const now = Date.now();
      const next: StatisticsDeliveryRecord = receipt.status === "uploaded"
        ? { ...entry, status: "uploaded", requestId: receipt.requestId, uploadedAt: now, updatedAt: now }
        : { ...entry, status: receipt.status, lastError: receipt.error, lastErrorAt: now, updatedAt: now };
      delete next.claimedAt;
      ledger.records[traceId] = next;
      return next;
    });
  }

  async resolve(traceId: string, outcome: { outcome: "written"; requestId: string } | { outcome: "retry" }) {
    return this.locked(ledger => {
      const entry = ledger.records[traceId];
      if (!entry) throw new Error("Unknown statistics delivery: " + traceId);
      if (!["sending", "uncertain"].includes(entry.status)) throw new Error("Statistics delivery does not need manual resolution: " + traceId);
      const now = Date.now();
      const next: StatisticsDeliveryRecord = outcome.outcome === "written"
        ? { ...entry, status: "uploaded", requestId: outcome.requestId, uploadedAt: now, updatedAt: now }
        : { ...entry, status: "pending", updatedAt: now };
      delete next.claimedAt; delete next.lastError; delete next.lastErrorAt;
      ledger.records[traceId] = next;
      return next;
    });
  }
}

export function statisticsSource(config: { id: string; publication: { logFile: string; logUrl: string } }): StatisticsAutomationSource {
  return { id: config.id, logFile: config.publication.logFile, logUrl: config.publication.logUrl };
}
