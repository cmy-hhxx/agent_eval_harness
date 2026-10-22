import type { PublicationCounts } from "@eval/contracts";

export const PUBLICATION_INTERVAL_MS = 4 * 60 * 60 * 1000;
export const nextPublicationAt = (now: number) => (Math.floor(now / PUBLICATION_INTERVAL_MS) + 1) * PUBLICATION_INTERVAL_MS;
export interface StatisticsSchedule {
  nextAt: number;
  attempts: number;
  lastWindow?: number;
  lastTraceId?: string;
  generatedAt?: number;
  error?: string;
}

export interface MongoReceipt {
  target?: string;
  startedAt: number;
  completedAt: number;
  counts: PublicationCounts;
}
export interface MongoPublicationState {
  target?: string;
  status: "pending" | "running" | "completed" | "retry";
  nextAt: number;
  attempts: number;
  synced?: { inputsUpdatedAt: number; comparisons: number };
  startedAt?: number;
  completedAt?: number;
  counts?: PublicationCounts;
  /** Read-only inventory of deliveries made before this pipeline had upload receipts. */
  verified?: { at: number; inputs: number; comparisons: number };
  error?: string;
}
