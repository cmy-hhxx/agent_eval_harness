import type { JsonObject } from "./primitives.js";

export interface PublicationInput { versionId: string; trace: JsonObject }
export interface PublicationResult { row: JsonObject; evaluatedAt: number }
export interface PublicationCounts { inputs: number; comparisons: number; inserted: number; updated: number }
export interface PublicationLabels { batchId: string; caseId: string; task?: string; difficulty?: string }
