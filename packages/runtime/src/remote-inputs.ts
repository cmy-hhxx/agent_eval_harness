import { REMOTE_MODELS, type InputDownload, type RemoteDay, type RemoteModel } from "@eval/contracts";

export function validInputDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

/** The source exposes neither HEAD nor a revision/ETag. Never infer one from row counts. */
export class RemoteInputs {
  constructor(readonly url: string, private readonly timeoutMs: number) {}

  private async request(route: string, signal: AbortSignal, init?: RequestInit, timeoutMs = this.timeoutMs): Promise<Response> {
    const response = await fetch(this.url + route, {
      ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    });
    if (!response.ok) {
      let detail = "";
      const reader = response.body?.getReader();
      try {
        if (reader) {
          const chunks: Uint8Array[] = [];
          let size = 0;
          // Error bodies are diagnostics, never an unbounded download or HTML dump.
          while (size < 4096) {
            const { value, done } = await reader.read();
            if (done) break;
            const chunk = value.subarray(0, 4096 - size);
            chunks.push(chunk); size += chunk.length;
          }
          const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (typeof payload?.error === "string") detail = payload.error.replace(/\s+/g, " ").slice(0, 500);
        }
      } catch { /* Preserve the HTTP status when the response body cannot be decoded. */ }
      finally { await reader?.cancel().catch(() => {}); }
      throw new Error(`Remote ${route}: HTTP ${response.status}${detail ? ": " + detail : ""}`);
    }
    return response;
  }

  async discover(signal: AbortSignal): Promise<RemoteDay[]> {
    const value = await (await this.request("/dashboard-data", signal, undefined, Math.min(this.timeoutMs, 10_000))).json() as {
      dates?: { date: string; ready: boolean; models: Record<string, { ready: boolean; row_count: number }> }[];
    };
    if (!Array.isArray(value.dates)) throw new Error("Invalid remote catalog: dates required");
    const seen = new Set<string>(), result: RemoteDay[] = [];
    for (const day of value.dates) {
      if (typeof day.date !== "string" || !validInputDate(day.date) || seen.has(day.date))
        throw new Error("Invalid or duplicate remote date");
      seen.add(day.date);
      if (!day.ready) continue;
      if (!day.models || REMOTE_MODELS.some((model) => !day.models[model]?.ready)) continue;
      if (REMOTE_MODELS.some((model) => !Number.isSafeInteger(day.models[model].row_count) || day.models[model].row_count < 0))
        throw new Error(`Invalid remote row count: ${day.date}`);
      result.push({ date: day.date, rows: Object.fromEntries(REMOTE_MODELS.map((model) =>
        [model, day.models[model].row_count])) as RemoteDay["rows"] });
    }
    return result.sort((a, b) => a.date.localeCompare(b.date));
  }

  async download(day: RemoteDay, model: RemoteModel, signal: AbortSignal): Promise<InputDownload> {
    if (!validInputDate(day.date) || !REMOTE_MODELS.includes(model)) throw new Error("Invalid remote input location");
    const controller = new AbortController();
    const response = await this.request(`/data/${day.date}/${model}.jsonl`,
      AbortSignal.any([signal, controller.signal]));
    const length = response.headers.get("content-length"), size = Number(length);
    if (!response.body || length === null || !Number.isSafeInteger(size) || size < 0) {
      await response.body?.cancel();
      throw new Error("Remote JSONL requires a body and Content-Length");
    }
    return {
      name: model + ".jsonl", rows: day.rows[model], size,
      chunks: response.body as unknown as AsyncIterable<Uint8Array>,
      close: async () => { controller.abort(); },
    };
  }

  async publish(progress: unknown, signal: AbortSignal): Promise<void> {
    const response = await this.request("/evaluation-progress", signal, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(progress),
    }, Math.min(this.timeoutMs, 10_000));
    await response.body?.cancel();
  }
}
