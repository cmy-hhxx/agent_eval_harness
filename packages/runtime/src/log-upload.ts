import type { JsonObject } from "@eval/contracts";

/** The API appends; callers must durably mark 'sending' before entering and never blindly retry. */
export async function uploadStatisticsLog(url: string, record: JsonObject, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(record),
    redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  });
  const receipt = await response.json() as { written?: boolean; requestId?: string };
  if (response.status !== 201 || receipt.written !== true || typeof receipt.requestId !== "string" || !receipt.requestId)
    throw new Error(`Log upload not acknowledged (HTTP ${response.status})`);
  return receipt.requestId;
}
