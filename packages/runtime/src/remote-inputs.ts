import { errorText, HttpError, safeId, RemoteInputNotReadyError, RetryableInputDownloadError, type InputDownload, type RemoteDay } from "@eval/contracts";
import { setTimeout as delay } from "node:timers/promises";

export function validInputDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

function retryableRequest(error: unknown): boolean {
  if (error instanceof HttpError) return error.status === 408 || error.status === 429 || error.status >= 500;
  return error instanceof TypeError || error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name);
}

/** The source exposes neither HEAD nor a revision/ETag. Never infer one from row counts. */
export class RemoteInputs {
  constructor(readonly url: string, private readonly timeoutMs: number, readonly models: readonly string[]) {
    if (!models.length || new Set(models).size !== models.length) throw new Error("Remote models must be nonempty and unique");
    models.forEach(safeId);
  }

  private async request(route: string, signal: AbortSignal, init?: RequestInit, timeoutMs: number | null = this.timeoutMs): Promise<Response> {
    const response = await fetch(this.url + route, {
      ...init, signal: timeoutMs === null ? signal : AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
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
      const message = `Remote ${route}: HTTP ${response.status}${detail ? ": " + detail : ""}`;
      if (response.status === 404 && detail === "data not ready") throw new RemoteInputNotReadyError(message);
      throw new HttpError(response.status, message);
    }
    return response;
  }

  async discover(signal: AbortSignal): Promise<RemoteDay[]> {
    let value: {
      dates?: { date: string; ready: boolean; models: Record<string, { ready: boolean; row_count: number }> }[];
    };
    for (let attempt = 1; ; attempt++) {
      signal.throwIfAborted();
      try {
        value = await (await this.request("/dashboard-data", signal, undefined, Math.min(this.timeoutMs, 10_000))).json() as typeof value;
        break;
      } catch (error) {
        signal.throwIfAborted();
        if (!retryableRequest(error) || attempt === 3) throw error;
        await delay(1000 * 2 ** (attempt - 1), undefined, { signal });
      }
    }
    if (!Array.isArray(value.dates)) throw new Error("Invalid remote catalog: dates required");
    const seen = new Set<string>(), result: RemoteDay[] = [];
    for (const day of value.dates) {
      if (typeof day.date !== "string" || !validInputDate(day.date) || seen.has(day.date))
        throw new Error("Invalid or duplicate remote date");
      seen.add(day.date);
      if (!day.ready) continue;
      if (!day.models || this.models.some((model) => !day.models[model]?.ready)) continue;
      if (this.models.some((model) => !Number.isSafeInteger(day.models[model].row_count) || day.models[model].row_count < 0))
        throw new Error(`Invalid remote row count: ${day.date}`);
      result.push({ date: day.date, rows: Object.fromEntries(this.models.map((model) =>
        [model, day.models[model].row_count])) as RemoteDay["rows"] });
    }
    return result.sort((a, b) => a.date.localeCompare(b.date));
  }

  async download(day: RemoteDay, model: string, signal: AbortSignal): Promise<InputDownload> {
    if (!validInputDate(day.date) || !this.models.includes(model) || !Number.isSafeInteger(day.rows[model]) || day.rows[model] < 0)
      throw new Error("Invalid remote input location or row count");
    const controller = new AbortController();
    const route = `/data/${day.date}/${model}.jsonl`, timeoutMs = this.timeoutMs;
    let received = 0, size: number | undefined;
    const interrupted = (error: unknown) => {
      signal.throwIfAborted();
      const cause = error instanceof Error ? error.cause as { code?: unknown } | undefined : undefined;
      const detail = errorText(controller.signal.aborted ? controller.signal.reason : error);
      return new RetryableInputDownloadError(`Remote ${route}: ${detail}${typeof cause?.code === "string" ? ` (${cause.code})` : ""}; received ${received}/${size ?? "unknown"} bytes`, { cause: error });
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new Error(`Remote ${route}: no download progress for ${timeoutMs / 1000}s`)), timeoutMs);
    };
    touch();
    let response: Response;
    try { response = await this.request(route, AbortSignal.any([signal, controller.signal]), undefined, null); }
    catch (error) {
      clearTimeout(timer);
      signal.throwIfAborted();
      if (!controller.signal.aborted && !retryableRequest(error)) throw error;
      throw interrupted(error);
    }
    const length = response.headers.get("content-length");
    size = Number(length);
    if (!response.body || length === null || !Number.isSafeInteger(size) || size < 0) {
      clearTimeout(timer);
      await response.body?.cancel();
      throw new Error("Remote JSONL requires a body and Content-Length");
    }
    touch();
    const body = response.body as unknown as AsyncIterable<Uint8Array>;
    return {
      name: model + ".jsonl", rows: day.rows[model], size,
      chunks: (async function* () {
        try {
          for await (const chunk of body) { received += chunk.length; touch(); yield chunk; }
          if (received !== size) throw new Error("Incomplete response body");
        } catch (error) { throw interrupted(error); }
        finally { clearTimeout(timer); }
      })(),
      close: async () => { clearTimeout(timer); controller.abort(); },
    };
  }

  async publish(progress: unknown, signal: AbortSignal): Promise<void> {
    const response = await this.request("/evaluation-progress", signal, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(progress),
    }, Math.min(this.timeoutMs, 10_000));
    await response.body?.cancel();
  }
}
