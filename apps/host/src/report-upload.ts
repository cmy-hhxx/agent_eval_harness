import { errorText, type JsonObject } from "@eval/contracts";
import { assertStatisticsLog } from "@eval/workflows/comparison";

export type ReportUploadOutcome =
  | { status: "uploaded"; requestId: string }
  | { status: "pending"; error: string }
  | { status: "uncertain"; error: string };

/** Only an acknowledged 201 is success; ambiguous transport or server outcomes are never auto-retried. */
export async function uploadStatisticsReport(url: string, record: JsonObject): Promise<ReportUploadOutcome> {
  assertStatisticsLog(record);
  let response: Response;
  try {
    response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(record),
      redirect: "manual", signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    return { status: "uncertain", error: `ambiguous POST result: ${errorText(error)}` };
  }
  const value = await response.json().catch(() => ({})) as { written?: unknown; requestId?: unknown; error?: unknown };
  if (response.status === 201 && value.written === true && typeof value.requestId === "string" && value.requestId)
    return { status: "uploaded", requestId: value.requestId };
  if ([400, 401, 403, 404, 409, 413, 415, 422].includes(response.status))
    return { status: "pending", error: `HTTP ${response.status}: ${String(value.error || response.statusText)}` };
  return { status: "uncertain", error: `ambiguous POST response: HTTP ${response.status} ${String(value.error || response.statusText)}` };
}
